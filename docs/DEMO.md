# MediCheck Live Demo Guide (`docs/DEMO.md`)

This guide contains ready-to-run demonstration scenarios using **only the rows currently loaded in the live Supabase database**.

> **Dataset Provenance Note (`SAMPLE` vs `REAL`):**
> - All 7 `brand_products`, 4 `barcodes`, 2 `ceiling_prices`, 3 `jan_aushadhi_products`, 1 `nsq_alerts`, and 7 `authorities` rows currently in the live database are **fictional sample records** clearly marked `"SAMPLE - NOT REAL DATA"` in `notes` (or `https://example.com/sample` in `source_url`).
> - A partial real-data seed exists in `./data/` (validated in `import_report.md`), where `data/nsq_alerts.csv` (15 rows) and `data/authorities.csv` (2 of 3 rows) are currently missing required `source_date` values (`YYYY-MM-DD`). Because `scripts/import.ts` enforces zero critical errors before replacing live tables, the live database retains the fictional `SAMPLE` rows so all price, barcode, and NSQ batch demo scenarios work out of the box.

---

## Scenario 1: Above NPPA Ceiling Price + Flagged CDSCO Batch + Cheaper Equivalents

**Medicine:** `TestFever 500` (`paracetamol` `500 mg` `tablet`, `Sample Labs`) — **[SAMPLE ROW]**
- **Printed MRP:** Rs 30.00 for 15 tablets (**Rs 2.00 / tablet**)
- **NPPA Base Ceiling:** Rs 1.80 / tablet → **Rs 1.89 / tablet** with 5% GST allowance (`ceiling_status: "above"`)
- **Cheaper Same-Salt Equivalents (sorted cheapest first):**
  1. `Paracetamol Tablets IP 500 mg` (Jan Aushadhi `#S1`) — **Rs 0.50 / tablet** (75% savings)
  2. `CoolPara 500` (`Sample Remedies`) — **Rs 1.50 / tablet** (25% savings)
- **Batch Check (`TST1234` or `tst 1234`):** Flagged (`category: "NSQ"`, alert month `2026-09`, failure reason: `"Dissolution"`).

**CLI Command:**
```bash
npm run demo -- --brand "TestFever 500" --batch TST1234
```

**Barcode / GS1 DataMatrix Scan Variant:**
```bash
npm run demo -- --barcode "(01)09900000000011(17)270531(10)TST1234"
```

---

## Scenario 2: Within NPPA Ceiling Price + Clean Batch

**Medicine:** `CoolPara 500` (`paracetamol` `500 mg` `tablet`, `Sample Remedies`) — **[SAMPLE ROW]**
- **Barcode:** `9900000000028`
- **Printed MRP:** Rs 15.00 for 10 tablets (**Rs 1.50 / tablet**)
- **Ceiling Status:** `"within"` (Rs 1.50 ≤ Rs 1.89 effective ceiling with 5% GST)
- **Cheaper Same-Salt Equivalent:**
  1. `Paracetamol Tablets IP 500 mg` (Jan Aushadhi `#S1`) — **Rs 0.50 / tablet** (66.7% savings)
- **Batch Check (`XYZ999`):** `"Batch not found in latest CDSCO lists"` (`flagged: false`)

**CLI Command:**
```bash
npm run demo -- --barcode 9900000000028 --batch XYZ999
```

---

## Scenario 3: Non-Scheduled Medicine (`no_ceiling`) + Cheaper Equivalents

**Medicine:** `SugarEase 500` (`metformin` `500 mg` `tablet`, `Sample Lifesciences`) — **[SAMPLE ROW]**
- **Barcode:** `9900000000035`
- **Printed MRP:** Rs 30.00 for 10 tablets (**Rs 3.00 / tablet**)
- **Ceiling Status:** `"no_ceiling"` (`schedule_status: "non_scheduled"`)
- **Cheaper Same-Salt Equivalents:**
  1. `Metformin Hydrochloride Tablets IP 500 mg` (Jan Aushadhi `#S2`) — **Rs 0.70 / tablet** (76.7% savings)
  2. `GlucoTest 500` (`Sample Bio`) — **Rs 1.60 / tablet** (46.7% savings)

**CLI Command:**
```bash
npm run demo -- --brand "SugarEase 500"
```

---

## Scenario 4: Combination Salt Within Ceiling (`amoxicillin + clavulanic acid`)

**Medicine:** `ClavoTest 625` (`amoxicillin + clavulanic acid` `500 mg + 125 mg` `tablet`, `Sample Pharma`) — **[SAMPLE ROW]**
- **Printed MRP:** Rs 120.00 for 6 tablets (**Rs 20.00 / tablet**)
- **NPPA Base Ceiling:** Rs 21.00 / tablet → **Rs 22.05 / tablet** with 5% GST (`ceiling_status: "within"`)

**CLI Command:**
```bash
npm run demo -- --brand "ClavoTest 625"
```

---

## Scenario 5: Tamper-Evident Public Log, Pharmacy Case Threshold & OpenTimestamps Anchor

The live database contains **1 test batch of 3 permanent report entries** (`seq` `1`, `2`, `3`) filed against test licence `TEST-HACKATHON-LIC-001` (`Test Hackathon Chemist (SAMPLE)`), all labeled `TEST ENTRY - SAMPLE - NOT REAL DATA`:
- **Report IDs in `public_log`:**
  - `seq 1`: `6bcfcc70-3965-413f-9441-f605b5c4aa89`
  - `seq 2`: `bf57bf87-d7d7-4fbd-a155-fe7199af3899`
  - `seq 3`: `c6ba5250-66ff-4038-95cb-878208bf6945`
- **Privacy check:** `public_log.payload` stores only `pharmacy_ref` (`sha256(normalised_licence_or_name || pepper)`), never `pharmacy_name`, `pharmacy_licence_no`, or `description`.
- **Threshold check (`getPharmacyCase('TEST-HACKATHON-LIC-001')`):** At 3 reports of `sold_above_mrp` within 90 days, `threshold_met` is `true` and `pharmacy_name` (`"Test Hackathon Chemist (SAMPLE)"`) is revealed.
- **Anchored Merkle Root (`getLatestSnapshot()`):**
  - Snapshot ID: `af51e5a9-4eeb-4433-b008-fd7beddc2d2d`
  - Merkle root (`3` entries): `b4c398619c1824241a75b0a1b99cd595a7b7b654bc8e264d66b2bb99f86b46fe`
  - `anchor_method`: `"opentimestamps"` (accepted by `https://alice.btc.calendar.opentimestamps.org`)
