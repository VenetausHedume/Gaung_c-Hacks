/**
 * MediCheck Multi-Page Presentation & API Server (`scripts/serve.ts`)
 *
 * Serves the 5 separate interactive presentation pages and exposes JSON API endpoints
 * backed directly by `src/lib/medicheck.ts` and the live Supabase database:
 *   - http://localhost:3000/               (Page 1: Medicine Price, Quality & Barcode Scanner)
 *   - http://localhost:3000/community.html (Page 2: Community Place Search — Verified Stores & Local Issues)
 *   - http://localhost:3000/government.html(Page 3: Government Officer Account & Progress Proof Portal)
 *   - http://localhost:3000/pharmacy.html  (Page 4: Phase 2 Pharmacy Stock & Fair-Billing Verification)
 *   - http://localhost:3000/security.html  (Page 5: Tamper-Evident Public Log, Receipts & Security Inspector)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMediCheckClient, type ReportInput } from '../src/lib/medicheck.js';
import { buildReportText } from '../src/lib/reportText.js';
import { buildReceiptText } from '../src/lib/receiptText.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(ROOT_DIR, 'pages');

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

loadDotEnv();

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const sdk = createMediCheckClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function createPresentationServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      // -----------------------------------------------------------------------
      // JSON API Routes (backed by src/lib/medicheck.ts + live Supabase)
      // -----------------------------------------------------------------------
      if (pathname === '/api/check' && req.method === 'GET') {
        const query = url.searchParams.get('q') ?? 'TestFever 500';
        const batch = url.searchParams.get('batch') ?? null;
        const pick = await sdk.pickBarcodeOrSearch(query, 10);

        if (pick.mode === 'barcode' && pick.exactMatch) {
          const check = batch
            ? await sdk.medicineCheck(pick.exactMatch.id, batch)
            : pick.check;
          sendJson(res, 200, { mode: 'barcode', parsed: pick.parsed, check, candidates: pick.candidates });
          return;
        }

        const top = pick.candidates[0] ?? null;
        const check = top ? await sdk.medicineCheck(top.id, batch) : null;
        sendJson(res, 200, { mode: 'search', parsed: pick.parsed, check, candidates: pick.candidates });
        return;
      }

      if (pathname === '/api/authorities' && req.method === 'GET') {
        const state = url.searchParams.get('state') || null;
        const reportType = (url.searchParams.get('reportType') as ReportInput['report_type']) || null;
        const authorities = await sdk.getAuthorities({ state, reportType });
        sendJson(res, 200, { authorities });
        return;
      }

      if (pathname === '/api/report-preview' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const brandProductId = String(body.brand_product_id ?? '');
        const batchNumber = body.batch_number ? String(body.batch_number) : null;
        const check = brandProductId ? await sdk.medicineCheck(brandProductId, batchNumber) : null;
        const reportInput: ReportInput = {
          brand_product_id: brandProductId || null,
          pharmacy_name: String(body.pharmacy_name ?? 'Sample Chemist'),
          pharmacy_licence_no: body.pharmacy_licence_no ? String(body.pharmacy_licence_no) : null,
          report_type: (body.report_type as ReportInput['report_type']) ?? 'price_above_ceiling',
          description: String(body.description ?? 'Observed discrepancy during purchase.'),
          batch_number: batchNumber,
        };
        const text = buildReportText(check, reportInput);
        sendJson(res, 200, { text });
        return;
      }

      if (pathname === '/api/community' && req.method === 'GET') {
        const placeQuery = url.searchParams.get('q') || null;
        const state = url.searchParams.get('state') || null;
        const status = (url.searchParams.get('status') as never) || null;
        const onlyJanAushadhi = url.searchParams.get('onlyJanAushadhi') === 'true';

        const [issues, verifiedPharmacies] = await Promise.all([
          sdk.searchCommunityIssues({ placeQuery, state, status, limit: 25 }),
          sdk.getVerifiedPharmacies({ areaOrQuery: placeQuery, state, onlyJanAushadhi, limit: 20 }),
        ]);

        sendJson(res, 200, { issues, verifiedPharmacies });
        return;
      }

      if (pathname === '/api/government/progress' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const proofUrls = Array.isArray(body.proof_urls)
          ? (body.proof_urls as unknown[]).map(String).filter(Boolean)
          : String(body.proof_urls ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const result = await sdk.postGovernmentProgress({
          report_id: String(body.report_id ?? ''),
          status: (body.status as 'acknowledged' | 'investigating' | 'action_taken' | 'resolved') ?? 'action_taken',
          action_taken: body.action_taken ? String(body.action_taken) : null,
          progress_note: String(body.progress_note ?? ''),
          proof_urls: proofUrls,
          agency_name: body.agency_name ? String(body.agency_name) : null,
          officer_designation: body.officer_designation ? String(body.officer_designation) : null,
        });

        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/pharmacy/verify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const pharmacy = await sdk.registerPharmacy({
          pharmacy_name: String(body.pharmacy_name ?? ''),
          licence_no: String(body.licence_no ?? ''),
          area: String(body.area ?? ''),
          city: String(body.city ?? ''),
          state: String(body.state ?? ''),
          pincode: String(body.pincode ?? ''),
          address: body.address ? String(body.address) : null,
          phone: body.phone ? String(body.phone) : null,
          jan_aushadhi_available: Boolean(body.jan_aushadhi_available),
        });

        const stockUrls = Array.isArray(body.stock_proof_urls)
          ? (body.stock_proof_urls as unknown[]).map(String).filter(Boolean)
          : String(body.stock_proof_urls ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const billingUrls = Array.isArray(body.billing_proof_urls)
          ? (body.billing_proof_urls as unknown[]).map(String).filter(Boolean)
          : String(body.billing_proof_urls ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const verification = await sdk.submitPharmacyVerification({
          pharmacy_id: pharmacy.id,
          stock_proof_urls: stockUrls,
          billing_proof_urls: billingUrls,
          essential_medicines_stocked: Number(body.essential_medicines_stocked ?? 20),
          sample_brand_product_id: String(body.sample_brand_product_id ?? ''),
          sample_billed_unit_price: Number(body.sample_billed_unit_price ?? 0),
          sample_batch_number: body.sample_batch_number ? String(body.sample_batch_number) : null,
          jan_aushadhi_stocked: Boolean(body.jan_aushadhi_available),
        });

        sendJson(res, 200, { pharmacy, verification });
        return;
      }

      if (pathname === '/api/products' && req.method === 'GET') {
        const matches = await sdk.searchBrands('a', 20);
        sendJson(res, 200, { products: matches });
        return;
      }

      if (pathname === '/api/security/overview' && req.method === 'GET') {
        const reportId = url.searchParams.get('reportId') || '6bcfcc70-3965-413f-9441-f605b5c4aa89';
        const licence = url.searchParams.get('licence') || 'TEST-HACKATHON-LIC-001';

        const [chain, snapshot, receipt, verify, pharmacyCase] = await Promise.all([
          sdk.verifyChain(),
          sdk.getLatestSnapshot(),
          sdk.getReceipt(reportId),
          sdk.verifyReceipt(reportId),
          sdk.getPharmacyCase(licence),
        ]);

        const receiptText = receipt ? buildReceiptText(receipt, verify) : null;
        let tamperDemo = null;
        if (receipt) {
          const p = receipt.proof;
          const originalComputed = sha256Hex(p.prev_hash + p.payload_canonical + p.entry_type + p.sealed_at);
          const tamperedPayload = p.payload_canonical.replace(
            /(price_above_ceiling|sold_above_mrp|suspect_batch_or_pack|bill_refused)/,
            'TAMPERED_REPORT_TYPE',
          );
          const tamperedComputed = sha256Hex(p.prev_hash + tamperedPayload + p.entry_type + p.sealed_at);
          tamperDemo = {
            stored_entry_hash: p.entry_hash,
            original_recomputed_hash: originalComputed,
            original_matches: originalComputed === p.entry_hash,
            tampered_payload_excerpt: tamperedPayload.slice(0, 120) + '...',
            tampered_recomputed_hash: tamperedComputed,
            tamper_detected: tamperedComputed !== p.entry_hash,
          };
        }

        sendJson(res, 200, {
          chain,
          snapshot,
          receipt,
          verify,
          receiptText,
          pharmacyCase,
          tamperDemo,
        });
        return;
      }

      // -----------------------------------------------------------------------
      // Static HTML Pages
      // -----------------------------------------------------------------------
      const pageName = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const safeFile = path.basename(pageName);
      const filePath = path.join(PAGES_DIR, safeFile);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType =
          ext === '.html'
            ? 'text/html; charset=utf-8'
            : ext === '.css'
            ? 'text/css; charset=utf-8'
            : ext === '.js'
            ? 'application/javascript; charset=utf-8'
            : ext === '.svg'
            ? 'image/svg+xml'
            : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(filePath));
        return;
      }

      sendJson(res, 404, { error: `Not found: ${pathname}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { error: msg });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createPresentationServer();
  server.listen(port, () => {
    console.log('====================================================================');
    console.log(`MediCheck Presentation Server running at http://localhost:${port}`);
    console.log('  0. Landing Page (Problem & Solution): http://localhost:' + port + '/index.html');
    console.log('  1. App Homepage (All Features)      : http://localhost:' + port + '/dashboard.html');
    console.log('  2. Medicine & Barcode Scanner Studio: http://localhost:' + port + '/scan.html');
    console.log('  3. Community & Verified Stores      : http://localhost:' + port + '/community.html');
    console.log('  4. Government Officer Portal        : http://localhost:' + port + '/government.html');
    console.log('  5. Pharmacy Verification            : http://localhost:' + port + '/pharmacy.html');
    console.log('  6. Security & Public Log            : http://localhost:' + port + '/security.html');
    console.log('====================================================================');
  });
}
