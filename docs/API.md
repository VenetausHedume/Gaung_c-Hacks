# MediCheck Client SDK & API Guide (`docs/API.md`)

This document explains how the frontend integrates with the MediCheck Supabase backend using the framework-agnostic TypeScript SDK (`src/lib/medicheck.ts`), plain-text complaint report builder (`src/lib/reportText.ts`), and proof receipt builder (`src/lib/receiptText.ts`).

---

## 1. Initialization

The client SDK works in any JavaScript/TypeScript frontend (React, Next.js, Vue, React Native, Svelte, or plain browser scripts). Pass your public `SUPABASE_URL` and `SUPABASE_ANON_KEY`:

```ts
import { createMediCheckClient } from '../src/lib/medicheck';

const medicheck = createMediCheckClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
```

> **Security Note:** Never expose `SUPABASE_SERVICE_ROLE_KEY` in the frontend bundle. The anon key has Row-Level Security (RLS) applied: read-only access on reference tables and insert-only access on `reports`.

---

## 2. Searching or Scanning a Medicine

### 2.1 `pickBarcodeOrSearch(input, limit = 15)` (Unified Barcode + Search Entrypoint)

Parses `input` with the offline GS1/barcode parser (`parseScan`), tries GTIN/barcode lookup first (including GTIN-14 and EAN-13 variants via `gtinCandidates`), automatically runs `medicineCheck` with any parsed batch number when a barcode hits, and falls back to fuzzy trigram search on `brand_name` and `salt_normalized` when no barcode matches.

**Request:**
```ts
const result = await medicheck.pickBarcodeOrSearch('(01)09900000000011(17)270531(10)TST1234', 10);
```

**Response (`mode === 'barcode'`):**
```json
{
  "mode": "barcode",
  "parsed": {
    "kind": "gs1",
    "gtin": "09900000000011",
    "batch": "TST1234",
    "expiry": { "raw": "270531", "iso": "2027-05-31", "expired": false },
    "serial": null,
    "manufactured": null,
    "raw": "(01)09900000000011(17)270531(10)TST1234"
  },
  "exactMatch": {
    "id": "8e35bf95-ef15-4a13-b2a2-991a0df85038",
    "brand_name": "TestFever 500",
    "manufacturer": "Sample Pharma Pvt Ltd",
    "salt_normalized": "paracetamol",
    "strength": "500 mg",
    "dosage_form": "tablet",
    "pack_size": 10,
    "pack_unit": "tablet",
    "printed_mrp": 20,
    "price_per_unit": 2,
    "mrp_source": "sample_pack",
    "mrp_date": "2026-01-15",
    "schedule_status": "scheduled",
    "notes": "SAMPLE - NOT REAL DATA"
  },
  "check": { "...": "full MedicineCheckResult with batch 'TST1234' checked" },
  "candidates": [{ "...": "exactMatch with similarity_score: 1" }]
}
```

### 2.2 `searchBrands(query, limit = 15)`

Fuzzy searches across `brand_name` and `salt_normalized`, ordered by trigram `similarity_score` descending.

**Request:**
```ts
const matches = await medicheck.searchBrands('paracetmol', 10);
```

**Response (`BrandSearchMatch[]`):**
```json
[
  {
    "id": "8e35bf95-ef15-4a13-b2a2-991a0df85038",
    "brand_name": "TestFever 500",
    "manufacturer": "Sample Pharma Pvt Ltd",
    "salt_normalized": "paracetamol",
    "strength": "500 mg",
    "dosage_form": "tablet",
    "pack_size": 10,
    "pack_unit": "tablet",
    "printed_mrp": 20,
    "price_per_unit": 2,
    "mrp_source": "sample_pack",
    "mrp_date": "2026-01-15",
    "schedule_status": "scheduled",
    "notes": "SAMPLE - NOT REAL DATA",
    "similarity_score": 0.64285713
  }
]
```

### 2.3 `lookupBarcode(code)`

Exact barcode lookup against `barcodes.barcode`, trying `gtinCandidates(code)` in order (as-is, 14-digit zero-padded, and 13-digit EAN-13 form). Returns `BrandProduct | null`.

**Request:**
```ts
const product = await medicheck.lookupBarcode('9900000000011');
```

**Response (`BrandProduct | null`):**
```json
{
  "id": "8e35bf95-ef15-4a13-b2a2-991a0df85038",
  "brand_name": "TestFever 500",
  "manufacturer": "Sample Pharma Pvt Ltd",
  "salt_normalized": "paracetamol",
  "strength": "500 mg",
  "dosage_form": "tablet",
  "pack_size": 10,
  "pack_unit": "tablet",
  "printed_mrp": 20,
  "price_per_unit": 2,
  "mrp_source": "sample_pack",
  "mrp_date": "2026-01-15",
  "schedule_status": "scheduled",
  "notes": "SAMPLE - NOT REAL DATA"
}
```

### 2.4 `scanAndCheck(raw, opts?)` (Dedicated Scanner Helper)

Pass whatever the scanner returns (GS1 element string, GS1 Digital Link QR, or plain EAN/UPC). It parses the scan offline (`src/lib/gs1.ts`), looks the GTIN up via `lookupBarcode`, and runs `medicineCheck` using the batch from the scan (or `opts.batchOverride`, which wins if the user typed one).

**Request:**
```ts
const res = await medicheck.scanAndCheck('(01)09900000000011(17)270531(10)TST1234');
```

**Response (`ScanAndCheckResult`):**
```ts
type ScanAndCheckResult =
  | { found: true; parsed: ParsedScan; product: BrandProduct; check: MedicineCheckResult;
      expired: boolean | null; notFoundReason: null }
  | { found: false; parsed: ParsedScan; suggestSearch: true; message: string;
      notFoundReason: 'unreadable_scan' | 'not_in_database' };

interface ParsedScan {
  kind: 'gs1' | 'digital_link' | 'plain_barcode' | 'unknown';
  gtin: string | null;
  batch: string | null;
  expiry: { raw: string; iso: string | null; expired: boolean | null } | null;
  serial: string | null;
  manufactured: string | null;
  raw: string;
}
```

`parseScan` and `gtinCandidates` are also exported directly from `src/lib/medicheck.ts`. Run offline GS1 unit tests with `npm run test:gs1`.

---

## 3. Running a Medicine Price & Quality Check

### `medicineCheck(brandProductId, batchNumber?)`

Calls the `medicine_check(p_brand_product_id, p_batch)` Postgres RPC function and returns a strongly typed `MedicineCheckResult`.

**Request:**
```ts
const check = await medicheck.medicineCheck(
  '8e35bf95-ef15-4a13-b2a2-991a0df85038',
  'tst 1234' // case and whitespace are ignored: 'tst 1234' matches 'TST1234'
);
```

**Response (`MedicineCheckResult`):**
```json
{
  "product": {
    "id": "8e35bf95-ef15-4a13-b2a2-991a0df85038",
    "brand_name": "TestFever 500",
    "manufacturer": "Sample Pharma Pvt Ltd",
    "salt_normalized": "paracetamol",
    "strength": "500 mg",
    "dosage_form": "tablet",
    "pack_size": 10,
    "pack_unit": "tablet",
    "printed_mrp": 20,
    "price_per_unit": 2,
    "mrp_source": "sample_pack",
    "mrp_date": "2026-01-15",
    "schedule_status": "scheduled",
    "notes": "SAMPLE - NOT REAL DATA"
  },
  "price": {
    "printed_mrp": 20,
    "price_per_unit": 2,
    "ceiling_status": "above",
    "gst_allowance_percent": 5,
    "effective_ceiling_per_unit_with_gst": 1.89,
    "gst_note": "NPPA ceiling prices exclude GST. A 5.0% GST allowance is included when comparing unit price against the ceiling (base ceiling Rs 1.80/tablet, effective threshold Rs 1.89/tablet).",
    "ceiling_row": {
      "id": "71f5f199-b7eb-4989-993a-be8e30fc2f48",
      "salt_normalized": "paracetamol",
      "strength": "500 mg",
      "dosage_form": "tablet",
      "pack_unit": "per tablet",
      "ceiling_price": 1.8,
      "gst_note": "Excludes GST",
      "effective_date": "2026-01-01",
      "notification_ref": "SO-SAMPLE-001",
      "source_url": "https://example.com/sample-nppa",
      "source_date": "2026-01-15"
    }
  },
  "equivalents": [
    {
      "id": "a6f92a38-7f7a-4b4e-8f5b-677ef3631954",
      "name": "Paracetamol Tablets IP 500mg (Jan Aushadhi)",
      "manufacturer": "PMBJP (Jan Aushadhi)",
      "ja_product_code": "S1",
      "salt_normalized": "paracetamol",
      "strength": "500 mg",
      "dosage_form": "tablet",
      "pack_size": 10,
      "pack_unit": "tablet",
      "mrp": 5,
      "price_per_unit": 0.5,
      "savings_per_unit": 1.5,
      "savings_percent": 75,
      "is_jan_aushadhi": true
    },
    {
      "id": "5976c80f-1c41-4259-b178-84998ee187a1",
      "name": "CoolPara 500",
      "manufacturer": "Sample Remedies Ltd",
      "ja_product_code": null,
      "salt_normalized": "paracetamol",
      "strength": "500 mg",
      "dosage_form": "tablet",
      "pack_size": 10,
      "pack_unit": "tablet",
      "mrp": 15,
      "price_per_unit": 1.5,
      "savings_per_unit": 0.5,
      "savings_percent": 25,
      "is_jan_aushadhi": false
    }
  ],
  "batch": {
    "batch_queried": "tst 1234",
    "batch_key": "TST1234",
    "checked": true,
    "flagged": true,
    "alert": {
      "id": "6f7fb1b5-a236-4f96-8c53-9828b308e1cf",
      "alert_month": "2026-01",
      "category": "NSQ",
      "drug_name": "Paracetamol Tablets IP 500 mg",
      "brand_name": "TestFever 500",
      "batch_number": "TST1234",
      "manufacturer": "Sample Pharma Pvt Ltd",
      "manufacturing_date": "2025-06",
      "expiry_date": "2027-05",
      "failure_reason": "Fails dissolution test (sample)",
      "testing_lab": "Sample Central Drug Lab",
      "source_url": "https://example.com/sample-cdsco",
      "source_date": "2026-01-20"
    },
    "manufacturer_salt_recent_alert_count": 1,
    "manufacturer_salt_note": "Historical alert count (1) for this manufacturer and salt is provided as background information only and does not flag your specific batch."
  },
  "data_dates": {
    "authorities": "2026-01-15",
    "brand_products": "2026-01-15",
    "ceiling_prices": "2026-01-15",
    "jan_aushadhi_products": "2026-01-15",
    "nsq_alerts": "2026-01-20"
  },
  "labels": [
    "Above ceiling price",
    "Cheaper equivalent available",
    "Batch flagged by CDSCO"
  ],
  "safety_note": "Information only. Do not change or stop a prescribed medicine without asking your doctor or pharmacist."
}
```

---

## 4. Submitting a Report & Generating Copyable Report Text

### 4.1 `submitReport(reportInput)` & `buildReportText(check, reportInput)`

Inserts an anonymous report into `public.reports` using a client-generated UUID (`crypto.randomUUID()`). Allowed `report_type` values:
- `'sold_above_mrp'`
- `'price_above_ceiling'`
- `'out_of_stock'`
- `'suspect_batch_or_pack'`
- `'bill_refused'`

**Request:**
```ts
import { buildReportText } from '../src/lib/reportText';

const reportInput = {
  brand_product_id: check.product.id,
  pharmacy_name: 'Sample Wellness Chemist, Andheri West',
  pharmacy_licence_no: 'MH-MZ1-123456',
  report_type: 'price_above_ceiling' as const,
  description: 'Purchased 1 strip of 10 tablets; printed MRP on strip was Rs 20.00.',
  batch_number: 'TST1234',
};

const submitted = await medicheck.submitReport(reportInput);
const plainText = buildReportText(check, reportInput);
```

**Response (`SubmitReportResult`):**
```json
{
  "submitted": true,
  "reportId": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## 5. Looking Up Regulatory Authorities

### `getAuthorities({ state?, reportType?, handles? })`

Returns central bodies (`state` is `null`) plus rows matching the given `state`. `authorities.handles` is a comma-separated list from `price`, `shortage`, `quality`, `bill_refusal`.
- `reportType` filters via a mapping: `sold_above_mrp`/`price_above_ceiling` → `price`, `out_of_stock` → `shortage`, `suspect_batch_or_pack` → `quality`, `bill_refused` → `bill_refusal`.

**Request:**
```ts
const authorities = await medicheck.getAuthorities({
  state: 'Maharashtra',
  reportType: 'price_above_ceiling',
});
```

**Response (`Authority[]`):**
```json
[
  {
    "id": "e1d83800-...",
    "authority_name": "National Pharmaceutical Pricing Authority (NPPA) - Pharma Jan Samadhan",
    "authority_type": "national_pricing",
    "state": null,
    "complaint_url": "https://example.com/sample-nppa-complaint",
    "email": "sample-nppa@example.com",
    "phone": "1800-11-1255",
    "handles": "price,shortage",
    "source_url": "https://example.com/sample-authorities",
    "source_date": "2026-01-15"
  },
  {
    "id": "f4c12900-...",
    "authority_name": "Maharashtra Food and Drug Administration (FDA)",
    "authority_type": "state_drug_control",
    "state": "Maharashtra",
    "complaint_url": "https://example.com/sample-mh-fda",
    "email": "sample-mhfda@example.com",
    "phone": "1800-22-2365",
    "handles": "price,quality,shortage,bill_refusal",
    "source_url": "https://example.com/sample-authorities",
    "source_date": "2026-01-15"
  }
]
```

> **Frontend note:** always pass the user's state (ask once, remember it) to `getAuthorities`. Without `state` only central bodies are returned.

---

## 6. Proof Receipts & Tamper-Evident Public Log

Every report is automatically "sealed" in an append-only public log (`public_log`) by a database trigger. Only non-personal fields are logged (`report_id`, `report_type`, salted `pharmacy_ref`, `salt_normalized`, `strength`, `dosage_form`, `brand_name`, `batch_number`, `filed_at`) and **never the `pharmacy_name`, `pharmacy_licence_no`, or free-text `description`** (which stay only in the private `reports` table).

### 6.1 `getReceipt(reportId)` & `buildReceiptText(receipt, verify)`

**Request:**
```ts
import { buildReceiptText } from '../src/lib/receiptText';

const receipt = await medicheck.getReceipt(reportId);
const verify  = await medicheck.verifyReceipt(reportId);
const text    = buildReceiptText(receipt!, verify);
```

**Response (`Receipt`):**
```json
{
  "report_id": "550e8400-e29b-41d4-a716-446655440000",
  "report": {
    "report_id": "550e8400-e29b-41d4-a716-446655440000",
    "report_type": "sold_above_mrp",
    "pharmacy_ref": "a94f6c81d3...64-hex-chars...",
    "salt_normalized": "paracetamol",
    "strength": "500 mg",
    "dosage_form": "tablet",
    "brand_name": "TestFever 500",
    "batch_number": "TST1234",
    "filed_at": "2026-10-30T18:00:00+00:00"
  },
  "seq": 1,
  "entry_hash": "8d1c2e4b...64-hex-chars...",
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "filed_at": "2026-10-30T18:00:00+00:00",
  "sealed_at": "2026-10-30T18:00:00+00:00",
  "days_since_filing": 0,
  "status": "filed",
  "authority_response": null,
  "timeline": [
    { "step": "Filed by patient and sealed in public log", "at": "2026-10-30T18:00:00+00:00", "sealed": true }
  ],
  "proof": {
    "entry_type": "report_filed",
    "payload_canonical": "{\"filed_at\": \"2026-10-30T18:00:00+00:00\", ...}",
    "sealed_at": "2026-10-30T18:00:00+00:00",
    "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
    "entry_hash": "8d1c2e4b...64-hex-chars..."
  }
}
```

### 6.2 `verifyReceipt(reportId)`

Recomputes `sha256(prev_hash || payload_canonical || entry_type || sealed_at)` and checks the link to the previous entry.

**Request & Response:**
```ts
const verify = await medicheck.verifyReceipt(reportId);
// { valid: true, message: "This record has not been changed since 30 Oct 2026." }
```

### 6.3 `verifyChain()`

Recomputes the entire `public_log` hash chain from genesis (`64` zeros).

**Request & Response:**
```ts
const chain = await medicheck.verifyChain();
// { valid: true, entries_checked: 3, first_bad_seq: null }
```

### 6.4 `getLatestSnapshot()`

Fetches the latest published Merkle root snapshot from `anchor_snapshots`.

**Request & Response:**
```ts
const snap = await medicheck.getLatestSnapshot();
// {
//   id: "d290f1ee-...",
//   root_hash: "c4b7f8...",
//   entry_count: 3,
//   last_seq: 3,
//   computed_at: "2026-10-30T18:05:00+00:00",
//   anchor_method: "opentimestamps", // or "none"
//   anchor_proof: "004f70656e54696d657374616d7073...",
//   entries_since_snapshot: 0
// }
```

### 6.5 `getPharmacyCase(licenceOrName)`

Computes `pharmacy_ref` from `licenceOrName` and counts `'report_filed'` log entries for that ref in the last 90 days, grouped by `report_type`. `threshold_met` is `true` when at least 3 reports of the same `report_type` exist; `pharmacy_name` is returned **only** when `threshold_met` is `true`.

**Request & Response (below threshold — 2 reports):**
```ts
const caseBelow = await medicheck.getPharmacyCase('TEST-HACKATHON-LIC-001');
// {
//   counts: { sold_above_mrp: 2 },
//   total: 2,
//   threshold_met: false,
//   window_days: 90,
//   note: "Counts reflect reports filed in the last 90 days; reporter identity is not verified."
// }
```

**Request & Response (at threshold — 3 reports):**
```ts
const caseMet = await medicheck.getPharmacyCase('TEST-HACKATHON-LIC-001');
// {
//   counts: { sold_above_mrp: 3 },
//   total: 3,
//   threshold_met: true,
//   window_days: 90,
//   pharmacy_name: "Test Hackathon Pharmacy (SAMPLE)",
//   note: "3 or more reports of the same issue type filed in the last 90 days."
// }
```

---

## 6b. Community Page & Government Progress Proofs (`0006` Migration)

### 6b.1 `searchCommunityIssues({ placeQuery?, state?, status?, reportType?, limit? })`

Allows a patient or community member to search up a place (`area`, `city`, `state`, `pincode`) or medicine and view:
- Aggregate issue counts (`total_matching_reports`, `filed_count`, `in_progress_count`, `resolved_count`, `with_government_response_count`).
- Individual sealed reports in that area, their current status (`'filed' | 'acknowledged' | 'investigating' | 'action_taken' | 'resolved'`), and every **government progress update with proof images** (`proof_urls`).
- Privacy protection: `pharmacy_name` is revealed only when `threshold_met` (`>= 3` reports of the same type in 90 days) is `true`.

**Request:**
```ts
const feed = await medicheck.searchCommunityIssues({
  placeQuery: 'Andheri West',
  state: 'Maharashtra',
});
```

**Response (`CommunityFeedResult`):**
```json
{
  "query": {
    "place_query": "Andheri West",
    "state": "Maharashtra",
    "status": null,
    "report_type": null
  },
  "summary": {
    "total_matching_reports": 3,
    "filed_count": 2,
    "in_progress_count": 1,
    "resolved_count": 0,
    "with_government_response_count": 1
  },
  "items": [
    {
      "seq": 1,
      "report_id": "6bcfcc70-3965-413f-9441-f605b5c4aa89",
      "entry_hash": "8d1c2e4b...",
      "filed_at": "2026-10-30T18:31:00Z",
      "sealed_at": "2026-10-30T18:31:00Z",
      "days_since_filing": 0,
      "report_type": "sold_above_mrp",
      "location": {
        "area": "Andheri West",
        "city": "Mumbai",
        "state": "Maharashtra",
        "pincode": "400058"
      },
      "medicine": {
        "brand_name": "TestFever 500",
        "salt_normalized": "paracetamol",
        "strength": "500 mg",
        "dosage_form": "tablet",
        "batch_number": "TST1234"
      },
      "pharmacy_ref": "a94f6c81...",
      "threshold_met": true,
      "pharmacy_name": "Test Hackathon Chemist (SAMPLE)",
      "current_status": "action_taken",
      "government_updates": [
        {
          "seq": 4,
          "status": "action_taken",
          "agency_name": "Maharashtra Food and Drug Administration",
          "officer_designation": "Assistant Commissioner (Drugs)",
          "action_taken": "Inspection conducted & show-cause notice issued",
          "progress_note": "Inspected premises on 31 Oct 2026; verified stock register and issued show-cause memo.",
          "proof_urls": [
            "https://bpekbusfdvcbvqxmhdsf.supabase.co/storage/v1/object/public/evidence_proofs/gov/inspection-memo-001.jpg"
          ],
          "updated_at": "2026-10-31T06:00:00Z",
          "entry_hash": "9f2a1d...",
          "sealed": true
        }
      ]
    }
  ],
  "note": "The public log proves records are unchanged since filing. Pharmacy names are shown only when 3 or more reports of the same issue type exist within 90 days."
}
```

### 6b.2 Government Account: `uploadProofFile` & `postGovernmentProgress`

Authorized government accounts (`government_accounts` table linked to `auth.users`) can upload photographic/documentary proof to the `evidence_proofs` bucket and post official progress on a report. Posting progress automatically appends a cryptographically sealed `'status_change'` entry to `public_log` and updates `getReceipt(reportId)`.

```ts
// 1. Upload inspection photo / official notice image
const proofUrl = await medicheck.uploadProofFile(
  `gov/${reportId}/inspection-notice.jpg`,
  imageBlob,
  'image/jpeg'
);

// 2. Post official progress & seal in public_log
const update = await medicheck.postGovernmentProgress({
  report_id: reportId,
  status: 'action_taken', // 'acknowledged' | 'investigating' | 'action_taken' | 'resolved'
  action_taken: 'Inspection conducted & show-cause notice issued',
  progress_note: 'Inspected store inventory and billing terminal; issued compliance notice.',
  proof_urls: [proofUrl],
  agency_name: 'Maharashtra FDA',
  officer_designation: 'Assistant Commissioner (Drugs)',
});
```

---

## 6c. Phase 2 Pharmacy Portal: Stock & Fair-Billing Verification & Verified Store Suggestions

### 6c.1 `registerPharmacy` & `submitPharmacyVerification`

Pharmacies can register their store profile and submit **proof images of maintaining required essential/Jan Aushadhi stock** (`stock_proof_urls`) and **proof images of billing at fair rates** (`billing_proof_urls`) along with a sample billed medicine and unit price.

The backend automatically verifies:
1. **Stock Requirement:** `essential_medicines_stocked >= 5` and at least one stock proof image attached.
2. **MRP Compliance:** `sample_billed_unit_price <= printed_mrp / pack_size`.
3. **NPPA Ceiling Compliance:** `sample_billed_unit_price <= ceiling_price * 1.05` (within NPPA ceiling + 5% GST allowance).
4. **CDSCO Quality Check:** `sample_batch_number` is **not** flagged in `nsq_alerts`.
5. **Clean Complaint Record:** Pharmacy does not have `>= 3` reports of the same issue type in the last 90 days.

When all 5 checks match, the pharmacy is marked **Verified (`is_verified = true`, `verification_status = 'verified'`)** and is suggested to patients searching for a verified store in their area!

```ts
// 1. Register or update pharmacy profile
const pharmacy = await medicheck.registerPharmacy({
  pharmacy_name: 'Sample Jan Aushadhi & Fair Price Kendra',
  licence_no: 'MH-AND-998877',
  area: 'Andheri West',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400058',
  address: 'Shop 4, Market Road, Andheri West',
  phone: '022-26001122',
  jan_aushadhi_available: true,
});

// 2. Submit stock & fair-billing proof images
const verification = await medicheck.submitPharmacyVerification({
  pharmacy_id: pharmacy.id,
  stock_proof_urls: ['https://.../evidence_proofs/pharmacies/stock-shelf.jpg'],
  billing_proof_urls: ['https://.../evidence_proofs/pharmacies/gst-bill-coolpara.jpg'],
  essential_medicines_stocked: 35,
  sample_brand_product_id: coolParaProduct.id, // CoolPara 500 (MRP Rs 1.50/tab, Ceiling+GST Rs 1.89/tab)
  sample_billed_unit_price: 1.50,
  sample_batch_number: 'CLEAN-BATCH-01',
  jan_aushadhi_stocked: true,
});

console.log(verification.is_verified);        // true
console.log(verification.verification_score); // 99.75
console.log(verification.auto_check_details); // Breakdown of all 5 automated checks
```

### 6c.2 Patient Area Search: `getVerifiedPharmacies({ areaOrQuery?, city?, state?, pincode?, onlyJanAushadhi? })`

Patients can search for **Verified Pharmacies** in their locality/city/pincode that have proven stock availability and fair billing. Results are ranked with Jan Aushadhi availability and highest verification score first.

```ts
const stores = await medicheck.getVerifiedPharmacies({
  areaOrQuery: 'Andheri West',
  state: 'Maharashtra',
});
// Returns PharmacyProfile[] with is_verified: true, stock_proof_urls, billing_proof_urls, verified_at
```

---

## 7. Mandatory Wording Rules & Disclaimers

1. **Always display `check.safety_note`** prominently on every medicine result screen:
   > *"Information only. Do not change or stop a prescribed medicine without asking your doctor or pharmacist."*
2. **Always display dataset freshness (`check.data_dates`)** as `"Data as of YYYY-MM-DD"` next to price, Jan Aushadhi, and CDSCO alert sections.
3. **Neutral Wording Policy:**
   - Use the exact `check.labels` strings (`"Within ceiling price"`, `"Above ceiling price"`, `"No ceiling price available"`, `"Cheaper equivalent available"`, `"Batch flagged by CDSCO"`, `"Batch not found in latest CDSCO lists"`).
   - Never use accusatory words like *"overpriced"*, *"fraud"*, or *"counterfeit"*.
   - For proof receipts, say **"sealed"** (e.g., *"Your report is sealed"*) and show a **"Verify"** button. Never say *"blockchain"*, *"hash"*, or *"ledger"* in patient-facing UI.
   - Show the silence clock as: *"Day N since filing, no official response recorded."*
   - For pharmacy report counts, always say **"reports"**, never *"independent"* or *"confirmed"*.
4. **Required Legal & Technical Disclaimers:**
   - **What the seal proves:** The chain proves a record is unchanged after filing, not that it was true when filed.
   - **Reporter independence:** Report counts are not independent until reporter verification (phone OTP) exists.
   - **Merkle root anchoring:** The Merkle root is anchoring-ready, and public anchoring is claimed only if `scripts/anchor.ts` printed that the calendar accepted it (`anchor_method = 'opentimestamps'`).

---

## 8. Maintainer CLI Commands

```bash
npm run import -- --dry-run                    # validate ./data CSVs and write import_report.md
npm run import                                 # validate ./data CSVs and import if zero critical errors
npm run test:gs1                               # run offline GS1 / barcode parser unit tests
npm run test:all                               # run live verification suite (skips permanent report inserts)
npm run test:all -- --confirm-permanent        # run full live suite including permanent public_log test batch
npm run anchor                                 # snapshot Merkle root and submit to OpenTimestamps
npm run demo -- --brand "TestFever 500" --batch TST1234
```
