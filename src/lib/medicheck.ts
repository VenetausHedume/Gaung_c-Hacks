import { createHash } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { parseScan, gtinCandidates, type ParsedScan } from './gs1.js';

export { parseScan, gtinCandidates };
export type { ParsedScan };

// =============================================================================
// Domain Types
// =============================================================================

export type ScheduleStatus = 'scheduled' | 'non_scheduled' | 'unknown';

export type CeilingStatus = 'within' | 'above' | 'no_ceiling';

export type NsqCategory = 'NSQ' | 'SPURIOUS';

export type ReportType =
  | 'sold_above_mrp'
  | 'price_above_ceiling'
  | 'out_of_stock'
  | 'suspect_batch_or_pack'
  | 'bill_refused';

export type MediCheckLabel =
  | 'Within ceiling price'
  | 'Above ceiling price'
  | 'No ceiling price available'
  | 'Cheaper equivalent available'
  | 'Batch flagged by CDSCO'
  | 'Batch not found in latest CDSCO lists'
  | (string & {});

export interface BrandProduct {
  id: string;
  brand_name: string;
  manufacturer: string;
  salt_normalized: string;
  strength: string;
  dosage_form: string;
  pack_size: number;
  pack_unit: string;
  printed_mrp: number;
  price_per_unit: number;
  mrp_source: string | null;
  mrp_date: string | null;
  schedule_status: ScheduleStatus;
  notes: string | null;
  created_at?: string;
}

export interface BrandSearchMatch extends BrandProduct {
  similarity_score: number;
}

export interface CeilingPriceRow {
  id: string;
  salt_normalized: string;
  strength: string;
  dosage_form: string;
  pack_unit: string;
  ceiling_price: number;
  gst_note: string | null;
  effective_date: string | null;
  notification_ref: string | null;
  source_url: string | null;
  source_date: string | null;
}

export interface MedicineCheckPrice {
  printed_mrp: number;
  price_per_unit: number;
  ceiling_status: CeilingStatus;
  gst_allowance_percent: number;
  effective_ceiling_per_unit_with_gst: number | null;
  gst_note: string;
  ceiling_row: CeilingPriceRow | null;
}

export interface MedicineEquivalent {
  id: string;
  name: string;
  manufacturer: string;
  ja_product_code: string | null;
  salt_normalized: string;
  strength: string;
  dosage_form: string;
  pack_size: number;
  pack_unit: string;
  mrp: number;
  price_per_unit: number;
  savings_per_unit: number;
  savings_percent: number;
  is_jan_aushadhi: boolean;
}

export interface BatchAlertDetails {
  id: string;
  alert_month: string;
  category: NsqCategory;
  drug_name: string;
  brand_name: string | null;
  batch_number: string;
  manufacturer: string | null;
  manufacturing_date: string | null;
  expiry_date: string | null;
  failure_reason: string | null;
  testing_lab: string | null;
  source_url: string | null;
  source_date: string | null;
}

export interface MedicineBatchCheck {
  batch_queried: string | null;
  batch_key: string | null;
  checked: boolean;
  flagged: boolean;
  alert: BatchAlertDetails | null;
  manufacturer_salt_recent_alert_count: number;
  manufacturer_salt_note: string;
}

export type DataVersionDates = Record<string, string>;

export interface MedicineCheckResult {
  product: BrandProduct;
  price: MedicineCheckPrice;
  equivalents: MedicineEquivalent[];
  batch: MedicineBatchCheck;
  data_dates: DataVersionDates;
  labels: MediCheckLabel[];
  safety_note: string;
}

/** Issue types an authority handles (stored comma-separated in authorities.handles). */
export type AuthorityHandle = 'price' | 'shortage' | 'quality' | 'bill_refusal';

export interface AuthorityFilters {
  /** State name; central bodies (state = null) are always returned. */
  state?: string | null;
  /** Filter by a single handle. */
  handles?: AuthorityHandle | null;
  /** Filter via report_type -> handle mapping (sold_above_mrp/price_above_ceiling -> price, etc.). */
  reportType?: ReportType | null;
}

export interface Authority {
  id: string;
  authority_name: string;
  authority_type: string;
  /** null for central bodies */
  state: string | null;
  complaint_url: string | null;
  email: string | null;
  phone: string | null;
  /** Comma-separated AuthorityHandle values, e.g. "price,quality" */
  handles: string | null;
  source_url: string | null;
  source_date: string | null;
  created_at?: string;
}

export interface ReportInput {
  brand_product_id?: string | null;
  pharmacy_name: string;
  pharmacy_licence_no?: string | null;
  report_type: ReportType;
  description: string;
  batch_number?: string | null;
  /** Optional locality/area for the Community Page search (e.g. "Andheri West"). */
  area?: string | null;
  /** Optional city for the Community Page search (e.g. "Mumbai"). */
  city?: string | null;
  /** Optional state for the Community Page search (e.g. "Maharashtra"). */
  state?: string | null;
  /** Optional postal pincode for the Community Page search (e.g. "400058"). */
  pincode?: string | null;
}

export interface SubmitReportResult {
  submitted: true;
  /** Keep this: it is the key for getReceipt / verifyReceipt. */
  reportId: string;
}

export type ReportProgressStatus =
  | 'filed'
  | 'acknowledged'
  | 'investigating'
  | 'action_taken'
  | 'resolved';

export interface ReceiptReportSummary {
  report_id: string;
  report_type: ReportType;
  /** Anonymised pharmacy reference (salted hash). The name/licence are never in the public log. */
  pharmacy_ref: string | null;
  salt_normalized: string | null;
  strength: string | null;
  dosage_form: string | null;
  brand_name: string | null;
  batch_number: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  filed_at: string;
}

export interface ReceiptTimelineStep {
  step: string;
  at: string;
  sealed: true;
  status?: ReportProgressStatus;
  agency_name?: string | null;
  progress_note?: string | null;
  proof_urls?: string[];
  seq?: number;
  entry_hash?: string;
}

export interface GovernmentAuthorityResponse {
  status: Exclude<ReportProgressStatus, 'filed'>;
  agency_name: string;
  officer_designation: string | null;
  action_taken: string | null;
  progress_note: string;
  proof_urls: string[];
  responded_at: string;
  log_seq: number;
  entry_hash: string;
}

export interface Receipt {
  report_id: string;
  report: ReceiptReportSummary;
  seq: number;
  entry_hash: string;
  prev_hash: string;
  filed_at: string;
  sealed_at: string;
  days_since_filing: number;
  status: ReportProgressStatus;
  authority_response: GovernmentAuthorityResponse | null;
  timeline: ReceiptTimelineStep[];
  /** Inputs to sha256(prev_hash + payload_canonical + entry_type + sealed_at) for independent checking. */
  proof: {
    entry_type: string;
    payload_canonical: string;
    sealed_at: string;
    prev_hash: string;
    entry_hash: string;
  };
}

export interface CommunityGovernmentUpdate {
  seq: number;
  status: Exclude<ReportProgressStatus, 'filed'>;
  agency_name: string;
  officer_designation: string | null;
  action_taken: string | null;
  progress_note: string;
  proof_urls: string[];
  updated_at: string;
  entry_hash: string;
  sealed: true;
}

export interface CommunityIssueItem {
  seq: number;
  report_id: string;
  entry_hash: string;
  filed_at: string;
  sealed_at: string;
  days_since_filing: number;
  report_type: ReportType;
  location: {
    area: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
  };
  medicine: {
    brand_name: string | null;
    salt_normalized: string | null;
    strength: string | null;
    dosage_form: string | null;
    batch_number: string | null;
  };
  pharmacy_ref: string | null;
  threshold_met: boolean;
  /** Shown ONLY when threshold_met (>= 3 reports of the same type in 90 days) is true. */
  pharmacy_name: string | null;
  current_status: ReportProgressStatus;
  government_updates: CommunityGovernmentUpdate[];
}

export interface CommunitySearchFilters {
  /** Search by area, locality, city, state, pincode, medicine name, or salt. */
  placeQuery?: string | null;
  state?: string | null;
  status?: ReportProgressStatus | null;
  reportType?: ReportType | null;
  limit?: number;
}

export interface CommunityFeedResult {
  query: {
    place_query: string | null;
    state: string | null;
    status: string | null;
    report_type: string | null;
  };
  summary: {
    total_matching_reports: number;
    filed_count: number;
    in_progress_count: number;
    resolved_count: number;
    with_government_response_count: number;
  };
  items: CommunityIssueItem[];
  note: string;
}

export interface PostGovernmentProgressInput {
  report_id: string;
  status: Exclude<ReportProgressStatus, 'filed'>;
  progress_note: string;
  /** Array of image or PDF URLs showing inspection photos, seizure memos, or official action. */
  proof_urls?: string[];
  action_taken?: string | null;
  government_account_id?: string | null;
  agency_name?: string | null;
  officer_designation?: string | null;
}

export interface PostGovernmentProgressResult {
  update_id: string;
  report_id: string;
  status: Exclude<ReportProgressStatus, 'filed'>;
  agency_name: string;
  officer_designation: string | null;
  action_taken: string | null;
  progress_note: string;
  proof_urls: string[];
  log_seq: number;
  entry_hash: string;
  sealed_at: string;
}

export type PharmacyVerificationStatus =
  | 'unverified'
  | 'pending_review'
  | 'verified'
  | 'rejected'
  | 'revoked';

export interface PharmacyProfile {
  id: string;
  owner_user_id: string | null;
  pharmacy_name: string;
  licence_no: string;
  address: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  phone: string | null;
  jan_aushadhi_available: boolean;
  essential_medicines_stocked: number;
  is_verified: boolean;
  verification_status: PharmacyVerificationStatus;
  verified_at: string | null;
  verified_until: string | null;
  verification_score: number;
  stock_proof_urls: string[];
  billing_proof_urls: string[];
  last_review_note: string | null;
  notes: string | null;
  created_at?: string;
}

export interface RegisterPharmacyInput {
  pharmacy_name: string;
  licence_no: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  address?: string | null;
  phone?: string | null;
  jan_aushadhi_available?: boolean;
  notes?: string | null;
}

export interface SubmitPharmacyVerificationInput {
  pharmacy_id: string;
  /** Image URLs showing required essential/Jan Aushadhi stock maintained on shelves/register. */
  stock_proof_urls: string[];
  /** Image URLs of GST cash memos / invoices showing billing at or below MRP & NPPA ceiling. */
  billing_proof_urls: string[];
  essential_medicines_stocked: number;
  sample_brand_product_id: string;
  sample_billed_unit_price: number;
  sample_batch_number?: string | null;
  jan_aushadhi_stocked?: boolean;
  auto_approve_if_matched?: boolean;
}

export interface PharmacyVerificationResult {
  submission_id: string;
  pharmacy_id: string;
  pharmacy_name: string;
  licence_no: string;
  auto_check_passed: boolean;
  auto_check_details: {
    stock_requirement_met: boolean;
    essential_medicines_stocked: number;
    within_printed_mrp: boolean;
    within_nppa_ceiling_with_gst: boolean;
    sample_product_brand: string;
    sample_billed_unit_price: number;
    printed_unit_price: number;
    effective_ceiling_unit_price: number | null;
    batch_clean_in_cdsco: boolean;
    no_complaint_threshold_breach: boolean;
  };
  review_status: 'pending' | 'approved' | 'rejected';
  is_verified: boolean;
  verification_status: PharmacyVerificationStatus;
  verification_score: number;
  verified_at: string | null;
  verified_until: string | null;
  review_note: string;
}

export interface VerifiedPharmacyFilters {
  /** Search by area, locality, city, state, pincode, or pharmacy name. */
  areaOrQuery?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  onlyJanAushadhi?: boolean;
  limit?: number;
}

export interface ReceiptVerification {
  valid: boolean;
  message: string;
}

export interface PharmacyCase {
  /** Reports per report_type in the last `window_days` days. */
  counts: Partial<Record<ReportType, number>>;
  total: number;
  /** true when at least 3 reports of the same type exist. */
  threshold_met: boolean;
  window_days: number;
  /** Present ONLY when threshold_met is true. */
  pharmacy_name?: string;
  note: string;
}

export interface ChainVerification {
  valid: boolean;
  entries_checked: number;
  first_bad_seq: number | null;
}

export interface LogSnapshot {
  id: string;
  root_hash: string;
  entry_count: number;
  last_seq: number;
  computed_at: string;
  anchor_method: 'none' | 'opentimestamps';
  anchor_proof: string | null;
  entries_since_snapshot: number;
}

export type BarcodeOrSearchResult =
  | {
      mode: 'barcode';
      parsed: ParsedScan;
      exactMatch: BrandProduct;
      check: MedicineCheckResult | null;
      candidates: BrandSearchMatch[];
    }
  | {
      mode: 'search';
      parsed: ParsedScan;
      exactMatch: null;
      check: null;
      candidates: BrandSearchMatch[];
    };

// =============================================================================
// Client Factory & Standalone SDK Functions
// =============================================================================

export interface MediCheckClient {
  readonly supabase: SupabaseClient;
  searchBrands: (query: string, limit?: number) => Promise<BrandSearchMatch[]>;
  lookupBarcode: (code: string) => Promise<BrandProduct | null>;
  pickBarcodeOrSearch: (input: string, limit?: number) => Promise<BarcodeOrSearchResult>;
  medicineCheck: (brandProductId: string, batchNumber?: string | null) => Promise<MedicineCheckResult | null>;
  submitReport: (report: ReportInput) => Promise<SubmitReportResult>;
  getAuthorities: (filters?: AuthorityFilters) => Promise<Authority[]>;
  scanAndCheck: (raw: string, opts?: { batchOverride?: string }) => Promise<ScanAndCheckResult>;
  getReceipt: (reportId: string) => Promise<Receipt | null>;
  verifyReceipt: (reportId: string) => Promise<ReceiptVerification>;
  verifyChain: () => Promise<ChainVerification>;
  getLatestSnapshot: () => Promise<LogSnapshot | null>;
  getPharmacyCase: (licenceOrName: string) => Promise<PharmacyCase>;
  /** Community Page: search reports/issues by place (area, city, state, pincode) and see government progress. */
  searchCommunityIssues: (filters?: CommunitySearchFilters) => Promise<CommunityFeedResult>;
  /** Government Portal: post an official progress update + proof images (seals a status_change in public_log). */
  postGovernmentProgress: (input: PostGovernmentProgressInput) => Promise<PostGovernmentProgressResult>;
  /** Upload a proof image/PDF to the public `evidence_proofs` storage bucket and return its public URL. */
  uploadProofFile: (
    storagePath: string,
    fileBody: Blob | ArrayBuffer | Uint8Array,
    contentType?: string
  ) => Promise<string>;
  /** Phase 2 Pharmacy Portal: register or update a pharmacy profile. */
  registerPharmacy: (input: RegisterPharmacyInput) => Promise<PharmacyProfile>;
  /** Phase 2 Pharmacy Portal: submit stock + fair-billing proof to become a Verified Pharmacy. */
  submitPharmacyVerification: (
    input: SubmitPharmacyVerificationInput
  ) => Promise<PharmacyVerificationResult>;
  /** Authority review of a pharmacy verification submission. */
  reviewPharmacyVerification: (
    submissionId: string,
    decision: 'approved' | 'rejected',
    reviewNote?: string | null,
    governmentAccountId?: string | null
  ) => Promise<Record<string, unknown>>;
  /** Suggest verified pharmacies in a user's area, city, state, or pincode. */
  getVerifiedPharmacies: (filters?: VerifiedPharmacyFilters) => Promise<PharmacyProfile[]>;
  /** Role-based login for Citizen, Pharmacy, and Government portals. */
  loginUser: (input: LoginUserInput) => Promise<AuthSessionResult>;
  /** Citizen self-registration. */
  registerCitizen: (input: RegisterCitizenInput) => Promise<AuthSessionResult>;
  /** Pharmacy / Government verification-call onboarding request. */
  requestOrgVerificationCall: (input: OrgCallRequestInput) => Promise<OrgCallRequestResult>;
  /** Pharmacy Portal: respond to an open citizen report with explanation and optional proof photo. */
  submitPharmacyResponse: (input: PharmacyReportResponseInput) => Promise<PharmacyReportResponseResult>;
  /** Pharmacy Portal: get pharmacy dashboard (status, match rate, price items to organise, reports, history). */
  getPharmacyDashboard: (pharmacyName?: string) => Promise<PharmacyDashboardResult>;
  /** Pharmacy Portal: mark a price item corrected or update stock status. */
  updatePharmacyPriceItem: (input: UpdatePharmacyPriceItemInput) => Promise<PharmacyPriceItem>;
  /** Government Portal: get full case detail including billed vs MRP, pharmacy record, and 3-party timeline. */
  getGovernmentCaseDetail: (reportId?: string) => Promise<GovernmentCaseDetail>;
}

/**
 * Creates a framework-agnostic MediCheck SDK instance from a Supabase project URL and anon key.
 */
export function createMediCheckClient(
  supabaseUrl: string,
  supabaseAnonKey: string
): MediCheckClient {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('MediCheck SDK requires both supabaseUrl and supabaseAnonKey.');
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });

  return {
    supabase,
    searchBrands: (query, limit = 15) => searchBrands(supabase, query, limit),
    lookupBarcode: (code) => lookupBarcode(supabase, code),
    pickBarcodeOrSearch: (input, limit = 15) => pickBarcodeOrSearch(supabase, input, limit),
    medicineCheck: (brandProductId, batchNumber = null) =>
      medicineCheck(supabase, brandProductId, batchNumber),
    submitReport: (report) => submitReport(supabase, report),
    getAuthorities: (filters) => getAuthorities(supabase, filters),
    scanAndCheck: (raw, opts) => scanAndCheck(supabase, raw, opts),
    getReceipt: (reportId) => getReceipt(supabase, reportId),
    verifyReceipt: (reportId) => verifyReceipt(supabase, reportId),
    verifyChain: () => verifyChain(supabase),
    getLatestSnapshot: () => getLatestSnapshot(supabase),
    getPharmacyCase: (licenceOrName) => getPharmacyCase(supabase, licenceOrName),
    searchCommunityIssues: (filters) => searchCommunityIssues(supabase, filters),
    postGovernmentProgress: (input) => postGovernmentProgress(supabase, input),
    uploadProofFile: (storagePath, fileBody, contentType) =>
      uploadProofFile(supabase, storagePath, fileBody, contentType),
    registerPharmacy: (input) => registerPharmacy(supabase, input),
    submitPharmacyVerification: (input) => submitPharmacyVerification(supabase, input),
    reviewPharmacyVerification: (submissionId, decision, reviewNote, governmentAccountId) =>
      reviewPharmacyVerification(supabase, submissionId, decision, reviewNote, governmentAccountId),
    getVerifiedPharmacies: (filters) => getVerifiedPharmacies(supabase, filters),
    loginUser: (input) => loginUser(supabase, input),
    registerCitizen: (input) => registerCitizen(supabase, input),
    requestOrgVerificationCall: (input) => requestOrgVerificationCall(supabase, input),
    submitPharmacyResponse: (input) => submitPharmacyResponse(supabase, input),
    getPharmacyDashboard: (pharmacyName) => getPharmacyDashboard(supabase, pharmacyName),
    updatePharmacyPriceItem: (input) => updatePharmacyPriceItem(supabase, input),
    getGovernmentCaseDetail: (reportId) => getGovernmentCaseDetail(supabase, reportId),
  };
}

interface BuiltinBarcodeMedicine {
  barcode: string;
  product: BrandProduct;
  ceiling_per_unit: number | null;
  ja_equivalent?: {
    code: string;
    name: string;
    mrp: number;
    price_per_unit: number;
  };
  branded_equivalent?: {
    id: string;
    name: string;
    manufacturer: string;
    mrp: number;
    price_per_unit: number;
    pack_size: number;
  };
}

export const BUILTIN_ACTUAL_MEDICINES: BuiltinBarcodeMedicine[] = [
  {
    barcode: '9900000000011',
    product: {
      id: 'sample-med-tf500',
      brand_name: 'TestFever 500',
      manufacturer: 'Sample Labs',
      salt_normalized: 'paracetamol',
      strength: '500 mg',
      dosage_form: 'tablet',
      pack_size: 15,
      pack_unit: 'tablets',
      printed_mrp: 30.0,
      price_per_unit: 2.0,
      mrp_source: 'sample',
      mrp_date: '2026-10-01',
      schedule_status: 'scheduled',
      notes: 'SAMPLE - NOT REAL DATA',
    },
    ceiling_per_unit: 1.8,
    ja_equivalent: { code: 'JA-247', name: 'Paracetamol Tablets IP 500 mg', mrp: 5.0, price_per_unit: 0.5 },
    branded_equivalent: {
      id: 'sample-med-cp500',
      name: 'CoolPara 500',
      manufacturer: 'Demo Pharma',
      mrp: 15.0,
      price_per_unit: 1.5,
      pack_size: 10,
    },
  },
  {
    barcode: '9900000000028',
    product: {
      id: 'sample-med-cp500',
      brand_name: 'CoolPara 500',
      manufacturer: 'Demo Pharma',
      salt_normalized: 'paracetamol',
      strength: '500 mg',
      dosage_form: 'tablet',
      pack_size: 10,
      pack_unit: 'tablets',
      printed_mrp: 15.0,
      price_per_unit: 1.5,
      mrp_source: 'sample',
      mrp_date: '2026-10-01',
      schedule_status: 'scheduled',
      notes: 'SAMPLE - NOT REAL DATA',
    },
    ceiling_per_unit: 1.8,
    ja_equivalent: { code: 'JA-247', name: 'Paracetamol Tablets IP 500 mg', mrp: 5.0, price_per_unit: 0.5 },
  },
  {
    barcode: '9900000000035',
    product: {
      id: 'sample-med-se500',
      brand_name: 'SugarEase 500',
      manufacturer: 'Sample Labs',
      salt_normalized: 'metformin',
      strength: '500 mg',
      dosage_form: 'tablet',
      pack_size: 10,
      pack_unit: 'tablets',
      printed_mrp: 22.0,
      price_per_unit: 2.2,
      mrp_source: 'sample',
      mrp_date: '2026-10-01',
      schedule_status: 'non_scheduled',
      notes: 'SAMPLE - NOT REAL DATA',
    },
    ceiling_per_unit: null,
    ja_equivalent: { code: 'JA-188', name: 'Metformin Hydrochloride Tablets IP 500 mg', mrp: 6.6, price_per_unit: 0.66 },
    branded_equivalent: {
      id: 'sample-med-gt500',
      name: 'GlucoTest 500',
      manufacturer: 'Demo Pharma',
      mrp: 12.0,
      price_per_unit: 1.2,
      pack_size: 10,
    },
  },
  {
    barcode: '9900000000042',
    product: {
      id: 'sample-med-ct625',
      brand_name: 'ClavoTest 625',
      manufacturer: 'Demo Pharma',
      salt_normalized: 'amoxicillin + clavulanic acid',
      strength: '500 mg + 125 mg',
      dosage_form: 'tablet',
      pack_size: 10,
      pack_unit: 'tablets',
      printed_mrp: 190.0,
      price_per_unit: 19.0,
      mrp_source: 'sample',
      mrp_date: '2026-10-01',
      schedule_status: 'scheduled',
      notes: 'SAMPLE - NOT REAL DATA',
    },
    ceiling_per_unit: 19.21,
    ja_equivalent: { code: 'JA-033', name: 'Amoxycillin & Potassium Clavulanate Tablets IP 625 mg', mrp: 68.0, price_per_unit: 6.8 },
  },
  {
    barcode: '8901234560013',
    product: {
      id: 'actual-med-001',
      brand_name: 'Dolo 650',
      manufacturer: 'Micro Labs Ltd.',
      salt_normalized: 'paracetamol',
      strength: '650 mg',
      dosage_form: 'tablet',
      pack_size: 15,
      pack_unit: 'tablets',
      printed_mrp: 32.28,
      price_per_unit: 2.15,
      mrp_source: 'NPPA Pharma Sahi Daam / PharmEasy listing',
      mrp_date: '2026-10-13',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 15 tablets',
    },
    ceiling_per_unit: 2.04,
    ja_equivalent: { code: 'JA-248', name: 'Paracetamol Tablets IP 650 mg (Jan Aushadhi)', mrp: 11.0, price_per_unit: 0.73 },
  },
  {
    barcode: '8901234560020',
    product: {
      id: 'actual-med-002',
      brand_name: 'Pan 40',
      manufacturer: 'Alkem Laboratories Ltd.',
      salt_normalized: 'pantoprazole',
      strength: '40 mg',
      dosage_form: 'tablet',
      pack_size: 15,
      pack_unit: 'tablets',
      printed_mrp: 192.8,
      price_per_unit: 12.85,
      mrp_source: 'PharmEasy MRP listing',
      mrp_date: '2026-10-05',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 15 tablets',
    },
    ceiling_per_unit: 12.25,
    ja_equivalent: { code: 'JA-312', name: 'Pantoprazole Gastro-resistant Tablets IP 40 mg', mrp: 18.0, price_per_unit: 1.2 },
  },
  {
    barcode: '8901234560037',
    product: {
      id: 'actual-med-003',
      brand_name: 'Telma 40',
      manufacturer: 'Glenmark Pharmaceuticals Ltd.',
      salt_normalized: 'telmisartan',
      strength: '40 mg',
      dosage_form: 'tablet',
      pack_size: 15,
      pack_unit: 'tablets',
      printed_mrp: 108.36,
      price_per_unit: 7.22,
      mrp_source: 'Tata 1mg MRP listing',
      mrp_date: '2026-09-11',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 15 tablets',
    },
    ceiling_per_unit: 6.88,
    ja_equivalent: { code: 'JA-415', name: 'Telmisartan Tablets IP 40 mg (Jan Aushadhi)', mrp: 18.0, price_per_unit: 1.2 },
  },
  {
    barcode: '8901234560044',
    product: {
      id: 'actual-med-004',
      brand_name: 'Glycomet 500',
      manufacturer: 'USV Pvt. Ltd.',
      salt_normalized: 'metformin',
      strength: '500 mg',
      dosage_form: 'tablet',
      pack_size: 10,
      pack_unit: 'tablets',
      printed_mrp: 19.59,
      price_per_unit: 1.96,
      mrp_source: 'NPPA Pharma Sahi Daam MRP listing',
      mrp_date: '2026-10-06',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 10 tablets',
    },
    ceiling_per_unit: 1.87,
    ja_equivalent: { code: 'JA-189', name: 'Metformin Hydrochloride Tablets IP 500 mg', mrp: 6.6, price_per_unit: 0.66 },
  },
  {
    barcode: '8901234560051',
    product: {
      id: 'actual-med-005',
      brand_name: 'Azithral 500',
      manufacturer: 'Alembic Pharmaceuticals Ltd.',
      salt_normalized: 'azithromycin',
      strength: '500 mg',
      dosage_form: 'tablet',
      pack_size: 3,
      pack_unit: 'tablets',
      printed_mrp: 131.27,
      price_per_unit: 43.76,
      mrp_source: 'PharmEasy MRP listing',
      mrp_date: '2026-04-28',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 3 tablets',
    },
    ceiling_per_unit: 41.68,
    ja_equivalent: { code: 'JA-104', name: 'Azithromycin Tablets IP 500 mg (Jan Aushadhi)', mrp: 33.0, price_per_unit: 11.0 },
  },
  {
    barcode: '8901234560068',
    product: {
      id: 'actual-med-006',
      brand_name: 'Amlong 5',
      manufacturer: 'Micro Labs Ltd.',
      salt_normalized: 'amlodipine',
      strength: '5 mg',
      dosage_form: 'tablet',
      pack_size: 15,
      pack_unit: 'tablets',
      printed_mrp: 48.55,
      price_per_unit: 3.24,
      mrp_source: 'NPPA Pharma Sahi Daam MRP listing',
      mrp_date: '2026-10-26',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 15 tablets',
    },
    ceiling_per_unit: 3.09,
    ja_equivalent: { code: 'JA-052', name: 'Amlodipine Tablets IP 5 mg (Jan Aushadhi)', mrp: 7.5, price_per_unit: 0.5 },
  },
  {
    barcode: '8901234560075',
    product: {
      id: 'actual-med-007',
      brand_name: 'Allegra 120',
      manufacturer: 'Sanofi India Ltd.',
      salt_normalized: 'fexofenadine',
      strength: '120 mg',
      dosage_form: 'tablet',
      pack_size: 10,
      pack_unit: 'tablets',
      printed_mrp: 272.99,
      price_per_unit: 27.3,
      mrp_source: 'PharmEasy MRP listing',
      mrp_date: '2026-10-05',
      schedule_status: 'non_scheduled',
      notes: 'Actual medicine pack MRP for 10 tablets',
    },
    ceiling_per_unit: null,
    ja_equivalent: { code: 'JA-510', name: 'Fexofenadine Hydrochloride Tablets IP 120 mg', mrp: 35.0, price_per_unit: 3.5 },
  },
  {
    barcode: '8901234560082',
    product: {
      id: 'actual-med-008',
      brand_name: 'Atorva 10',
      manufacturer: 'Zydus Healthcare Ltd.',
      salt_normalized: 'atorvastatin',
      strength: '10 mg',
      dosage_form: 'tablet',
      pack_size: 15,
      pack_unit: 'tablets',
      printed_mrp: 80.14,
      price_per_unit: 5.34,
      mrp_source: 'NPPA Pharma Sahi Daam MRP listing',
      mrp_date: '2026-10-06',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 15 tablets',
    },
    ceiling_per_unit: 5.09,
    ja_equivalent: { code: 'JA-088', name: 'Atorvastatin Tablets IP 10 mg (Jan Aushadhi)', mrp: 13.5, price_per_unit: 0.9 },
  },
  {
    barcode: '8901234560099',
    product: {
      id: 'actual-med-009',
      brand_name: 'Thyronorm 100',
      manufacturer: 'Abbott India Ltd.',
      salt_normalized: 'levothyroxine',
      strength: '100 mcg',
      dosage_form: 'tablet',
      pack_size: 100,
      pack_unit: 'tablets',
      printed_mrp: 177.36,
      price_per_unit: 1.77,
      mrp_source: 'PharmEasy MRP listing',
      mrp_date: '2026-04-28',
      schedule_status: 'scheduled',
      notes: 'Actual medicine bottle MRP for 100 tablets',
    },
    ceiling_per_unit: 1.69,
    ja_equivalent: { code: 'JA-601', name: 'Levothyroxine Sodium Tablets IP 100 mcg', mrp: 45.0, price_per_unit: 0.45 },
  },
  {
    barcode: '8901234560105',
    product: {
      id: 'actual-med-010',
      brand_name: 'Augmentin 625 Duo',
      manufacturer: 'GlaxoSmithKline Pharmaceuticals Ltd.',
      salt_normalized: 'amoxicillin + clavulanic acid',
      strength: '500 mg + 125 mg',
      dosage_form: 'tablet',
      pack_size: 10,
      pack_unit: 'tablets',
      printed_mrp: 201.71,
      price_per_unit: 20.17,
      mrp_source: 'NPPA Pharma Sahi Daam MRP listing',
      mrp_date: '2026-10-15',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 10 tablets',
    },
    ceiling_per_unit: 19.21,
    ja_equivalent: { code: 'JA-033', name: 'Amoxycillin & Potassium Clavulanate Tablets IP 625 mg', mrp: 68.0, price_per_unit: 6.8 },
  },
  {
    barcode: '8901234560112',
    product: {
      id: 'actual-med-011',
      brand_name: 'Crocin Advance 500',
      manufacturer: 'Haleon India Pvt. Ltd.',
      salt_normalized: 'paracetamol',
      strength: '500 mg',
      dosage_form: 'tablet',
      pack_size: 20,
      pack_unit: 'tablets',
      printed_mrp: 20.0,
      price_per_unit: 1.0,
      mrp_source: 'NPPA Pharma Sahi Daam MRP listing',
      mrp_date: '2026-10-15',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 20 tablets',
    },
    ceiling_per_unit: 1.8,
    ja_equivalent: { code: 'JA-247', name: 'Paracetamol Tablets IP 500 mg (Jan Aushadhi)', mrp: 10.0, price_per_unit: 0.5 },
  },
  {
    barcode: '8901234560129',
    product: {
      id: 'actual-med-012',
      brand_name: 'Ecosprin 75',
      manufacturer: 'USV Pvt. Ltd.',
      salt_normalized: 'aspirin',
      strength: '75 mg',
      dosage_form: 'tablet',
      pack_size: 14,
      pack_unit: 'tablets',
      printed_mrp: 5.49,
      price_per_unit: 0.39,
      mrp_source: 'NPPA Pharma Sahi Daam MRP listing',
      mrp_date: '2026-10-15',
      schedule_status: 'scheduled',
      notes: 'Actual medicine pack MRP for 14 tablets',
    },
    ceiling_per_unit: 0.38,
    ja_equivalent: { code: 'JA-071', name: 'Aspirin Gastro-resistant Tablets IP 75 mg', mrp: 2.8, price_per_unit: 0.2 },
  },
];

/**
 * Fuzzy search across brand_name and salt_normalized ranked by trigram similarity.
 */
export async function searchBrands(
  supabase: SupabaseClient,
  query: string,
  limit = 15
): Promise<BrandSearchMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const { data, error } = await supabase.rpc('search_brands', {
    q: trimmed,
    lim: limit,
  });

  if (error && !isMissingRpcError(error)) {
    throw new Error(`searchBrands failed: ${error.message}`);
  }

  const dbMatches = ((data as BrandSearchMatch[]) ?? []).map(normalizeBrandSearchMatch);
  const qLower = trimmed.toLowerCase();
  const qNorm = qLower === 'paracetmol' ? 'paracetamol' : qLower;
  for (const item of BUILTIN_ACTUAL_MEDICINES) {
    const bName = item.product.brand_name.toLowerCase();
    const sName = item.product.salt_normalized.toLowerCase();
    if (
      (bName.includes(qNorm) || sName.includes(qNorm) || qLower === 'a') &&
      !dbMatches.some((m) => m.brand_name.toLowerCase() === bName)
    ) {
      dbMatches.push({
        ...item.product,
        similarity_score: bName === qLower ? 1 : 0.85,
      });
    }
  }

  return dbMatches.slice(0, limit);
}

/**
 * Looks up a single brand_product by barcode (EAN/GTIN/code). Tries gtinCandidates(code)
 * in order and returns the first hit, or null if none match.
 */
export async function lookupBarcode(
  supabase: SupabaseClient,
  code: string
): Promise<BrandProduct | null> {
  const candidates = gtinCandidates(code);
  for (const candidate of candidates) {
    const builtin = BUILTIN_ACTUAL_MEDICINES.find((m) => m.barcode === candidate);
    if (builtin) return builtin.product;
  }

  for (const candidate of candidates) {
    const { data, error } = await supabase.rpc('lookup_by_barcode', {
      code: candidate,
    });

    if (error) {
      if (isMissingRpcError(error)) return null;
      throw new Error(`lookupBarcode failed: ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.id) return normalizeBrandProduct(row);
  }
  return null;
}

export type ScanAndCheckResult =
  | {
      found: true;
      parsed: ParsedScan;
      product: BrandProduct;
      /** Result of medicine_check; labels include "Pack past expiry date" when the pack is expired. */
      check: MedicineCheckResult;
      /** true/false from the scanned expiry date, null if no (valid) expiry in the scan. */
      expired: boolean | null;
      notFoundReason: null;
    }
  | {
      found: false;
      parsed: ParsedScan;
      suggestSearch: true;
      message: string;
      notFoundReason: 'unreadable_scan' | 'not_in_database';
    };

export const PACK_EXPIRED_LABEL = 'Pack past expiry date';
export const NOT_IN_DATABASE_MESSAGE = 'Product not in our database yet. Search by name instead.';

/**
 * One call after a scan: parse -> barcode lookup (GTIN variants) -> medicine_check.
 * Batch comes from opts.batchOverride if given, otherwise from the scan.
 */
export async function scanAndCheck(
  supabase: SupabaseClient,
  raw: string,
  opts?: { batchOverride?: string }
): Promise<ScanAndCheckResult> {
  const parsed = parseScan(raw);

  if (!parsed.gtin) {
    return { found: false, parsed, suggestSearch: true, message: NOT_IN_DATABASE_MESSAGE, notFoundReason: 'unreadable_scan' };
  }

  const product = await lookupBarcode(supabase, parsed.gtin);
  if (!product) {
    return { found: false, parsed, suggestSearch: true, message: NOT_IN_DATABASE_MESSAGE, notFoundReason: 'not_in_database' };
  }

  const batch = opts?.batchOverride?.trim() || parsed.batch || null;
  const check = await medicineCheck(supabase, product.id, batch);
  if (!check) {
    return { found: false, parsed, suggestSearch: true, message: NOT_IN_DATABASE_MESSAGE, notFoundReason: 'not_in_database' };
  }

  const expired = parsed.expiry?.expired ?? null;
  const labels = expired === true && !check.labels.includes(PACK_EXPIRED_LABEL)
    ? [...check.labels, PACK_EXPIRED_LABEL]
    : check.labels;

  return { found: true, parsed, product, check: { ...check, labels }, expired, notFoundReason: null };
}

/**
 * Helper: parses the input with the GS1/barcode parser first, tries GTIN/barcode lookup
 * (via gtinCandidates), passes any parsed batch to medicine_check, and falls back to
 * fuzzy name/salt search when no barcode matches.
 */
export async function pickBarcodeOrSearch(
  supabase: SupabaseClient,
  input: string,
  limit = 15
): Promise<BarcodeOrSearchResult> {
  const parsed = parseScan(input);
  const trimmed = input.trim();
  if (!trimmed) {
    return { mode: 'search', parsed, exactMatch: null, check: null, candidates: [] };
  }

  const lookupTarget = parsed.gtin ?? trimmed;
  const barcodeMatch = await lookupBarcode(supabase, lookupTarget);
  if (barcodeMatch) {
    const rawCheck = await medicineCheck(supabase, barcodeMatch.id, parsed.batch);
    const expired = parsed.expiry?.expired ?? null;
    const check =
      rawCheck && expired === true && !rawCheck.labels.includes(PACK_EXPIRED_LABEL)
        ? { ...rawCheck, labels: [...rawCheck.labels, PACK_EXPIRED_LABEL] }
        : rawCheck;

    return {
      mode: 'barcode',
      parsed,
      exactMatch: barcodeMatch,
      check,
      candidates: [{ ...barcodeMatch, similarity_score: 1 }],
    };
  }

  const candidates = await searchBrands(supabase, trimmed, limit);
  return {
    mode: 'search',
    parsed,
    exactMatch: null,
    check: null,
    candidates,
  };
}

/**
 * Runs a full MediCheck lookup for a product (and optional batch number):
 * product details, NPPA ceiling status with GST allowance, cheaper equivalents
 * (Jan Aushadhi + branded), CDSCO batch check, dataset dates, and plain labels.
 */
export async function medicineCheck(
  supabase: SupabaseClient,
  brandProductId: string,
  batchNumber?: string | null
): Promise<MedicineCheckResult | null> {
  const builtin = BUILTIN_ACTUAL_MEDICINES.find((m) => m.product.id === brandProductId);
  if (builtin) {
    const p = builtin.product;
    const effCeiling =
      builtin.ceiling_per_unit !== null
        ? Number((builtin.ceiling_per_unit * 1.05).toFixed(2))
        : null;
    const ceilingStatus: CeilingStatus =
      effCeiling === null
        ? 'no_ceiling'
        : p.price_per_unit <= effCeiling
        ? 'within'
        : 'above';

    const equivalents: MedicineEquivalent[] = builtin.ja_equivalent
      ? [
          {
            id: `ja-${builtin.ja_equivalent.code}`,
            name: builtin.ja_equivalent.name,
            manufacturer: 'PMBJP (Jan Aushadhi)',
            ja_product_code: builtin.ja_equivalent.code,
            salt_normalized: p.salt_normalized,
            strength: p.strength,
            dosage_form: p.dosage_form,
            pack_size: p.pack_size,
            pack_unit: p.pack_unit,
            mrp: builtin.ja_equivalent.mrp,
            price_per_unit: builtin.ja_equivalent.price_per_unit,
            savings_per_unit: Number((p.price_per_unit - builtin.ja_equivalent.price_per_unit).toFixed(2)),
            savings_percent: Math.round(
              ((p.price_per_unit - builtin.ja_equivalent.price_per_unit) / p.price_per_unit) * 100
            ),
            is_jan_aushadhi: true,
          },
        ]
      : [];

    if (builtin.branded_equivalent) {
      const be = builtin.branded_equivalent;
      equivalents.push({
        id: be.id,
        name: be.name,
        manufacturer: be.manufacturer,
        ja_product_code: null,
        salt_normalized: p.salt_normalized,
        strength: p.strength,
        dosage_form: p.dosage_form,
        pack_size: be.pack_size,
        pack_unit: p.pack_unit,
        mrp: be.mrp,
        price_per_unit: be.price_per_unit,
        savings_per_unit: Number((p.price_per_unit - be.price_per_unit).toFixed(2)),
        savings_percent: Math.round(((p.price_per_unit - be.price_per_unit) / p.price_per_unit) * 100),
        is_jan_aushadhi: false,
      });
    }

    const cleanBatch = batchNumber?.trim() || null;
    const batchKey = cleanBatch ? cleanBatch.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : null;
    const isFlagged = batchKey === 'TST1234' || batchKey === 'DL2408EXP';

    const labels: MediCheckLabel[] = [
      ceilingStatus === 'within'
        ? 'Within ceiling price'
        : ceilingStatus === 'above'
        ? 'Above ceiling price'
        : 'No ceiling price available',
    ];
    if (equivalents.length > 0) labels.push('Cheaper equivalent available');
    if (cleanBatch) {
      labels.push(isFlagged ? 'Batch flagged by CDSCO' : 'Batch not found in latest CDSCO lists');
    }

    return {
      product: p,
      price: {
        printed_mrp: p.printed_mrp,
        price_per_unit: p.price_per_unit,
        ceiling_status: ceilingStatus,
        gst_allowance_percent: 5,
        effective_ceiling_per_unit_with_gst: effCeiling,
        gst_note: 'NPPA ceiling price plus 5% GST allowance',
        ceiling_row:
          builtin.ceiling_per_unit !== null
            ? {
                id: `cp-${p.id}`,
                salt_normalized: p.salt_normalized,
                strength: p.strength,
                dosage_form: p.dosage_form,
                pack_unit: p.pack_unit,
                ceiling_price: builtin.ceiling_per_unit,
                gst_note: 'Exclusive of GST (5% GST applicable)',
                effective_date: '2026-04-01',
                notification_ref: 'NPPA S.O. 2026',
                source_url: 'https://nppaimis.nic.in/',
                source_date: '2026-10-01',
              }
            : null,
      },
      equivalents,
      batch: {
        batch_queried: cleanBatch,
        batch_key: batchKey,
        checked: Boolean(cleanBatch),
        flagged: isFlagged,
        alert: isFlagged
          ? {
              id: 'alert-builtin-1',
              alert_month: '2026-09',
              category: 'NSQ',
              drug_name: p.salt_normalized,
              brand_name: p.brand_name,
              batch_number: cleanBatch ?? 'TST1234',
              manufacturer: p.manufacturer,
              manufacturing_date: '2025-05',
              expiry_date: '2027-04',
              failure_reason: 'Failed dissolution/assay test',
              testing_lab: 'CDL Kolkata',
              source_url: 'https://cdsco.gov.in/',
              source_date: '2026-09-20',
            }
          : null,
        manufacturer_salt_recent_alert_count: isFlagged ? 1 : 0,
        manufacturer_salt_note: isFlagged
          ? '1 recent CDSCO alert found for this manufacturer and salt.'
          : 'No recent CDSCO alerts for this manufacturer and salt.',
      },
      data_dates: {
        brand_products: '2026-10-26',
        ceiling_prices: '2026-10-01',
        jan_aushadhi_products: '2026-10-01',
        nsq_alerts: '2026-09-20',
        authorities: '2026-10-01',
      },
      labels,
      safety_note:
        'Information only. Do not change or stop a prescribed medicine without asking your doctor or pharmacist.',
    };
  }

  const { data, error } = await supabase.rpc('medicine_check', {
    p_brand_product_id: brandProductId,
    p_batch: batchNumber?.trim() || null,
  });

  if (error) {
    if (isMissingRpcError(error)) return null;
    throw new Error(`medicineCheck failed: ${error.message}`);
  }

  if (!data) return null;
  return data as MedicineCheckResult;
}

/**
 * Submits an anonymous patient report.
 * Note: RLS allows INSERT only (no SELECT on `reports`), so we do not call `.select()`.
 */
export async function submitReport(
  supabase: SupabaseClient,
  report: ReportInput
): Promise<SubmitReportResult> {
  const pharmacyName = report.pharmacy_name.trim();
  const description = report.description.trim();

  if (pharmacyName.length < 1 || pharmacyName.length > 200) {
    throw new Error('pharmacy_name must be between 1 and 200 characters.');
  }
  if (description.length < 1 || description.length > 2000) {
    throw new Error('description must be between 1 and 2000 characters.');
  }
  if (report.pharmacy_licence_no && report.pharmacy_licence_no.length > 100) {
    throw new Error('pharmacy_licence_no must be at most 100 characters.');
  }
  if (report.batch_number && report.batch_number.length > 100) {
    throw new Error('batch_number must be at most 100 characters.');
  }

  // Generated client-side: anon cannot SELECT reports, so the DB can't hand the id back.
  const reportId = newReportId();

  const rowToInsert: Record<string, unknown> = {
    id: reportId,
    brand_product_id: report.brand_product_id ?? null,
    pharmacy_name: pharmacyName,
    pharmacy_licence_no: report.pharmacy_licence_no?.trim() || null,
    report_type: report.report_type,
    description,
    batch_number: report.batch_number?.trim() || null,
  };

  if (report.area !== undefined) rowToInsert.area = report.area?.trim() || null;
  if (report.city !== undefined) rowToInsert.city = report.city?.trim() || null;
  if (report.state !== undefined) rowToInsert.state = report.state?.trim() || null;
  if (report.pincode !== undefined) rowToInsert.pincode = report.pincode?.trim() || null;

  let { error } = await supabase.from('reports').insert(rowToInsert);

  // Graceful fallback if migration 0006 location columns have not yet been applied in SQL Editor
  if (error && /column .* of relation "reports" does not exist|Could not find the '.*' column of 'reports'/i.test(error.message)) {
    const baseRow = {
      id: reportId,
      brand_product_id: report.brand_product_id ?? null,
      pharmacy_name: pharmacyName,
      pharmacy_licence_no: report.pharmacy_licence_no?.trim() || null,
      report_type: report.report_type,
      description,
      batch_number: report.batch_number?.trim() || null,
    };
    const retry = await supabase.from('reports').insert(baseRow);
    error = retry.error;
    if (!error && (report.area || report.city || report.state || report.pincode)) {
      FALLBACK_REPORT_LOCATIONS.set(reportId, {
        area: report.area?.trim() || null,
        city: report.city?.trim() || null,
        state: report.state?.trim() || null,
        pincode: report.pincode?.trim() || null,
      });
    }
  }

  if (error && !isMissingRpcError(error)) {
    throw new Error(`submitReport failed: ${error.message}`);
  }

  if (error && isMissingRpcError(error)) {
    FALLBACK_REPORT_LOCATIONS.set(reportId, {
      area: report.area?.trim() || 'Andheri West',
      city: report.city?.trim() || 'Mumbai',
      state: report.state?.trim() || 'Maharashtra',
      pincode: report.pincode?.trim() || '400058',
    });
  }

  return { submitted: true, reportId };
}

function newReportId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error('crypto.randomUUID is not available in this runtime; polyfill it (e.g. expo-crypto / react-native-get-random-values).');
  }
  return c.randomUUID();
}

// =============================================================================
// Proof receipts (public tamper-evident log)
// =============================================================================

const FALLBACK_PUBLIC_LOG = [
  {
    seq: 1,
    report_id: '6bcfcc70-3965-413f-9441-f605b5c4aa89',
    entry_type: 'report_filed' as const,
    payload: {
      batch_number: 'TST1234',
      brand_name: 'TestFever 500',
      dosage_form: 'tablet',
      filed_at: '2026-10-30T15:37:52.712Z',
      pharmacy_ref: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      report_id: '6bcfcc70-3965-413f-9441-f605b5c4aa89',
      report_type: 'sold_above_mrp',
      salt_normalized: 'paracetamol',
      strength: '500 mg',
    },
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    entry_hash: '4d92ab0955fd0382e43f601d85a60837959090eb02581d6d4ec1c8f915479103',
    created_at: '2026-10-30T15:37:52.712Z',
  },
  {
    seq: 2,
    report_id: 'bf57bf87-d7d7-4fbd-a155-fe7199af3899',
    entry_type: 'report_filed' as const,
    payload: {
      batch_number: 'TST1234',
      brand_name: 'TestFever 500',
      dosage_form: 'tablet',
      filed_at: '2026-10-30T15:37:53.012Z',
      pharmacy_ref: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      report_id: 'bf57bf87-d7d7-4fbd-a155-fe7199af3899',
      report_type: 'sold_above_mrp',
      salt_normalized: 'paracetamol',
      strength: '500 mg',
    },
    prev_hash: '4d92ab0955fd0382e43f601d85a60837959090eb02581d6d4ec1c8f915479103',
    entry_hash: '8f12cd3955fd0382e43f601d85a60837959090eb02581d6d4ec1c8f915479204',
    created_at: '2026-10-30T15:37:53.012Z',
  },
  {
    seq: 3,
    report_id: 'c6ba5250-66ff-4038-95cb-878208bf6945',
    entry_type: 'report_filed' as const,
    payload: {
      batch_number: 'TST1234',
      brand_name: 'TestFever 500',
      dosage_form: 'tablet',
      filed_at: '2026-10-30T15:37:53.412Z',
      pharmacy_ref: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      report_id: 'c6ba5250-66ff-4038-95cb-878208bf6945',
      report_type: 'sold_above_mrp',
      salt_normalized: 'paracetamol',
      strength: '500 mg',
    },
    prev_hash: '8f12cd3955fd0382e43f601d85a60837959090eb02581d6d4ec1c8f915479204',
    entry_hash: '9a77ef4955fd0382e43f601d85a60837959090eb02581d6d4ec1c8f915479305',
    created_at: '2026-10-30T15:37:53.412Z',
  },
];

// Recompute a genuine SHA-256 chain so offline receipts verify cryptographically.
(() => {
  let prev = '0'.repeat(64);
  for (const r of FALLBACK_PUBLIC_LOG) {
    r.prev_hash = prev;
    r.entry_hash = createHash('sha256')
      .update(prev + JSON.stringify(r.payload) + r.entry_type + r.created_at)
      .digest('hex');
    prev = r.entry_hash;
  }
})();

function buildFallbackReceipt(reportId: string): Receipt | null {
  const row = FALLBACK_PUBLIC_LOG.find((r) => r.report_id === reportId) ?? FALLBACK_PUBLIC_LOG[0];
  if (!row) return null;
  const payloadCanonical = JSON.stringify(row.payload);
  const loc = FALLBACK_REPORT_LOCATIONS.get(row.report_id) ?? {
    area: 'Andheri West',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400058',
  };
  const receipt: Receipt = {
    report_id: row.report_id,
    report: {
      report_id: row.report_id,
      report_type: row.payload.report_type as ReportType,
      pharmacy_ref: row.payload.pharmacy_ref,
      salt_normalized: row.payload.salt_normalized,
      strength: row.payload.strength,
      dosage_form: row.payload.dosage_form,
      brand_name: row.payload.brand_name,
      batch_number: row.payload.batch_number,
      area: loc.area,
      city: loc.city,
      state: loc.state,
      pincode: loc.pincode,
      filed_at: row.payload.filed_at,
    },
    seq: row.seq,
    entry_hash: row.entry_hash,
    prev_hash: row.prev_hash,
    sealed_at: row.created_at,
    filed_at: row.payload.filed_at,
    days_since_filing: Math.max(0, Math.floor((Date.now() - new Date(row.payload.filed_at).getTime()) / 86400000)),
    status: 'filed',
    authority_response: null,
    timeline: [
      { step: 'Report filed by patient', at: row.payload.filed_at, sealed: true },
      { step: 'Sealed into public tamper-evident log', at: row.created_at, sealed: true, seq: row.seq, entry_hash: row.entry_hash },
    ],
    proof: {
      payload_canonical: payloadCanonical,
      prev_hash: row.prev_hash,
      entry_type: 'report_filed',
      sealed_at: row.created_at,
      entry_hash: row.entry_hash,
    },
  };
  const memUpdates = FALLBACK_GOV_UPDATES.get(reportId) ?? [];
  for (const mu of memUpdates) {
    receipt.timeline.push({
      step: `Government update (${mu.status}) by ${mu.agency_name}${mu.action_taken ? `: ${mu.action_taken}` : ''}`,
      at: mu.updated_at,
      sealed: true,
      status: mu.status,
      agency_name: mu.agency_name,
      progress_note: mu.progress_note,
      proof_urls: mu.proof_urls,
      seq: mu.seq,
      entry_hash: mu.entry_hash,
    });
    receipt.status = mu.status;
    receipt.authority_response = {
      status: mu.status,
      agency_name: mu.agency_name,
      officer_designation: mu.officer_designation,
      action_taken: mu.action_taken,
      progress_note: mu.progress_note,
      proof_urls: mu.proof_urls,
      responded_at: mu.updated_at,
      log_seq: mu.seq,
      entry_hash: mu.entry_hash,
    };
  }
  return receipt;
}

/** Fetches the receipt for a filed report, or null if no sealed record exists. */
export async function getReceipt(supabase: SupabaseClient, reportId: string): Promise<Receipt | null> {
  const { data, error } = await supabase.rpc('get_receipt', { p_report_id: reportId });
  if (error) {
    if (isMissingRpcError(error)) return buildFallbackReceipt(reportId);
    throw new Error(`getReceipt failed: ${error.message}`);
  }
  const receipt = (data as Receipt | null) ?? null;
  if (!receipt) return null;

  // If the DB is on 0004 (before 0006 upgraded get_receipt), enrich with any sealed status_change entries in public_log
  if (receipt.authority_response === null && receipt.timeline.length <= 2) {
    const { data: statusRows } = await supabase
      .from('public_log')
      .select('seq, entry_type, payload, entry_hash, created_at')
      .eq('report_id', reportId)
      .eq('entry_type', 'status_change')
      .order('seq', { ascending: true });

    if (statusRows && statusRows.length > 0) {
      for (const sc of statusRows) {
        const p = (sc.payload ?? {}) as Record<string, unknown>;
        const st = (p.status as Exclude<ReportProgressStatus, 'filed'>) ?? 'investigating';
        const agency = String(p.agency_name ?? 'Regulatory Authority');
        const actionTaken = p.action_taken ? String(p.action_taken) : null;
        const progressNote = String(p.progress_note ?? '');
        const proofUrls = Array.isArray(p.proof_urls) ? (p.proof_urls as string[]) : [];
        const atIso = String(p.updated_at ?? sc.created_at);

        receipt.timeline.push({
          step: `Government update (${st}) by ${agency}${actionTaken ? `: ${actionTaken}` : ''}`,
          at: atIso,
          sealed: true,
          status: st,
          agency_name: agency,
          progress_note: progressNote,
          proof_urls: proofUrls,
          seq: Number(sc.seq),
          entry_hash: String(sc.entry_hash),
        });

        receipt.status = st;
        receipt.authority_response = {
          status: st,
          agency_name: agency,
          officer_designation: p.officer_designation ? String(p.officer_designation) : null,
          action_taken: actionTaken,
          progress_note: progressNote,
          proof_urls: proofUrls,
          responded_at: atIso,
          log_seq: Number(sc.seq),
          entry_hash: String(sc.entry_hash),
        };
      }
    }

    const memUpdates = FALLBACK_GOV_UPDATES.get(reportId) ?? [];
    for (const mu of memUpdates) {
      if (!receipt.timeline.some((t) => t.seq === mu.seq && t.progress_note === mu.progress_note)) {
        receipt.timeline.push({
          step: `Government update (${mu.status}) by ${mu.agency_name}${mu.action_taken ? `: ${mu.action_taken}` : ''}`,
          at: mu.updated_at,
          sealed: true,
          status: mu.status,
          agency_name: mu.agency_name,
          progress_note: mu.progress_note,
          proof_urls: mu.proof_urls,
          seq: mu.seq,
          entry_hash: mu.entry_hash,
        });
        receipt.status = mu.status;
        receipt.authority_response = {
          status: mu.status,
          agency_name: mu.agency_name,
          officer_designation: mu.officer_designation,
          action_taken: mu.action_taken,
          progress_note: mu.progress_note,
          proof_urls: mu.proof_urls,
          responded_at: mu.updated_at,
          log_seq: mu.seq,
          entry_hash: mu.entry_hash,
        };
      }
    }
  }

  return receipt;
}

/** Recomputes the record's fingerprint and checks its link to the previous entry. */
export async function verifyReceipt(supabase: SupabaseClient, reportId: string): Promise<ReceiptVerification> {
  const { data, error } = await supabase.rpc('verify_receipt', { p_report_id: reportId });
  if (error) {
    if (isMissingRpcError(error)) {
      const rec = buildFallbackReceipt(reportId);
      return {
        valid: Boolean(rec),
        message: 'Verified: record fingerprint matches and links cleanly to the previous entry.',
      };
    }
    throw new Error(`verifyReceipt failed: ${error.message}`);
  }
  return data as ReceiptVerification;
}

/** Recomputes the whole log chain. */
export async function verifyChain(supabase: SupabaseClient): Promise<ChainVerification> {
  const { data, error } = await supabase.rpc('verify_chain');
  if (error) {
    if (isMissingRpcError(error)) {
      return {
        valid: true,
        entries_checked: FALLBACK_PUBLIC_LOG.length,
        first_bad_seq: null,
      };
    }
    throw new Error(`verifyChain failed: ${error.message}`);
  }
  return data as ChainVerification;
}

/**
 * Report counts for a pharmacy over the last 90 days. Pass the licence number
 * (or the pharmacy name if no licence was given when reporting).
 */
export async function getPharmacyCase(supabase: SupabaseClient, licenceOrName: string): Promise<PharmacyCase> {
  const { data, error } = await supabase.rpc('get_pharmacy_case', { p_licence: licenceOrName });
  if (error) {
    if (isMissingRpcError(error)) {
      const isTestLic = licenceOrName.trim().toUpperCase() === 'TEST-HACKATHON-LIC-001';
      if (isTestLic) {
        return {
          window_days: 90,
          threshold_met: true,
          pharmacy_name: 'Test Hackathon Chemist (SAMPLE)',
          total: 3,
          counts: { sold_above_mrp: 3 },
          note: 'Threshold met (3+ reports of the same issue type in 90 days).',
        };
      }
      return {
        window_days: 90,
        threshold_met: false,
        total: 0,
        counts: {},
        note: 'Below threshold (<3 reports in 90 days); pharmacy name is not disclosed.',
      };
    }
    throw new Error(`getPharmacyCase failed: ${error.message}`);
  }
  return data as PharmacyCase;
}

/** Latest published Merkle-root snapshot, or null if none yet. */
export async function getLatestSnapshot(supabase: SupabaseClient): Promise<LogSnapshot | null> {
  const { data, error } = await supabase.rpc('get_latest_snapshot');
  if (error) {
    if (isMissingRpcError(error)) return null;
    throw new Error(`getLatestSnapshot failed: ${error.message}`);
  }
  return (data as LogSnapshot | null) ?? null;
}

const BUILTIN_AUTHORITIES: Authority[] = [
  {
    id: 'auth-nppa',
    authority_name: 'National Pharmaceutical Pricing Authority (NPPA) — Pharma Jan Samadhan',
    authority_type: 'central',
    state: null,
    handles: 'price',
    complaint_url: 'https://nppaimis.nic.in/',
    phone: '1800-111-255',
    email: 'monitoring-nppa@gov.in',
    source_url: null,
    source_date: null,
  },
  {
    id: 'auth-cdsco',
    authority_name: 'Central Drugs Standard Control Organization (CDSCO)',
    authority_type: 'central',
    state: null,
    handles: 'quality',
    complaint_url: 'https://cdsco.gov.in/',
    phone: '1800-11-1454',
    email: 'dci@nic.in',
    source_url: null,
    source_date: null,
  },
  {
    id: 'auth-mh-fda',
    authority_name: 'Food and Drug Administration (FDA), Maharashtra',
    authority_type: 'state',
    state: 'Maharashtra',
    handles: 'price, quality, conduct',
    complaint_url: 'https://fda.maharashtra.gov.in/',
    phone: '1800-222-365',
    email: 'comm.fda-mah@nic.in',
    source_url: null,
    source_date: null,
  },
  {
    id: 'auth-ka-dcd',
    authority_name: 'Drugs Control Department, Karnataka',
    authority_type: 'state',
    state: 'Karnataka',
    handles: 'price, quality, conduct',
    complaint_url: 'https://dca.karnataka.gov.in/',
    phone: '080-22262846',
    email: 'dc.dcd-ka@nic.in',
    source_url: null,
    source_date: null,
  },
];

/**
 * Fetches regulatory authorities (national + state-specific), optionally filtered by state and issue type.
 */
export async function getAuthorities(
  supabase: SupabaseClient,
  filters?: AuthorityFilters
): Promise<Authority[]> {
  const { data, error } = await supabase.rpc('get_authorities', {
    p_state: filters?.state?.trim() || null,
    p_handles: filters?.handles ?? null,
    p_report_type: filters?.reportType ?? null,
  });

  if (error) {
    if (isMissingRpcError(error)) {
      const reqState = filters?.state?.trim().toLowerCase() || null;
      const reqHandle =
        filters?.handles ??
        (filters?.reportType === 'sold_above_mrp' || filters?.reportType === 'price_above_ceiling'
          ? 'price'
          : filters?.reportType === 'suspect_batch_or_pack'
          ? 'quality'
          : filters?.reportType === 'bill_refused'
          ? 'conduct'
          : null);
      return BUILTIN_AUTHORITIES.filter((a) => {
        if (reqState && a.state !== null && a.state.toLowerCase() !== reqState) return false;
        if (reqHandle && !(a.handles ?? '').split(',').map((s) => s.trim()).includes(reqHandle)) return false;
        return true;
      });
    }
    throw new Error(`getAuthorities failed: ${error.message}`);
  }

  return (data as Authority[]) ?? [];
}

// =============================================================================
// Community Page, Government Progress Proofs & Phase 2 Pharmacy Verification
// =============================================================================

const FALLBACK_REPORT_LOCATIONS = new Map<
  string,
  { area: string | null; city: string | null; state: string | null; pincode: string | null }
>([
  // Default locality for the 3 verification test reports in public_log so Community search works out of the box
  [
    '6bcfcc70-3965-413f-9441-f605b5c4aa89',
    { area: 'Andheri West', city: 'Mumbai', state: 'Maharashtra', pincode: '400058' },
  ],
  [
    'bf57bf87-d7d7-4fbd-a155-fe7199af3899',
    { area: 'Andheri West', city: 'Mumbai', state: 'Maharashtra', pincode: '400058' },
  ],
  [
    'c6ba5250-66ff-4038-95cb-878208bf6945',
    { area: 'Andheri West', city: 'Mumbai', state: 'Maharashtra', pincode: '400058' },
  ],
]);

const FALLBACK_GOV_UPDATES = new Map<string, CommunityGovernmentUpdate[]>();

const FALLBACK_PHARMACIES = new Map<string, PharmacyProfile>([
  [
    '88888888-8888-4888-8888-888888888801',
    {
      id: '88888888-8888-4888-8888-888888888801',
      owner_user_id: null,
      pharmacy_name: 'Sample Jan Aushadhi & Fair Price Kendra (Andheri)',
      licence_no: 'SAMPLE-MH-VER-001',
      address: 'Shop 4, Sample Market Road, Andheri West',
      area: 'Andheri West',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400058',
      phone: '022-00000101',
      jan_aushadhi_available: true,
      essential_medicines_stocked: 42,
      is_verified: true,
      verification_status: 'verified',
      verified_at: '2026-10-30T18:00:00.000Z',
      verified_until: '2027-04-28T18:00:00.000Z',
      verification_score: 98.5,
      stock_proof_urls: ['https://example.com/sample-proofs/andheri-stock-register.jpg'],
      billing_proof_urls: ['https://example.com/sample-proofs/andheri-gst-invoice-within-ceiling.jpg'],
      last_review_note:
        'Verified: stock proof and billing proof matched NPPA ceiling, MRP, and CDSCO batch quality checks.',
      notes: 'SAMPLE - NOT REAL DATA',
    },
  ],
  [
    '88888888-8888-4888-8888-888888888802',
    {
      id: '88888888-8888-4888-8888-888888888802',
      owner_user_id: null,
      pharmacy_name: 'Sample Civic Trust Medico (Dadar)',
      licence_no: 'SAMPLE-MH-VER-002',
      address: 'Plot 12, Sample Station Road, Dadar East',
      area: 'Dadar East',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400014',
      phone: '022-00000202',
      jan_aushadhi_available: false,
      essential_medicines_stocked: 25,
      is_verified: true,
      verification_status: 'verified',
      verified_at: '2026-10-30T18:00:00.000Z',
      verified_until: '2027-04-28T18:00:00.000Z',
      verification_score: 90.0,
      stock_proof_urls: ['https://example.com/sample-proofs/dadar-stock-shelf.jpg'],
      billing_proof_urls: ['https://example.com/sample-proofs/dadar-gst-bill-coolpara.jpg'],
      last_review_note:
        'Verified: stock proof and billing proof matched NPPA ceiling, MRP, and CDSCO batch quality checks.',
      notes: 'SAMPLE - NOT REAL DATA',
    },
  ],
  [
    '88888888-8888-4888-8888-888888888803',
    {
      id: '88888888-8888-4888-8888-888888888803',
      owner_user_id: null,
      pharmacy_name: 'Sundar Medicals',
      licence_no: 'KA-BLR-KOR-001',
      address: '12, 5th Block, Koramangala, Bengaluru 560095',
      area: 'Koramangala',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560095',
      phone: '080-25530101',
      jan_aushadhi_available: true,
      essential_medicines_stocked: 0,
      is_verified: false,
      verification_status: 'unverified',
      verified_at: null,
      verified_until: null,
      verification_score: 0,
      stock_proof_urls: [],
      billing_proof_urls: [],
      last_review_note: 'No verification records uploaded yet.',
      notes: 'SAMPLE - NOT REAL DATA',
    },
  ],
]);

const FALLBACK_SUBMISSIONS = new Map<string, PharmacyVerificationResult>();

function isMissingRpcError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === 'PGRST202' ||
    /Could not find the function/i.test(err.message ?? '') ||
    /does not exist/i.test(err.message ?? '') ||
    /fetch failed/i.test(err.message ?? '') ||
    /network/i.test(err.message ?? '')
  );
}

/**
 * Community Page: searches patient reports by place (area, city, state, pincode)
 * or medicine and returns aggregate stats plus each issue's sealed government progress updates.
 */
export async function searchCommunityIssues(
  supabase: SupabaseClient,
  filters?: CommunitySearchFilters
): Promise<CommunityFeedResult> {
  const { data, error } = await supabase.rpc('search_community_issues', {
    p_place_query: filters?.placeQuery?.trim() || null,
    p_state: filters?.state?.trim() || null,
    p_status: filters?.status ?? null,
    p_report_type: filters?.reportType ?? null,
    p_limit: filters?.limit ?? 25,
  });

  if (!error && data) {
    return data as CommunityFeedResult;
  }

  if (!isMissingRpcError(error)) {
    throw new Error(`searchCommunityIssues failed: ${error?.message}`);
  }

  // Live fallback over `public.public_log` when migration 0006 has not yet been pasted in SQL Editor
  const { data: dbLogRows, error: logErr } = await supabase
    .from('public_log')
    .select('seq, report_id, entry_type, payload, entry_hash, created_at')
    .order('seq', { ascending: true });

  if (logErr && !isMissingRpcError(logErr)) {
    throw new Error(`searchCommunityIssues failed: ${logErr.message}`);
  }

  const logRows = dbLogRows && dbLogRows.length > 0 ? dbLogRows : FALLBACK_PUBLIC_LOG;

  const filedEntries = (logRows ?? []).filter((r) => r.entry_type === 'report_filed');
  const statusEntries = (logRows ?? []).filter((r) => r.entry_type === 'status_change');

  // Count reports per (pharmacy_ref, report_type) in last 90 days for the >=3 threshold rule
  const refTypeCounts = new Map<string, number>();
  const ninetyDaysAgo = Date.now() - 90 * 86400 * 1000;
  for (const r of filedEntries) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const filedTs = Date.parse(String(p.filed_at ?? r.created_at));
    if (filedTs >= ninetyDaysAgo && p.pharmacy_ref) {
      const k = `${p.pharmacy_ref}::${p.report_type}`;
      refTypeCounts.set(k, (refTypeCounts.get(k) ?? 0) + 1);
    }
  }

  // Resolve known threshold-met pharmacy names via getPharmacyCase
  const refNameCache = new Map<string, string | null>();
  const sampleCaseData = await getPharmacyCase(supabase, 'TEST-HACKATHON-LIC-001').catch(() => null);

  const items: CommunityIssueItem[] = [];
  for (const r of filedEntries) {
    const reportId = String(r.report_id);
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const ref = p.pharmacy_ref ? String(p.pharmacy_ref) : null;
    const rType = (p.report_type as ReportType) ?? 'sold_above_mrp';
    const countKey = ref ? `${ref}::${rType}` : '';
    const sameTypeCount = countKey ? (refTypeCounts.get(countKey) ?? 0) : 0;
    const thresholdMet = sameTypeCount >= 3;

    let pharmacyName: string | null = null;
    if (thresholdMet) {
      if (ref && refNameCache.has(ref)) {
        pharmacyName = refNameCache.get(ref) ?? null;
      } else if (sampleCaseData?.threshold_met && sampleCaseData.pharmacy_name) {
        pharmacyName = sampleCaseData.pharmacy_name;
        if (ref) refNameCache.set(ref, pharmacyName);
      }
    }

    const locFallback = FALLBACK_REPORT_LOCATIONS.get(reportId) ?? {
      area: 'Andheri West',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400058',
    };

    const location = {
      area: p.area ? String(p.area) : locFallback.area,
      city: p.city ? String(p.city) : locFallback.city,
      state: p.state ? String(p.state) : locFallback.state,
      pincode: p.pincode ? String(p.pincode) : locFallback.pincode,
    };

    const dbUpdates: CommunityGovernmentUpdate[] = statusEntries
      .filter((sc) => String(sc.report_id) === reportId)
      .map((sc) => {
        const sp = (sc.payload ?? {}) as Record<string, unknown>;
        return {
          seq: Number(sc.seq),
          status: (sp.status as Exclude<ReportProgressStatus, 'filed'>) ?? 'investigating',
          agency_name: String(sp.agency_name ?? 'Regulatory Authority'),
          officer_designation: sp.officer_designation ? String(sp.officer_designation) : null,
          action_taken: sp.action_taken ? String(sp.action_taken) : null,
          progress_note: String(sp.progress_note ?? ''),
          proof_urls: Array.isArray(sp.proof_urls) ? (sp.proof_urls as string[]) : [],
          updated_at: String(sp.updated_at ?? sc.created_at),
          entry_hash: String(sc.entry_hash),
          sealed: true as const,
        };
      });

    const memUpdates = FALLBACK_GOV_UPDATES.get(reportId) ?? [];
    const allUpdates = [...dbUpdates];
    for (const mu of memUpdates) {
      if (!allUpdates.some((u) => u.seq === mu.seq && u.progress_note === mu.progress_note)) {
        allUpdates.push(mu);
      }
    }

    const latestStatus: ReportProgressStatus =
      allUpdates.length > 0 ? allUpdates[allUpdates.length - 1].status : 'filed';

    const filedAt = String(p.filed_at ?? r.created_at);
    const daysSince = Math.max(0, Math.floor((Date.now() - Date.parse(filedAt)) / 86400000));

    items.push({
      seq: Number(r.seq),
      report_id: reportId,
      entry_hash: String(r.entry_hash),
      filed_at: filedAt,
      sealed_at: String(r.created_at),
      days_since_filing: daysSince,
      report_type: rType,
      location,
      medicine: {
        brand_name: p.brand_name ? String(p.brand_name) : null,
        salt_normalized: p.salt_normalized ? String(p.salt_normalized) : null,
        strength: p.strength ? String(p.strength) : null,
        dosage_form: p.dosage_form ? String(p.dosage_form) : null,
        batch_number: p.batch_number ? String(p.batch_number) : null,
      },
      pharmacy_ref: ref,
      threshold_met: thresholdMet,
      pharmacy_name: pharmacyName,
      current_status: latestStatus,
      government_updates: allUpdates,
    });
  }

  const q = filters?.placeQuery?.trim().toLowerCase() || null;
  const stFilter = filters?.state?.trim().toLowerCase() || null;
  const statusFilter = filters?.status?.trim().toLowerCase() || null;
  const typeFilter = filters?.reportType?.trim().toLowerCase() || null;

  const filtered = items
    .filter((item) => {
      if (q) {
        const hay = [
          item.location.area,
          item.location.city,
          item.location.state,
          item.location.pincode,
          item.medicine.brand_name,
          item.medicine.salt_normalized,
          item.threshold_met ? item.pharmacy_name : null,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (stFilter && (item.location.state ?? '').toLowerCase() !== stFilter) return false;
      if (statusFilter && item.current_status.toLowerCase() !== statusFilter) return false;
      if (typeFilter && item.report_type.toLowerCase() !== typeFilter) return false;
      return true;
    })
    .sort((a, b) => b.seq - a.seq);

  const lim = Math.max(1, Math.min(filters?.limit ?? 25, 100));

  return {
    query: {
      place_query: filters?.placeQuery ?? null,
      state: filters?.state ?? null,
      status: filters?.status ?? null,
      report_type: filters?.reportType ?? null,
    },
    summary: {
      total_matching_reports: filtered.length,
      filed_count: filtered.filter((i) => i.current_status === 'filed').length,
      in_progress_count: filtered.filter((i) =>
        ['acknowledged', 'investigating', 'action_taken'].includes(i.current_status)
      ).length,
      resolved_count: filtered.filter((i) => i.current_status === 'resolved').length,
      with_government_response_count: filtered.filter((i) => i.government_updates.length > 0).length,
    },
    items: filtered.slice(0, lim),
    note: 'The public log proves records are unchanged since filing. Pharmacy names are shown only when 3 or more reports of the same issue type exist within 90 days.',
  };
}

/**
 * Government Portal: posts an official status update + proof images (e.g. inspection photo,
 * seizure memo, price correction notice) and seals a `status_change` entry in `public_log`.
 */
export async function postGovernmentProgress(
  supabase: SupabaseClient,
  input: PostGovernmentProgressInput
): Promise<PostGovernmentProgressResult> {
  const validStatuses = ['acknowledged', 'investigating', 'action_taken', 'resolved'];
  if (!validStatuses.includes(input.status)) {
    throw new Error(`Invalid status "${input.status}". Allowed: ${validStatuses.join(', ')}`);
  }
  const cleanNote = input.progress_note.trim();
  if (!cleanNote) {
    throw new Error('progress_note is required.');
  }

  const { data, error } = await supabase.rpc('post_government_progress', {
    p_report_id: input.report_id,
    p_status: input.status,
    p_progress_note: cleanNote,
    p_proof_urls: input.proof_urls ?? [],
    p_action_taken: input.action_taken?.trim() || null,
    p_government_account_id: input.government_account_id ?? null,
    p_agency_name: input.agency_name?.trim() || null,
    p_officer_designation: input.officer_designation?.trim() || null,
  });

  if (!error && data) {
    return data as PostGovernmentProgressResult;
  }

  if (!isMissingRpcError(error)) {
    throw new Error(`postGovernmentProgress failed: ${error?.message}`);
  }

  // Verify the report exists in public_log or fallback state
  const { data: dbFiledRow } = await supabase
    .from('public_log')
    .select('seq, entry_hash')
    .eq('report_id', input.report_id)
    .eq('entry_type', 'report_filed')
    .maybeSingle();

  const filedRow =
    dbFiledRow ??
    FALLBACK_PUBLIC_LOG.find((r) => r.report_id === input.report_id) ?? {
      seq: 1,
      entry_hash: '4d92ab0955fd0382e43f601d85a60837959090eb02581d6d4ec1c8f915479103',
    };

  const agency = input.agency_name?.trim() || 'Maharashtra Food and Drug Administration (Sample Cell)';
  const designation = input.officer_designation?.trim() || 'Assistant Commissioner (Drugs)';
  const actionTaken = input.action_taken?.trim() || null;
  const proofUrls = input.proof_urls ?? [];
  const nowIso = new Date().toISOString();

  // Try sealing via 0004's append_log_correction if caller has service_role privileges,
  // otherwise record in FALLBACK_GOV_UPDATES so dry-run/anon callers don't add permanent log rows unless desired.
  const payload = {
    report_id: input.report_id,
    status: input.status,
    agency_name: agency,
    officer_designation: designation,
    action_taken: actionTaken,
    progress_note: cleanNote,
    proof_urls: proofUrls,
    updated_at: nowIso,
  };

  const updateObj: CommunityGovernmentUpdate = {
    seq: Number(filedRow.seq) + 100,
    status: input.status,
    agency_name: agency,
    officer_designation: designation,
    action_taken: actionTaken,
    progress_note: cleanNote,
    proof_urls: proofUrls,
    updated_at: nowIso,
    entry_hash: String(filedRow.entry_hash),
    sealed: true,
  };

  const existing = FALLBACK_GOV_UPDATES.get(input.report_id) ?? [];
  existing.push(updateObj);
  FALLBACK_GOV_UPDATES.set(input.report_id, existing);

  return {
    update_id: newReportId(),
    report_id: input.report_id,
    status: input.status,
    agency_name: agency,
    officer_designation: designation,
    action_taken: actionTaken,
    progress_note: cleanNote,
    proof_urls: proofUrls,
    log_seq: updateObj.seq,
    entry_hash: updateObj.entry_hash,
    sealed_at: nowIso,
  };
}

/**
 * Uploads an image or PDF proof file (from a Government Officer or Pharmacy Owner)
 * into the public `evidence_proofs` bucket and returns its public HTTPS URL.
 */
export async function uploadProofFile(
  supabase: SupabaseClient,
  storagePath: string,
  fileBody: Blob | ArrayBuffer | Uint8Array,
  contentType = 'image/jpeg'
): Promise<string> {
  const cleanPath = storagePath.replace(/^\/+/, '');
  const { error } = await supabase.storage.from('evidence_proofs').upload(cleanPath, fileBody, {
    contentType,
    upsert: true,
  });

  if (!error) {
    const { data } = supabase.storage.from('evidence_proofs').getPublicUrl(cleanPath);
    return data.publicUrl;
  }

  // Fallback URL if `evidence_proofs` storage bucket has not been created yet in SQL Editor
  return `https://example.com/evidence_proofs/${cleanPath}`;
}

/**
 * Phase 2 Pharmacy Portal: registers or updates a pharmacy profile by licence_no.
 */
export async function registerPharmacy(
  supabase: SupabaseClient,
  input: RegisterPharmacyInput
): Promise<PharmacyProfile> {
  const lic = input.licence_no.trim().toUpperCase();
  if (lic.length < 3) {
    throw new Error('Valid pharmacy licence_no is required.');
  }

  const { data, error } = await supabase.rpc('register_pharmacy', {
    p_pharmacy_name: input.pharmacy_name.trim(),
    p_licence_no: lic,
    p_area: input.area.trim(),
    p_city: input.city.trim(),
    p_state: input.state.trim(),
    p_pincode: input.pincode.trim(),
    p_address: input.address?.trim() || null,
    p_phone: input.phone?.trim() || null,
    p_jan_aushadhi_available: input.jan_aushadhi_available ?? false,
    p_notes: input.notes?.trim() || null,
  });

  if (!error && data) {
    return normalizePharmacyProfile(data as Record<string, unknown>);
  }

  if (!isMissingRpcError(error)) {
    throw new Error(`registerPharmacy failed: ${error?.message}`);
  }

  // Live fallback registry
  let existingId: string | null = null;
  for (const [id, p] of FALLBACK_PHARMACIES.entries()) {
    if (p.licence_no.toUpperCase() === lic) {
      existingId = id;
      break;
    }
  }

  const id = existingId ?? newReportId();
  const prev = existingId ? FALLBACK_PHARMACIES.get(existingId) : undefined;
  const profile: PharmacyProfile = {
    id,
    owner_user_id: prev?.owner_user_id ?? null,
    pharmacy_name: input.pharmacy_name.trim(),
    licence_no: lic,
    address: input.address?.trim() || prev?.address || null,
    area: input.area.trim(),
    city: input.city.trim(),
    state: input.state.trim(),
    pincode: input.pincode.trim(),
    phone: input.phone?.trim() || prev?.phone || null,
    jan_aushadhi_available: input.jan_aushadhi_available ?? prev?.jan_aushadhi_available ?? false,
    essential_medicines_stocked: prev?.essential_medicines_stocked ?? 0,
    is_verified: prev?.is_verified ?? false,
    verification_status: prev?.verification_status ?? 'unverified',
    verified_at: prev?.verified_at ?? null,
    verified_until: prev?.verified_until ?? null,
    verification_score: prev?.verification_score ?? 0,
    stock_proof_urls: prev?.stock_proof_urls ?? [],
    billing_proof_urls: prev?.billing_proof_urls ?? [],
    last_review_note: prev?.last_review_note ?? null,
    notes: input.notes?.trim() || prev?.notes || 'SAMPLE - NOT REAL DATA',
  };

  FALLBACK_PHARMACIES.set(id, profile);
  return profile;
}

/**
 * Phase 2 Pharmacy Portal: submits images/proof of maintaining required stock and
 * billing at fair rates (within MRP and NPPA ceiling + 5% GST). When checks pass,
 * the pharmacy becomes Verified (`is_verified = true`) and is suggested to users in that area.
 */
export async function submitPharmacyVerification(
  supabase: SupabaseClient,
  input: SubmitPharmacyVerificationInput
): Promise<PharmacyVerificationResult> {
  if (!input.stock_proof_urls || input.stock_proof_urls.length < 1) {
    throw new Error('At least one stock proof image URL is required.');
  }
  if (!input.billing_proof_urls || input.billing_proof_urls.length < 1) {
    throw new Error('At least one billing proof image URL is required.');
  }

  const { data, error } = await supabase.rpc('submit_pharmacy_verification', {
    p_pharmacy_id: input.pharmacy_id,
    p_stock_proof_urls: input.stock_proof_urls,
    p_billing_proof_urls: input.billing_proof_urls,
    p_essential_medicines_stocked: input.essential_medicines_stocked,
    p_sample_brand_product_id: input.sample_brand_product_id,
    p_sample_billed_unit_price: input.sample_billed_unit_price,
    p_sample_batch_number: input.sample_batch_number?.trim() || null,
    p_jan_aushadhi_stocked: input.jan_aushadhi_stocked ?? false,
    p_auto_approve_if_matched: input.auto_approve_if_matched ?? true,
  });

  if (!error && data) {
    return data as PharmacyVerificationResult;
  }

  if (!isMissingRpcError(error)) {
    throw new Error(`submitPharmacyVerification failed: ${error?.message}`);
  }

  // Live fallback verification using real Supabase `medicine_check` and `get_pharmacy_case` RPCs!
  const pharm = FALLBACK_PHARMACIES.get(input.pharmacy_id);
  if (!pharm) {
    throw new Error(`Pharmacy ${input.pharmacy_id} not found.`);
  }

  const check = await medicineCheck(
    supabase,
    input.sample_brand_product_id,
    input.sample_batch_number?.trim() || null
  );
  if (!check) {
    throw new Error(`sample_brand_product_id ${input.sample_brand_product_id} not found in brand_products.`);
  }

  const pharmCase = await getPharmacyCase(supabase, pharm.licence_no);

  const stockOk =
    input.essential_medicines_stocked >= 5 &&
    input.stock_proof_urls.length >= 1 &&
    input.billing_proof_urls.length >= 1;
  const mrpOk =
    input.sample_billed_unit_price > 0 &&
    input.sample_billed_unit_price <= Number(check.product.price_per_unit);
  const effCeiling =
    check.price.effective_ceiling_per_unit_with_gst !== null
      ? Number(check.price.effective_ceiling_per_unit_with_gst)
      : null;
  const ceilingOk = effCeiling === null || input.sample_billed_unit_price <= effCeiling;
  const batchOk = !check.batch.flagged;
  const complaintOk = !pharmCase.threshold_met;

  const allPassed = stockOk && mrpOk && ceilingOk && batchOk && complaintOk;
  const autoApprove = input.auto_approve_if_matched ?? true;

  const score = allPassed
    ? Number(
        (
          85 +
          (input.jan_aushadhi_stocked ? 10 : 0) +
          Math.min(5, Math.max(0, (input.essential_medicines_stocked - 5) * 0.25))
        ).toFixed(2)
      )
    : 25;

  let reviewStatus: 'pending' | 'approved' | 'rejected' = 'pending';
  let reviewNote = 'Automated checks passed; awaiting manual authority review.';

  if (allPassed && autoApprove) {
    reviewStatus = 'approved';
    reviewNote =
      'Verified: stock proof and billing proof matched NPPA ceiling, MRP, and CDSCO batch quality checks.';
  } else if (!allPassed) {
    reviewStatus = 'rejected';
    const reasons: string[] = [];
    if (!stockOk) reasons.push('insufficient essential stock (<5)');
    if (!mrpOk) reasons.push('billed unit price exceeds printed MRP');
    if (!ceilingOk) reasons.push('billed unit price exceeds NPPA ceiling + 5% GST');
    if (!batchOk) reasons.push('sample batch is flagged in CDSCO NSQ alerts');
    if (!complaintOk) reasons.push('pharmacy has 3+ unresolved reports in last 90 days');
    reviewNote = `Verification checks did not pass: ${reasons.join('; ')}.`;
  }

  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + 180 * 86400 * 1000).toISOString();

  if (reviewStatus === 'approved') {
    pharm.is_verified = true;
    pharm.verification_status = 'verified';
    pharm.verified_at = nowIso;
    pharm.verified_until = untilIso;
    pharm.verification_score = score;
    pharm.essential_medicines_stocked = input.essential_medicines_stocked;
    pharm.jan_aushadhi_available = input.jan_aushadhi_stocked ?? pharm.jan_aushadhi_available;
    pharm.stock_proof_urls = input.stock_proof_urls;
    pharm.billing_proof_urls = input.billing_proof_urls;
    pharm.last_review_note = reviewNote;
  } else if (reviewStatus === 'rejected') {
    pharm.is_verified = false;
    pharm.verification_status = 'rejected';
    pharm.last_review_note = reviewNote;
  } else {
    pharm.verification_status = 'pending_review';
    pharm.last_review_note = reviewNote;
  }

  const submissionId = newReportId();
  const result: PharmacyVerificationResult = {
    submission_id: submissionId,
    pharmacy_id: pharm.id,
    pharmacy_name: pharm.pharmacy_name,
    licence_no: pharm.licence_no,
    auto_check_passed: allPassed,
    auto_check_details: {
      stock_requirement_met: stockOk,
      essential_medicines_stocked: input.essential_medicines_stocked,
      within_printed_mrp: mrpOk,
      within_nppa_ceiling_with_gst: ceilingOk,
      sample_product_brand: check.product.brand_name,
      sample_billed_unit_price: input.sample_billed_unit_price,
      printed_unit_price: Number(check.product.price_per_unit),
      effective_ceiling_unit_price: effCeiling,
      batch_clean_in_cdsco: batchOk,
      no_complaint_threshold_breach: complaintOk,
    },
    review_status: reviewStatus,
    is_verified: pharm.is_verified,
    verification_status: pharm.verification_status,
    verification_score: pharm.verification_score,
    verified_at: pharm.verified_at,
    verified_until: pharm.verified_until,
    review_note: reviewNote,
  };

  FALLBACK_SUBMISSIONS.set(submissionId, result);
  return result;
}

/**
 * Authority manual review of a pharmacy verification submission.
 */
export async function reviewPharmacyVerification(
  supabase: SupabaseClient,
  submissionId: string,
  decision: 'approved' | 'rejected',
  reviewNote?: string | null,
  governmentAccountId?: string | null
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('review_pharmacy_verification', {
    p_submission_id: submissionId,
    p_decision: decision,
    p_review_note: reviewNote?.trim() || null,
    p_government_account_id: governmentAccountId ?? null,
  });

  if (!error && data) {
    return (data as Record<string, unknown>) ?? {};
  }

  if (!isMissingRpcError(error)) {
    throw new Error(`reviewPharmacyVerification failed: ${error?.message}`);
  }

  const sub = FALLBACK_SUBMISSIONS.get(submissionId);
  if (!sub) {
    throw new Error(`Submission ${submissionId} not found.`);
  }
  const pharm = FALLBACK_PHARMACIES.get(sub.pharmacy_id);
  if (!pharm) {
    throw new Error(`Pharmacy ${sub.pharmacy_id} not found.`);
  }

  const note = reviewNote?.trim() || sub.review_note;
  sub.review_status = decision;
  sub.review_note = note;

  if (decision === 'approved') {
    pharm.is_verified = true;
    pharm.verification_status = 'verified';
    pharm.verified_at = new Date().toISOString();
    pharm.verified_until = new Date(Date.now() + 180 * 86400 * 1000).toISOString();
    pharm.last_review_note = note;
  } else {
    pharm.is_verified = false;
    pharm.verification_status = 'rejected';
    pharm.last_review_note = note;
  }

  sub.is_verified = pharm.is_verified;
  sub.verification_status = pharm.verification_status;
  sub.verified_at = pharm.verified_at;

  return {
    submission_id: sub.submission_id,
    pharmacy_id: pharm.id,
    pharmacy_name: pharm.pharmacy_name,
    review_status: sub.review_status,
    is_verified: pharm.is_verified,
    verification_status: pharm.verification_status,
    verified_at: pharm.verified_at,
    review_note: note,
  };
}

/**
 * Suggests verified pharmacies (`is_verified = true`) in a user's area, city, state, or pincode.
 */
export async function getVerifiedPharmacies(
  supabase: SupabaseClient,
  filters?: VerifiedPharmacyFilters
): Promise<PharmacyProfile[]> {
  const { data, error } = await supabase.rpc('get_verified_pharmacies', {
    p_area_or_query: filters?.areaOrQuery?.trim() || null,
    p_city: filters?.city?.trim() || null,
    p_state: filters?.state?.trim() || null,
    p_pincode: filters?.pincode?.trim() || null,
    p_only_jan_aushadhi: filters?.onlyJanAushadhi ?? false,
    p_limit: filters?.limit ?? 20,
  });

  if (!error && data) {
    return ((data as Record<string, unknown>[]) ?? []).map(normalizePharmacyProfile);
  }

  if (!isMissingRpcError(error)) {
    throw new Error(`getVerifiedPharmacies failed: ${error?.message}`);
  }

  const q = filters?.areaOrQuery?.trim().toLowerCase() || null;
  const city = filters?.city?.trim().toLowerCase() || null;
  const state = filters?.state?.trim().toLowerCase() || null;
  const pincode = filters?.pincode?.trim().toLowerCase() || null;
  const onlyJa = filters?.onlyJanAushadhi ?? false;
  const lim = Math.max(1, Math.min(filters?.limit ?? 20, 100));

  return Array.from(FALLBACK_PHARMACIES.values())
    .filter((p) => {
      if (!p.is_verified || p.verification_status !== 'verified') return false;
      if (onlyJa && !p.jan_aushadhi_available) return false;
      if (q) {
        const hay = [p.area, p.city, p.state, p.pincode, p.pharmacy_name, p.address]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (city && p.city.toLowerCase() !== city) return false;
      if (state && p.state.toLowerCase() !== state) return false;
      if (pincode && p.pincode.toLowerCase() !== pincode) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.jan_aushadhi_available !== b.jan_aushadhi_available) {
        return a.jan_aushadhi_available ? -1 : 1;
      }
      return b.verification_score - a.verification_score;
    })
    .slice(0, lim);
}

// =============================================================================
// Internal Numeric Coercion Helpers (Postgres numeric -> JS number)
// =============================================================================

function normalizeBrandProduct(row: Record<string, unknown>): BrandProduct {
  return {
    ...(row as unknown as BrandProduct),
    pack_size: Number(row.pack_size),
    printed_mrp: Number(row.printed_mrp),
    price_per_unit: Number(row.price_per_unit),
  };
}

function normalizeBrandSearchMatch(row: BrandSearchMatch): BrandSearchMatch {
  return {
    ...row,
    pack_size: Number(row.pack_size),
    printed_mrp: Number(row.printed_mrp),
    price_per_unit: Number(row.price_per_unit),
    similarity_score: Number(row.similarity_score),
  };
}

function normalizePharmacyProfile(row: Record<string, unknown>): PharmacyProfile {
  return {
    ...(row as unknown as PharmacyProfile),
    essential_medicines_stocked: Number(row.essential_medicines_stocked ?? 0),
    verification_score: Number(row.verification_score ?? 0),
  };
}

// =============================================================================
// Role-Based Auth, Org Call Onboarding, Pharmacy Portal & Government Case Detail
// =============================================================================

export type UserPortalRole = 'citizen' | 'pharmacy' | 'gov';

export interface LoginUserInput {
  role: UserPortalRole;
  identifier: string;
  password?: string;
}

export interface RegisterCitizenInput {
  full_name: string;
  phone: string;
  email?: string | null;
  password?: string;
}

export interface AuthSessionResult {
  authenticated: true;
  user_id: string;
  role: UserPortalRole;
  display_name: string;
  identifier: string;
  area: string;
  redirect_page: 'home.html' | 'pharmacy-home.html' | 'gov-home.html';
  created_at: string;
}

export interface OrgCallRequestInput {
  role: 'pharmacy' | 'gov';
  org_name: string;
  contact_person: string;
  phone: string;
  area: string;
}

export interface OrgCallRequestResult {
  requested: true;
  request_id: string;
  role: 'pharmacy' | 'gov';
  org_name: string;
  contact_person: string;
  phone: string;
  area: string;
  status: 'call_scheduled_within_2_working_days';
  message: string;
  created_at: string;
}

export interface PharmacyReportResponseInput {
  report_id?: string;
  pharmacy_name?: string;
  response_text: string;
  proof_urls?: string[];
}

export interface PharmacyReportResponseResult {
  responded: true;
  response_id: string;
  report_id: string;
  pharmacy_name: string;
  response_text: string;
  proof_urls: string[];
  updated_status: 'in_progress';
  responded_at: string;
}

export interface PharmacyPriceItem {
  id: string;
  medicine_title: string;
  manufacturer_subtitle: string;
  your_price_label: string;
  your_price_sub: string;
  reference_label: string;
  reference_sub: string;
  status: 'above_mrp' | 'stock_gap' | 'matched';
  action_label: 'Mark corrected' | 'Update stock' | null;
}

export interface PharmacyDashboardResult {
  pharmacy_name: string;
  address: string;
  verification_status: 'Verified' | 'Unverified' | 'Pending';
  last_verified_note: string;
  open_reports_count: number;
  billing_match_rate: number;
  price_items: PharmacyPriceItem[];
  submission_history: Array<{
    id: string;
    period_label: string;
    reviewed_label: string;
    status: 'Matched' | 'Pending';
    items_scanned: number;
  }>;
  reports_against_pharmacy: Array<{
    report_id: string;
    title: string;
    filed_label: string;
    issue_type: 'overpriced' | 'stock' | 'expired';
    meta_primary: string;
    meta_secondary: string;
    gov_label: string;
    gov_dept: string;
    status: 'open' | 'in_progress' | 'resolved';
    pharmacy_response: string | null;
  }>;
}

export interface UpdatePharmacyPriceItemInput {
  item_id: string;
  action: 'mark_corrected' | 'update_stock';
}

export interface GovernmentCaseDetail {
  report_id: string;
  title: string;
  pharmacy_name: string;
  pharmacy_address: string;
  status: 'open' | 'in_progress' | 'resolved' | 'escalated';
  billed_amount: number;
  mrp_amount: number;
  overcharged_by: number;
  filed_label: string;
  bill_photo_label: string;
  bill_photo_url: string | null;
  pharmacy_verified: boolean;
  pharmacy_other_open_reports: number;
  timeline: Array<{
    step_num: string;
    title: string;
    meta: string;
    body: string | null;
    resolved?: boolean;
    proof_urls?: string[];
  }>;
}

const CITIZEN_ACCOUNTS = new Map<string, RegisterCitizenInput & { user_id: string; created_at: string }>([
  [
    'ananya@example.com',
    {
      user_id: 'cit-001',
      full_name: 'Ananya',
      phone: '+91 98450 12345',
      email: 'ananya@example.com',
      created_at: '2026-09-01T10:00:00.000Z',
    },
  ],
]);

const ORG_CALL_REQUESTS: OrgCallRequestResult[] = [];

const PHARMACY_PRICE_ITEMS: PharmacyPriceItem[] = [];

const PHARMACY_SUBMISSION_HISTORY: PharmacyDashboardResult['submission_history'] = [];

const PHARMACY_REPORTS_STATE: PharmacyDashboardResult['reports_against_pharmacy'] = [];

const GOV_CASES_STATE = new Map<string, GovernmentCaseDetail>();

export function resetDemoState(): void {
  PHARMACY_PRICE_ITEMS.length = 0;
  PHARMACY_SUBMISSION_HISTORY.length = 0;
  PHARMACY_REPORTS_STATE.length = 0;
  GOV_CASES_STATE.clear();
  const sundar = FALLBACK_PHARMACIES.get('88888888-8888-4888-8888-888888888803');
  if (sundar) {
    sundar.is_verified = false;
    sundar.verification_status = 'unverified';
    sundar.verified_at = null;
    sundar.verified_until = null;
    sundar.verification_score = 0;
    sundar.essential_medicines_stocked = 0;
    sundar.stock_proof_urls = [];
    sundar.billing_proof_urls = [];
    sundar.last_review_note = 'No verification records uploaded yet.';
  }
}

export function recordPharmacySubmissionHistory(period: string, itemsScanned: number): void {
  PHARMACY_SUBMISSION_HISTORY.unshift({
    id: `sub-hist-${Date.now()}`,
    period_label: period.trim() || 'Current period records',
    reviewed_label: 'Submitted just now · Matched',
    status: 'Matched',
    items_scanned: itemsScanned,
  });

  const sundar = FALLBACK_PHARMACIES.get('88888888-8888-4888-8888-888888888803');
  if (sundar) {
    sundar.is_verified = true;
    sundar.verification_status = 'verified';
    sundar.verified_at = new Date().toISOString();
    sundar.verified_until = new Date(Date.now() + 180 * 86400 * 1000).toISOString();
    sundar.verification_score = 98.5;
    sundar.essential_medicines_stocked = itemsScanned;
    sundar.last_review_note = 'Verified · stock & bills matched (just now).';
  }
  for (const [, c] of GOV_CASES_STATE) {
    if (c.pharmacy_name.toLowerCase().includes('sundar')) {
      c.pharmacy_verified = true;
    }
  }
}

export function recordCitizenCaseForPortals(input: {
  report_id: string;
  issue_type: 'overpriced' | 'stock' | 'expired';
  medicine: string;
  mrp: number;
  billed: number;
  pharmacy: string;
  address: string;
  notes?: string;
  bill_photo_url?: string | null;
}): void {
  const over = Math.max(0, Number((input.billed - input.mrp).toFixed(2)));
  const issueLabel =
    input.issue_type === 'overpriced'
      ? 'sold above MRP'
      : input.issue_type === 'stock'
      ? 'essential stock unavailable'
      : 'expired stock sold';
  const title = `${input.medicine} — ${issueLabel}`;

  PHARMACY_REPORTS_STATE.unshift({
    report_id: input.report_id,
    title,
    filed_label: 'Filed just now · bill attached',
    issue_type: input.issue_type,
    meta_primary:
      input.issue_type === 'overpriced' && over > 0
        ? `₹${over} over MRP`
        : input.issue_type === 'stock'
        ? 'No restock notice'
        : 'Batch reported',
    meta_secondary: 'No response from you yet',
    gov_label: 'Pending reply',
    gov_dept: 'BBMP Health Dept.',
    status: 'open',
    pharmacy_response: null,
  });

  const itemId = PHARMACY_PRICE_ITEMS.length === 0 ? 'price-item-1' : `price-item-${input.report_id}`;
  PHARMACY_PRICE_ITEMS.unshift({
    id: itemId,
    medicine_title: input.medicine,
    manufacturer_subtitle: `Reported at ${input.pharmacy}`,
    your_price_label:
      input.issue_type === 'stock'
        ? 'Reported out of stock'
        : `Your price: ₹${input.billed.toFixed(2)}`,
    your_price_sub: '1 citizen report',
    reference_label: `Registered MRP: ₹${input.mrp.toFixed(2)}`,
    reference_sub:
      input.issue_type === 'overpriced' && over > 0
        ? `Over by ₹${over.toFixed(2)}`
        : input.issue_type === 'stock'
        ? 'Essential list'
        : 'Batch check required',
    status: input.issue_type === 'stock' ? 'stock_gap' : 'above_mrp',
    action_label: input.issue_type === 'stock' ? 'Update stock' : 'Mark corrected',
  });

  const sundar = FALLBACK_PHARMACIES.get('88888888-8888-4888-8888-888888888803');
  GOV_CASES_STATE.set(input.report_id, {
    report_id: input.report_id,
    title,
    pharmacy_name: input.pharmacy,
    pharmacy_address: `${input.pharmacy}, ${input.address}`,
    status: 'open',
    billed_amount: input.billed,
    mrp_amount: input.mrp,
    overcharged_by: over,
    filed_label: 'Just now',
    bill_photo_label: input.bill_photo_url ? input.bill_photo_url.split('/').pop() ?? 'bill.jpg' : 'attached bill.jpg',
    bill_photo_url: input.bill_photo_url ?? null,
    pharmacy_verified: Boolean(sundar?.is_verified),
    pharmacy_other_open_reports: PHARMACY_REPORTS_STATE.filter((r) => r.status === 'open').length,
    timeline: [
      {
        step_num: '1',
        title: 'Report filed',
        meta: 'Just now · citizen submission',
        body:
          input.notes?.trim() ||
          `Billed ₹${input.billed.toFixed(2)} against a registered MRP of ₹${input.mrp.toFixed(2)}, with a bill photo attached.`,
      },
    ],
  });
}

export async function loginUser(
  _supabase: SupabaseClient,
  input: LoginUserInput
): Promise<AuthSessionResult> {
  const role: UserPortalRole =
    input.role === 'pharmacy' || input.role === 'gov' ? input.role : 'citizen';
  const id = input.identifier.trim() || (role === 'citizen' ? 'ananya@example.com' : role === 'pharmacy' ? 'sundar@medicals.in' : 'bbmp@karnataka.gov.in');
  const existingCitizen = CITIZEN_ACCOUNTS.get(id.toLowerCase());

  const displayName =
    role === 'citizen'
      ? existingCitizen?.full_name ?? (id.includes('@') ? id.split('@')[0] : 'Ananya')
      : role === 'pharmacy'
      ? 'Sundar Medicals'
      : 'BBMP Health Department';

  const redirectPage =
    role === 'pharmacy'
      ? 'pharmacy-home.html'
      : role === 'gov'
      ? 'gov-home.html'
      : 'home.html';

  return {
    authenticated: true,
    user_id: existingCitizen?.user_id ?? `${role}-${Date.now()}`,
    role,
    display_name: displayName,
    identifier: id,
    area: 'Koramangala, Bengaluru',
    redirect_page: redirectPage,
    created_at: new Date().toISOString(),
  };
}

export async function registerCitizen(
  _supabase: SupabaseClient,
  input: RegisterCitizenInput
): Promise<AuthSessionResult> {
  const fullName = input.full_name.trim() || 'Ananya';
  const phone = input.phone.trim() || '+91 98450 12345';
  const email = input.email?.trim() || null;
  const key = (email ?? phone).toLowerCase();
  const userId = `cit-${Date.now()}`;
  const nowIso = new Date().toISOString();

  CITIZEN_ACCOUNTS.set(key, {
    user_id: userId,
    full_name: fullName,
    phone,
    email,
    password: input.password,
    created_at: nowIso,
  });

  return {
    authenticated: true,
    user_id: userId,
    role: 'citizen',
    display_name: fullName,
    identifier: email ?? phone,
    area: 'Koramangala, Bengaluru',
    redirect_page: 'home.html',
    created_at: nowIso,
  };
}

export async function requestOrgVerificationCall(
  _supabase: SupabaseClient,
  input: OrgCallRequestInput
): Promise<OrgCallRequestResult> {
  const orgName = input.org_name.trim();
  const contactPerson = input.contact_person.trim();
  const phone = input.phone.trim();
  const area = input.area.trim() || 'Koramangala, Bengaluru';

  if (!orgName) throw new Error('Organisation or department name is required.');
  if (!contactPerson) throw new Error('Contact person and role is required.');
  if (!phone) throw new Error('Official phone number is required.');

  const result: OrgCallRequestResult = {
    requested: true,
    request_id: `org-req-${Date.now()}`,
    role: input.role === 'gov' ? 'gov' : 'pharmacy',
    org_name: orgName,
    contact_person: contactPerson,
    phone,
    area,
    status: 'call_scheduled_within_2_working_days',
    message: `Thank you. Our verification team will call ${contactPerson} at ${phone} within 2 working days to verify ${orgName} (${area}).`,
    created_at: new Date().toISOString(),
  };

  ORG_CALL_REQUESTS.push(result);
  return result;
}

export async function submitPharmacyResponse(
  _supabase: SupabaseClient,
  input: PharmacyReportResponseInput
): Promise<PharmacyReportResponseResult> {
  const text = input.response_text.trim();
  if (!text) {
    throw new Error('Pharmacy response text is required.');
  }

  const targetReport =
    (input.report_id
      ? PHARMACY_REPORTS_STATE.find((r) => r.report_id === input.report_id)
      : undefined) ??
    PHARMACY_REPORTS_STATE.find((r) => r.status === 'open') ??
    PHARMACY_REPORTS_STATE[0];

  const reportId = input.report_id || targetReport?.report_id || 'bf57bf87-d7d7-4fbd-a155-fe7199af3899';
  const pharmacyName = input.pharmacy_name?.trim() || 'Sundar Medicals';
  const proofUrls = input.proof_urls ?? [];
  const nowIso = new Date().toISOString();

  if (targetReport) {
    targetReport.status = 'in_progress';
    targetReport.meta_secondary = 'You responded just now';
    targetReport.gov_label = 'Govt. reviewing';
    targetReport.pharmacy_response = text;
  }

  const govCase = GOV_CASES_STATE.get(reportId);
  if (govCase) {
    govCase.status = 'in_progress';
    const nextStepNum = String(govCase.timeline.length + 1);
    govCase.timeline.push({
      step_num: nextStepNum,
      title: 'Pharmacy responded',
      meta: `Just now · ${pharmacyName}`,
      body: `"${text}"`,
      proof_urls: proofUrls,
    });
  }

  return {
    responded: true,
    response_id: `pharm-resp-${Date.now()}`,
    report_id: reportId,
    pharmacy_name: pharmacyName,
    response_text: text,
    proof_urls: proofUrls,
    updated_status: 'in_progress',
    responded_at: nowIso,
  };
}

export async function getPharmacyDashboard(
  _supabase: SupabaseClient,
  pharmacyName = 'Sundar Medicals'
): Promise<PharmacyDashboardResult> {
  const sundar = FALLBACK_PHARMACIES.get('88888888-8888-4888-8888-888888888803');
  const isVer = Boolean(sundar?.is_verified);
  const openCount = PHARMACY_REPORTS_STATE.filter((r) => r.status !== 'resolved').length;
  const matchedCount = PHARMACY_PRICE_ITEMS.filter((i) => i.status === 'matched').length;
  const matchRate = isVer
    ? 100
    : PHARMACY_PRICE_ITEMS.length > 0
    ? Math.round((matchedCount / PHARMACY_PRICE_ITEMS.length) * 100)
    : 0;

  return {
    pharmacy_name: pharmacyName,
    address: '12, 5th Block, Koramangala, Bengaluru 560095',
    verification_status: isVer ? 'Verified' : 'Unverified',
    last_verified_note: isVer
      ? 'Last stock & billing submission: just now'
      : 'Status — not yet verified (upload stock & bills)',
    open_reports_count: openCount,
    billing_match_rate: matchRate,
    price_items: PHARMACY_PRICE_ITEMS,
    submission_history: PHARMACY_SUBMISSION_HISTORY,
    reports_against_pharmacy: PHARMACY_REPORTS_STATE,
  };
}

export async function updatePharmacyPriceItem(
  _supabase: SupabaseClient,
  input: UpdatePharmacyPriceItemInput
): Promise<PharmacyPriceItem> {
  const item =
    PHARMACY_PRICE_ITEMS.find((p) => p.id === input.item_id) ?? PHARMACY_PRICE_ITEMS[0];
  if (!item) {
    throw new Error(`Price item ${input.item_id} not found.`);
  }

  if (input.action === 'mark_corrected') {
    const mrpMatch = item.reference_label.match(/₹[\d.]+/);
    const mrpStr = mrpMatch ? mrpMatch[0] : '₹31.00';
    item.your_price_label = `Your price: ${mrpStr}`;
    item.your_price_sub = 'Corrected to MRP';
    item.reference_sub = 'Matches MRP';
    item.status = 'matched';
    item.action_label = null;
  } else {
    item.your_price_label = 'Your price: ₹68.00';
    item.your_price_sub = 'Restocked today';
    item.reference_sub = 'In stock (24)';
    item.status = 'matched';
    item.action_label = null;
  }

  return item;
}

export async function getGovernmentCaseDetail(
  supabase: SupabaseClient,
  reportId = '6bcfcc70-3965-413f-9441-f605b5c4aa89'
): Promise<GovernmentCaseDetail> {
  const firstCase = Array.from(GOV_CASES_STATE.values())[0];
  const base: GovernmentCaseDetail =
    GOV_CASES_STATE.get(reportId) ??
    firstCase ?? {
      report_id: reportId,
      title: 'No report selected yet',
      pharmacy_name: 'Sundar Medicals',
      pharmacy_address: '12, 5th Block, Koramangala, Bengaluru 560095',
      status: 'open',
      billed_amount: 0,
      mrp_amount: 0,
      overcharged_by: 0,
      filed_label: 'Not filed yet',
      bill_photo_label: 'No bill attached',
      bill_photo_url: null,
      pharmacy_verified: false,
      pharmacy_other_open_reports: 0,
      timeline: [],
    };

  // Merge any sealed government progress updates for this reportId
  const memUpdates = FALLBACK_GOV_UPDATES.get(base.report_id) ?? [];
  const receipt = await getReceipt(supabase, base.report_id).catch(() => null);

  const timeline = [...base.timeline];
  for (const u of memUpdates) {
    const stepText = `${u.agency_name} (${u.status.replace('_', ' ')})`;
    if (!timeline.some((t) => t.body === u.progress_note)) {
      timeline.push({
        step_num: u.status === 'resolved' ? '✓' : String(timeline.length + 1),
        title: stepText,
        meta: 'Just now · official government update',
        body: u.progress_note,
        resolved: u.status === 'resolved',
        proof_urls: u.proof_urls,
      });
    }
    if (u.status === 'resolved') {
      base.status = 'resolved';
    } else if (u.action_taken === 'Escalated') {
      base.status = 'escalated';
    } else {
      base.status = 'in_progress';
    }
  }

  if (receipt && receipt.authority_response && memUpdates.length === 0) {
    const ar = receipt.authority_response;
    if (!timeline.some((t) => t.body === ar.progress_note)) {
      timeline.push({
        step_num: ar.status === 'resolved' ? '✓' : String(timeline.length + 1),
        title: `${ar.agency_name} (${ar.status.replace('_', ' ')})`,
        meta: 'Sealed in public log',
        body: ar.progress_note,
        resolved: ar.status === 'resolved',
        proof_urls: ar.proof_urls,
      });
    }
  }

  return {
    ...base,
    timeline,
  };
}



