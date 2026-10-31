import assert from 'node:assert';
import {
  createFreshState,
  validateReportInput,
  fileReport,
  pharmacyRespond,
  markCorrected,
  govUpdate,
  submitVerification,
  reviewVerification,
  searchArea,
  buildDirectory,
  evaluateVerification,
  signToken,
  verifyToken,
  loginAccount,
  registerCitizenAccount,
  requestOrgAccount,
  storeProof,
  readProof,
  handlePortalRequest,
  __resetPortalForTests,
  PortalError,
} from '../src/lib/portal.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${name}:`, err?.message || err);
    failed++;
  }
}

async function runAll() {
  console.log('====================================================================');
  console.log('MediCheck Portal Unit & Integration Tests (scripts/test-portal.ts)');
  console.log('====================================================================');

  __resetPortalForTests();

  await test('State initialisation: starts fresh with 0 reports & unverified pharmacy', () => {
    const s = createFreshState();
    assert.strictEqual(s.reports.length, 0);
    assert.strictEqual(s.pharmacy.verified, false);
    assert.strictEqual(s.pharmacy.verification.status, 'unverified');
    assert.strictEqual(s.pharmacy.submissions.length, 0);
  });

  await test('Role-based access: Citizens file reports, others cannot', () => {
    const s = createFreshState();
    const citizenActor = { user_id: 'c1', role: 'citizen' as const, display_name: 'Aarav' };
    const pharmActor = { user_id: 'p1', role: 'pharmacy' as const, display_name: 'Sundar' };

    assert.throws(() => {
      fileReport(s, pharmActor, {
        medicine: 'Dolo 650',
        pharmacy: 'Sundar Medicals',
        licence_no: 'KA-BLR-KOR-001',
        address: '12, 5th Block, Koramangala',
        issue_type: 'overpriced',
        mrp: 30,
        billed: 45,
        bill_photo_url: 'https://example.com/bill.jpg',
      });
    }, /Only citizen accounts can file reports/);

    const rep = fileReport(s, citizenActor, {
      medicine: 'Dolo 650',
      pharmacy: 'Sundar Medicals',
      licence_no: 'KA-BLR-KOR-001',
      address: '12, 5th Block, Koramangala',
      issue_type: 'overpriced',
      mrp: 30,
      billed: 45,
      bill_photo_url: 'https://example.com/bill.jpg',
      notes: 'Charged 45 instead of 30',
    });

    assert.strictEqual(s.reports.length, 1);
    assert.strictEqual(rep.status, 'open');
    assert.strictEqual(rep.overcharge, 15);
  });

  await test('Pharmacy response & Government update flow updates status & timeline', () => {
    const s = createFreshState();
    const citizenActor = { user_id: 'c1', role: 'citizen' as const, display_name: 'Aarav' };
    const pharmActor = { user_id: 'p1', role: 'pharmacy' as const, display_name: 'Sundar Medicals' };
    const govActor = { user_id: 'g1', role: 'gov' as const, display_name: 'BBMP Health Dept.' };

    const rep = fileReport(s, citizenActor, {
      medicine: 'Dolo 650',
      pharmacy: 'Sundar Medicals',
      licence_no: 'KA-BLR-KOR-001',
      address: '12, 5th Block, Koramangala',
      issue_type: 'overpriced',
      mrp: 30,
      billed: 45,
      bill_photo_url: 'https://example.com/bill.jpg',
    });

    // Pharmacy responds
    pharmacyRespond(s, pharmActor, {
      report_id: rep.id,
      text: 'Billing error on batch, refund available.',
      proof_url: 'https://example.com/credit_note.pdf',
    });
    assert.strictEqual(rep.pharmacy_response?.text, 'Billing error on batch, refund available.');
    assert.strictEqual(rep.status, 'in_progress');

    // Pharmacy marks price corrected
    markCorrected(s, pharmActor, { report_id: rep.id });
    assert.strictEqual(rep.price_corrected, true);

    // Government posts progress update
    govUpdate(s, govActor, {
      report_id: rep.id,
      status: 'resolved',
      note: 'Inspected pharmacy records, verified price corrected and credit issued.',
      proof_urls: ['https://example.com/inspection.jpg'],
    });
    assert.strictEqual(rep.status, 'resolved');
    assert.strictEqual(rep.gov_updates.length, 1);
  });

  await test('Pharmacy Verification 5-point match requirement and Government review', () => {
    const s = createFreshState();
    const citizenActor = { user_id: 'c1', role: 'citizen' as const, display_name: 'Aarav' };
    const pharmActor = { user_id: 'p1', role: 'pharmacy' as const, display_name: 'Sundar Medicals' };
    const govActor = { user_id: 'g1', role: 'gov' as const, display_name: 'BBMP Health Dept.' };

    // Unresolved citizen report blocks verification
    const rep = fileReport(s, citizenActor, {
      medicine: 'Dolo 650',
      pharmacy: 'Sundar Medicals',
      licence_no: 'KA-BLR-KOR-001',
      address: '12, 5th Block, Koramangala',
      issue_type: 'overpriced',
      mrp: 30,
      billed: 45,
      bill_photo_url: 'https://example.com/bill.jpg',
    });

    submitVerification(s, pharmActor, {
      period: 'October 2026',
      barcodes: ['8901234560013', '8901234560020', '8901234560037', '8901234560044', '8901234560051'],
      stock_proof_url: 'https://example.com/stock.jpg',
      billing_proof_url: 'https://example.com/billing.csv',
    });

    assert.strictEqual(s.pharmacy.verification.status, 'action_needed');
    assert.strictEqual(s.pharmacy.verified, false);

    // Gov cannot approve while match is false
    assert.throws(() => {
      reviewVerification(s, govActor, { action: 'approve' });
    }, /Cannot approve/);

    // Once price is marked corrected or report is resolved
    markCorrected(s, pharmActor, { report_id: rep.id });
    const match = evaluateVerification(s);
    assert.strictEqual(match.ok, true);

    // Re-check verification status updates to pending
    submitVerification(s, pharmActor, {
      period: 'October 2026',
      barcodes: ['8901234560013', '8901234560020', '8901234560037', '8901234560044', '8901234560051'],
      stock_proof_url: 'https://example.com/stock.jpg',
      billing_proof_url: 'https://example.com/billing.csv',
    });
    assert.strictEqual(s.pharmacy.verification.status, 'pending');

    // Gov approves
    reviewVerification(s, govActor, { action: 'approve', note: 'All bills & stock checked.' });
    assert.strictEqual(s.pharmacy.verification.status, 'verified');
    assert.strictEqual(s.pharmacy.verified, true);
  });

  await test('Google-Maps-style Area Radius & Directory Search', () => {
    const s = createFreshState();
    const citizenActor = { user_id: 'c1', role: 'citizen' as const, display_name: 'Aarav' };

    // File report in Koramangala
    fileReport(s, citizenActor, {
      medicine: 'Dolo 650',
      pharmacy: 'Sundar Medicals',
      licence_no: 'KA-BLR-KOR-001',
      address: '12, 5th Block, Koramangala',
      lat: 12.9352,
      lon: 77.6245,
      issue_type: 'overpriced',
      mrp: 30,
      billed: 45,
      bill_photo_url: 'https://example.com/bill.jpg',
    });

    // File report far away in Whitefield
    fileReport(s, citizenActor, {
      medicine: 'Augmentin 625',
      pharmacy: 'Whitefield Meds',
      licence_no: 'KA-BLR-WHI-002',
      address: 'Whitefield Main Road, Bengaluru',
      lat: 12.9698,
      lon: 77.7500,
      issue_type: 'stock',
      mrp: 200,
      billed: 200,
      bill_photo_url: null,
    });

    // Search near Koramangala with 5 km radius
    const resNear = searchArea(s, { lat: 12.9350, lon: 77.6240, radiusKm: 5 });
    assert.strictEqual(resNear.reports.length, 1);
    assert.strictEqual(resNear.reports[0].pharmacy, 'Sundar Medicals');
    assert(resNear.reports[0].distance_km! < 1.0);

    // Search with 20 km radius returns both
    const resFar = searchArea(s, { lat: 12.9350, lon: 77.6240, radiusKm: 25 });
    assert.strictEqual(resFar.reports.length, 2);

    // Directory calculates trust status accurately
    const dir = buildDirectory(s);
    assert.strictEqual(dir.length, 2);
  });

  await test('Auth token signing, verification & manual org requests', async () => {
    __resetPortalForTests();

    // Citizen register
    const regRes = await registerCitizenAccount({
      full_name: 'Rohan Sharma',
      phone: '+91 99887 76655',
      email: 'rohan@example.com',
      password: 'Password@123',
    });
    assert.strictEqual(regRes.role, 'citizen');
    assert.strictEqual(regRes.display_name, 'Rohan Sharma');

    // Token verifies
    const verified = verifyToken(regRes.token);
    assert.strictEqual(verified?.user_id, regRes.user_id);
    assert.strictEqual(verified?.role, 'citizen');

    // Org onboarding request (manual phone call verification requirement)
    const orgRes = await requestOrgAccount({
      role: 'pharmacy',
      org_name: 'Apollo Koramangala',
      contact_person: 'Mr. S. Rao',
      phone: '+91 91234 56789',
      area: 'Koramangala, Bengaluru',
    });
    assert.strictEqual(orgRes.requested, true);
    assert(orgRes.message.includes('A MediCheck team member will call'));
  });

  await test('Proof storage and retrieval', async () => {
    const fakeB64 = Buffer.from('TEST_IMAGE_BYTES').toString('base64');
    const stored = await storeProof({
      filename: 'sample_bill.jpg',
      content_base64: fakeB64,
      content_type: 'image/jpeg',
      folder: 'bills',
    });
    assert(stored.url.length > 0);
    assert.strictEqual(stored.bytes, Buffer.from('TEST_IMAGE_BYTES').length);

    if (stored.url.startsWith('/api/proof/')) {
      const id = stored.url.slice('/api/proof/'.length);
      const read = readProof(id);
      assert.strictEqual(read?.buf.toString(), 'TEST_IMAGE_BYTES');
    }
  });

  console.log('====================================================================');
  console.log(`SUMMARY: ${passed} PASS, ${failed} FAIL`);
  console.log('====================================================================');
  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
