/**
 * Integration test for the public log (uses the service role; ADDS 3 permanent log entries).
 *   npm run test:log
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { Receipt } from '../src/lib/medicheck.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(): void {
  const p = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function merkleRoot(leaves: string[]): string | null {
  if (leaves.length === 0) return null;
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256Hex(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}

/** Same formula as SQL: sha256(prev_hash || payload::text || entry_type || sealed_at) */
const entryHash = (p: Receipt['proof']) => sha256Hex(p.prev_hash + p.payload_canonical + p.entry_type + p.sealed_at);

async function main(): Promise<void> {
  loadDotEnv();
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example).');
    process.exit(1);
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 0. preflight: do not insert anything unless migration 0004 is applied
  const pre = await sb.rpc('verify_chain');
  if (pre.error) {
    console.error(`Preflight failed (${pre.error.message}). Run supabase/migrations/0004_public_log.sql first; nothing was inserted.`);
    process.exit(1);
  }

  // 1. insert reports for testing privacy and threshold
  console.log('1. Inserting reports to test pharmacy privacy and case threshold...');
  const testLicence = `TEST-LIC-CASE-${Date.now()}`;
  const testPharmacyName = 'Test Case Chemist';
  const reportType = 'sold_above_mrp';

  // Insert 2 reports first to verify threshold_met is false
  const id1 = randomUUID();
  const id2 = randomUUID();
  const { error: insErr2 } = await sb.from('reports').insert([
    {
      id: id1,
      pharmacy_name: testPharmacyName,
      pharmacy_licence_no: testLicence,
      report_type: reportType,
      description: 'Private free text 1',
      batch_number: 'TST-1',
    },
    {
      id: id2,
      pharmacy_name: testPharmacyName,
      pharmacy_licence_no: testLicence,
      report_type: reportType,
      description: 'Private free text 2',
      batch_number: 'TST-2',
    },
  ]);
  assert.equal(insErr2, null, `insert 2 reports failed: ${insErr2?.message}`);

  // Check get_pharmacy_case at 2 reports (threshold_met must be false)
  const { data: caseAt2, error: caseErr2 } = await sb.rpc('get_pharmacy_case', { p_licence: testLicence });
  assert.equal(caseErr2, null, `get_pharmacy_case at 2 failed: ${caseErr2?.message}`);
  assert.equal((caseAt2 as { threshold_met: boolean }).threshold_met, false, 'threshold_met must be false at 2 reports');
  assert.ok(!('pharmacy_name' in (caseAt2 as object)), 'pharmacy_name must NOT be present when threshold_met is false');
  console.log('   get_pharmacy_case at 2 reports: threshold_met = false, pharmacy_name hidden');

  // Insert 3rd report with the same licence and report_type to cross threshold
  const id3 = randomUUID();
  const { error: insErr3 } = await sb.from('reports').insert({
    id: id3,
    pharmacy_name: testPharmacyName,
    pharmacy_licence_no: testLicence,
    report_type: reportType,
    description: 'Private free text 3',
    batch_number: 'TST-3',
  });
  assert.equal(insErr3, null, `insert 3rd report failed: ${insErr3?.message}`);

  // Check get_pharmacy_case at 3 reports (threshold_met must be true)
  const { data: caseAt3, error: caseErr3 } = await sb.rpc('get_pharmacy_case', { p_licence: testLicence });
  assert.equal(caseErr3, null, `get_pharmacy_case at 3 failed: ${caseErr3?.message}`);
  assert.equal((caseAt3 as { threshold_met: boolean }).threshold_met, true, 'threshold_met must be true at 3 reports');
  assert.equal((caseAt3 as { pharmacy_name?: string }).pharmacy_name, testPharmacyName, 'pharmacy_name must be returned when threshold_met is true');
  console.log('   get_pharmacy_case at 3 reports: threshold_met = true, pharmacy_name revealed');

  const ids = [id1, id2, id3];

  // 2. receipts + verify
  console.log('2. get_receipt / verify_receipt...');
  const receipts: Receipt[] = [];
  for (const id of ids) {
    const { data: rec, error: e1 } = await sb.rpc('get_receipt', { p_report_id: id });
    assert.equal(e1, null, e1?.message);
    const receipt = rec as Receipt;
    assert.ok(receipt, 'receipt exists');
    assert.equal(receipt.status, 'filed');
    assert.equal(receipt.authority_response, null);
    assert.ok(!('description' in receipt.report), 'description must not be in the public payload');
    assert.ok(!('pharmacy_name' in receipt.report), 'pharmacy_name must not be in the public payload');
    assert.ok(!('pharmacy_licence_no' in receipt.report), 'pharmacy_licence_no must not be in the public payload');
    assert.ok('pharmacy_ref' in receipt.report, 'pharmacy_ref must be in the public payload');
    assert.ok(!receipt.proof.payload_canonical.includes('private free text'), 'free text leaked');
    assert.ok(!receipt.proof.payload_canonical.includes(testPharmacyName), 'pharmacy_name leaked in payload_canonical');
    assert.ok(!receipt.proof.payload_canonical.includes(testLicence), 'pharmacy_licence_no leaked in payload_canonical');
    receipts.push(receipt);

    const { data: v, error: e2 } = await sb.rpc('verify_receipt', { p_report_id: id });
    assert.equal(e2, null, e2?.message);
    assert.equal((v as { valid: boolean }).valid, true, JSON.stringify(v));
    console.log(`   seq ${receipt.seq}: valid - ${(v as { message: string }).message}`);
  }
  assert.ok(receipts[1].seq > receipts[0].seq && receipts[2].seq > receipts[1].seq, 'seq increases');
  assert.equal(receipts[1].prev_hash, receipts[0].entry_hash, 'chain link 1->2');
  assert.equal(receipts[2].prev_hash, receipts[1].entry_hash, 'chain link 2->3');

  // 3. whole chain
  console.log('3. verify_chain...');
  const { data: chain, error: e3 } = await sb.rpc('verify_chain');
  assert.equal(e3, null, e3?.message);
  console.log('  ', JSON.stringify(chain));
  assert.equal((chain as { valid: boolean }).valid, true);

  // 4. UPDATE / DELETE must fail
  console.log('4. UPDATE and DELETE on public_log must fail...');
  const upd = await sb.from('public_log').update({ payload: { tampered: true } }).eq('seq', receipts[0].seq).select();
  assert.ok(upd.error, 'UPDATE should have failed');
  console.log(`   UPDATE rejected: ${upd.error?.message}`);
  const del = await sb.from('public_log').delete().eq('seq', receipts[0].seq).select();
  assert.ok(del.error, 'DELETE should have failed');
  console.log(`   DELETE rejected: ${del.error?.message}`);

  // 5. Merkle root (SQL vs JS)
  console.log('5. compute_merkle_root...');
  const { data: root, error: e5 } = await sb.rpc('compute_merkle_root');
  assert.equal(e5, null, e5?.message);
  const { data: rows, error: e6 } = await sb.from('public_log').select('entry_hash').order('seq');
  assert.equal(e6, null, e6?.message);
  const jsRoot = merkleRoot((rows ?? []).map((r) => r.entry_hash as string));
  console.log(`   SQL root: ${root}\n   JS root : ${jsRoot}`);
  assert.equal(root, jsRoot, 'SQL and JS Merkle roots must match');

  // 6. tamper detection on an in-memory copy only
  console.log('6. Tamper detection (JS copy; real log untouched)...');
  const original = receipts[0].proof;
  assert.equal(entryHash(original), original.entry_hash, 'untouched copy re-hashes to stored hash');
  const tampered = {
    ...original,
    payload_canonical: original.payload_canonical.replace(receipts[0].report.pharmacy_ref ?? '', '0000000000000000000000000000000000000000000000000000000000000000'),
  };
  assert.notEqual(tampered.payload_canonical, original.payload_canonical, 'copy was modified');
  assert.notEqual(entryHash(tampered), original.entry_hash, 'tampered copy must not match stored hash');
  console.log('   original copy: hash matches; modified copy: hash MISMATCH (tamper detected)');

  console.log('\nAll log checks passed.');
}

main().catch((e) => {
  console.error('\nFAILED:', (e as Error).message);
  process.exit(1);
});
