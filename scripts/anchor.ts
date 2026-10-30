/**
 * Snapshot the public log's Merkle root and (optionally) submit it to an OpenTimestamps calendar.
 *   npm run anchor              snapshot + try OpenTimestamps
 *   npm run anchor -- --no-ots  snapshot only
 * Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env. Never claims success unless the
 * calendar server actually accepted the digest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALENDAR = (process.env.OTS_CALENDAR_URL ?? 'https://alice.btc.calendar.opentimestamps.org').replace(/\/$/, '');

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

// OpenTimestamps detached-file header: magic, version 1, SHA256 op tag, then the 32-byte digest.
const OTS_MAGIC = Buffer.concat([
  Buffer.from([0x00]), Buffer.from('OpenTimestamps', 'ascii'),
  Buffer.from([0x00, 0x00]), Buffer.from('Proof', 'ascii'),
  Buffer.from([0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]),
]);

async function main(): Promise<void> {
  loadDotEnv();
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data, error } = await sb.rpc('snapshot_log');
  if (error) throw new Error(`snapshot_log failed: ${error.message}`);
  const snap = data as { id: string; root_hash: string; entry_count: number; last_seq: number };
  console.log('Snapshot saved.');
  console.log(`  id          : ${snap.id}`);
  console.log(`  entries     : ${snap.entry_count} (last seq ${snap.last_seq})`);
  console.log(`  Merkle root : ${snap.root_hash}`);

  if (process.argv.includes('--no-ots')) {
    console.log('OpenTimestamps skipped (--no-ots). anchor_method remains "none".');
    return;
  }

  try {
    const digest = Buffer.from(snap.root_hash, 'hex');
    if (digest.length !== 32) throw new Error('root hash is not 32 bytes');
    const res = await fetch(`${CALENDAR}/digest`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'medicheck-anchor', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: digest,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`calendar responded HTTP ${res.status}`);
    const fragment = Buffer.from(await res.arrayBuffer());
    if (fragment.length === 0) throw new Error('calendar returned an empty response');

    const proof = Buffer.concat([OTS_MAGIC, Buffer.from([0x01, 0x08]), digest, fragment]).toString('base64');
    const { error: upErr } = await sb
      .from('anchor_snapshots')
      .update({ anchor_method: 'opentimestamps', anchor_proof: proof })
      .eq('id', snap.id);
    if (upErr) throw new Error(`calendar accepted the digest but saving the proof failed: ${upErr.message}`);

    console.log(`OpenTimestamps: calendar ${CALENDAR} accepted the digest and the proof was saved (base64, anchor_method="opentimestamps").`);
    console.log('  Note: the proof is PENDING until the calendar commits it to Bitcoin (usually hours); it was not independently verified here.');
  } catch (e) {
    console.log(`OpenTimestamps NOT anchored: ${(e as Error).message}`);
    console.log('anchor_method remains "none". The snapshot itself is still saved; re-run later to anchor a new one.');
  }
}

main().catch((e) => { console.error('Anchor failed:', (e as Error).message); process.exit(1); });
