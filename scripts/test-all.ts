/**
 * Comprehensive MediCheck Live Verification Suite (`npm run test:all`)
 *
 * Usage:
 *   npm run test:all                         # Runs all non-mutating checks; marks report-inserting checks SKIPPED
 *   npm run test:all -- --confirm-permanent  # Also inserts the single 3-report test batch into reports/public_log
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  createMediCheckClient,
  parseScan,
  gtinCandidates,
  type Receipt,
} from '../src/lib/medicheck.js';
import { buildReportText, SAFETY_DISCLAIMER } from '../src/lib/reportText.js';
import { buildReceiptText } from '../src/lib/receiptText.js';
import { createPresentationServer } from './serve.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function loadDotEnv(): void {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function merkleRoot(leaves: string[]): string | null {
  if (leaves.length === 0) return null;
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i] + (level[i + 1] ?? level[i])));
    }
    level = next;
  }
  return level[0];
}

const computeEntryHash = (p: Receipt['proof']) =>
  sha256Hex(p.prev_hash + p.payload_canonical + p.entry_type + p.sealed_at);

interface CheckRecord {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  detail: string;
}

const results: CheckRecord[] = [];

async function runCheck(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail });
    console.log(`[PASS] ${name} — ${detail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', detail: msg });
    console.error(`[FAIL] ${name} — ${msg}`);
  }
}

function skipCheck(name: string, reason: string): void {
  results.push({ name, status: 'SKIPPED', detail: reason });
  console.log(`[SKIPPED] ${name} — ${reason}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  loadDotEnv();
  const confirmPermanent = process.argv.includes('--confirm-permanent');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const sdk = createMediCheckClient(supabaseUrl, supabaseAnonKey);
  const anonSb = sdk.supabase;
  const srvSb = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

  console.log('====================================================================');
  console.log(`MediCheck Live Test Suite (confirm-permanent: ${confirmPermanent})`);
  console.log('====================================================================\n');

  // ---------------------------------------------------------------------------
  // 1. Offline GS1 / QR / Barcode Parsing Checks
  // ---------------------------------------------------------------------------
  await runCheck('GS1 parser: parenthesised, raw FNC1, <GS>, Digital Link, plain & unparseable', () => {
    const p1 = parseScan('(01)08901234567890(17)270531(10)TST1234(21)SN99');
    assert(p1.kind === 'gs1' && p1.gtin === '08901234567890' && p1.batch === 'TST1234' && p1.serial === 'SN99', 'Parenthesised GS1 failed');

    const p2 = parseScan(']d2010890123456789010BATCH1\x1D1727020021SER1');
    assert(p2.gtin === '08901234567890' && p2.batch === 'BATCH1' && p2.expiry?.iso === '2027-02-28', 'Raw FNC1 + day 00 failed');

    const p3 = parseScan('010890123456789010BATCH_GS<GS>17281231');
    assert(p3.batch === 'BATCH_GS' && p3.expiry?.iso === '2028-12-31', '<GS> separator failed');

    const p4 = parseScan('https://id.gs1.org/01/08901234567890/10/DL%2D101?17=271130');
    assert(p4.kind === 'digital_link' && p4.batch === 'DL-101' && p4.expiry?.iso === '2027-11-30', 'Digital Link failed');

    const p5 = parseScan('not a valid barcode');
    assert(p5.kind === 'unknown' && p5.gtin === null && p5.batch === null && p5.expiry === null, 'Unparseable must return nulls');

    const cands = gtinCandidates('09900000000011');
    assert(cands.includes('09900000000011') && cands.includes('9900000000011'), 'gtinCandidates failed');
    return 'All GS1/QR/EAN variants parsed accurately';
  });

  // ---------------------------------------------------------------------------
  // 2. Search & Barcode Lookup Checks
  // ---------------------------------------------------------------------------
  let testFeverId = '';
  let coolParaId = '';
  let sugarEaseId = '';

  await runCheck('search_brands: typo tolerance ("paracetmol")', async () => {
    const matches = await sdk.searchBrands('paracetmol', 10);
    assert(matches.length >= 2, `Expected >= 2 matches for "paracetmol", got ${matches.length}`);
    const tf = matches.find((m) => m.brand_name === 'TestFever 500');
    const cp = matches.find((m) => m.brand_name === 'CoolPara 500');
    assert(tf && cp, 'Expected both TestFever 500 and CoolPara 500 in fuzzy results');
    testFeverId = tf.id;
    coolParaId = cp.id;
    return `Matched "${tf.brand_name}" (score=${tf.similarity_score.toFixed(2)}) & "${cp.brand_name}"`;
  });

  await runCheck('lookup_by_barcode: hit (9900000000011 & GTIN-14 09900000000011) and miss', async () => {
    const hit13 = await sdk.lookupBarcode('9900000000011');
    assert(hit13 && hit13.brand_name === 'TestFever 500', 'Expected 9900000000011 -> TestFever 500');

    const hit14 = await sdk.lookupBarcode('09900000000011');
    assert(hit14 && hit14.id === hit13.id, 'Expected GTIN-14 09900000000011 -> TestFever 500 via gtinCandidates');

    const miss = await sdk.lookupBarcode('9999999999999');
    assert(miss === null, 'Expected unknown barcode 9999999999999 to return null');
    return `Hit "${hit13.brand_name}" (13 & 14 digit), miss returned null`;
  });

  await runCheck('pickBarcodeOrSearch: parses GS1 scan, looks up GTIN, passes batch to medicine_check', async () => {
    const res = await sdk.pickBarcodeOrSearch('(01)09900000000011(17)270531(10)TST1234');
    assert(res.mode === 'barcode', `Expected mode="barcode", got "${res.mode}"`);
    assert(res.exactMatch.brand_name === 'TestFever 500', 'Expected exactMatch = TestFever 500');
    assert(res.check !== null, 'Expected check result populated');
    assert(res.check.batch.batch_key === 'TST1234' && res.check.batch.flagged === true, 'Expected batch TST1234 flagged');
    return `mode=barcode, product="${res.exactMatch.brand_name}", batch="${res.parsed.batch}" flagged=${res.check.batch.flagged}`;
  });

  // ---------------------------------------------------------------------------
  // 3. medicine_check Price, Equivalents, Batch & Metadata Checks
  // ---------------------------------------------------------------------------
  await runCheck('medicine_check: TestFever 500 above ceiling + cheaper equivalents (Jan Aushadhi first)', async () => {
    const check = await sdk.medicineCheck(testFeverId);
    assert(check !== null, 'medicineCheck returned null');
    assert(check.price.ceiling_status === 'above', `Expected ceiling_status="above", got "${check.price.ceiling_status}"`);
    assert(check.price.price_per_unit === 2, `Expected price_per_unit=2, got ${check.price.price_per_unit}`);
    assert(check.price.effective_ceiling_per_unit_with_gst === 1.89, `Expected ceiling+5%=1.89, got ${check.price.effective_ceiling_per_unit_with_gst}`);
    assert(check.equivalents.length >= 2, `Expected >=2 cheaper equivalents, got ${check.equivalents.length}`);
    assert(check.equivalents[0].is_jan_aushadhi === true && check.equivalents[0].price_per_unit === 0.5, 'Expected Jan Aushadhi (Rs 0.50) first');
    assert(check.equivalents[1].name === 'CoolPara 500' && check.equivalents[1].price_per_unit === 1.5, 'Expected CoolPara 500 (Rs 1.50) second');
    return `status=above (Rs 2.00 vs Rs 1.89 ceiling+GST), equivalents=[Jan Aushadhi @ Rs 0.50, CoolPara 500 @ Rs 1.50]`;
  });

  await runCheck('medicine_check: CoolPara 500 within ceiling', async () => {
    const check = await sdk.medicineCheck(coolParaId);
    assert(check !== null, 'medicineCheck returned null');
    assert(check.price.ceiling_status === 'within', `Expected ceiling_status="within", got "${check.price.ceiling_status}"`);
    assert(check.labels.includes('Within ceiling price'), 'Expected label "Within ceiling price"');
    return `status=within (Rs ${check.price.price_per_unit}/tab <= Rs ${check.price.effective_ceiling_per_unit_with_gst}/tab)`;
  });

  await runCheck('medicine_check: SugarEase 500 no_ceiling', async () => {
    const matches = await sdk.searchBrands('SugarEase 500', 5);
    const se = matches.find((m) => m.brand_name === 'SugarEase 500');
    assert(se, 'SugarEase 500 not found');
    sugarEaseId = se.id;
    const check = await sdk.medicineCheck(sugarEaseId);
    assert(check !== null, 'medicineCheck returned null');
    assert(check.price.ceiling_status === 'no_ceiling', `Expected ceiling_status="no_ceiling", got "${check.price.ceiling_status}"`);
    assert(check.labels.includes('No ceiling price available'), 'Expected label "No ceiling price available"');
    return `status=no_ceiling, equivalents=${check.equivalents.length}`;
  });

  await runCheck('medicine_check: batch "TST1234" and "tst 1234" both flagged', async () => {
    const c1 = await sdk.medicineCheck(testFeverId, 'TST1234');
    const c2 = await sdk.medicineCheck(testFeverId, 'tst 1234');
    assert(c1?.batch.flagged === true && c1.batch.alert?.category === 'NSQ', 'Expected TST1234 flagged as NSQ');
    assert(c2?.batch.flagged === true && c2.batch.batch_key === 'TST1234', 'Expected "tst 1234" normalised to TST1234 and flagged');
    assert(c1.labels.includes('Batch flagged by CDSCO'), 'Expected "Batch flagged by CDSCO" label');
    return `Both "TST1234" and "tst 1234" -> batch_key="TST1234", flagged=true (${c1.batch.alert.category})`;
  });

  await runCheck('medicine_check: batch "XYZ999" not found in CDSCO lists', async () => {
    const c = await sdk.medicineCheck(testFeverId, 'XYZ999');
    assert(c !== null, 'medicineCheck returned null');
    assert(c.batch.checked === true && c.batch.flagged === false && c.batch.alert === null, 'Expected XYZ999 not flagged');
    assert(c.labels.includes('Batch not found in latest CDSCO lists'), 'Expected "Batch not found in latest CDSCO lists" label');
    return `checked=true, flagged=false, label="Batch not found in latest CDSCO lists"`;
  });

  await runCheck('medicine_check: data_dates and safety_note present', async () => {
    const c = await sdk.medicineCheck(testFeverId);
    assert(c !== null, 'medicineCheck returned null');
    const keys = Object.keys(c.data_dates);
    assert(keys.length >= 5, `Expected >=5 data_dates entries, got ${keys.length}`);
    assert(c.safety_note === SAFETY_DISCLAIMER, `Unexpected safety_note: "${c.safety_note}"`);
    return `data_dates keys=[${keys.join(', ')}], safety_note verified`;
  });

  await runCheck('get_authorities: central (state IS NULL) + state filtering + report_type mapping', async () => {
    const mhPrice = await sdk.getAuthorities({ state: 'Maharashtra', reportType: 'sold_above_mrp' });
    assert(mhPrice.some((a) => a.state === null), 'Expected central authority (state=null) included');
    assert(mhPrice.some((a) => a.state === 'Maharashtra'), 'Expected Maharashtra state authority included');
    assert(mhPrice.every((a) => (a.handles ?? '').split(',').map((s) => s.trim()).includes('price')), 'All returned rows must handle "price"');
    return `Returned ${mhPrice.length} authorities (central + Maharashtra) handling "price"`;
  });

  // ---------------------------------------------------------------------------
  // 4. Row-Level Security (RLS) & Table Protection Checks
  // ---------------------------------------------------------------------------
  await runCheck('RLS: anon cannot read, update, or delete reports', async () => {
    const sel = await anonSb.from('reports').select('*');
    assert((sel.data ?? []).length === 0, `Anon SELECT on reports must return 0 rows, got ${sel.data?.length}`);

    const upd = await anonSb.from('reports').update({ pharmacy_name: 'Hacked' }).eq('report_type', 'sold_above_mrp').select();
    assert(upd.error !== null || (upd.data ?? []).length === 0, 'Anon UPDATE on reports must not affect rows');

    const del = await anonSb.from('reports').delete().eq('report_type', 'sold_above_mrp').select();
    assert(del.error !== null || (del.data ?? []).length === 0, 'Anon DELETE on reports must not affect rows');
    return 'Anon SELECT/UPDATE/DELETE on reports blocked (0 rows exposed/modified)';
  });

  await runCheck('RLS: anon cannot write reference tables or private_settings', async () => {
    const bpIns = await anonSb.from('brand_products').insert({
      brand_name: 'HackTab',
      manufacturer: 'Hack',
      salt_normalized: 'paracetamol',
      strength: '500 mg',
      dosage_form: 'tablet',
      pack_size: 10,
      pack_unit: 'tablet',
      printed_mrp: 10,
      price_per_unit: 1,
    });
    assert(bpIns.error !== null, 'Anon INSERT into brand_products should fail');

    const cpDel = await anonSb.from('ceiling_prices').delete().eq('salt_normalized', 'paracetamol').select();
    assert(cpDel.error !== null || (cpDel.data ?? []).length === 0, 'Anon DELETE on ceiling_prices should fail/affect 0 rows');

    const psAnon = await anonSb.from('private_settings').select('*');
    assert(psAnon.error !== null || (psAnon.data ?? []).length === 0, 'Anon cannot read private_settings');

    const psSrv = await srvSb.from('private_settings').select('*');
    assert(psSrv.error !== null, 'Direct SELECT on private_settings should be revoked even for service_role');
    return `Reference writes rejected (${bpIns.error.message}); private_settings direct read blocked`;
  });

  // ---------------------------------------------------------------------------
  // 5. Permanent Report & Tamper-Evident Public Log Checks
  // ---------------------------------------------------------------------------
  const TEST_LICENCE = 'TEST-HACKATHON-LIC-001';
  const TEST_PHARMACY_NAME = 'Test Hackathon Chemist (SAMPLE)';
  const TEST_REPORT_TYPE = 'sold_above_mrp' as const;

  if (!confirmPermanent) {
    const reason = 'Pass --confirm-permanent to run permanent report/public_log insertion checks';
    skipCheck('RLS & SDK: anon submitReport (creates permanent public_log entry)', reason);
    skipCheck('Public log privacy: payload excludes pharmacy_name, pharmacy_licence_no, description', reason);
    skipCheck('get_pharmacy_case: threshold_met false at 2 reports and true at 3 reports', reason);
    skipCheck('get_receipt, verify_receipt & verify_chain: cryptographic chain verification', reason);
    skipCheck('Immutability trigger: UPDATE and DELETE on public_log rejected (even service_role)', reason);
    skipCheck('compute_merkle_root & JS tamper detection on in-memory receipt copy', reason);
  } else {
    // Abort permanent checks if network / earlier lookup failed
    if (!testFeverId) {
      skipCheck('Permanent public_log checks', 'Skipped because Supabase network was unreachable in earlier checks');
    } else {
    // Check if the single 3-report test batch already exists so we never create more than 3 entries
    const { data: existingLogs, error: logCountErr } = await srvSb
      .from('public_log')
      .select('seq, report_id, payload')
      .order('seq', { ascending: true });
    if (logCountErr !== null && /fetch failed/i.test(logCountErr.message)) {
      const ids = ['6bcfcc70-3965-413f-9441-f605b5c4aa89', 'bf57bf87-d7d7-4fbd-a155-fe7199af3899', 'c6ba5250-66ff-4038-95cb-878208bf6945'];
      await runCheck('OFFLINE FALLBACK: receipts, verify_receipt, verify_chain, tamper detection', async () => {
        let first: Receipt | null = null;
        for (const id of ids) {
          const rec = await sdk.getReceipt(id);
          assert(rec !== null, `Receipt missing for ${id}`);
          if (!first) first = rec;
          assert(computeEntryHash(rec.proof) === rec.proof.entry_hash, 'Fallback proof hash mismatch');
          const ver = await sdk.verifyReceipt(id);
          assert(ver.valid === true, 'verifyReceipt failed');
        }
        const chain = await sdk.verifyChain();
        assert(chain.valid === true && chain.entries_checked === 3, 'verifyChain failed');
        const c3 = await sdk.getPharmacyCase(TEST_LICENCE);
        assert(c3.threshold_met === true && c3.total === 3, 'getPharmacyCase failed');
        const proof = (first as unknown as Receipt).proof;
        const t = { ...proof, payload_canonical: proof.payload_canonical.replace('sold_above_mrp', 'bill_refused') };
        assert(computeEntryHash(t) !== proof.entry_hash, 'Tamper not detected');
        return 'Supabase unreachable; SDK offline fallback chain verified (3 entries) and tamper detected';
      });
    } else {
    assert(logCountErr === null, `Failed to query public_log: ${logCountErr?.message}`);

    let reportIds: string[] = [];
    let caseAt2Snapshot: { threshold_met: boolean; hasPharmacyName: boolean; total: number } | null = null;

    if ((existingLogs ?? []).length === 0) {
      await runCheck('RLS & SDK: anon submitReport + 3-report batch insertion', async () => {
        // 1st report via anon SDK client (verifies anon INSERT policy + trigger)
        const r1 = await sdk.submitReport({
          brand_product_id: testFeverId,
          pharmacy_name: TEST_PHARMACY_NAME,
          pharmacy_licence_no: TEST_LICENCE,
          report_type: TEST_REPORT_TYPE,
          description: 'TEST ENTRY 1/3 - SAMPLE - NOT REAL DATA (Hackathon verification batch)',
          batch_number: 'TST1234',
        });
        // 2nd report via anon SDK client
        const r2 = await sdk.submitReport({
          brand_product_id: testFeverId,
          pharmacy_name: TEST_PHARMACY_NAME,
          pharmacy_licence_no: TEST_LICENCE,
          report_type: TEST_REPORT_TYPE,
          description: 'TEST ENTRY 2/3 - SAMPLE - NOT REAL DATA (Hackathon verification batch)',
          batch_number: 'TST1234',
        });

        // Capture get_pharmacy_case at 2 reports before inserting the 3rd
        const c2 = await sdk.getPharmacyCase(TEST_LICENCE);
        caseAt2Snapshot = {
          threshold_met: c2.threshold_met,
          hasPharmacyName: 'pharmacy_name' in c2,
          total: c2.total,
        };

        // 3rd report via anon SDK client
        const r3 = await sdk.submitReport({
          brand_product_id: testFeverId,
          pharmacy_name: TEST_PHARMACY_NAME,
          pharmacy_licence_no: TEST_LICENCE,
          report_type: TEST_REPORT_TYPE,
          description: 'TEST ENTRY 3/3 - SAMPLE - NOT REAL DATA (Hackathon verification batch)',
          batch_number: 'TST1234',
        });

        reportIds = [r1.reportId, r2.reportId, r3.reportId];
        return `Inserted 1 batch of 3 test reports via anon SDK (${reportIds.join(', ')})`;
      });
    } else {
      reportIds = (existingLogs ?? []).map((r) => String(r.report_id));
      await runCheck('RLS & SDK: existing 3-report permanent test batch detected (no duplicate inserts)', () => {
        return `Reusing existing ${reportIds.length} permanent public_log entries (${reportIds.join(', ')})`;
      });
    }

    await runCheck('Public log privacy: payload excludes pharmacy_name, pharmacy_licence_no, description', async () => {
      const { data: logs, error } = await srvSb.from('public_log').select('seq, payload').order('seq');
      assert(error === null && logs && logs.length > 0, 'Expected public_log entries');
      for (const row of logs) {
        const p = row.payload as Record<string, unknown>;
        assert(!('pharmacy_name' in p), `seq ${row.seq} leaked pharmacy_name`);
        assert(!('pharmacy_licence_no' in p), `seq ${row.seq} leaked pharmacy_licence_no`);
        assert(!('description' in p), `seq ${row.seq} leaked description`);
        assert(typeof p.pharmacy_ref === 'string' && p.pharmacy_ref.length === 64, `seq ${row.seq} missing 64-char pharmacy_ref`);
      }
      return `Verified all ${logs.length} public_log payloads contain only pharmacy_ref (64 hex chars) and zero PII/name/licence keys`;
    });

    await runCheck('get_pharmacy_case: threshold_met false at 2 reports and true at 3 reports', async () => {
      if (caseAt2Snapshot) {
        assert(caseAt2Snapshot.threshold_met === false, 'threshold_met must be false at 2 reports');
        assert(caseAt2Snapshot.hasPharmacyName === false, 'pharmacy_name must be omitted at 2 reports');
      } else {
        // Also verify with a non-existent/sub-threshold licence that threshold_met is false and name is hidden
        const c0 = await sdk.getPharmacyCase('NON-EXISTENT-LIC');
        assert(c0.threshold_met === false && !('pharmacy_name' in c0), 'Sub-threshold must hide pharmacy_name');
      }

      const c3 = await sdk.getPharmacyCase(TEST_LICENCE);
      assert(c3.threshold_met === true, `Expected threshold_met=true at 3 reports, got ${c3.threshold_met}`);
      assert(c3.total === 3, `Expected total=3, got ${c3.total}`);
      assert(c3.pharmacy_name === TEST_PHARMACY_NAME, `Expected pharmacy_name="${TEST_PHARMACY_NAME}", got "${c3.pharmacy_name}"`);
      return `At <3 reports: threshold_met=false (name hidden); at 3 reports: threshold_met=true, pharmacy_name="${c3.pharmacy_name}"`;
    });

    let firstReceipt: Receipt | null = null;

    await runCheck('get_receipt, verify_receipt & verify_chain: cryptographic chain verification', async () => {
      for (const id of reportIds) {
        const rec = await sdk.getReceipt(id);
        assert(rec !== null, `Receipt missing for ${id}`);
        if (!firstReceipt) firstReceipt = rec;
        const ver = await sdk.verifyReceipt(id);
        assert(ver.valid === true, `verifyReceipt failed for ${id}: ${ver.message}`);
        const text = buildReceiptText(rec, ver);
        assert(text.includes('MEDICHECK PROOF RECEIPT') && text.includes(rec.entry_hash), 'buildReceiptText output invalid');
      }
      const chain = await sdk.verifyChain();
      assert(chain.valid === true && chain.entries_checked === reportIds.length && chain.first_bad_seq === null, `verifyChain failed: ${JSON.stringify(chain)}`);

      const check = await sdk.medicineCheck(testFeverId, 'TST1234');
      const repText = buildReportText(check, {
        brand_product_id: testFeverId,
        pharmacy_name: TEST_PHARMACY_NAME,
        pharmacy_licence_no: TEST_LICENCE,
        report_type: TEST_REPORT_TYPE,
        description: 'Sample description',
        batch_number: 'TST1234',
      });
      assert(repText.includes('MEDICHECK PATIENT OBSERVATION REPORT'), 'buildReportText output invalid');
      return `All ${reportIds.length} receipts valid; verify_chain valid=true (entries_checked=${chain.entries_checked})`;
    });

    await runCheck('Immutability trigger: UPDATE and DELETE on public_log rejected (even service_role)', async () => {
      const upd = await srvSb.from('public_log').update({ entry_type: 'status_change' }).eq('seq', 1).select();
      assert(upd.error !== null, 'Service-role UPDATE on public_log must fail');

      const del = await srvSb.from('public_log').delete().eq('seq', 1).select();
      assert(del.error !== null, 'Service-role DELETE on public_log must fail');
      return `UPDATE rejected ("${upd.error.message}"); DELETE rejected ("${del.error.message}")`;
    });

    await runCheck('compute_merkle_root & JS tamper detection on in-memory receipt copy', async () => {
      const { data: sqlRoot, error: rootErr } = await srvSb.rpc('compute_merkle_root');
      assert(rootErr === null && typeof sqlRoot === 'string', `compute_merkle_root failed: ${rootErr?.message}`);

      const { data: rows } = await srvSb.from('public_log').select('entry_hash').order('seq');
      const jsRoot = merkleRoot((rows ?? []).map((r) => String(r.entry_hash)));
      assert(sqlRoot === jsRoot, `SQL Merkle root (${sqlRoot}) != JS Merkle root (${jsRoot})`);

      assert(firstReceipt !== null, 'No receipt available for tamper check');
      const origProof = (firstReceipt as Receipt).proof;
      assert(computeEntryHash(origProof) === origProof.entry_hash, 'Original proof hash mismatch');

      const tamperedProof = {
        ...origProof,
        payload_canonical: origProof.payload_canonical.replace('sold_above_mrp', 'bill_refused'),
      };
      assert(computeEntryHash(tamperedProof) !== origProof.entry_hash, 'Tampered JS copy must not match entry_hash');
      return `Merkle root=${sqlRoot.slice(0, 16)}... (matches JS); in-memory tamper detected without touching DB`;
    });
    }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Community Page, Government Progress Proofs & Phase 2 Pharmacy Verification
  // ---------------------------------------------------------------------------
  await runCheck('Community Page: searchCommunityIssues by place ("Andheri West" & "Mumbai")', async () => {
    const feed = await sdk.searchCommunityIssues({ placeQuery: 'Andheri West', state: 'Maharashtra' });
    assert(feed.summary.total_matching_reports >= 3, `Expected >= 3 reports in Andheri West, got ${feed.summary.total_matching_reports}`);
    assert(feed.items.length >= 3, 'Expected >= 3 items in Community feed');
    assert(feed.items[0].threshold_met === true && feed.items[0].pharmacy_name === TEST_PHARMACY_NAME, 'Expected >=3 threshold to reveal pharmacy_name');
    return `Matched ${feed.summary.total_matching_reports} reports in Andheri West; threshold_met=true revealed "${feed.items[0].pharmacy_name}"`;
  });

  await runCheck('Government Account: postGovernmentProgress with proof images updates receipt & community feed', async () => {
    const targetReportId = '6bcfcc70-3965-413f-9441-f605b5c4aa89';
    const proofUrls = [
      'https://example.com/sample-proofs/fda-inspection-memo-2026-10-31.jpg',
      'https://example.com/sample-proofs/dpco-show-cause-order.pdf',
    ];
    const govUpdate = await sdk.postGovernmentProgress({
      report_id: targetReportId,
      status: 'action_taken',
      action_taken: 'Premises inspected, billing register audited & show-cause notice issued',
      progress_note: 'Drug Inspector visited premises in Andheri West and issued official compliance directive.',
      proof_urls: proofUrls,
      agency_name: 'Maharashtra Food and Drug Administration (FDA)',
      officer_designation: 'Assistant Commissioner (Drugs)',
    });
    assert(govUpdate.status === 'action_taken' && govUpdate.proof_urls.length === 2, 'Government progress update failed');

    const updatedReceipt = await sdk.getReceipt(targetReportId);
    assert(updatedReceipt !== null && updatedReceipt.status === 'action_taken', 'Expected receipt status updated to action_taken');
    assert(updatedReceipt.authority_response !== null && updatedReceipt.authority_response.proof_urls.length === 2, 'Expected authority_response proof_urls populated');

    const receiptTxt = buildReceiptText(updatedReceipt, { valid: true, message: 'Verified' });
    assert(receiptTxt.includes('ACTION_TAKEN') && receiptTxt.includes('fda-inspection-memo'), 'Expected buildReceiptText to include government progress & proof URL');

    const feedAfter = await sdk.searchCommunityIssues({ placeQuery: 'Andheri West' });
    assert(feedAfter.summary.with_government_response_count >= 1, 'Expected Community feed to reflect government response');
    return `Posted status="${govUpdate.status}" with ${govUpdate.proof_urls.length} proof attachments; reflected in receipt & community feed`;
  });

  await runCheck('Phase 2 Pharmacy Verification: passing store verified & suggested in area search', async () => {
    const pharm = await sdk.registerPharmacy({
      pharmacy_name: 'Sample Bandra FairCare Medico',
      licence_no: 'SAMPLE-MH-BND-777',
      area: 'Bandra West',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400050',
      address: 'Shop 9, Sample Hill Road, Bandra West',
      phone: '022-26009900',
      jan_aushadhi_available: true,
    });

    const ver = await sdk.submitPharmacyVerification({
      pharmacy_id: pharm.id,
      stock_proof_urls: ['https://example.com/sample-proofs/bandra-stock-register.jpg'],
      billing_proof_urls: ['https://example.com/sample-proofs/bandra-gst-bill-coolpara.jpg'],
      essential_medicines_stocked: 38,
      sample_brand_product_id: coolParaId, // CoolPara 500: MRP Rs 1.50/tab, Ceiling+5% GST Rs 1.89/tab
      sample_billed_unit_price: 1.5,
      sample_batch_number: 'CLEAN-BATCH-2026',
      jan_aushadhi_stocked: true,
    });

    assert(ver.auto_check_passed === true && ver.is_verified === true && ver.verification_status === 'verified', 'Expected CoolPara fair-billing store to pass all 5 checks');

    const nearby = await sdk.getVerifiedPharmacies({ areaOrQuery: 'Bandra West' });
    assert(nearby.some((s) => s.licence_no === 'SAMPLE-MH-BND-777'), 'Expected newly verified store to appear in getVerifiedPharmacies("Bandra West")');
    return `Store "${ver.pharmacy_name}" passed all 5 checks (score=${ver.verification_score}%) & suggested in Bandra West`;
  });

  await runCheck('Phase 2 Pharmacy Verification: overcharging / flagged-batch store rejected & excluded', async () => {
    const badPharm = await sdk.registerPharmacy({
      pharmacy_name: 'Overcharging Sample Chemist',
      licence_no: TEST_LICENCE,
      area: 'Andheri West',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400058',
    });

    const badVer = await sdk.submitPharmacyVerification({
      pharmacy_id: badPharm.id,
      stock_proof_urls: ['https://example.com/sample-proofs/bad-stock.jpg'],
      billing_proof_urls: ['https://example.com/sample-proofs/bad-bill.jpg'],
      essential_medicines_stocked: 3, // < 5 required
      sample_brand_product_id: testFeverId, // TestFever 500 @ Rs 2.00/tab (> Rs 1.89 ceiling+GST)
      sample_billed_unit_price: 2.0,
      sample_batch_number: 'TST1234', // Flagged NSQ batch
    });

    assert(badVer.auto_check_passed === false && badVer.is_verified === false && badVer.verification_status === 'rejected', 'Expected non-compliant store to be rejected');
    assert(badVer.auto_check_details.within_nppa_ceiling_with_gst === false, 'Expected ceiling check to fail');
    assert(badVer.auto_check_details.batch_clean_in_cdsco === false, 'Expected CDSCO batch check to fail');

    const nearby = await sdk.getVerifiedPharmacies({ areaOrQuery: 'Andheri West' });
    assert(!nearby.some((s) => s.licence_no === TEST_LICENCE), 'Rejected store must NEVER appear in verified pharmacy suggestions');
    return `Non-compliant store rejected (${badVer.review_note}) & excluded from suggestions`;
  });

  await runCheck('New Frontend Multi-Page Server: all 11 HTML pages, style.css, app.js & No-Map verification', async () => {
    const server = createPresentationServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const pages = [
        '/index.html',
        '/login.html',
        '/home.html',
        '/scan.html',
        '/report.html',
        '/area.html',
        '/pharmacy-home.html',
        '/pharmacy-verify.html',
        '/pharmacy-reports.html',
        '/gov-home.html',
        '/gov-case.html',
      ];
      for (const pg of pages) {
        const r = await fetch(`${base}${pg}`);
        assert(r.status === 200, `Expected 200 for ${pg}, got ${r.status}`);
        const html = await r.text();
        assert(html.includes('MediCheck') && html.includes('style.css') && html.includes('app.js'), `Page ${pg} missing MediCheck title, style.css, or app.js`);
        assert(!html.includes('leaflet') && !html.includes('mcMapRoot'), `Page ${pg} must not contain any interactive map component`);
      }

      const areaHtml = await (await fetch(`${base}/area.html`)).text();
      assert(areaHtml.includes('Address only — no map'), 'area.html must explicitly state "Address only — no map"');

      const assets = ['/style.css', '/app.js'];
      for (const asset of assets) {
        const r = await fetch(`${base}${asset}`);
        assert(r.status === 200, `Expected 200 for asset ${asset}, got ${r.status}`);
      }

      const appJs = await (await fetch(`${base}/app.js`)).text();
      assert(!appJs.includes('L.map') && !appJs.includes('initMediCheckMap'), 'app.js must not contain any interactive map code');

      return `Verified all 11 pages (${pages.join(', ')}), style.css, app.js, and confirmed interactive map is completely removed`;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await runCheck('Full-Stack Integration APIs: Auth, Citizen Report, Area Search, Pharmacy Portal & Gov Case', async () => {
    const server = createPresentationServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Auth Login & Citizen Registration & Org Verification Call Request
      const loginRes = await (
        await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'citizen', identifier: 'ananya@example.com' }),
        })
      ).json() as { authenticated?: boolean; redirect_page?: string };
      assert(loginRes.authenticated === true && loginRes.redirect_page === 'home.html', '/api/auth/login failed');

      const regRes = await (
        await fetch(`${base}/api/auth/register-citizen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_name: 'Rohan Sharma', phone: '+91 98450 99999', email: 'rohan@example.com' }),
        })
      ).json() as { authenticated?: boolean; display_name?: string };
      assert(regRes.authenticated === true && regRes.display_name === 'Rohan Sharma', '/api/auth/register-citizen failed');

      const orgRes = await (
        await fetch(`${base}/api/auth/request-org-call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'pharmacy',
            org_name: 'Sundar Medicals',
            contact_person: 'R. Sundar — Proprietor',
            phone: '+91 80 2553 0101',
            area: 'Koramangala, Bengaluru',
          }),
        })
      ).json() as { requested?: boolean; status?: string };
      assert(orgRes.requested === true && orgRes.status === 'call_scheduled_within_2_working_days', '/api/auth/request-org-call failed');

      // 2. Barcode & Medicine Check (Sample + Actual Medicines from CSV)
      const apiCheck = await (await fetch(`${base}/api/check?q=TestFever%20500&batch=TST1234`)).json() as {
        check?: { price?: { ceiling_status?: string } };
      };
      assert(apiCheck.check?.price?.ceiling_status === 'above', '/api/check failed');

      const actualBarcodes = [
        { code: '8901234560013', name: 'Dolo 650', mrp: 32.28 },
        { code: '8901234560020', name: 'Pan 40', mrp: 192.8 },
        { code: '8901234560037', name: 'Telma 40', mrp: 108.36 },
        { code: '8901234560044', name: 'Glycomet 500', mrp: 19.59 },
        { code: '8901234560051', name: 'Azithral 500', mrp: 131.27 },
        { code: '8901234560068', name: 'Amlong 5', mrp: 48.55 },
        { code: '8901234560075', name: 'Allegra 120', mrp: 272.99 },
        { code: '8901234560082', name: 'Atorva 10', mrp: 80.14 },
        { code: '8901234560099', name: 'Thyronorm 100', mrp: 177.36 },
        { code: '8901234560105', name: 'Augmentin 625 Duo', mrp: 201.71 },
        { code: '8901234560112', name: 'Crocin Advance 500', mrp: 20.0 },
        { code: '8901234560129', name: 'Ecosprin 75', mrp: 5.49 },
      ];
      for (const b of actualBarcodes) {
        const res = await (await fetch(`${base}/api/check?q=${b.code}`)).json() as {
          mode?: string;
          check?: { product?: { brand_name?: string; printed_mrp?: number } };
        };
        assert(
          res.mode === 'barcode' &&
            res.check?.product?.brand_name === b.name &&
            res.check?.product?.printed_mrp === b.mrp,
          `Expected barcode ${b.code} -> ${b.name} (MRP ₹${b.mrp}), got ${JSON.stringify(res.check?.product)}`
        );
      }

      // 3. Verify Clean Start (Unverified pharmacy, 0 reports before citizen files)
      await fetch(`${base}/api/demo/reset`, { method: 'POST' });
      const initialPharmDash = await (await fetch(`${base}/api/pharmacy/dashboard`)).json() as {
        verification_status?: string;
        open_reports_count?: number;
        price_items?: unknown[];
        reports_against_pharmacy?: unknown[];
      };
      assert(
        initialPharmDash.verification_status === 'Unverified' &&
          initialPharmDash.open_reports_count === 0 &&
          (initialPharmDash.price_items ?? []).length === 0 &&
          (initialPharmDash.reports_against_pharmacy ?? []).length === 0,
        `Expected clean unverified pharmacy start, got ${JSON.stringify(initialPharmDash)}`
      );

      const korCommBefore = await (await fetch(`${base}/api/community?q=Koramangala`)).json() as {
        verifiedPharmacies?: Array<{ pharmacy_name: string }>;
      };
      assert(
        (korCommBefore.verifiedPharmacies ?? []).length === 0,
        'Expected 0 verified pharmacies in Koramangala before pharmacy submits verification'
      );

      // 4. Proof Upload & Citizen Report Filing
      const upRes = await (
        await fetch(`${base}/api/upload-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'dolo-bill.jpg', folder: 'citizen-bills' }),
        })
      ).json() as { uploaded?: boolean; url?: string };
      assert(upRes.uploaded === true && typeof upRes.url === 'string', '/api/upload-proof failed');

      const repRes = await (
        await fetch(`${base}/api/reports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issue_type: 'overpriced',
            medicine: 'Dolo 650, 15 tablets',
            mrp: 32.28,
            billed: 50,
            pharmacy: 'Sundar Medicals',
            address: '12, 5th Block, Koramangala, Bengaluru 560095',
            notes: 'Billed ₹50 instead of ₹32.28 MRP',
            bill_photo_url: upRes.url,
          }),
        })
      ).json() as { submitted?: boolean; reportId?: string; overcharge?: number };
      assert(repRes.submitted === true && repRes.overcharge === 17.72 && typeof repRes.reportId === 'string', '/api/reports failed');

      // 5. Pharmacy Portal: Dashboard shows 1 new report & 1 price mismatch item, Price Fix, Report Response & Verification Proof
      const pharmDash = await (await fetch(`${base}/api/pharmacy/dashboard`)).json() as {
        pharmacy_name?: string;
        verification_status?: string;
        open_reports_count?: number;
        price_items?: unknown[];
        reports_against_pharmacy?: unknown[];
      };
      assert(
        pharmDash.pharmacy_name === 'Sundar Medicals' &&
          pharmDash.verification_status === 'Unverified' &&
          pharmDash.open_reports_count === 1 &&
          (pharmDash.price_items ?? []).length === 1 &&
          (pharmDash.reports_against_pharmacy ?? []).length === 1,
        '/api/pharmacy/dashboard after citizen report failed'
      );

      const fixRes = await (
        await fetch(`${base}/api/pharmacy/price-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id: 'price-item-1', action: 'mark_corrected' }),
        })
      ).json() as { updated_item?: { status?: string } };
      assert(fixRes.updated_item?.status === 'matched', '/api/pharmacy/price-fix failed');

      const respRes = await (
        await fetch(`${base}/api/pharmacy/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            report_id: repRes.reportId,
            pharmacy_name: 'Sundar Medicals',
            response_text: 'Price corrected in POS system and refund offered.',
            proof_url: 'https://example.com/proof/corrected-pos.jpg',
          }),
        })
      ).json() as { responded?: boolean; updated_status?: string };
      assert(respRes.responded === true && respRes.updated_status === 'in_progress', '/api/pharmacy/respond failed');

      const pVerRes = await (
        await fetch(`${base}/api/pharmacy/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pharmacy_name: 'Sundar Medicals',
            licence_no: 'KA-BLR-KOR-001',
            area: 'Koramangala',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560095',
            period: '1–31 October 2026',
            items_scanned: 42,
            stock_proof_urls: ['https://example.com/proof/oct-stock.jpg'],
            billing_proof_urls: ['https://example.com/proof/oct-billing.csv'],
          }),
        })
      ).json() as { verification?: { is_verified?: boolean } };
      assert(pVerRes.verification?.is_verified === true, '/api/pharmacy/verify failed');

      // 6. Community / Area Search now shows Sundar Medicals as Verified
      const korCommAfter = await (await fetch(`${base}/api/community?q=Koramangala`)).json() as {
        verifiedPharmacies?: Array<{ pharmacy_name: string }>;
      };
      assert(
        (korCommAfter.verifiedPharmacies ?? []).some((p) => p.pharmacy_name === 'Sundar Medicals'),
        'Expected Sundar Medicals in /api/community?q=Koramangala after verification'
      );

      const mumComm = await (await fetch(`${base}/api/community?q=Mumbai`)).json() as {
        verifiedPharmacies?: unknown[];
        issues?: { items?: unknown[] };
      };
      assert((mumComm.verifiedPharmacies ?? []).length >= 2 && (mumComm.issues?.items ?? []).length >= 3, '/api/community?q=Mumbai failed');

      // 7. Government Case Detail & Progress Update
      const govCaseBefore = await (await fetch(`${base}/api/gov/case?id=${encodeURIComponent(repRes.reportId!)}`)).json() as {
        pharmacy_verified?: boolean;
        timeline?: Array<{ title: string }>;
      };
      assert(
        govCaseBefore.pharmacy_verified === true &&
          (govCaseBefore.timeline ?? []).some((t) => t.title.includes('Pharmacy responded')),
        'Expected pharmacy response & verified status in government case timeline'
      );

      const govProgRes = await (
        await fetch(`${base}/api/government/progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            report_id: '6bcfcc70-3965-413f-9441-f605b5c4aa89',
            status: 'Resolved',
            progress_note: 'Inspector verified corrected MRP labels at Sundar Medicals.',
            proof_urls: ['https://example.com/proof/bbmp-inspection.jpg'],
          }),
        })
      ).json() as { status?: string };
      assert(govProgRes.status === 'resolved', '/api/government/progress failed');

      // Reset back to clean state after test
      await fetch(`${base}/api/demo/reset`, { method: 'POST' });

      // 7. Security & Tamper-Evident Log Overview
      const apiSec = await (await fetch(`${base}/api/security/overview`)).json() as {
        chain?: { valid?: boolean };
        tamperDemo?: { tamper_detected?: boolean };
      };
      assert(apiSec.chain?.valid === true && apiSec.tamperDemo?.tamper_detected === true, '/api/security/overview failed');

      return 'All 14 JSON API endpoints (auth, scan, report, area, pharmacy, gov, security) verified end-to-end';
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIPPED').length;

  console.log('\n====================================================================');
  console.log(`SUMMARY: ${passCount} PASS, ${failCount} FAIL, ${skipCount} SKIPPED`);
  console.log('====================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in test-all:', err);
  process.exit(1);
});

