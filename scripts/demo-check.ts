/**
 * MediCheck CLI Demo Runner (`scripts/demo-check.ts`)
 *
 * Given a brand name, optional batch number, or optional barcode / GS1 scan string,
 * runs the live lookup against Supabase and prints the full `medicine_check` output
 * in a clean, human-readable format.
 *
 * Examples:
 *   npm run demo -- --brand "TestFever 500" --batch TST1234
 *   npm run demo -- --barcode 9900000000011 --batch "tst 1234"
 *   npm run demo -- --barcode "(01)09900000000011(17)270531(10)TST1234"
 *   npm run demo -- "CoolPara 500"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMediCheckClient, type MedicineCheckResult } from '../src/lib/medicheck.js';

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

interface DemoArgs {
  brand: string | null;
  batch: string | null;
  barcode: string | null;
}

function parseArgs(argv: string[]): DemoArgs {
  let brand: string | null = null;
  let batch: string | null = null;
  let barcode: string | null = null;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--brand' && argv[i + 1]) {
      brand = argv[++i];
    } else if (arg === '--batch' && argv[i + 1]) {
      batch = argv[++i];
    } else if ((arg === '--barcode' || arg === '--scan') && argv[i + 1]) {
      barcode = argv[++i];
    } else if (!arg.startsWith('--')) {
      positionals.push(arg);
    }
  }

  if (!brand && !barcode && positionals.length > 0) {
    brand = positionals[0];
    if (!batch && positionals.length > 1) {
      batch = positionals[1];
    }
  }

  if (!brand && !barcode) {
    brand = 'TestFever 500';
    batch = batch ?? 'TST1234';
  }

  return { brand, batch, barcode };
}

function printReadableCheck(check: MedicineCheckResult): void {
  const p = check.product;
  const pr = check.price;
  const b = check.batch;

  console.log('====================================================================');
  console.log(`MEDICHECK RESULT: ${p.brand_name}`);
  console.log('====================================================================');
  console.log(`Brand Name       : ${p.brand_name}`);
  console.log(`Manufacturer     : ${p.manufacturer}`);
  console.log(`Composition      : ${p.salt_normalized} — ${p.strength} (${p.dosage_form})`);
  console.log(`Pack             : ${p.pack_size} ${p.pack_unit} | Schedule: ${p.schedule_status}`);
  if (p.notes) {
    console.log(`Dataset Note     : ${p.notes}`);
  }
  console.log('');

  console.log('--- LABELS ---');
  for (const label of check.labels) {
    console.log(`  * [${label}]`);
  }
  console.log('');

  console.log('--- PRICE & NPPA CEILING COMPARISON ---');
  console.log(`Printed MRP      : Rs ${Number(pr.printed_mrp).toFixed(2)} per pack (${p.pack_size} ${p.pack_unit})`);
  console.log(`Unit Price       : Rs ${Number(pr.price_per_unit).toFixed(2)} per ${p.pack_unit}`);
  console.log(`Ceiling Status   : ${pr.ceiling_status.toUpperCase()}`);
  if (pr.ceiling_row) {
    console.log(`NPPA Base Ceiling: Rs ${Number(pr.ceiling_row.ceiling_price).toFixed(2)} (${pr.ceiling_row.pack_unit})`);
    console.log(
      `Ceiling + ${pr.gst_allowance_percent}% GST : Rs ${Number(pr.effective_ceiling_per_unit_with_gst).toFixed(4)} per ${p.pack_unit}`
    );
    console.log(`Notification Ref : ${pr.ceiling_row.notification_ref ?? 'N/A'} (effective ${pr.ceiling_row.effective_date ?? 'N/A'})`);
  }
  console.log(`GST Note         : ${pr.gst_note}`);
  console.log('');

  console.log(`--- CHEAPER SAME-SALT EQUIVALENTS (${check.equivalents.length}) ---`);
  if (check.equivalents.length === 0) {
    console.log('  No cheaper equivalents listed in current dataset.');
  } else {
    for (const eq of check.equivalents) {
      const tag = eq.is_jan_aushadhi ? `[Jan Aushadhi #${eq.ja_product_code ?? 'PMBJP'}]` : '[Branded]';
      console.log(
        `  - ${eq.name} ${tag} | Rs ${Number(eq.price_per_unit).toFixed(2)}/${eq.pack_unit} (Pack of ${eq.pack_size}: Rs ${Number(eq.mrp).toFixed(2)}) | Saves ${eq.savings_percent}%`
      );
    }
  }
  console.log('');

  console.log('--- CDSCO NSQ / SPURIOUS BATCH CHECK ---');
  if (!b.checked) {
    console.log('  Batch Checked  : No (no batch number supplied)');
  } else {
    console.log(`  Batch Queried  : "${b.batch_queried}" (normalised key: "${b.batch_key}")`);
    console.log(`  Flagged        : ${b.flagged ? 'YES (ALERT MATCHED)' : 'NO (Not in latest CDSCO lists)'}`);
    if (b.flagged && b.alert) {
      console.log(`  Category       : ${b.alert.category} (${b.alert.alert_month})`);
      console.log(`  Failure Reason : ${b.alert.failure_reason ?? 'N/A'}`);
      console.log(`  Testing Lab    : ${b.alert.testing_lab ?? 'N/A'}`);
      console.log(`  Source URL     : ${b.alert.source_url ?? 'N/A'}`);
    }
  }
  console.log(`  Background Info: ${b.manufacturer_salt_note}`);
  console.log('');

  console.log('--- DATA FRESHNESS (DATA AS OF) ---');
  for (const [dataset, dt] of Object.entries(check.data_dates)) {
    console.log(`  - ${dataset.padEnd(22)}: ${dt}`);
  }
  console.log('');
  console.log(`SAFETY NOTE: ${check.safety_note}`);
  console.log('====================================================================');
}

async function main(): Promise<void> {
  loadDotEnv();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
    process.exit(1);
  }

  const sdk = createMediCheckClient(supabaseUrl, supabaseAnonKey);
  const args = parseArgs(process.argv.slice(2));

  if (args.barcode) {
    console.log(`Scanning barcode / QR input: ${args.barcode}`);
    const scanRes = await sdk.scanAndCheck(args.barcode, {
      batchOverride: args.batch ?? undefined,
    });
    if (!scanRes.found) {
      console.error(`Scan lookup failed (${scanRes.notFoundReason}): ${scanRes.message}`);
      process.exit(1);
    }
    console.log(
      `Parsed Scan -> kind=${scanRes.parsed.kind}, gtin=${scanRes.parsed.gtin}, batch=${scanRes.parsed.batch ?? 'none'}, expiry=${scanRes.parsed.expiry?.iso ?? 'none'} (expired=${scanRes.expired})\n`
    );
    printReadableCheck(scanRes.check);
    return;
  }

  const query = args.brand!;
  console.log(`Searching brand/salt: "${query}"${args.batch ? ` (batch: "${args.batch}")` : ''}...\n`);
  const res = await sdk.pickBarcodeOrSearch(query, 5);

  if (res.mode === 'barcode' && res.check) {
    const finalCheck = args.batch
      ? await sdk.medicineCheck(res.exactMatch.id, args.batch)
      : res.check;
    if (finalCheck) printReadableCheck(finalCheck);
    return;
  }

  if (res.candidates.length === 0) {
    console.error(`No matching medicines found for "${query}".`);
    process.exit(1);
  }

  const top = res.candidates[0];
  console.log(
    `Top search match: "${top.brand_name}" (${top.salt_normalized} ${top.strength}, similarity=${top.similarity_score.toFixed(2)})\n`
  );
  const check = await sdk.medicineCheck(top.id, args.batch);
  if (!check) {
    console.error('medicineCheck returned null.');
    process.exit(1);
  }
  printReadableCheck(check);
}

main().catch((err) => {
  console.error('Error in demo-check:', err);
  process.exit(1);
});
