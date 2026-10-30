/**
 * MediCheck CSV Importer & Validator (Phase 2)
 * Usage:
 *   npm run import -- --dry-run               (validate ./data and write import_report.md)
 *   npm run import                            (validate ./data; if valid, replace SAMPLE rows & upsert real rows)
 *   npm run import -- --dir ./sample_data --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// =============================================================================
// Types & Dataset Specifications
// =============================================================================

type RawRow = Record<string, string>;
type Severity = 'error' | 'warning' | 'autofix';

export interface ValidationIssue {
  file: string;
  row: number | null;
  column: string | null;
  severity: Severity;
  reason: string;
  tag?: 'price_text' | 'source' | 'header' | 'ppu' | 'barcode' | 'norm';
}

interface DatasetSpec {
  dataset: string;
  file: string;
  requiredColumns: string[];
  optionalColumns: string[];
  requiredFields: string[];
  numericFields: string[];
  dateFields: string[];
  enums: Record<string, string[]>;
  mrpColumn?: string;
}

interface ParsedRow {
  line: number;
  valid: boolean;
  record: Record<string, unknown>;
}

interface LoadedDataset {
  spec: DatasetSpec;
  present: boolean;
  headerValid: boolean;
  rows: ParsedRow[];
}

const ALLOWED_HANDLES = ['price', 'shortage', 'quality', 'bill_refusal'];

const SPECS: DatasetSpec[] = [
  {
    dataset: 'ceiling_prices',
    file: 'ceiling_prices.csv',
    requiredColumns: [
      'salt_normalized',
      'strength',
      'dosage_form',
      'pack_unit',
      'ceiling_price',
      'gst_note',
      'effective_date',
      'notification_ref',
      'source_url',
      'source_date',
      'notes',
    ],
    optionalColumns: [],
    requiredFields: [
      'salt_normalized',
      'strength',
      'dosage_form',
      'pack_unit',
      'ceiling_price',
      'effective_date',
      'notification_ref',
      'source_url',
      'source_date',
    ],
    numericFields: ['ceiling_price'],
    dateFields: ['effective_date', 'source_date'],
    enums: {},
  },
  {
    dataset: 'nsq_alerts',
    file: 'nsq_alerts.csv',
    requiredColumns: [
      'alert_month',
      'category',
      'drug_name',
      'salt_normalized',
      'brand_name',
      'batch_number',
      'manufacturer',
      'manufacturing_date',
      'expiry_date',
      'failure_reason',
      'testing_lab',
      'source_url',
      'source_date',
      'notes',
    ],
    optionalColumns: [],
    requiredFields: [
      'alert_month',
      'category',
      'drug_name',
      'manufacturer',
      'source_url',
      'source_date',
    ],
    numericFields: [],
    dateFields: ['source_date'],
    enums: { category: ['NSQ', 'SPURIOUS'] },
  },
  {
    dataset: 'jan_aushadhi_products',
    file: 'jan_aushadhi_products.csv',
    requiredColumns: [
      'ja_product_code',
      'generic_name',
      'salt_normalized',
      'strength',
      'dosage_form',
      'pack_size',
      'pack_unit',
      'mrp',
      'price_per_unit',
      'source_url',
      'source_date',
      'notes',
    ],
    optionalColumns: [],
    requiredFields: [
      'generic_name',
      'salt_normalized',
      'strength',
      'dosage_form',
      'pack_size',
      'pack_unit',
      'mrp',
      'source_url',
      'source_date',
    ],
    numericFields: ['pack_size', 'mrp', 'price_per_unit'],
    dateFields: ['source_date'],
    enums: {},
    mrpColumn: 'mrp',
  },
  {
    dataset: 'brand_products',
    file: 'brand_products.csv',
    requiredColumns: [
      'brand_name',
      'manufacturer',
      'salt_normalized',
      'strength',
      'dosage_form',
      'pack_size',
      'pack_unit',
      'printed_mrp',
      'price_per_unit',
      'mrp_source',
      'mrp_date',
      'schedule_status',
      'notes',
    ],
    optionalColumns: [],
    requiredFields: [
      'brand_name',
      'manufacturer',
      'salt_normalized',
      'strength',
      'dosage_form',
      'pack_size',
      'pack_unit',
      'printed_mrp',
      'mrp_source',
      'mrp_date',
      'schedule_status',
    ],
    numericFields: ['pack_size', 'printed_mrp', 'price_per_unit'],
    dateFields: ['mrp_date'],
    enums: { schedule_status: ['scheduled', 'non_scheduled', 'unknown'] },
    mrpColumn: 'printed_mrp',
  },
  {
    dataset: 'barcodes',
    file: 'barcodes.csv',
    requiredColumns: [
      'barcode',
      'barcode_type',
      'brand_name',
      'pack_size',
      'source',
      'notes',
    ],
    optionalColumns: [],
    requiredFields: ['barcode', 'barcode_type', 'brand_name', 'pack_size', 'source'],
    numericFields: ['pack_size'],
    dateFields: [],
    enums: { barcode_type: ['EAN13', 'QR', 'DATAMATRIX', 'GS1_128'] },
  },
  {
    dataset: 'authorities',
    file: 'authorities.csv',
    requiredColumns: [
      'authority_name',
      'authority_type',
      'state',
      'complaint_url',
      'email',
      'phone',
      'handles',
      'source_url',
      'source_date',
    ],
    optionalColumns: ['notes'],
    requiredFields: [
      'authority_name',
      'authority_type',
      'handles',
      'source_url',
      'source_date',
    ],
    numericFields: [],
    dateFields: ['source_date'],
    enums: {
      authority_type: [
        'central_pricing',
        'central_quality',
        'state_drug_controller',
        'consumer_forum',
      ],
    },
  },
];

// =============================================================================
// Normalisation & Validation Helpers
// =============================================================================

const PLAIN_NUMBER_RE = /^\d+(\.\d+)?$/;
const STRENGTH_PART_RE = /^\d+(\.\d+)?\s(mg|mcg|g|kg|ml|l|iu|%|w\/v|w\/w|units)(\/(\d+(\.\d+)?\s?)?(mg|mcg|g|ml|l|dose|actuation))?$/i;
const PHARMACOPOEIA_WORDS = new Set(['ip', 'bp', 'usp']);

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidAlertMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * Normalises a salt string according to Spec 4.1:
 * - lowercase
 * - strip IP/BP/USP suffix tokens
 * - map acetaminophen -> paracetamol
 * - combinations alphabetical joined with " + "
 */
export function normalizeSalt(raw: string): { normalized: string; reasons: string[] } {
  const reasons: string[] = [];
  const cleaned = raw.replace(/\u00A0/g, ' ').trim();
  if (cleaned !== cleaned.toLowerCase()) {
    reasons.push('lowercased salt_normalized');
  }

  const rawParts = cleaned
    .toLowerCase()
    .replace(/\s*(\+|&|\band\b)\s*/gi, '+')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);

  const processedParts = rawParts.map((part) => {
    const tokens = part.split(/\s+/).filter(Boolean);
    const filtered = tokens.filter((t) => {
      const bare = t.replace(/\./g, '');
      if (PHARMACOPOEIA_WORDS.has(bare)) {
        reasons.push(`stripped pharmacopoeia suffix "${t}"`);
        return false;
      }
      return true;
    });
    let joined = filtered.join(' ');
    if (joined === 'acetaminophen') {
      reasons.push('mapped acetaminophen -> paracetamol');
      joined = 'paracetamol';
    }
    return joined;
  });

  const sorted = [...processedParts].sort((a, b) => a.localeCompare(b));
  if (processedParts.length > 1 && sorted.join(' + ') !== processedParts.join(' + ')) {
    reasons.push('reordered combination salts alphabetically');
  }

  const normalized = sorted.join(' + ');
  if (rawParts.length > 1 && !cleaned.includes(' + ') && normalized !== cleaned.toLowerCase()) {
    reasons.push('standardised combination separator to " + "');
  }

  return { normalized, reasons: [...new Set(reasons)] };
}

/**
 * Normalises a strength string according to Spec 4.2:
 * - e.g. "500mg" -> "500 mg", "100mcg" -> "100 mcg", "60000 iu" -> "60000 IU"
 * - combinations joined by " + "
 */
export function normalizeStrength(raw: string): { normalized: string; reasons: string[]; valid: boolean } {
  const reasons: string[] = [];
  const cleaned = raw.replace(/\u00A0/g, ' ').trim();
  const parts = cleaned.split(/\s*\+\s*/).map((p) => {
    let s = p.trim().replace(/\s+/g, ' ');
    // Insert space between number and unit if missing (e.g. "500mg" -> "500 mg")
    const spaced = s.replace(/^(\d+(?:\.\d+)?)([A-Za-z%])/, '$1 $2');
    if (spaced !== s) {
      reasons.push(`inserted space in strength "${s}" -> "${spaced}"`);
      s = spaced;
    }
    // Lowercase units except IU
    const unitFixed = s.replace(/\b([A-Za-z]+)\b/g, (m) =>
      m.toUpperCase() === 'IU' ? 'IU' : m.toLowerCase()
    );
    if (unitFixed !== s) {
      reasons.push(`normalised unit casing "${s}" -> "${unitFixed}"`);
      s = unitFixed;
    }
    return s;
  });

  const normalized = parts.join(' + ');
  const valid = parts.every((p) => STRENGTH_PART_RE.test(p));
  return { normalized, reasons: [...new Set(reasons)], valid };
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

// =============================================================================
// Core Importer Logic
// =============================================================================

function loadDotEnv(): void {
  const p = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (!(k in process.env)) {
      process.env[k] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

function parseAndValidateDataset(
  dir: string,
  spec: DatasetSpec,
  issues: ValidationIssue[]
): LoadedDataset {
  const ds: LoadedDataset = {
    spec,
    present: false,
    headerValid: false,
    rows: [],
  };

  const filePath = path.join(dir, spec.file);
  const addIssue = (
    row: number | null,
    column: string | null,
    severity: Severity,
    reason: string,
    tag?: ValidationIssue['tag']
  ) => {
    issues.push({ file: spec.file, row, column, severity, reason, tag });
  };

  if (!fs.existsSync(filePath)) {
    addIssue(null, null, 'warning', 'File is missing in directory — skipped.');
    return ds;
  }
  ds.present = true;

  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const parsed = Papa.parse<RawRow>(text, {
    header: true,
    delimiter: ',',
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (h) => h.trim(),
  });

  for (const err of parsed.errors) {
    const line = err.row !== undefined ? err.row + 2 : null;
    addIssue(line, null, 'error', `CSV parse error: ${err.message}`);
  }

  const fields = parsed.meta.fields ?? [];
  const allowedCols = new Set([...spec.requiredColumns, ...spec.optionalColumns]);
  const missingCols = spec.requiredColumns.filter((c) => !fields.includes(c));
  const extraCols = fields.filter((c) => !allowedCols.has(c));

  for (const c of missingCols) {
    addIssue(1, c, 'error', `Missing required column "${c}"`, 'header');
  }
  for (const c of extraCols) {
    addIssue(1, c, 'error', `Unexpected extra column "${c}"`, 'header');
  }
  if (missingCols.length > 0 || extraCols.length > 0) {
    return ds;
  }
  ds.headerValid = true;

  if (parsed.data.length === 0) {
    addIssue(null, null, 'warning', 'File has headers only (0 data rows) — skipped.');
    return ds;
  }

  const allCols = [...spec.requiredColumns, ...spec.optionalColumns.filter((c) => fields.includes(c))];
  const seenCodes = new Map<string, number>();

  parsed.data.forEach((rawRow, idx) => {
    const line = idx + 2;
    let rowErrors = 0;
    const err = (col: string | null, reason: string, tag?: ValidationIssue['tag']) => {
      rowErrors++;
      addIssue(line, col, 'error', reason, tag);
    };
    const warn = (col: string | null, reason: string, tag?: ValidationIssue['tag']) => {
      addIssue(line, col, 'warning', reason, tag);
    };
    const fix = (col: string | null, reason: string, tag?: ValidationIssue['tag']) => {
      addIssue(line, col, 'autofix', reason, tag);
    };

    const row: Record<string, string> = {};
    for (const c of allCols) {
      const original = rawRow[c] ?? '';
      // Auto-fix non-breaking spaces and outer whitespace cleanly
      const cleaned = original.replace(/\u00A0/g, ' ').trim();
      if (original !== cleaned && original.trim() !== '') {
        fix(c, `Normalised whitespace/NBSP in "${c}"`, 'norm');
      }
      row[c] = cleaned;
    }

    const isBlank = (c: string) => !row[c] || row[c] === '';

    // 1. Required fields check (including source_url and source_date)
    for (const reqCol of spec.requiredFields) {
      if (isBlank(reqCol)) {
        const isSource = reqCol === 'source_url' || reqCol === 'source_date' || reqCol === 'mrp_source' || reqCol === 'mrp_date';
        err(reqCol, `Required field "${reqCol}" is empty`, isSource ? 'source' : undefined);
      }
    }

    // 2. Numeric fields check (plain numbers only; reject "Rs", commas, symbols)
    const nums: Record<string, number> = {};
    for (const numCol of spec.numericFields) {
      if (isBlank(numCol)) continue;
      const val = row[numCol];
      if (!PLAIN_NUMBER_RE.test(val)) {
        err(
          numCol,
          `Invalid numeric value "${val}" in "${numCol}" (must be a plain number without "Rs", commas, or currency symbols)`,
          'price_text'
        );
      } else {
        nums[numCol] = Number(val);
        if (numCol === 'pack_size' && nums[numCol] <= 0) {
          err(numCol, 'pack_size must be > 0');
        }
      }
    }

    // 3. Date fields check (YYYY-MM-DD)
    for (const dateCol of spec.dateFields) {
      if (!isBlank(dateCol) && !isValidIsoDate(row[dateCol])) {
        const isSource = dateCol === 'source_date' || dateCol === 'mrp_date';
        err(dateCol, `Date "${row[dateCol]}" in "${dateCol}" must be YYYY-MM-DD`, isSource ? 'source' : undefined);
      }
    }

    // 4. URL check on source_url
    if (allCols.includes('source_url') && !isBlank('source_url') && !/^https?:\/\/\S+$/i.test(row.source_url)) {
      err('source_url', `source_url "${row.source_url}" must be a valid http(s) URL`, 'source');
    }

    // 5. Enums check
    for (const [enumCol, allowed] of Object.entries(spec.enums)) {
      if (!isBlank(enumCol) && !allowed.includes(row[enumCol])) {
        err(enumCol, `Invalid value "${row[enumCol]}" for "${enumCol}"; allowed: ${allowed.join(', ')}`);
      }
    }

    // 6. Normalisation checks (salt_normalized, strength, dosage_form)
    if (allCols.includes('salt_normalized') && !isBlank('salt_normalized')) {
      const { normalized, reasons } = normalizeSalt(row.salt_normalized);
      if (normalized !== row.salt_normalized) {
        fix(
          'salt_normalized',
          `Auto-normalised salt "${row.salt_normalized}" -> "${normalized}" (${reasons.join('; ')})`,
          'norm'
        );
        row.salt_normalized = normalized;
      }
    }

    if (allCols.includes('strength') && !isBlank('strength')) {
      const { normalized, reasons, valid } = normalizeStrength(row.strength);
      if (normalized !== row.strength && valid) {
        fix(
          'strength',
          `Auto-normalised strength "${row.strength}" -> "${normalized}" (${reasons.join('; ')})`,
          'norm'
        );
        row.strength = normalized;
      }
      if (!valid) {
        err('strength', `Strength "${row.strength}" does not match pattern "<number> <unit>" (e.g. "500 mg", "125 mg/5 ml")`);
      }
    }

    if (allCols.includes('dosage_form') && !isBlank('dosage_form')) {
      const lowerForm = row.dosage_form.toLowerCase();
      if (row.dosage_form !== lowerForm) {
        fix('dosage_form', `Auto-lowercased dosage_form "${row.dosage_form}" -> "${lowerForm}"`, 'norm');
        row.dosage_form = lowerForm;
      }
    }

    // 7. price_per_unit = mrp / pack_size check (recompute & flag mismatches > 0.01)
    if (
      spec.mrpColumn &&
      nums[spec.mrpColumn] !== undefined &&
      nums.pack_size !== undefined &&
      nums.pack_size > 0
    ) {
      const expectedPpu = Number((nums[spec.mrpColumn] / nums.pack_size).toFixed(2));
      const exactRatio = nums[spec.mrpColumn] / nums.pack_size;
      if (isBlank('price_per_unit')) {
        nums.price_per_unit = expectedPpu;
        row.price_per_unit = expectedPpu.toFixed(2);
        fix('price_per_unit', `Computed missing price_per_unit = ${expectedPpu.toFixed(2)} (${spec.mrpColumn} / pack_size)`, 'ppu');
      } else if (nums.price_per_unit !== undefined) {
        const diff = Math.abs(nums.price_per_unit - exactRatio);
        if (diff > 0.011) {
          err(
            'price_per_unit',
            `price_per_unit (${nums.price_per_unit}) does not match ${spec.mrpColumn} / pack_size (${exactRatio.toFixed(4)}); recomputed expected value is ${expectedPpu.toFixed(2)}`,
            'ppu'
          );
        }
      }
    }

    // 8. Dataset-specific checks
    if (spec.dataset === 'nsq_alerts') {
      if (!isBlank('alert_month') && !isValidAlertMonth(row.alert_month)) {
        err('alert_month', `alert_month "${row.alert_month}" must be YYYY-MM`);
      }
      if (isBlank('batch_number')) {
        if (isBlank('notes')) {
          err('batch_number', 'batch_number is empty and notes has no explanation');
        } else {
          warn('batch_number', 'batch_number is empty (kept with explanation in notes; will not match batch queries)');
        }
      }
      if (isBlank('salt_normalized')) {
        warn('salt_normalized', 'salt_normalized is empty (allowed by spec when ambiguous; requires migration 0005 if DB column is NOT NULL)');
      }
    }

    if (spec.dataset === 'barcodes') {
      if (!isBlank('barcode')) {
        if (seenCodes.has(row.barcode)) {
          err('barcode', `Duplicate barcode "${row.barcode}" (first seen at line ${seenCodes.get(row.barcode)})`, 'barcode');
        } else {
          seenCodes.set(row.barcode, line);
        }
        if (row.barcode_type === 'EAN13' && !/^\d{13}$/.test(row.barcode)) {
          err('barcode', `EAN13 barcode "${row.barcode}" must be 13 digits (kept as text with leading zeros)`, 'barcode');
        } else if (!/^\d+$/.test(row.barcode) && row.barcode_type === 'EAN13') {
          err('barcode', `Barcode "${row.barcode}" must contain digits only`, 'barcode');
        }
      }
    }

    if (spec.dataset === 'authorities') {
      if (!isBlank('handles')) {
        const handleParts = row.handles.split(',').map((h) => h.trim()).filter(Boolean);
        const invalidHandles = handleParts.filter((h) => !ALLOWED_HANDLES.includes(h));
        if (invalidHandles.length > 0) {
          err('handles', `Invalid handles [${invalidHandles.join(', ')}]; allowed: ${ALLOWED_HANDLES.join(', ')}`);
        }
        row.handles = handleParts.join(',');
      }
      if (row.authority_type === 'state_drug_controller' && isBlank('state')) {
        err('state', 'state is required when authority_type is state_drug_controller');
      }
      if (
        row.authority_type &&
        row.authority_type !== 'state_drug_controller' &&
        !isBlank('state')
      ) {
        err('state', `state must be empty (NULL) for central authority_type "${row.authority_type}"`);
      }
    }

    // Build DB record
    const record: Record<string, unknown> = {};
    for (const c of allCols) {
      if (spec.dataset === 'barcodes' && c === 'brand_name') continue;
      if (isBlank(c)) {
        record[c] = null;
      } else if (spec.numericFields.includes(c) && nums[c] !== undefined) {
        record[c] = nums[c];
      } else {
        record[c] = row[c];
      }
    }
    if (spec.dataset === 'brand_products') {
      record.id = randomUUID();
    }
    if (spec.dataset === 'barcodes') {
      record.__brand_name = row.brand_name;
    }

    ds.rows.push({ line, valid: rowErrors === 0, record });
  });

  return ds;
}

// =============================================================================
// Cross-File Checks & Barcode Resolution
// =============================================================================

interface CrossFileStats {
  brandCount: number;
  ceilingMatchCount: number;
  ceilingMatchedBrands: string[];
  jaMatchCount: number;
  jaMatchedBrands: string[];
  nsqMonths: string[];
  inconsistentSalts: Array<{
    saltA: string;
    filesA: string[];
    saltB: string;
    filesB: string[];
    note: string;
  }>;
}

function runCrossFileChecks(
  datasets: Record<string, LoadedDataset>,
  issues: ValidationIssue[]
): CrossFileStats {
  // 1. Resolve barcodes.brand_name against brand_products
  const bpRows = datasets.brand_products.rows;
  const bcRows = datasets.barcodes.rows;

  for (const bc of bcRows) {
    const brandName = String(bc.record.__brand_name ?? '').trim();
    const packSize = Number(bc.record.pack_size);
    delete bc.record.__brand_name;
    if (!brandName) continue;

    const exactMatches = bpRows.filter(
      (b) =>
        String(b.record.brand_name ?? '').toLowerCase() === brandName.toLowerCase() &&
        Number(b.record.pack_size) === packSize
    );
    const nameOnlyMatches = bpRows.filter(
      (b) => String(b.record.brand_name ?? '').toLowerCase() === brandName.toLowerCase()
    );

    const match = exactMatches[0] ?? (nameOnlyMatches.length === 1 ? nameOnlyMatches[0] : null);
    if (!match) {
      bc.valid = false;
      issues.push({
        file: 'barcodes.csv',
        row: bc.line,
        column: 'brand_name',
        severity: 'error',
        reason: `barcodes.brand_name "${brandName}" (pack_size ${packSize}) does not match any row in brand_products.csv`,
        tag: 'barcode',
      });
    } else {
      bc.record.brand_product_id = match.record.id;
    }
  }

  // 2. Match keys: salt_normalized | strength | dosage_form
  const makeKey = (r: Record<string, unknown>) =>
    `${String(r.salt_normalized ?? '').toLowerCase()}|${String(r.strength ?? '').toLowerCase()}|${String(r.dosage_form ?? '').toLowerCase()}`;

  const ceilingKeys = new Set(datasets.ceiling_prices.rows.map((r) => makeKey(r.record)));
  const jaKeys = new Set(datasets.jan_aushadhi_products.rows.map((r) => makeKey(r.record)));

  const ceilingMatchedBrands: string[] = [];
  const jaMatchedBrands: string[] = [];

  for (const bp of bpRows) {
    const k = makeKey(bp.record);
    const bName = String(bp.record.brand_name ?? '');
    if (ceilingKeys.has(k)) ceilingMatchedBrands.push(bName);
    if (jaKeys.has(k)) jaMatchedBrands.push(bName);
  }

  // 3. NSQ months covered
  const nsqMonths = [
    ...new Set(
      datasets.nsq_alerts.rows
        .map((r) => String(r.record.alert_month ?? ''))
        .filter(Boolean)
    ),
  ].sort();

  // 4. Salt spelling consistency across files (fuzzy + base salt vs salt suffix like hydrochloride/sodium/sulfate)
  const saltToFiles = new Map<string, Set<string>>();
  for (const dsName of ['ceiling_prices', 'nsq_alerts', 'jan_aushadhi_products', 'brand_products']) {
    const ds = datasets[dsName];
    for (const r of ds.rows) {
      const s = String(r.record.salt_normalized ?? '').trim().toLowerCase();
      if (!s) continue;
      if (!saltToFiles.has(s)) saltToFiles.set(s, new Set());
      saltToFiles.get(s)!.add(ds.spec.file);
    }
  }

  const stripSaltForm = (s: string) =>
    s
      .replace(
        /\b(hydrochloride|hcl|sodium|potassium|calcium|maleate|besylate|tartrate|succinate|sulfate|sulphate|mesylate|citrate|fumarate|proxetil|axetil|trihydrate|dihydrate|monohydrate)\b/g,
        ''
      )
      .replace(/\s+/g, ' ')
      .trim();

  const salts = [...saltToFiles.keys()].sort();
  const inconsistentSalts: CrossFileStats['inconsistentSalts'] = [];

  for (let i = 0; i < salts.length; i++) {
    for (let j = i + 1; j < salts.length; j++) {
      const a = salts[i];
      const b = salts[j];
      const filesA = [...saltToFiles.get(a)!];
      const filesB = [...saltToFiles.get(b)!];

      const baseA = stripSaltForm(a);
      const baseB = stripSaltForm(b);
      const maxLen = Math.max(a.length, b.length);
      const sim = 1 - levenshtein(a, b) / maxLen;

      if (baseA && baseA === baseB) {
        inconsistentSalts.push({
          saltA: a,
          filesA,
          saltB: b,
          filesB,
          note: `Base salt "${baseA}" appears with and without salt/ester modifier across files`,
        });
      } else if (sim >= 0.82) {
        inconsistentSalts.push({
          saltA: a,
          filesA,
          saltB: b,
          filesB,
          note: `High spelling similarity (${(sim * 100).toFixed(0)}%)`,
        });
      }
    }
  }

  return {
    brandCount: bpRows.length,
    ceilingMatchCount: ceilingMatchedBrands.length,
    ceilingMatchedBrands,
    jaMatchCount: jaMatchedBrands.length,
    jaMatchedBrands,
    nsqMonths,
    inconsistentSalts,
  };
}

// =============================================================================
// Markdown Report Generation (import_report.md)
// =============================================================================

function writeImportReport(
  reportPath: string,
  dir: string,
  dryRun: boolean,
  datasets: Record<string, LoadedDataset>,
  stats: CrossFileStats,
  issues: ValidationIssue[],
  dbWriteSummary: string[]
): { criticalErrors: number; checklistAllPass: boolean } {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const autofixes = issues.filter((i) => i.severity === 'autofix');

  const headerErrors = errors.filter((e) => e.tag === 'header').length;
  const priceErrors = errors.filter((e) => e.tag === 'price_text').length;
  const sourceErrors = errors.filter((e) => e.tag === 'source').length;
  const ppuErrors = errors.filter((e) => e.tag === 'ppu').length;
  const barcodeErrors = errors.filter((e) => e.tag === 'barcode').length;

  const allPresent = SPECS.every((s) => datasets[s.dataset].present && datasets[s.dataset].headerValid);

  const checklist: Array<{ check: string; pass: boolean; detail: string }> = [
    {
      check: 'All six CSVs present with exact column names',
      pass: allPresent && headerErrors === 0,
      detail: `${headerErrors} header error(s)`,
    },
    {
      check: 'Plain-number prices (no "Rs", commas, or currency symbols)',
      pass: priceErrors === 0,
      detail: `${priceErrors} price format error(s)`,
    },
    {
      check: 'source_url and source_date filled and valid on every row',
      pass: sourceErrors === 0,
      detail: `${sourceErrors} missing/invalid source field(s)`,
    },
    {
      check: 'price_per_unit = mrp / pack_size within 0.01',
      pass: ppuErrors === 0,
      detail: `${ppuErrors} mismatch(es), ${autofixes.filter((a) => a.tag === 'ppu').length} auto-computed`,
    },
    {
      check: 'Barcodes valid & every barcodes.brand_name matches brand_products',
      pass: barcodeErrors === 0,
      detail: `${ datasets.barcodes.rows.length } barcode row(s), ${barcodeErrors} error(s)`,
    },
    {
      check: 'Spec target: brand_products.csv >= 100 rows',
      pass: stats.brandCount >= 100,
      detail: `${stats.brandCount} row(s)`,
    },
    {
      check: 'Spec target: >= 20 brand_products match a ceiling_prices row',
      pass: stats.ceilingMatchCount >= 20,
      detail: `${stats.ceilingMatchCount} matched (${stats.ceilingMatchedBrands.join(', ') || 'none'})`,
    },
    {
      check: 'Spec target: nsq_alerts.csv covers >= 6 monthly lists',
      pass: stats.nsqMonths.length >= 6,
      detail: `${stats.nsqMonths.length} month(s) (${stats.nsqMonths.join(', ') || 'none'})`,
    },
    {
      check: 'Spec target: >= 15 brand_products have a Jan Aushadhi equivalent',
      pass: stats.jaMatchCount >= 15,
      detail: `${stats.jaMatchCount} matched (${stats.jaMatchedBrands.join(', ') || 'none'})`,
    },
  ];

  const L: string[] = [];
  L.push('# MediCheck Data Import & Validation Report');
  L.push('');
  L.push(`- **Source Directory:** \`${dir}\``);
  L.push(`- **Mode:** ${dryRun ? 'DRY RUN (`--dry-run`)' : 'LIVE IMPORT'}`);
  L.push(`- **Generated At:** ${new Date().toISOString()}`);
  L.push(`- **Row Validation Errors:** ${errors.length}`);
  L.push(`- **Warnings:** ${warnings.length}`);
  L.push(`- **Unambiguous Auto-Fixes Applied:** ${autofixes.length}`);
  L.push('');

  L.push('## 1. Spec Acceptance Checklist');
  L.push('');
  L.push('| Status | Checklist Item | Observed Detail |');
  L.push('|---|---|---|');
  for (const item of checklist) {
    L.push(`| **${item.pass ? 'PASS' : 'FAIL'}** | ${item.check} | ${item.detail} |`);
  }
  L.push('');

  L.push('## 2. Dataset Summary');
  L.push('');
  L.push('| Dataset File | Present | Header OK | Total Rows | Valid Rows | Row Errors |');
  L.push('|---|---|---|---|---|---|');
  for (const s of SPECS) {
    const ds = datasets[s.dataset];
    const validCount = ds.rows.filter((r) => r.valid).length;
    const fileErrCount = errors.filter((e) => e.file === s.file).length;
    L.push(
      `| \`${s.file}\` | ${ds.present ? 'yes' : 'no'} | ${ds.headerValid ? 'yes' : 'no'} | ${ds.rows.length} | ${validCount} | ${fileErrCount} |`
    );
  }
  L.push('');

  L.push('## 3. Cross-File Matching & Consistency Report');
  L.push('');
  L.push(
    `- **Brand products matching an NPPA ceiling row** (\`salt_normalized | strength | dosage_form\`): **${stats.ceilingMatchCount} / ${stats.brandCount}** (${stats.ceilingMatchedBrands.join(', ') || 'none'})`
  );
  L.push(
    `- **Brand products with a Jan Aushadhi equivalent** (\`salt_normalized | strength | dosage_form\`): **${stats.jaMatchCount} / ${stats.brandCount}** (${stats.jaMatchedBrands.join(', ') || 'none'})`
  );
  L.push(
    `- **CDSCO NSQ alert months covered (${stats.nsqMonths.length}):** ${stats.nsqMonths.join(', ') || 'none'}`
  );
  L.push('');
  L.push('### Salts with Inconsistent Spelling Across Files');
  L.push('');
  if (stats.inconsistentSalts.length === 0) {
    L.push('- None detected.');
  } else {
    for (const pair of stats.inconsistentSalts) {
      L.push(
        `- \`${pair.saltA}\` (in ${pair.filesA.join(', ')}) vs \`${pair.saltB}\` (in ${pair.filesB.join(', ')}) — *${pair.note}*`
      );
    }
  }
  L.push('');

  if (dbWriteSummary.length > 0) {
    L.push('## 4. Database Import Actions');
    L.push('');
    for (const msg of dbWriteSummary) {
      L.push(`- ${msg}`);
    }
    L.push('');
  }

  L.push(`## 5. Unambiguous Normalisation Auto-Fixes (${autofixes.length})`);
  L.push('');
  if (autofixes.length === 0) {
    L.push('None.');
  } else {
    L.push('| File | Row | Column | Change Applied |');
    L.push('|---|---|---|---|');
    for (const a of autofixes) {
      L.push(`| \`${a.file}\` | ${a.row ?? '-'} | \`${a.column ?? '-'}\` | ${a.reason.replace(/\|/g, '\\|')} |`);
    }
  }
  L.push('');

  L.push(`## 6. Validation Errors (${errors.length})`);
  L.push('');
  if (errors.length === 0) {
    L.push('None.');
  } else {
    L.push('| File | Row | Column | Error Reason |');
    L.push('|---|---|---|---|');
    for (const e of errors) {
      L.push(`| \`${e.file}\` | ${e.row ?? '-'} | \`${e.column ?? '-'}\` | ${e.reason.replace(/\|/g, '\\|')} |`);
    }
  }
  L.push('');

  L.push(`## 7. Warnings (${warnings.length})`);
  L.push('');
  if (warnings.length === 0) {
    L.push('None.');
  } else {
    L.push('| File | Row | Column | Warning |');
    L.push('|---|---|---|---|');
    for (const w of warnings) {
      L.push(`| \`${w.file}\` | ${w.row ?? '-'} | \`${w.column ?? '-'}\` | ${w.reason.replace(/\|/g, '\\|')} |`);
    }
  }
  L.push('');

  fs.writeFileSync(reportPath, L.join('\n'), 'utf8');
  return {
    criticalErrors: errors.length,
    checklistAllPass: checklist.every((c) => c.pass),
  };
}

// =============================================================================
// Database Upsert Logic (replaces SAMPLE rows only, never deletes real rows)
// =============================================================================

async function commitDatasetsToSupabase(
  sb: SupabaseClient,
  datasets: Record<string, LoadedDataset>,
  summary: string[]
): Promise<void> {
  const todayIso = new Date().toISOString();
  const order = [
    'brand_products',
    'barcodes',
    'ceiling_prices',
    'nsq_alerts',
    'jan_aushadhi_products',
    'authorities',
  ];

  for (const name of order) {
    const ds = datasets[name];
    if (!ds.present || !ds.headerValid) {
      summary.push(`Skipped \`${name}\`: file missing or invalid header.`);
      continue;
    }
    const validRows = ds.rows.filter((r) => r.valid).map((r) => r.record);
    if (validRows.length === 0) {
      summary.push(`Skipped \`${name}\`: 0 valid rows to load (existing rows left untouched).`);
      continue;
    }

    // 1. Delete ONLY sample rows for this table (never touch real rows)
    if (name === 'authorities') {
      const { error: delErr1 } = await sb.from('authorities').delete().ilike('source_url', '%sample%');
      if (delErr1) throw new Error(`Failed deleting sample authorities by source_url: ${delErr1.message}`);
      const { error: delErr2 } = await sb.from('authorities').delete().ilike('notes', 'SAMPLE%');
      if (delErr2) throw new Error(`Failed deleting sample authorities by notes: ${delErr2.message}`);
    } else {
      const { error: delErr } = await sb.from(name).delete().ilike('notes', 'SAMPLE%');
      if (delErr) throw new Error(`Failed deleting SAMPLE rows from ${name}: ${delErr.message}`);
    }

    // 2. Insert/upsert in batches of 500
    for (let i = 0; i < validRows.length; i += 500) {
      const batch = validRows.slice(i, i + 500);
      if (name === 'barcodes') {
        const { error } = await sb.from(name).upsert(batch, { onConflict: 'barcode' });
        if (error) throw new Error(`Failed upserting barcodes batch: ${error.message}`);
      } else if (name === 'jan_aushadhi_products') {
        const { error } = await sb.from(name).upsert(batch, { onConflict: 'ja_product_code' });
        if (error) throw new Error(`Failed upserting jan_aushadhi_products batch: ${error.message}`);
      } else {
        const { error } = await sb.from(name).insert(batch);
        if (error) throw new Error(`Failed inserting ${name} batch: ${error.message}`);
      }
    }

    // 3. Update data_versions (dataset_name, loaded_on, source_date = max source_date, row_count)
    const dateCol = name === 'brand_products' ? 'mrp_date' : 'source_date';
    const dates = validRows
      .map((r) => r[dateCol])
      .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();

    if (dates.length > 0) {
      const maxSourceDate = dates[dates.length - 1];
      const { error: dvErr } = await sb.from('data_versions').upsert(
        {
          dataset_name: name,
          loaded_on: todayIso,
          source_date: maxSourceDate,
          row_count: validRows.length,
        },
        { onConflict: 'dataset_name' }
      );
      if (dvErr) throw new Error(`Failed updating data_versions for ${name}: ${dvErr.message}`);
      summary.push(
        `Loaded \`${name}\`: deleted SAMPLE rows, upserted ${validRows.length} row(s), updated \`data_versions\` (\`source_date = ${maxSourceDate}\`).`
      );
    } else {
      summary.push(`Loaded \`${name}\`: deleted SAMPLE rows, upserted ${validRows.length} row(s).`);
    }
  }
}

// =============================================================================
// CLI Entrypoint
// =============================================================================

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const dir = path.resolve(getArg('--dir') ?? './data');
  const dryRun = argv.includes('--dry-run') || (!argv.includes('--commit') && argv.includes('--dry'));
  const reportPath = path.resolve(getArg('--report') ?? 'import_report.md');

  console.log(`=== MediCheck CSV Importer (${dryRun ? 'DRY RUN' : 'LIVE MODE'}) ===`);
  console.log(`Directory : ${dir}`);

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const issues: ValidationIssue[] = [];
  const datasets: Record<string, LoadedDataset> = {};

  for (const spec of SPECS) {
    datasets[spec.dataset] = parseAndValidateDataset(dir, spec, issues);
  }

  const stats = runCrossFileChecks(datasets, issues);
  const dbWriteSummary: string[] = [];

  const errorCount = issues.filter((i) => i.severity === 'error').length;

  if (dryRun) {
    dbWriteSummary.push('Dry-run mode (`--dry-run`): no database changes were made.');
  } else if (errorCount > 0) {
    dbWriteSummary.push(
      `Aborted database write due to ${errorCount} critical validation error(s). Existing database rows were left untouched.`
    );
  } else {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
      process.exit(1);
    }
    const sb = createClient(url, key, { auth: { persistSession: false } });
    await commitDatasetsToSupabase(sb, datasets, dbWriteSummary);
  }

  const { criticalErrors } = writeImportReport(
    reportPath,
    dir,
    dryRun,
    datasets,
    stats,
    issues,
    dbWriteSummary
  );

  // Also mirror to validation_report.md if default report path was used
  if (path.basename(reportPath) === 'import_report.md') {
    fs.copyFileSync(reportPath, path.resolve('validation_report.md'));
  }

  console.log('\nDataset Summary:');
  for (const s of SPECS) {
    const ds = datasets[s.dataset];
    const validRows = ds.rows.filter((r) => r.valid).length;
    const errs = issues.filter((i) => i.file === s.file && i.severity === 'error').length;
    console.log(
      `  ${s.file.padEnd(26)} | rows: ${String(ds.rows.length).padStart(3)} | valid: ${String(validRows).padStart(3)} | errors: ${errs}`
    );
  }
  console.log(
    `\nCross-file matches: Ceiling ${stats.ceilingMatchCount}/${stats.brandCount}, Jan Aushadhi ${stats.jaMatchCount}/${stats.brandCount}, NSQ months: ${stats.nsqMonths.length}`
  );
  console.log(`Report written to : ${reportPath}`);

  if (criticalErrors > 0) {
    console.error(`\nExited with code 1: ${criticalErrors} critical validation error(s) found (see ${path.basename(reportPath)}).`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error('Importer failed:', (err as Error).message);
    process.exit(1);
  });
}
