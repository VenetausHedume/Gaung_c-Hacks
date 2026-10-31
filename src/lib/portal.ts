/**
 * MediCheck portal backend: accounts, role-based sessions, the shared
 * citizen / pharmacy / government case state, the pharmacy verification
 * workflow (citizen reports must match -> government approval -> Verified),
 * radius-based area search and proof-file storage.
 *
 * Persistence: Supabase (service-role key, tables from migration 0007) with an
 * in-memory fallback so local development and offline tests keep working.
 * Every state change goes through the pure reducer functions below, which is
 * what the role checks and the test-suite exercise.
 */
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Types
// =============================================================================

export type PortalRole = 'citizen' | 'pharmacy' | 'gov';
export type IssueType = 'overpriced' | 'stock' | 'expired';
export type CaseStatus = 'open' | 'in_progress' | 'resolved' | 'escalated';
export type VerificationStatus = 'unverified' | 'pending' | 'action_needed' | 'verified' | 'rejected';

export interface GovUpdate {
  status: 'in_progress' | 'resolved' | 'escalated';
  note: string;
  proof_urls: string[];
  agency: string;
  at: string;
}

export interface PortalReport {
  id: string;
  sealed_report_id: string | null;
  issue_type: IssueType;
  medicine: string;
  barcode: string | null;
  mrp: number;
  billed: number;
  overcharge: number;
  pharmacy: string;
  licence_no: string;
  address: string;
  lat: number | null;
  lon: number | null;
  notes: string;
  bill_photo_url: string | null;
  bill_photo_name: string | null;
  filed_at: string;
  filed_by: string;
  status: CaseStatus;
  price_corrected: boolean;
  pharmacy_response: { text: string; proof_url: string | null; at: string } | null;
  gov_updates: GovUpdate[];
}

export interface VerificationCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface PharmacySubmission {
  id: string;
  period: string;
  items_scanned: number;
  barcodes: string[];
  stock_proof_url: string | null;
  billing_proof_url: string | null;
  notes: string;
  at: string;
  status: string;
}

export interface PortalPharmacy {
  name: string;
  licence_no: string;
  address: string;
  area: string;
  lat: number | null;
  lon: number | null;
  items_scanned: number;
  period: string | null;
  submissions: PharmacySubmission[];
  verification: {
    status: VerificationStatus;
    submitted_at: string | null;
    reviewed_at: string | null;
    reviewed_by: string | null;
    review_note: string | null;
    match: { ok: boolean; checks: VerificationCheck[] } | null;
  };
  verified: boolean;
  verified_at: string | null;
}

export interface PortalState {
  version: number;
  reports: PortalReport[];
  pharmacy: PortalPharmacy;
  updated_at: string;
}

export interface Actor {
  user_id: string;
  role: PortalRole;
  display_name: string;
}

export class PortalError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const MIN_STOCK_SCANS = 5;

// =============================================================================
// Small helpers
// =============================================================================

const nowIso = (): string => new Date().toISOString();

function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

function num(v: unknown): number {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function coord(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function safeUrl(v: unknown): string | null {
  const s = str(v, 1000);
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || s.startsWith('/api/proof/')) return s;
  return null;
}

// =============================================================================
// State: defaults + pure reducers
// =============================================================================

export function createFreshPharmacy(): PortalPharmacy {
  return {
    name: 'Sundar Medicals',
    licence_no: 'KA-BLR-KOR-001',
    address: '12, 5th Block, Koramangala, Bengaluru 560095',
    area: 'Koramangala, Bengaluru',
    lat: 12.9352,
    lon: 77.6245,
    items_scanned: 0,
    period: null,
    submissions: [],
    verification: {
      status: 'unverified',
      submitted_at: null,
      reviewed_at: null,
      reviewed_by: null,
      review_note: null,
      match: null,
    },
    verified: false,
    verified_at: null,
  };
}

export function createFreshState(): PortalState {
  return { version: 1, reports: [], pharmacy: createFreshPharmacy(), updated_at: nowIso() };
}

export function reportMatchesPharmacy(rep: PortalReport, ph: PortalPharmacy): boolean {
  const lic = norm(rep.licence_no);
  if (lic && lic === norm(ph.licence_no)) return true;
  const a = norm(rep.pharmacy);
  const b = norm(ph.name);
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}

export function deriveStatus(rep: PortalReport): CaseStatus {
  const last = rep.gov_updates[rep.gov_updates.length - 1];
  if (last) return last.status;
  if (rep.pharmacy_response) return 'in_progress';
  return 'open';
}

/** A complaint no longer blocks verification once resolved, or once an overcharge has been corrected. */
function isCleared(rep: PortalReport): boolean {
  return rep.status === 'resolved' || (rep.issue_type === 'overpriced' && rep.price_corrected);
}

/** Does the pharmacy's submission agree with what citizens are reporting on the ground? */
export function evaluateVerification(state: PortalState): { ok: boolean; checks: VerificationCheck[] } {
  const ph = state.pharmacy;
  const sub = ph.submissions[0];
  const mine = state.reports.filter((r) => reportMatchesPharmacy(r, ph));
  const blocking = mine.filter((r) => !isCleared(r));
  const checks: VerificationCheck[] = [
    {
      key: 'stock_scans',
      label: `Stock barcode scans (min ${MIN_STOCK_SCANS})`,
      ok: Boolean(sub) && sub.items_scanned >= MIN_STOCK_SCANS,
      detail: sub ? `${sub.items_scanned} distinct items scanned` : 'No submission yet',
    },
    {
      key: 'billing_proof',
      label: 'Billing records uploaded',
      ok: Boolean(sub && sub.billing_proof_url),
      detail: sub && sub.billing_proof_url ? 'Billing export attached' : 'Billing records missing',
    },
    {
      key: 'period',
      label: 'Billing period stated',
      ok: Boolean(sub && sub.period),
      detail: sub && sub.period ? sub.period : 'Period missing',
    },
    {
      key: 'citizen_reports',
      label: 'Matches citizen reports',
      ok: blocking.length === 0,
      detail:
        blocking.length === 0
          ? mine.length === 0
            ? 'No citizen complaints on record'
            : `All ${mine.length} citizen complaint(s) resolved or corrected`
          : `${blocking.length} unresolved citizen complaint(s) must be resolved or corrected first`,
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/** Re-derives every computed field. Call after any mutation. */
export function recompute(state: PortalState): PortalState {
  for (const r of state.reports) {
    r.status = deriveStatus(r);
    r.overcharge = r.issue_type === 'overpriced' ? Math.max(0, Number((r.billed - r.mrp).toFixed(2))) : 0;
  }
  const v = state.pharmacy.verification;
  if (v.status === 'pending' || v.status === 'action_needed') {
    const m = evaluateVerification(state);
    v.match = m;
    v.status = m.ok ? 'pending' : 'action_needed';
  } else if (v.status === 'verified') {
    const sub = state.pharmacy.submissions[0];
    if (sub && sub.status === 'Action needed') v.status = 'action_needed';
  }
  state.pharmacy.verified = v.status === 'verified';
  const latest = state.pharmacy.submissions[0];
  if (latest) {
    latest.status =
      v.status === 'verified'
        ? 'Approved'
        : v.status === 'rejected'
        ? 'Rejected'
        : v.status === 'pending'
        ? 'Awaiting government approval'
        : v.status === 'action_needed'
        ? 'Action needed'
        : latest.status;
  }
  state.updated_at = nowIso();
  state.version += 1;
  return state;
}

export interface FileReportInput {
  issue_type?: unknown;
  medicine?: unknown;
  barcode?: unknown;
  mrp?: unknown;
  billed?: unknown;
  pharmacy?: unknown;
  licence_no?: unknown;
  address?: unknown;
  lat?: unknown;
  lon?: unknown;
  notes?: unknown;
  bill_photo_url?: unknown;
  bill_photo_name?: unknown;
  sealed_report_id?: unknown;
}

export function validateReportInput(input: FileReportInput): Omit<PortalReport, 'id' | 'filed_at' | 'filed_by' | 'status' | 'price_corrected' | 'pharmacy_response' | 'gov_updates' | 'overcharge'> {
  const rawType = str(input.issue_type, 30).toLowerCase();
  const issue_type: IssueType =
    rawType === 'stock' || rawType === 'out_of_stock'
      ? 'stock'
      : rawType === 'expired' || rawType === 'suspect_batch_or_pack'
      ? 'expired'
      : 'overpriced';
  const medicine = str(input.medicine, 160);
  const pharmacy = str(input.pharmacy, 160);
  const licence_no = str(input.licence_no, 60);
  const address = str(input.address, 300);
  if (!medicine) throw new PortalError('Medicine name is required.');
  if (!pharmacy) throw new PortalError('Pharmacy name is required.');
  if (!licence_no) throw new PortalError('The pharmacy licence number (from the bill) is required.');
  if (!address) throw new PortalError('Pick the pharmacy location from the address search.');
  const bill = safeUrl(input.bill_photo_url);
  if (issue_type !== 'stock' && !bill) throw new PortalError('A photo of the bill is required as proof.');
  let mrp = num(input.mrp);
  let billed = num(input.billed);
  if (issue_type === 'overpriced') {
    if (!(mrp > 0) || !(billed > 0)) throw new PortalError('Enter both the registered MRP and the amount billed.');
    if (billed <= mrp) throw new PortalError('The billed amount is not above MRP, so this is not an overpricing report.');
  } else {
    mrp = mrp > 0 ? mrp : 0;
    billed = billed > 0 ? billed : 0;
  }
  return {
    sealed_report_id: input.sealed_report_id ? str(input.sealed_report_id, 80) : null,
    issue_type,
    medicine,
    barcode: input.barcode ? str(input.barcode, 40) : null,
    mrp,
    billed,
    pharmacy,
    licence_no,
    address,
    lat: coord(input.lat, -90, 90),
    lon: coord(input.lon, -180, 180),
    notes: str(input.notes, 1000),
    bill_photo_url: bill,
    bill_photo_name: input.bill_photo_name ? str(input.bill_photo_name, 120) : null,
  };
}

export function fileReport(state: PortalState, actor: Actor, input: FileReportInput): PortalReport {
  if (actor.role !== 'citizen') throw new PortalError('Only citizen accounts can file reports.', 403);
  const v = validateReportInput(input);
  const rep: PortalReport = {
    ...v,
    id: v.sealed_report_id || randomUUID(),
    overcharge: 0,
    filed_at: nowIso(),
    filed_by: actor.user_id,
    status: 'open',
    price_corrected: false,
    pharmacy_response: null,
    gov_updates: [],
  };
  state.reports.unshift(rep);
  recompute(state);
  return rep;
}

function findReport(state: PortalState, id: unknown): PortalReport {
  const rep = state.reports.find((r) => r.id === str(id, 80));
  if (!rep) throw new PortalError('Report not found.', 404);
  return rep;
}

export function pharmacyRespond(state: PortalState, actor: Actor, input: { report_id: unknown; text: unknown; proof_url?: unknown }): PortalReport {
  if (actor.role !== 'pharmacy') throw new PortalError('Only the pharmacy account can respond to reports.', 403);
  const rep = findReport(state, input.report_id);
  if (!reportMatchesPharmacy(rep, state.pharmacy)) throw new PortalError('This report is not filed against your pharmacy.', 403);
  const text = str(input.text, 1500);
  if (!text) throw new PortalError('Write a response before sending.');
  rep.pharmacy_response = { text, proof_url: safeUrl(input.proof_url), at: nowIso() };
  recompute(state);
  return rep;
}

export function markCorrected(state: PortalState, actor: Actor, input: { report_id: unknown }): PortalReport {
  if (actor.role !== 'pharmacy') throw new PortalError('Only the pharmacy account can mark prices corrected.', 403);
  const rep = findReport(state, input.report_id);
  if (!reportMatchesPharmacy(rep, state.pharmacy)) throw new PortalError('This report is not filed against your pharmacy.', 403);
  rep.price_corrected = true;
  recompute(state);
  return rep;
}

export function govUpdate(
  state: PortalState,
  actor: Actor,
  input: { report_id: unknown; status: unknown; note: unknown; proof_urls?: unknown }
): PortalReport {
  if (actor.role !== 'gov') throw new PortalError('Only government accounts can post progress updates.', 403);
  const rep = findReport(state, input.report_id);
  const raw = str(input.status, 30).toLowerCase().replace(/\s+/g, '_');
  const status: GovUpdate['status'] | null =
    raw === 'resolved' ? 'resolved' : raw === 'escalated' ? 'escalated' : raw === 'in_progress' || raw === 'investigating' ? 'in_progress' : null;
  if (!status) throw new PortalError('Status must be In progress, Resolved or Escalated.');
  const note = str(input.note, 2000);
  if (!note) throw new PortalError('Describe what is being done before posting an update.');
  const urls = (Array.isArray(input.proof_urls) ? input.proof_urls : [])
    .map(safeUrl)
    .filter((u): u is string => Boolean(u));
  rep.gov_updates.push({ status, note, proof_urls: urls, agency: actor.display_name, at: nowIso() });
  recompute(state);
  return rep;
}

export function submitVerification(
  state: PortalState,
  actor: Actor,
  input: { period: unknown; barcodes: unknown; notes?: unknown; stock_proof_url?: unknown; billing_proof_url?: unknown }
): PortalPharmacy {
  if (actor.role !== 'pharmacy') throw new PortalError('Only the pharmacy account can submit verification records.', 403);
  const barcodes = Array.from(
    new Set((Array.isArray(input.barcodes) ? input.barcodes : []).map((b) => str(b, 40)).filter(Boolean))
  );
  const period = str(input.period, 120);
  if (!period) throw new PortalError('State the period your billing records cover.');
  const sub: PharmacySubmission = {
    id: randomUUID(),
    period,
    items_scanned: barcodes.length,
    barcodes,
    stock_proof_url: safeUrl(input.stock_proof_url),
    billing_proof_url: safeUrl(input.billing_proof_url),
    notes: str(input.notes, 1000),
    at: nowIso(),
    status: 'Awaiting government approval',
  };
  const ph = state.pharmacy;
  ph.submissions.unshift(sub);
  ph.items_scanned = sub.items_scanned;
  ph.period = period;
  const m = evaluateVerification(state);
  const v = ph.verification;
  v.submitted_at = sub.at;
  v.match = m;
  if (v.status === 'verified' && m.ok) {
    // Routine re-submission for an already verified store that still matches.
  } else {
    v.status = m.ok ? 'pending' : 'action_needed';
    v.review_note = null;
    v.reviewed_at = null;
    v.reviewed_by = null;
    ph.verified_at = null;
  }
  recompute(state);
  return ph;
}

export function reviewVerification(
  state: PortalState,
  actor: Actor,
  input: { action: unknown; note?: unknown }
): PortalPharmacy {
  if (actor.role !== 'gov') throw new PortalError('Only government accounts can approve or reject verification.', 403);
  const ph = state.pharmacy;
  const v = ph.verification;
  const action = str(input.action, 20).toLowerCase();
  if (action !== 'approve' && action !== 'reject') throw new PortalError('Action must be approve or reject.');
  if (v.status !== 'pending' && v.status !== 'action_needed') {
    throw new PortalError('There is no pending verification request to review.', 409);
  }
  if (action === 'approve') {
    const m = evaluateVerification(state);
    v.match = m;
    if (!m.ok) {
      throw new PortalError('Cannot approve: the submission does not yet match citizen reports and required proof.', 409);
    }
    v.status = 'verified';
    ph.verified_at = nowIso();
  } else {
    v.status = 'rejected';
    ph.verified_at = null;
  }
  v.reviewed_at = nowIso();
  v.reviewed_by = actor.display_name;
  v.review_note = str(input.note, 500) || null;
  recompute(state);
  return ph;
}

// =============================================================================
// Area search (radius, Google-Maps style) + pharmacy directory
// =============================================================================

export interface DirectoryPharmacy {
  key: string;
  name: string;
  address: string;
  licence_no: string;
  lat: number | null;
  lon: number | null;
  distance_km: number | null;
  verification: VerificationStatus;
  verified: boolean;
  total_reports: number;
  open_issues: number;
  resolved_issues: number;
  trust: 'verified' | 'multiple_issues' | 'has_issues' | 'pending' | 'no_reports';
  summary: string;
  registered: boolean;
}

export function buildDirectory(state: PortalState): DirectoryPharmacy[] {
  const out = new Map<string, DirectoryPharmacy>();
  const ph = state.pharmacy;
  const reg: DirectoryPharmacy = {
    key: 'reg:' + norm(ph.licence_no || ph.name),
    name: ph.name,
    address: ph.address,
    licence_no: ph.licence_no,
    lat: ph.lat,
    lon: ph.lon,
    distance_km: null,
    verification: ph.verification.status,
    verified: ph.verified,
    total_reports: 0,
    open_issues: 0,
    resolved_issues: 0,
    trust: 'no_reports',
    summary: '',
    registered: true,
  };
  out.set(reg.key, reg);
  for (const r of state.reports) {
    if (reportMatchesPharmacy(r, ph)) continue;
    const key = 'rep:' + (norm(r.licence_no) || norm(r.pharmacy));
    let d = out.get(key);
    if (!d) {
      d = {
        key,
        name: r.pharmacy,
        address: r.address,
        licence_no: r.licence_no,
        lat: r.lat,
        lon: r.lon,
        distance_km: null,
        verification: 'unverified',
        verified: false,
        total_reports: 0,
        open_issues: 0,
        resolved_issues: 0,
        trust: 'no_reports',
        summary: '',
        registered: false,
      };
      out.set(key, d);
    }
    d.total_reports += 1;
    if (isCleared(r)) d.resolved_issues += 1;
    else d.open_issues += 1;
  }
  for (const r of state.reports) {
    if (!reportMatchesPharmacy(r, ph)) continue;
    reg.total_reports += 1;
    if (isCleared(r)) reg.resolved_issues += 1;
    else reg.open_issues += 1;
  }
  for (const d of out.values()) {
    d.trust = d.verified
      ? 'verified'
      : d.open_issues >= 2
      ? 'multiple_issues'
      : d.open_issues === 1
      ? 'has_issues'
      : d.verification === 'pending'
      ? 'pending'
      : 'no_reports';
    d.summary =
      d.total_reports === 0
        ? 'No citizen reports'
        : `${d.total_reports} citizen report${d.total_reports === 1 ? '' : 's'} · ${d.open_issues} open · ${d.resolved_issues} resolved`;
  }
  return Array.from(out.values());
}

export interface AreaQuery {
  lat?: number | null;
  lon?: number | null;
  radiusKm?: number | null;
  q?: string | null;
}

function textTokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export function searchArea(
  state: PortalState,
  query: AreaQuery
): { reports: Array<PortalReport & { distance_km: number | null }>; pharmacies: DirectoryPharmacy[]; radius_km: number | null; center: { lat: number; lon: number } | null } {
  const hasCenter = typeof query.lat === 'number' && typeof query.lon === 'number';
  const radius = hasCenter && query.radiusKm && query.radiusKm > 0 ? query.radiusKm : null;
  const tokens = textTokens(query.q ?? '');
  const textHit = (hay: string): boolean => tokens.length === 0 || tokens.some((t) => hay.toLowerCase().includes(t));

  const within = (lat: number | null, lon: number | null, hay: string): { ok: boolean; km: number | null } => {
    if (hasCenter && lat !== null && lon !== null) {
      const km = haversineKm(query.lat as number, query.lon as number, lat, lon);
      return { ok: radius === null || km <= radius, km: Number(km.toFixed(2)) };
    }
    return { ok: textHit(hay), km: null };
  };

  const reports: Array<PortalReport & { distance_km: number | null }> = [];
  for (const r of state.reports) {
    const w = within(r.lat, r.lon, `${r.address} ${r.pharmacy}`);
    if (w.ok) reports.push({ ...r, distance_km: w.km });
  }
  reports.sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9) || b.filed_at.localeCompare(a.filed_at));

  const pharmacies: DirectoryPharmacy[] = [];
  for (const d of buildDirectory(state)) {
    const w = within(d.lat, d.lon, `${d.address} ${d.name}`);
    if (w.ok) pharmacies.push({ ...d, distance_km: w.km });
  }
  const rank: Record<string, number> = { verified: 0, pending: 3, no_reports: 2, has_issues: 4, multiple_issues: 5 };
  pharmacies.sort((a, b) => (rank[a.trust] ?? 9) - (rank[b.trust] ?? 9) || (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));

  return {
    reports,
    pharmacies,
    radius_km: radius,
    center: hasCenter ? { lat: query.lat as number, lon: query.lon as number } : null,
  };
}

// =============================================================================
// Persistence (Supabase service role with in-memory fallback + circuit breaker)
// =============================================================================

let memState: PortalState | null = null;
let adminClient: SupabaseClient | null | undefined;
let dbDownUntil = 0;

function admin(): SupabaseClient | null {
  if (adminClient !== undefined) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  adminClient = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return adminClient;
}

function dbUsable(): SupabaseClient | null {
  if (Date.now() < dbDownUntil) return null;
  return admin();
}

function tripBreaker(): void {
  dbDownUntil = Date.now() + 30_000;
}

/** Test hook: forget cached state / client so env changes take effect. */
export function __resetPortalForTests(): void {
  memState = null;
  adminClient = undefined;
  dbDownUntil = 0;
  memAccounts.clear();
  memOrgRequests.length = 0;
  memProofs.clear();
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function loadState(): Promise<PortalState> {
  const db = dbUsable();
  if (db) {
    try {
      const { data, error } = await withTimeout(db.from('portal_state').select('state').eq('id', 'main').maybeSingle(), 4000);
      if (error) throw new Error(error.message);
      if (data && data.state) {
        const s = data.state as PortalState;
        if (Array.isArray(s.reports) && s.pharmacy) {
          memState = s;
          return s;
        }
      }
      if (!memState) memState = createFreshState();
      return memState;
    } catch {
      tripBreaker();
    }
  }
  if (!memState) memState = createFreshState();
  return memState;
}

export async function saveState(state: PortalState): Promise<void> {
  memState = state;
  const db = dbUsable();
  if (!db) return;
  try {
    const { error } = await withTimeout(
      db.from('portal_state').upsert({ id: 'main', state, updated_at: nowIso() }, { onConflict: 'id' }),
      4000
    );
    if (error) throw new Error(error.message);
  } catch {
    tripBreaker();
  }
}

export async function resetState(): Promise<PortalState> {
  const s = createFreshState();
  await saveState(s);
  return s;
}

/** Public view of the state for a viewer; flags the viewer's own reports. */
export function publicView(state: PortalState, viewerId: string | null): unknown {
  return {
    ...state,
    reports: state.reports.map((r) => {
      const { filed_by, ...rest } = r;
      return { ...rest, mine: Boolean(viewerId) && filed_by === viewerId };
    }),
  };
}

// =============================================================================
// Accounts + sessions
// =============================================================================

interface MemAccount {
  user_id: string;
  role: PortalRole;
  identifier: string;
  display_name: string;
  password_hash: string;
  profile: Record<string, unknown>;
}

const memAccounts = new Map<string, MemAccount>();
const memOrgRequests: Array<Record<string, unknown>> = [];

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

function checkPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const a = Buffer.from(scryptSync(pw, salt, 32).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

function demoFallbackAllowed(): boolean {
  return process.env.PORTAL_ALLOW_DEMO_FALLBACK !== 'false';
}

function seedDemoAccounts(): void {
  if (memAccounts.size > 0 || !demoFallbackAllowed()) return;
  const add = (role: PortalRole, identifier: string, display: string, pw: string, profile: Record<string, unknown>): void => {
    memAccounts.set(`${role}:${identifier.toLowerCase()}`, {
      user_id: `demo-${role}`,
      role,
      identifier,
      display_name: display,
      password_hash: hashPassword(pw),
      profile,
    });
  };
  add('pharmacy', 'sundar@medicals.in', 'Sundar Medicals', 'Pharmacy@123', { licence_no: 'KA-BLR-KOR-001' });
  add('gov', 'bbmp@karnataka.gov.in', 'BBMP Health Department', 'Gov@12345', { agency: 'BBMP Health Department' });
}

function tokenSecret(): string {
  return process.env.PORTAL_TOKEN_SECRET || createHash('sha256').update('medicheck|' + (process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret')).digest('hex');
}

const b64u = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

export function signToken(actor: Actor, ttlSeconds = 12 * 3600): string {
  const payload = b64u(JSON.stringify({ u: actor.user_id, r: actor.role, n: actor.display_name, e: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(header: string | undefined | null): Actor | null {
  if (!header) return null;
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string; r: PortalRole; n: string; e: number };
    if (!p.e || p.e < Date.now() / 1000) return null;
    if (p.r !== 'citizen' && p.r !== 'pharmacy' && p.r !== 'gov') return null;
    return { user_id: p.u, role: p.r, display_name: p.n };
  } catch {
    return null;
  }
}

export interface Session {
  authenticated: true;
  user_id: string;
  role: PortalRole;
  display_name: string;
  identifier: string;
  token: string;
  redirect_page: string;
}

const HOME: Record<PortalRole, string> = { citizen: 'home.html', pharmacy: 'pharmacy-home.html', gov: 'gov-home.html' };

function makeSession(a: { user_id: string; role: PortalRole; display_name: string; identifier: string }): Session {
  return {
    authenticated: true,
    user_id: a.user_id,
    role: a.role,
    display_name: a.display_name,
    identifier: a.identifier,
    token: signToken({ user_id: a.user_id, role: a.role, display_name: a.display_name }),
    redirect_page: HOME[a.role],
  };
}

function isDbUnavailable(msg: string): boolean {
  return /fetch failed|timeout|could not find the function|does not exist|schema cache|relation .* does not exist|ECONN|ENOTFOUND/i.test(msg);
}

export async function loginAccount(roleIn: unknown, identifierIn: unknown, passwordIn: unknown): Promise<Session> {
  const role: PortalRole = roleIn === 'pharmacy' || roleIn === 'gov' ? roleIn : 'citizen';
  const identifier = str(identifierIn, 200).toLowerCase();
  const password = String(passwordIn ?? '');
  if (!identifier || !password) throw new PortalError('Enter your email/phone and password.');

  const db = dbUsable();
  if (db) {
    try {
      const { data, error } = await withTimeout(db.rpc('portal_login', { p_role: role, p_identifier: identifier, p_password: password }), 5000);
      if (error) throw new Error(error.message);
      const row = data as { user_id: string; role: PortalRole; display_name: string; identifier: string } | null;
      if (!row) throw new PortalError('Incorrect email/phone or password.', 401);
      return makeSession({ user_id: String(row.user_id), role, display_name: row.display_name, identifier: row.identifier });
    } catch (e) {
      if (e instanceof PortalError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isDbUnavailable(msg)) throw new PortalError('Login failed. Please try again.', 500);
      tripBreaker();
    }
  }

  seedDemoAccounts();
  const acct = memAccounts.get(`${role}:${identifier}`);
  if (!acct || !checkPassword(password, acct.password_hash)) throw new PortalError('Incorrect email/phone or password.', 401);
  return makeSession(acct);
}

export async function registerCitizenAccount(input: { full_name?: unknown; phone?: unknown; email?: unknown; password?: unknown }): Promise<Session> {
  const name = str(input.full_name, 120);
  const phone = str(input.phone, 30);
  const email = str(input.email, 200).toLowerCase();
  const password = String(input.password ?? '');
  if (name.length < 2) throw new PortalError('Enter your full name.');
  if (!/^\+?[0-9 \-]{8,16}$/.test(phone)) throw new PortalError('Enter a valid phone number.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PortalError('Enter a valid email address.');
  if (password.length < 8) throw new PortalError('Password must be at least 8 characters.');

  const db = dbUsable();
  if (db) {
    try {
      const { data, error } = await withTimeout(
        db.rpc('portal_register_citizen', { p_name: name, p_phone: phone, p_email: email, p_password: password }),
        5000
      );
      if (error) {
        if (/already registered/i.test(error.message)) throw new PortalError('An account with this email or phone already exists.', 409);
        throw new Error(error.message);
      }
      const row = data as { user_id: string; display_name: string; identifier: string };
      return makeSession({ user_id: String(row.user_id), role: 'citizen', display_name: row.display_name, identifier: row.identifier });
    } catch (e) {
      if (e instanceof PortalError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isDbUnavailable(msg)) throw new PortalError('Could not create the account. Please try again.', 500);
      tripBreaker();
    }
  }

  for (const key of [`citizen:${email}`, `citizen:${phone.toLowerCase()}`]) {
    if (memAccounts.has(key)) throw new PortalError('An account with this email or phone already exists.', 409);
  }
  const acct: MemAccount = {
    user_id: 'cit-' + randomUUID(),
    role: 'citizen',
    identifier: email,
    display_name: name,
    password_hash: hashPassword(password),
    profile: { phone },
  };
  memAccounts.set(`citizen:${email}`, acct);
  memAccounts.set(`citizen:${phone.toLowerCase()}`, acct);
  return makeSession(acct);
}

export async function requestOrgAccount(input: { role?: unknown; org_name?: unknown; contact_person?: unknown; phone?: unknown; area?: unknown }): Promise<{ requested: true; request_id: string; message: string }> {
  const role = input.role === 'gov' ? 'gov' : 'pharmacy';
  const org = str(input.org_name, 200);
  const contact = str(input.contact_person, 120);
  const phone = str(input.phone, 30);
  const area = str(input.area, 200);
  if (!org || !contact || !phone || !area) throw new PortalError('Fill in organisation, contact person, phone and area.');
  const row = { id: randomUUID(), role, org_name: org, contact_person: contact, phone, area, status: 'new', created_at: nowIso() };
  const db = dbUsable();
  let stored = false;
  if (db) {
    try {
      const { error } = await withTimeout(db.from('portal_org_requests').insert(row), 4000);
      if (error) throw new Error(error.message);
      stored = true;
    } catch {
      tripBreaker();
    }
  }
  if (!stored) memOrgRequests.push(row);
  return {
    requested: true,
    request_id: row.id,
    message: `Thank you. A MediCheck team member will call ${contact} at ${phone} to verify ${org} before the account is activated.`,
  };
}

export function listOrgRequestsForTests(): Array<Record<string, unknown>> {
  return memOrgRequests;
}

// =============================================================================
// Proof file storage
// =============================================================================

const memProofs = new Map<string, { buf: Buffer; type: string }>();
const ALLOWED_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv'];
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export async function storeProof(input: { filename?: unknown; content_base64?: unknown; content_type?: unknown; folder?: unknown }): Promise<{ url: string; filename: string; bytes: number }> {
  const type = str(input.content_type, 80).toLowerCase() || 'application/octet-stream';
  if (!ALLOWED_PROOF_TYPES.includes(type)) throw new PortalError('Only JPG, PNG, WebP, PDF or CSV files can be uploaded.');
  const b64 = String(input.content_base64 ?? '').replace(/^data:[^,]*,/, '');
  if (!b64) throw new PortalError('No file content received.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new PortalError('The uploaded file is empty.');
  if (buf.length > MAX_PROOF_BYTES) throw new PortalError('File is too large (5 MB maximum).', 413);
  const ext = type === 'application/pdf' ? 'pdf' : type === 'text/csv' ? 'csv' : type.split('/')[1];
  const filename = (str(input.filename, 100).replace(/[^a-zA-Z0-9._-]/g, '_') || 'proof') + '';
  const folder = str(input.folder, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'proofs';
  const path = `${folder}/${Date.now()}-${randomBytes(4).toString('hex')}-${filename.replace(/\.[a-z0-9]+$/i, '')}.${ext}`;

  const db = dbUsable();
  if (db) {
    try {
      const { error } = await withTimeout(db.storage.from('evidence_proofs').upload(path, buf, { contentType: type, upsert: false }), 8000);
      if (error) throw new Error(error.message);
      const { data } = db.storage.from('evidence_proofs').getPublicUrl(path);
      return { url: data.publicUrl, filename, bytes: buf.length };
    } catch {
      tripBreaker();
    }
  }
  const id = randomBytes(12).toString('hex');
  memProofs.set(id, { buf, type });
  return { url: `/api/proof/${id}`, filename, bytes: buf.length };
}

export function readProof(id: string): { buf: Buffer; type: string } | null {
  return memProofs.get(id) ?? null;
}

// =============================================================================
// HTTP handler (shared by scripts/serve.ts and api/index.ts)
// =============================================================================

export interface PortalRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  authorization?: string | null;
}

export interface PortalResponse {
  status: number;
  json?: unknown;
  binary?: Buffer;
  contentType?: string;
}

export interface PortalDeps {
  /** Optional: seal citizen reports into the tamper-evident Supabase public_log. */
  sealReport?: (r: ReturnType<typeof validateReportInput>) => Promise<string | null>;
}

const ok = (json: unknown): PortalResponse => ({ status: 200, json });

function needRole(actor: Actor | null, ...roles: PortalRole[]): Actor {
  if (!actor) throw new PortalError('Please log in first.', 401);
  if (!roles.includes(actor.role)) throw new PortalError('Your account type cannot do this.', 403);
  return actor;
}

export async function handlePortalRequest(req: PortalRequest, deps: PortalDeps = {}): Promise<PortalResponse | null> {
  const p = req.pathname;
  if (!p.startsWith('/api/portal/') && !p.startsWith('/api/proof/')) return null;

  try {
    const actor = verifyToken(req.authorization);

    if (req.method === 'GET' && p.startsWith('/api/proof/')) {
      const f = readProof(p.slice('/api/proof/'.length));
      if (!f) return { status: 404, json: { error: 'File not found' } };
      return { status: 200, binary: f.buf, contentType: f.type };
    }

    // ---- public auth endpoints ------------------------------------------------
    if (req.method === 'POST' && p === '/api/portal/login') {
      return ok(await loginAccount(req.body.role, req.body.identifier, req.body.password));
    }
    if (req.method === 'POST' && p === '/api/portal/register') {
      return ok(await registerCitizenAccount(req.body));
    }
    if (req.method === 'POST' && p === '/api/portal/org-request') {
      return ok(await requestOrgAccount(req.body));
    }
    if (req.method === 'GET' && p === '/api/portal/me') {
      if (!actor) return { status: 401, json: { error: 'Not logged in' } };
      return ok({ user_id: actor.user_id, role: actor.role, display_name: actor.display_name });
    }

    // ---- public read endpoints ------------------------------------------------
    if (req.method === 'GET' && p === '/api/portal/state') {
      const state = await loadState();
      return ok(publicView(state, actor?.user_id ?? null));
    }
    if (req.method === 'GET' && p === '/api/portal/area') {
      const state = await loadState();
      const lat = req.query.get('lat') ? Number(req.query.get('lat')) : NaN;
      const lon = req.query.get('lon') ? Number(req.query.get('lon')) : NaN;
      const radius = req.query.get('radius_km') ? Number(req.query.get('radius_km')) : NaN;
      const result = searchArea(state, {
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        radiusKm: Number.isFinite(radius) ? radius : null,
        q: req.query.get('q'),
      });
      return ok({
        ...(publicView({ ...state, reports: result.reports } as PortalState, actor?.user_id ?? null) as object),
        pharmacies: result.pharmacies,
        radius_km: result.radius_km,
        center: result.center,
      });
    }

    // ---- authenticated actions --------------------------------------------------
    if (req.method === 'POST' && p === '/api/portal/upload') {
      needRole(actor, 'citizen', 'pharmacy', 'gov');
      return ok(await storeProof(req.body));
    }

    const state = await loadState();
    let result: unknown;

    if (req.method === 'POST' && p === '/api/portal/reports') {
      const a = needRole(actor, 'citizen');
      const v = validateReportInput(req.body);
      let sealed: string | null = null;
      if (deps.sealReport) {
        try {
          sealed = await deps.sealReport(v);
        } catch {
          sealed = null;
        }
      }
      const rep = fileReport(state, a, { ...req.body, sealed_report_id: sealed });
      await saveState(state);
      result = { submitted: true, reportId: rep.id, sealed: Boolean(sealed) };
    } else if (req.method === 'POST' && p === '/api/portal/reports/respond') {
      pharmacyRespond(state, needRole(actor, 'pharmacy'), { report_id: req.body.report_id, text: req.body.text, proof_url: req.body.proof_url });
      await saveState(state);
      result = { ok: true };
    } else if (req.method === 'POST' && p === '/api/portal/reports/corrected') {
      markCorrected(state, needRole(actor, 'pharmacy'), { report_id: req.body.report_id });
      await saveState(state);
      result = { ok: true };
    } else if (req.method === 'POST' && p === '/api/portal/reports/gov-update') {
      govUpdate(state, needRole(actor, 'gov'), {
        report_id: req.body.report_id,
        status: req.body.status,
        note: req.body.note,
        proof_urls: req.body.proof_urls,
      });
      await saveState(state);
      result = { ok: true };
    } else if (req.method === 'POST' && p === '/api/portal/pharmacy/submit') {
      submitVerification(state, needRole(actor, 'pharmacy'), {
        period: req.body.period,
        barcodes: req.body.barcodes,
        notes: req.body.notes,
        stock_proof_url: req.body.stock_proof_url,
        billing_proof_url: req.body.billing_proof_url,
      });
      await saveState(state);
      result = { ok: true };
    } else if (req.method === 'POST' && p === '/api/portal/pharmacy/review') {
      reviewVerification(state, needRole(actor, 'gov'), { action: req.body.action, note: req.body.note });
      await saveState(state);
      result = { ok: true };
    } else if (req.method === 'POST' && p === '/api/portal/reset') {
      needRole(actor, 'citizen', 'pharmacy', 'gov');
      const fresh = await resetState();
      return ok({ reset: true, state: publicView(fresh, actor?.user_id ?? null) });
    } else {
      return { status: 404, json: { error: `Unknown portal route ${req.method} ${p}` } };
    }

    return ok({ ...(result as object), state: publicView(await loadState(), actor?.user_id ?? null) });
  } catch (e) {
    if (e instanceof PortalError) return { status: e.status, json: { error: e.message } };
    return { status: 500, json: { error: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * Builds the optional "seal into the tamper-evident public log" hook from a MediCheck SDK client.
 * Best effort: returns null (report still saved in the portal) if Supabase is unreachable or slow.
 */
export function makeSealer(sdk: { submitReport: (input: any) => Promise<{ reportId: string }> } | null): PortalDeps['sealReport'] {
  if (!sdk || process.env.PORTAL_SKIP_SEAL === '1') return undefined;
  return async (v) => {
    const typeMap: Record<IssueType, string> = { overpriced: 'sold_above_mrp', stock: 'out_of_stock', expired: 'suspect_batch_or_pack' };
    const parts = v.address.split(',').map((s) => s.trim()).filter(Boolean);
    const pin = (v.address.match(/\b\d{6}\b/) ?? [null])[0];
    const res = await withTimeout(
      sdk.submitReport({
        pharmacy_name: v.pharmacy,
        pharmacy_licence_no: v.licence_no,
        report_type: typeMap[v.issue_type],
        description: v.notes || `${v.medicine}: ${v.issue_type} (billed ${v.billed} vs MRP ${v.mrp}) at ${v.pharmacy}, ${v.address}`,
        area: parts[0] ?? null,
        city: parts.length > 1 ? parts[parts.length - 1].replace(/\b\d{6}\b/, '').trim() || null : null,
        pincode: pin,
      }),
      3500
    );
    return res.reportId;
  };
}
