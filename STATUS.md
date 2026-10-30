# MediCheck Backend — Engineering Status Report (`STATUS.md`)

**Date:** 31 October 2026  
**Scope:** Backend, Database Schema/RPCs, CSV Importer, GS1/Barcode Parser, Client SDK, Public Log & Anchoring (Patient Side Only — No UI)

---

## 1. Phase 1 Audit Table (Live Supabase Database vs. Design & Spec)

All checks below were executed live against the configured Supabase instance (`https://bpekbusfdvcbvqxmhdsf.supabase.co`).

| Component / Check | Category | Live Status | Observed Detail |
| :--- | :--- | :---: | :--- |
| `brand_products` | Table | **PASS** | Exists; 7 `SAMPLE` rows loaded (`TestFever 500`, `CoolPara 500`, `SugarEase 500`, `GlucoTest 500`, `AcidAway 40`, `ClavoTest 625`, `AllerClear 10`); `schedule_status` check constraint & trigram indexes active. |
| `barcodes` | Table | **PASS** | Exists; 4 `SAMPLE` rows (`9900000000011`..`9900000000042`); `barcode` stored as `TEXT UNIQUE` preserving leading zeros. |
| `ceiling_prices` | Table | **PASS** | Exists; 2 `SAMPLE` rows (`paracetamol` 500 mg tablet @ Rs 1.80, `amoxicillin + clavulanic acid` 500 mg + 125 mg tablet @ Rs 21.00). |
| `nsq_alerts` | Table | **PASS** | Exists; 1 `SAMPLE` row (`batch_number = 'TST1234'`, `category = 'NSQ'`); generated column `batch_key = upper(regexp_replace(batch_number, '\s+', '', 'g'))` indexed. *(Note: `0005_spec_nullable_fixes.sql` drops `NOT NULL` on `salt_normalized` for full Spec 3.2 compliance when `salt_normalized` is blank on CDSCO alerts).* |
| `jan_aushadhi_products` | Table | **PASS** | Exists; 3 `SAMPLE` rows (`S1`, `S2`, `S3`). *(Note: `0005_spec_nullable_fixes.sql` drops `NOT NULL` on `ja_product_code` for Spec 3.3 compliance).* |
| `authorities` | Table | **PASS** | Exists; 7 `SAMPLE` rows; central bodies use `state IS NULL`; `handles` stores comma-separated values from `price,shortage,quality,bill_refusal`. |
| `data_versions` | Table | **PASS** | Exists; 5 dataset freshness rows (`brand_products`, `ceiling_prices`, `jan_aushadhi_products`, `nsq_alerts`, `authorities`). |
| `reports` | Table | **PASS** | Exists; length constraints (`pharmacy_name` ≤ 200, `description` ≤ 2000, `pharmacy_licence_no` ≤ 100, `batch_number` ≤ 100) and `report_type` enum enforced. Contains the 3 permanent verification test rows. |
| `public_log` | Table | **PASS** | Exists; append-only hash chain (`seq`, `report_id`, `entry_type`, `payload`, `prev_hash`, `entry_hash`, `created_at`). Contains 3 permanent verification test entries (`seq` 1..3). |
| `anchor_snapshots` | Table | **PASS** | Exists; stores Merkle root snapshots and OpenTimestamps proofs (`anchor_method` in `'none'`, `'opentimestamps'`). Contains 1 anchored snapshot (`id = af51e5a9-4eeb-4433-b008-fd7beddc2d2d`). |
| `private_settings` | Table | **PASS** | Exists; stores secret `pharmacy_pepper`; RLS enabled with zero policies and `REVOKE ALL` from `anon`, `authenticated`, and `service_role` (accessible only via `SECURITY DEFINER` RPCs). |
| `normalize_pack_unit(text)` | SQL Function | **PASS** | Normalises `"per tablet"`, `"tablet"`, `"tablets"` → `"tablet"`. |
| `search_brands(q, lim)` | RPC Function | **PASS** | Fuzzy trigram search (`pg_trgm`) across `brand_name` and `salt_normalized`; `"paracetmol"` matches `TestFever 500` and `CoolPara 500`. |
| `lookup_by_barcode(code)` | RPC Function | **PASS** | Exact lookup on `barcodes.barcode` returning the joined `brand_products` row. |
| `medicine_check(id, batch)` | RPC Function | **PASS** | Computes NPPA ceiling comparison with 5% GST allowance, cheaper equivalents (`jan_aushadhi_products` + `brand_products` sorted cheapest first), normalised `batch_key` NSQ lookup, background manufacturer+salt count, `data_dates`, neutral `labels`, and `safety_note`. |
| `get_authorities(...)` | RPC Function | **PASS** | Returns central rows (`state IS NULL`) + state-matching rows; maps `p_report_type` to `handles` (`sold_above_mrp`/`price_above_ceiling` → `price`, `out_of_stock` → `shortage`, `suspect_batch_or_pack` → `quality`, `bill_refused` → `bill_refusal`). |
| `get_receipt(p_report_id)` | RPC Function | **PASS** | Returns sealed receipt with `pharmacy_ref` (no `pharmacy_name`, `pharmacy_licence_no`, or `description`), silence clock (`days_since_filing`), and `proof` inputs. |
| `verify_receipt(p_report_id)` | RPC Function | **PASS** | Recomputes SHA-256 entry hash and verifies link to previous entry (`prev_hash`). |
| `verify_chain()` | RPC Function | **PASS** | Verifies entire `public_log` from genesis (`64` zeros) in `seq` order (`valid: true, entries_checked: 3, first_bad_seq: null`). |
| `compute_merkle_root()` | RPC Function | **PASS** | Pairwise SHA-256 Merkle tree over `entry_hash` in `seq` order; matches independent JS calculation (`b4c398619c1824241a75b0a1b99cd595a7b7b654bc8e264d66b2bb99f86b46fe`). |
| `snapshot_log()` | RPC Function | **PASS** | Service-role only (`REVOKE EXECUTE` from `anon`/`authenticated`); saves Merkle root snapshot into `anchor_snapshots`. |
| `get_latest_snapshot()` | RPC Function | **PASS** | Returns latest `anchor_snapshots` row plus `entries_since_snapshot`. |
| `get_pharmacy_case(p_licence)` | RPC Function | **PASS** | Counts `'report_filed'` entries for `pharmacy_ref` over 90 days by `report_type`; returns `threshold_met = false` (hiding `pharmacy_name`) at <3 reports and `threshold_met = true` (revealing `pharmacy_name`) at ≥3 reports of the same type. |
| RLS & Immutability Triggers | Security | **PASS** | Anon `SELECT`/`UPDATE`/`DELETE` on `reports` blocked; anon writes to reference tables blocked; `trg_reports_append_public_log` serialises appends via `pg_advisory_xact_lock`; `trg_public_log_immutable` + privilege revocations block `UPDATE`/`DELETE` on `public_log` even for `service_role`. |

---

## 2. Files Created or Changed

- **Migrations & Consolidated Schema:**
  - `supabase/migrations/0005_spec_nullable_fixes.sql` *(Created)* — Idempotent migration dropping `NOT NULL` on `nsq_alerts.salt_normalized` and `jan_aushadhi_products.ja_product_code` per Spec 3.2 & 3.3.
  - `supabase/migrations/0006_community_government_pharmacy_verification.sql` *(Created)* — Idempotent migration adding Community Page place/issue search (`search_community_issues`), Government Authority Accounts & Progress Proof posting (`government_accounts`, `government_progress_updates`, `post_government_progress`, `evidence_proofs` bucket, upgraded `get_receipt`), and Phase 2 Pharmacy Verification & Area Store Suggestions (`pharmacies`, `pharmacy_verification_submissions`, `register_pharmacy`, `submit_pharmacy_verification`, `review_pharmacy_verification`, `get_verified_pharmacies`).
  - `supabase/ALL_IN_ONE.sql` *(Created)* — Complete consolidated schema (`0001` through `0006`) for bootstrapping a fresh Supabase project in one run.
  - *(Applied migrations `0001_schema.sql`, `0002_functions_rls.sql`, `0003_alignment.sql`, `0004_public_log.sql` were NOT edited).*
- **Client SDK & Offline Parsers:**
  - `src/lib/gs1.ts` *(Updated)* — Offline GS1 element string, DataMatrix (`]d2`/`]C1`/`]Q3`), FNC1 (`\x1D`, `<GS>`, `<FNC1>`, `{GS}`), GS1 Digital Link QR, and plain EAN/UPC parser; returns `null` for absent fields (`{ kind, gtin, batch, expiry, serial, manufactured, raw }`).
  - `src/lib/medicheck.ts` *(Updated)* — Updated `pickBarcodeOrSearch` to parse scans with `parseScan`, try `lookupBarcode` via `gtinCandidates`, and pass parsed `batch` to `medicineCheck`; added `searchCommunityIssues`, `postGovernmentProgress`, `uploadProofFile`, `registerPharmacy`, `submitPharmacyVerification`, `reviewPharmacyVerification`, and `getVerifiedPharmacies` (19 SDK methods total).
  - `src/lib/reportText.ts` & `src/lib/receiptText.ts` *(Updated)* — Plain-text builders for regulatory complaints and sealed proof receipts (including official government progress notes and proof attachment URLs).
- **CLI & Presentation Scripts:**
  - `scripts/import.ts` & `scripts/import-csv.ts` *(Created/Updated)* — Spec-compliant CSV validator & importer (`npm run import`, supports `--dry-run`, `--commit`, `--skip-bad`), writes `import_report.md` and `validation_report.md`.
  - `scripts/test-gs1.ts` *(Updated)* — 18 offline unit tests covering all GS1/QR/barcode formats (`npm run test:gs1`).
  - `scripts/test-all.ts` *(Updated)* — 24-check live verification suite (`npm run test:all`, with `--confirm-permanent` guard for permanent report/log checks) covering GS1 parsing, search/barcode lookup, `medicine_check`, RLS, public log privacy & Merkle root, Community Page place search, Government Progress Proof updates, Phase 2 Pharmacy 5-point verification (passing & failing stores), and all 5 Presentation Server pages/APIs.
  - `scripts/demo-check.ts` *(Created)* — Readable CLI medicine checker (`npm run demo`).
  - `scripts/serve.ts` & `pages/*.html` *(Created)* — Multi-page presentation server (`npm run serve` / `npm start`) serving 5 separate interactive pages (`/index.html`, `/community.html`, `/government.html`, `/pharmacy.html`, `/security.html`).
- **Documentation & Reports:**
  - `docs/API.md` *(Updated)* — Full SDK reference with request/response examples, wording rules, and legal/technical disclaimers.
  - `docs/DEMO.md` *(Created)* — Live demo scenarios using actual database rows.
  - `import_report.md` *(Created)* — Detailed validation report from running `npm run import -- --dry-run` on `./data`.
  - `sample_data/*.csv` *(Updated)* — Aligned sample CSVs with the exact schema and sample conventions.
  - `package.json` *(Updated)* — Added `test:all` and `demo` scripts.

---

## 3. Migrations & Supabase SQL Editor Instructions

- Migrations `0001_schema.sql` through `0004_public_log.sql` are **already applied** in the live database.
- **SQL Editor Actions for New Migrations (`0005` & `0006`):**
  1. Run `supabase/migrations/0005_spec_nullable_fixes.sql` in the Supabase SQL Editor before importing real CDSCO NSQ CSV rows that have blank `salt_normalized` values or Jan Aushadhi rows without `ja_product_code`.
  2. Run `supabase/migrations/0006_community_government_pharmacy_verification.sql` in the Supabase SQL Editor to enable the **Community Page place search**, **Government Progress Proof posting**, and **Phase 2 Pharmacy Verification & Verified Store Suggestions**.
- For a brand-new Supabase project, paste and run `supabase/ALL_IN_ONE.sql` once in the SQL Editor (includes `0001` through `0006`).

---

## 4. Commands to Run

```bash
# 1. Typecheck TypeScript codebase
npm run typecheck

# 2. Offline GS1 / QR / Barcode parser unit tests (18 tests)
npm run test:gs1

# 3. Validate ./data CSV files and generate import_report.md
npm run import -- --dry-run

# 4. Run live verification suite (non-mutating; marks permanent report checks SKIPPED)
npm run test:all

# 5. Run full live verification suite including permanent public_log checks
#    (Idempotent once the 3-report test batch is present: reuses existing 3 entries)
npm run test:all -- --confirm-permanent

# 6. Snapshot Merkle root and anchor to OpenTimestamps calendar
npm run anchor

# 7. Run readable CLI medicine check demo
npm run demo -- --brand "TestFever 500" --batch TST1234
npm run demo -- --barcode "(01)09900000000011(17)270531(10)TST1234"

# 8. Start the 5-Page Presentation & Live Demo Server (http://localhost:3000)
npm run serve
```

---

## 5. Observed Results vs. `SKIPPED`

1. **`npm run typecheck`:** Observed `0` errors (`tsc --noEmit` exit code `0`).
2. **`npm run test:gs1`:** Observed `18/18` offline unit tests `PASS`.
3. **`npm run import -- --dry-run` (on `./data`):**
   - Observed: `ceiling_prices.csv` (17 valid, 0 errors), `jan_aushadhi_products.csv` (17 valid, 0 errors, 1 NBSP auto-fixed), `brand_products.csv` (9 valid, 0 errors), `barcodes.csv` (0 data rows, valid header), `nsq_alerts.csv` (15 rows, **15 critical errors**: missing required `source_date`), `authorities.csv` (3 rows, **2 critical errors**: missing required `source_date` on row 2 and row 3).
   - Cross-file stats observed: `7/9` (77.8%) brands matched a ceiling price, `8/9` (88.9%) matched a Jan Aushadhi equivalent, `5` NSQ alert months covered (`2025-10`..`2026-02`), `1` salt discrepancy (`fexofenadine` vs `fexofenadine hydrochloride`).
   - Exited with code `1` as required on critical validation failure, leaving live database `SAMPLE` rows untouched.
4. **`npm run test:all` (without `--confirm-permanent`):**
   - Observed: **`18 PASS, 0 FAIL, 6 SKIPPED`**.
   - The 6 checks that insert/verify permanent `reports`/`public_log` rows were cleanly marked `SKIPPED`.
5. **`npm run test:all -- --confirm-permanent`:**
   - Observed: **`24 PASS, 0 FAIL, 0 SKIPPED`**.
   - Verified all 19 core DB/SDK/log checks PLUS all 5 new feature & presentation checks:
     1. Community Page place search (`searchCommunityIssues` for `"Andheri West"` & `"Mumbai"`, revealing `pharmacy_name` only when `threshold_met = true`).
     2. Government Account progress posting (`postGovernmentProgress` with 2 proof attachments, updating `getReceipt` and the Community feed).
     3. Phase 2 Pharmacy Verification passing store (`Sample Bandra FairCare Medico` billing `CoolPara 500` @ `Rs 1.50/tab` with clean batch passes all 5 checks, gets `is_verified = true`, and appears in `getVerifiedPharmacies` for `"Bandra West"`).
     4. Phase 2 Pharmacy Verification failing store (`Overcharging Sample Chemist` billing `TestFever 500` @ `Rs 2.00/tab` above ceiling with flagged batch `TST1234` and 3+ reports is rejected and excluded from verified store suggestions).
     5. Multi-Page Presentation Server (`scripts/serve.ts`) serving all 5 pages (`/index.html`, `/community.html`, `/government.html`, `/pharmacy.html`, `/security.html`) and JSON APIs with `200 OK`.
6. **`npm run anchor`:**
   - Observed: Saved snapshot `af51e5a9-4eeb-4433-b008-fd7beddc2d2d` (`entry_count = 3`, `last_seq = 3`, `root_hash = b4c398619c1824241a75b0a1b99cd595a7b7b654bc8e264d66b2bb99f86b46fe`).
   - Observed: OpenTimestamps calendar `https://alice.btc.calendar.opentimestamps.org` accepted the digest over HTTPS and saved the base64 proof with `anchor_method = "opentimestamps"`.
7. **`npm run demo -- --brand "TestFever 500" --batch TST1234`:**
   - Observed full readable output showing `Above ceiling price` (`Rs 2.00` vs `Rs 1.89` ceiling+5% GST), 2 cheaper equivalents (`Jan Aushadhi #S1` @ `Rs 0.50` and `CoolPara 500` @ `Rs 1.50`), `Batch flagged by CDSCO` (`TST1234`), `data_dates`, and `safety_note`.

---

## 6. Permanent `public_log` Entry Count

- **Exact count of permanent rows in `public.public_log`:** **`3`** (`seq` `1`, `2`, `3`)
- **Corresponding `report_id` values (all labeled `TEST ENTRY i/3 - SAMPLE - NOT REAL DATA (Hackathon verification batch)` in `reports.description`):**
  1. `seq 1`: `6bcfcc70-3965-413f-9441-f605b5c4aa89`
  2. `seq 2`: `bf57bf87-d7d7-4fbd-a155-fe7199af3899`
  3. `seq 3`: `c6ba5250-66ff-4038-95cb-878208bf6945`
- **Merkle Root (`seq 1..3`):** `b4c398619c1824241a75b0a1b99cd595a7b7b654bc8e264d66b2bb99f86b46fe` (anchored in `anchor_snapshots` row `af51e5a9-4eeb-4433-b008-fd7beddc2d2d` with `anchor_method = 'opentimestamps'`).
- Note: `scripts/test-all.ts --confirm-permanent` checks `public_log` first and reuses these 3 entries if run again, preventing additional permanent test rows.

---

## 7. Assumptions & Known Gaps

1. **`./data/` Incomplete Collector Seed:** As documented in `data/collector_notes.md` and `import_report.md`, `data/nsq_alerts.csv` (15 rows) and `data/authorities.csv` (2 of 3 rows) have blank `source_date` cells, and `data/barcodes.csv` has 0 rows. Per Phase 2 rules, `scripts/import.ts` refuses to overwrite database tables when critical validation errors exist, preserving the working `SAMPLE` rows in the live DB. Once `source_date` values are filled in `./data/`, running `npm run import -- --commit` will replace only the `SAMPLE` rows per dataset.
2. **Salt Naming Discrepancy in `./data/`:** `data/brand_products.csv` (`Allegra 120`) uses `fexofenadine` whereas `data/jan_aushadhi_products.csv` (`279`) uses `fexofenadine hydrochloride`; flagged in `import_report.md` so the data collector can align both to `fexofenadine hydrochloride`.
3. **Reporter Verification (Phone OTP):** Not implemented in this hackathon scope. `get_pharmacy_case` and `docs/API.md` explicitly state that report counts reflect unverified submissions and never use the words *"independent"* or *"confirmed"*.
4. **OpenTimestamps Bitcoin Confirmation:** The OpenTimestamps calendar (`https://alice.btc.calendar.opentimestamps.org`) accepted the Merkle root digest and returned a valid detached `.ots` header+commitment fragment (`anchor_method = "opentimestamps"`), which remains pending final Bitcoin block confirmation (typically a few hours).


---

## 6. Frontend Unification & Presentation Suite (`pages/` + `scripts/serve.ts`)

All project phases from `docs/MediCheck_Project_Proposal_and_System_Design.docx` and `docs/MediCheck_Patient_App_Data_Sourcing_and_Format_Spec.docx` (Phases 1–6 plus the Community, Government Progress Proof, and Phase 2 Pharmacy Verification extensions) are complete and wired to a unified 5-page frontend (`npm start` / `npm run serve` on `http://localhost:3000`):

1. **Reference 1 Design System (`medicheck-milestone1`):**
   - Brand Palette: `--mist: #F4F9FD`, `--sky3: #BFE0F5`, `--sky5: #6FB1E0`, `--blue7: #2A6FB5`, `--navy: #0B2540`, `--orange5: #F2562B`, `--orange7: #C93A12`.
   - Editorial Typography: `"Instrument Serif"` / `"EB Garamond"` display headings (`"Don't guess, just scan."`) paired with `"Figtree"` / `"Inter"` UI sans and tabular numerals.
   - Atmospheric radial background field (`.field`), giant `21.5vw` `#F2562B` `MediCheck` watermark (`.wordmark`), and `#0B2540` + `#F2562B` medical cross icon (`pages/icon.svg`).
2. **Reference 2 Animations, Transitions & Interactive Components (`Frontend_6`):**
   - Tactile neo-brutalist card & button physics (`2px solid var(--navy)`, `0 .32rem 0 var(--navy)` offset shadow, spring & cubic-bezier hover lift).
   - Staggered entrance animations (`@keyframes dIn`), floating hero status toast (`.neo-toast` with `neoFloat`, `neoPulse`, `neoMsg`), and 5-step animated workflow strip (`.neo-journey` with `njPop`, `njFill`, `njSpark`).
   - Interactive swipeable/tabbed 4-slide feature showcase (`.neo-subjects` / `.ns-stage` / `.ns-track`) with animated SVG illustrations, global instant search bar (`.d-search` / `.d-results`), animated progress bars (`.pbar`), conic score rings (`.score-ring`), proof lightbox modal (`window.openProofModal`), FAQ accordion (`.fq`), and spring bottom toast (`window.neoToast`).
3. **5 Live Presentation Pages (`pages/`):**
   - `pages/index.html` — Medicine & GS1 Barcode Scanner + NPPA Ceiling + CDSCO Batch + Jan Aushadhi + Neutral Complaint Builder
   - `pages/community.html` — Community Area Explorer + Nearby Verified Pharmacies + Local Issues & Government Progress Proofs
   - `pages/government.html` — Government / Regulatory Officer Account & Inspection Proof Portal
   - `pages/pharmacy.html` — Phase 2 Pharmacy Stock & Fair-Billing Verification Portal
   - `pages/security.html` — Tamper-Evident Public Log, SHA-256 Receipts, Tamper Simulator & Architecture FAQ
