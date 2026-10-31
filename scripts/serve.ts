/**
 * MediCheck Multi-Page Presentation & API Server (`scripts/serve.ts`)
 *
 * Serves the MediCheck frontend pages from `pages/` and exposes JSON API endpoints
 * backed directly by `src/lib/medicheck.ts` and the live Supabase database:
 *   - http://localhost:3000/                     (index.html — Landing Page)
 *   - http://localhost:3000/login.html           (Role-based Sign in & Registration)
 *   - http://localhost:3000/home.html            (Citizen Dashboard)
 *   - http://localhost:3000/scan.html            (Citizen 3-Step Barcode & MRP Scanner)
 *   - http://localhost:3000/report.html          (Citizen Add Report)
 *   - http://localhost:3000/area.html            (Citizen Area Search — Issues & Verified Pharmacies, No Map)
 *   - http://localhost:3000/pharmacy-home.html   (Pharmacy Portal Overview & Price Organiser)
 *   - http://localhost:3000/pharmacy-verify.html (Pharmacy Stock Scan & Billing Proof Verification)
 *   - http://localhost:3000/pharmacy-reports.html(Pharmacy Reports & Response Portal)
 *   - http://localhost:3000/gov-home.html        (Government Area Overview & Case Queue)
 *   - http://localhost:3000/gov-case.html        (Government Case Detail, Timeline & Progress Proof)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createMediCheckClient,
  recordCitizenCaseForPortals,
  recordPharmacySubmissionHistory,
  type ReportInput,
  type ReportType,
  type UserPortalRole,
} from '../src/lib/medicheck.js';
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

      if (pathname === '/api/reports' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const issueTypeRaw = String(body.issue_type ?? body.report_type ?? 'overpriced');
        const issueCategory: 'overpriced' | 'stock' | 'expired' =
          issueTypeRaw === 'stock' || issueTypeRaw === 'out_of_stock'
            ? 'stock'
            : issueTypeRaw === 'expired' || issueTypeRaw === 'suspect_batch_or_pack'
            ? 'expired'
            : 'overpriced';

        const mappedReportType: ReportType =
          issueCategory === 'stock'
            ? 'out_of_stock'
            : issueCategory === 'expired'
            ? 'suspect_batch_or_pack'
            : 'sold_above_mrp';

        const medicineName = String(body.medicine ?? body.medicine_name ?? 'Dolo 650mg, 15 tablets').trim();
        const mrpAmount = Number(body.mrp ?? body.mrp_amount ?? 31);
        const billedAmount = Number(body.billed ?? body.billed_amount ?? 49);
        const pharmacyName = String(body.pharmacy ?? body.pharmacy_name ?? 'Sundar Medicals').trim() || 'Sundar Medicals';
        const address = String(body.address ?? '12, 5th Block, Koramangala, Bengaluru 560095').trim();
        const notes = String(body.notes ?? body.description ?? '').trim();
        const billPhotoUrl = body.bill_photo_url ? String(body.bill_photo_url) : null;
        const persistToDb = body.persist_to_db === true;

        const description =
          notes ||
          `${medicineName} at ${pharmacyName} (${address}): billed ₹${billedAmount} vs MRP ₹${mrpAmount} (${issueCategory}).`;

        let reportId = `rep-${Date.now()}`;
        if (persistToDb) {
          const matches = await sdk.searchBrands(medicineName.split(' ')[0] || 'TestFever', 1).catch(() => []);
          const sub = await sdk.submitReport({
            brand_product_id: matches[0]?.id ?? null,
            pharmacy_name: pharmacyName,
            report_type: mappedReportType,
            description,
            area: address,
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560095',
          });
          reportId = sub.reportId;
        }

        recordCitizenCaseForPortals({
          report_id: reportId,
          issue_type: issueCategory,
          medicine: medicineName,
          mrp: mrpAmount,
          billed: billedAmount,
          pharmacy: pharmacyName,
          address,
          notes: description,
          bill_photo_url: billPhotoUrl,
        });

        sendJson(res, 200, {
          submitted: true,
          reportId,
          issue_type: issueCategory,
          report_type: mappedReportType,
          medicine: medicineName,
          mrp: mrpAmount,
          billed: billedAmount,
          overcharge: Math.max(0, Number((billedAmount - mrpAmount).toFixed(2))),
          pharmacy: pharmacyName,
          address,
          status: 'open',
        });
        return;
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const role = (String(body.role ?? 'citizen') as UserPortalRole);
        const identifier = String(body.identifier ?? body.id ?? '');
        const password = body.password ? String(body.password) : undefined;
        const session = await sdk.loginUser({ role, identifier, password });
        sendJson(res, 200, session);
        return;
      }

      if (pathname === '/api/auth/register-citizen' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const session = await sdk.registerCitizen({
          full_name: String(body.full_name ?? body.name ?? 'Ananya'),
          phone: String(body.phone ?? '+91 98450 12345'),
          email: body.email ? String(body.email) : null,
          password: body.password ? String(body.password) : undefined,
        });
        sendJson(res, 200, session);
        return;
      }

      if (pathname === '/api/auth/request-org-call' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const role = String(body.role ?? 'pharmacy') === 'gov' ? 'gov' : 'pharmacy';
        const result = await sdk.requestOrgVerificationCall({
          role,
          org_name: String(body.org_name ?? body.org ?? 'Sundar Medicals'),
          contact_person: String(body.contact_person ?? body.contact ?? 'R. Sundar — Proprietor'),
          phone: String(body.phone ?? '+91 80 2553 0101'),
          area: String(body.area ?? 'Koramangala, Bengaluru'),
        });
        sendJson(res, 200, result);
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

      if (pathname === '/api/pharmacy/dashboard' && req.method === 'GET') {
        const pharmacyName = url.searchParams.get('pharmacy') || 'Sundar Medicals';
        const dashboard = await sdk.getPharmacyDashboard(pharmacyName);
        sendJson(res, 200, dashboard);
        return;
      }

      if (pathname === '/api/pharmacy/price-fix' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const item = await sdk.updatePharmacyPriceItem({
          item_id: String(body.item_id ?? 'price-item-1'),
          action: body.action === 'update_stock' ? 'update_stock' : 'mark_corrected',
        });
        const dashboard = await sdk.getPharmacyDashboard();
        sendJson(res, 200, { updated_item: item, billing_match_rate: dashboard.billing_match_rate });
        return;
      }

      if (pathname === '/api/pharmacy/respond' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const proofUrls = Array.isArray(body.proof_urls)
          ? (body.proof_urls as unknown[]).map(String).filter(Boolean)
          : body.proof_url
          ? [String(body.proof_url)]
          : [];

        const response = await sdk.submitPharmacyResponse({
          report_id: body.report_id ? String(body.report_id) : undefined,
          pharmacy_name: body.pharmacy_name ? String(body.pharmacy_name) : 'Sundar Medicals',
          response_text: String(body.response_text ?? body.response ?? ''),
          proof_urls: proofUrls,
        });
        sendJson(res, 200, response);
        return;
      }

      if (pathname === '/api/gov/case' && req.method === 'GET') {
        const reportId = url.searchParams.get('id') || '6bcfcc70-3965-413f-9441-f605b5c4aa89';
        const detail = await sdk.getGovernmentCaseDetail(reportId);
        sendJson(res, 200, detail);
        return;
      }

      if (pathname === '/api/government/progress' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const rawStatus = String(body.status ?? 'action_taken').toLowerCase();
        const mappedStatus: 'acknowledged' | 'investigating' | 'action_taken' | 'resolved' =
          rawStatus === 'resolved'
            ? 'resolved'
            : rawStatus === 'in progress' || rawStatus === 'in_progress' || rawStatus === 'investigating'
            ? 'investigating'
            : rawStatus === 'acknowledged'
            ? 'acknowledged'
            : 'action_taken';

        const actionTaken =
          rawStatus === 'escalated'
            ? 'Escalated'
            : body.action_taken
            ? String(body.action_taken)
            : null;

        const proofUrls = Array.isArray(body.proof_urls)
          ? (body.proof_urls as unknown[]).map(String).filter(Boolean)
          : String(body.proof_urls ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const result = await sdk.postGovernmentProgress({
          report_id: String(body.report_id || '6bcfcc70-3965-413f-9441-f605b5c4aa89'),
          status: mappedStatus,
          action_taken: actionTaken,
          progress_note: String(body.progress_note ?? body.update ?? ''),
          proof_urls: proofUrls,
          agency_name: body.agency_name ? String(body.agency_name) : 'BBMP Health Department',
          officer_designation: body.officer_designation ? String(body.officer_designation) : 'Drug Control Inspector',
        });

        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/pharmacy/verify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const pharmacyName = String(body.pharmacy_name ?? 'Sundar Medicals');
        const licenceNo = String(body.licence_no ?? 'KA-BLR-KOR-001');
        const area = String(body.area ?? 'Koramangala');
        const city = String(body.city ?? 'Bengaluru');
        const state = String(body.state ?? 'Karnataka');
        const pincode = String(body.pincode ?? '560095');

        const pharmacy = await sdk.registerPharmacy({
          pharmacy_name: pharmacyName,
          licence_no: licenceNo,
          area,
          city,
          state,
          pincode,
          address: body.address ? String(body.address) : '12, 5th Block, Koramangala, Bengaluru 560095',
          phone: body.phone ? String(body.phone) : '080-25530101',
          jan_aushadhi_available: Boolean(body.jan_aushadhi_available ?? true),
          notes: body.notes ? String(body.notes) : null,
        });

        const stockUrls = Array.isArray(body.stock_proof_urls)
          ? (body.stock_proof_urls as unknown[]).map(String).filter(Boolean)
          : String(body.stock_proof_urls ?? 'https://example.com/proof/shelf-barcode-scan.jpg')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const billingUrls = Array.isArray(body.billing_proof_urls)
          ? (body.billing_proof_urls as unknown[]).map(String).filter(Boolean)
          : String(body.billing_proof_urls ?? 'https://example.com/proof/billing-export-30d.csv')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        let sampleProductId = String(body.sample_brand_product_id ?? '');
        let sampleBilledUnit = Number(body.sample_billed_unit_price ?? 0);
        if (!sampleProductId) {
          const products = await sdk.searchBrands('a', 5);
          const first = products[0];
          if (first) {
            sampleProductId = first.id;
            if (!sampleBilledUnit || sampleBilledUnit <= 0) {
              sampleBilledUnit = Number((first.price_per_unit * 0.9).toFixed(2));
            }
          }
        }

        const itemsScanned = Number(body.essential_medicines_stocked ?? body.items_scanned ?? 25);
        const verification = await sdk.submitPharmacyVerification({
          pharmacy_id: pharmacy.id,
          stock_proof_urls: stockUrls.length > 0 ? stockUrls : ['https://example.com/proof/stock.jpg'],
          billing_proof_urls: billingUrls.length > 0 ? billingUrls : ['https://example.com/proof/billing.jpg'],
          essential_medicines_stocked: Math.max(5, itemsScanned),
          sample_brand_product_id: sampleProductId,
          sample_billed_unit_price: sampleBilledUnit > 0 ? sampleBilledUnit : 1.5,
          sample_batch_number: body.sample_batch_number ? String(body.sample_batch_number) : null,
          jan_aushadhi_stocked: Boolean(body.jan_aushadhi_available ?? true),
        });

        if (body.period) {
          recordPharmacySubmissionHistory(String(body.period), Math.max(1, itemsScanned));
        }

        sendJson(res, 200, { pharmacy, verification });
        return;
      }

      if (pathname === '/api/upload-proof' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const fileName = String(body.filename ?? `proof-${Date.now()}.jpg`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const folder = String(body.folder ?? 'citizen-bills').replace(/[^a-zA-Z0-9._-]/g, '_');
        const content = new TextEncoder().encode(String(body.content ?? 'MEDICHECK_PROOF_DOCUMENT'));
        const publicUrl = await sdk.uploadProofFile(`${folder}/${fileName}`, content, String(body.content_type ?? 'image/jpeg'));
        sendJson(res, 200, { uploaded: true, filename: fileName, url: publicUrl });
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
      // Static HTML / CSS / JS Pages from `pages/`
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

        if (ext === '.html') {
          let html = fs.readFileSync(filePath, 'utf8');
          if (!html.includes('src="app.js"') && !html.includes('src="/app.js"')) {
            html = html.replace('</body>', '<script src="app.js"></script>\n</body>');
          }
          res.end(html);
          return;
        }

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
    console.log(`MediCheck Server running at http://localhost:${port}`);
    console.log(`  Landing Page      : http://localhost:${port}/index.html`);
    console.log(`  Login / Register  : http://localhost:${port}/login.html`);
    console.log(`  Citizen Home      : http://localhost:${port}/home.html`);
    console.log(`  Barcode Scanner   : http://localhost:${port}/scan.html`);
    console.log(`  Add Report        : http://localhost:${port}/report.html`);
    console.log(`  Area Search       : http://localhost:${port}/area.html`);
    console.log(`  Pharmacy Portal   : http://localhost:${port}/pharmacy-home.html`);
    console.log(`  Pharmacy Verify   : http://localhost:${port}/pharmacy-verify.html`);
    console.log(`  Pharmacy Reports  : http://localhost:${port}/pharmacy-reports.html`);
    console.log(`  Government Portal : http://localhost:${port}/gov-home.html`);
    console.log(`  Government Case   : http://localhost:${port}/gov-case.html`);
    console.log('====================================================================');
  });
}
