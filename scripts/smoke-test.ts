import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMediCheckClient } from '../src/lib/medicheck.js';
import { buildReportText } from '../src/lib/reportText.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (no extra dependency). */
function loadDotEnv(): void {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing env vars. Copy .env.example to .env and fill SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  // 1. Load sample_data through the importer (service role, replaces existing rows)
  console.log('--- 1. Importing sample_data/ via scripts/import-csv.ts --commit ---');
  const imp = spawnSync(
    'npx',
    ['tsx', path.join('scripts', 'import-csv.ts'), '--dir', 'sample_data', '--commit', '--report', path.join('sample_data', 'validation_report.md')],
    { cwd: ROOT_DIR, stdio: 'inherit', shell: true }
  );
  if (imp.status !== 0) throw new Error('Sample import failed (see output above).');

  const sdk = createMediCheckClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  console.log('\n--- 2. searchBrands("Dolomed 650") ---');
  const searchRes = await sdk.searchBrands('Dolomed 650', 5);
  console.log(JSON.stringify(searchRes, null, 2));
  const dolomed = searchRes.find((b) => b.brand_name.startsWith('Dolomed'));
  if (!dolomed) throw new Error('Dolomed sample product not found after import.');

  console.log('\n--- 3. lookupBarcode("8901000000011") ---');
  console.log(JSON.stringify(await sdk.lookupBarcode('8901000000011'), null, 2));

  console.log('\n--- 4. pickBarcodeOrSearch("8901000000028") ---');
  console.log(JSON.stringify(await sdk.pickBarcodeOrSearch('8901000000028'), null, 2));

  console.log('\n--- 5. medicineCheck(Dolomed, batch "dlm-2409") ---');
  const checkRes = await sdk.medicineCheck(dolomed.id, 'dlm-2409');
  console.log(JSON.stringify(checkRes, null, 2));

  console.log('\n--- 6. getAuthorities({ state: "Maharashtra", reportType: "price_above_ceiling" }) ---');
  console.log(JSON.stringify(await sdk.getAuthorities({ state: 'Maharashtra', reportType: 'price_above_ceiling' }), null, 2));

  console.log('\n--- 7. submitReport(...) + buildReportText(...) ---');
  const reportPayload = {
    brand_product_id: dolomed.id,
    pharmacy_name: 'Sample Chemist (Smoke Test)',
    pharmacy_licence_no: 'SAMPLE-LIC-001',
    report_type: 'price_above_ceiling' as const,
    description: 'SAMPLE - NOT REAL DATA: Smoke test verification of anonymous report submission.',
    batch_number: 'DLM-2409',
  };
  console.log('submitReport result:', await sdk.submitReport(reportPayload));
  console.log('\nGenerated Report Text:\n' + buildReportText(checkRes, reportPayload));
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
