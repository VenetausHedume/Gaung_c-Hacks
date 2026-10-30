# MediCheck Data Import & Validation Report

- **Source Directory:** `C:\Users\Inesh Banerjee\OneDrive\Desktop\Medic\data`
- **Mode:** DRY RUN (`--dry-run`)
- **Generated At:** 2026-10-30T18:23:05.094Z
- **Row Validation Errors:** 17
- **Warnings:** 6
- **Unambiguous Auto-Fixes Applied:** 1

## 1. Spec Acceptance Checklist

| Status | Checklist Item | Observed Detail |
|---|---|---|
| **PASS** | All six CSVs present with exact column names | 0 header error(s) |
| **PASS** | Plain-number prices (no "Rs", commas, or currency symbols) | 0 price format error(s) |
| **FAIL** | source_url and source_date filled and valid on every row | 17 missing/invalid source field(s) |
| **PASS** | price_per_unit = mrp / pack_size within 0.01 | 0 mismatch(es), 0 auto-computed |
| **PASS** | Barcodes valid & every barcodes.brand_name matches brand_products | 0 barcode row(s), 0 error(s) |
| **FAIL** | Spec target: brand_products.csv >= 100 rows | 9 row(s) |
| **FAIL** | Spec target: >= 20 brand_products match a ceiling_prices row | 7 matched (Dolo 650, Telma 40, Amlong 5, Glycomet 500, Atorva 10, Azithral 500, Thyronorm 100) |
| **FAIL** | Spec target: nsq_alerts.csv covers >= 6 monthly lists | 5 month(s) (2026-04, 2026-05, 2026-06, 2026-07, 2026-09) |
| **FAIL** | Spec target: >= 15 brand_products have a Jan Aushadhi equivalent | 8 matched (Dolo 650, Telma 40, Amlong 5, Glycomet 500, Pan 40, Atorva 10, Azithral 500, Thyronorm 100) |

## 2. Dataset Summary

| Dataset File | Present | Header OK | Total Rows | Valid Rows | Row Errors |
|---|---|---|---|---|---|
| `ceiling_prices.csv` | yes | yes | 17 | 17 | 0 |
| `nsq_alerts.csv` | yes | yes | 15 | 0 | 15 |
| `jan_aushadhi_products.csv` | yes | yes | 17 | 17 | 0 |
| `brand_products.csv` | yes | yes | 9 | 9 | 0 |
| `barcodes.csv` | yes | yes | 0 | 0 | 0 |
| `authorities.csv` | yes | yes | 3 | 1 | 2 |

## 3. Cross-File Matching & Consistency Report

- **Brand products matching an NPPA ceiling row** (`salt_normalized | strength | dosage_form`): **7 / 9** (Dolo 650, Telma 40, Amlong 5, Glycomet 500, Atorva 10, Azithral 500, Thyronorm 100)
- **Brand products with a Jan Aushadhi equivalent** (`salt_normalized | strength | dosage_form`): **8 / 9** (Dolo 650, Telma 40, Amlong 5, Glycomet 500, Pan 40, Atorva 10, Azithral 500, Thyronorm 100)
- **CDSCO NSQ alert months covered (5):** 2026-04, 2026-05, 2026-06, 2026-07, 2026-09

### Salts with Inconsistent Spelling Across Files

- `fexofenadine` (in brand_products.csv) vs `fexofenadine hydrochloride` (in jan_aushadhi_products.csv) — *Base salt "fexofenadine" appears with and without salt/ester modifier across files*

## 4. Database Import Actions

- Dry-run mode (`--dry-run`): no database changes were made.

## 5. Unambiguous Normalisation Auto-Fixes (1)

| File | Row | Column | Change Applied |
|---|---|---|---|
| `jan_aushadhi_products.csv` | 5 | `generic_name` | Normalised whitespace/NBSP in "generic_name" |

## 6. Validation Errors (17)

| File | Row | Column | Error Reason |
|---|---|---|---|
| `nsq_alerts.csv` | 2 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 3 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 4 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 5 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 6 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 7 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 8 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 9 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 10 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 11 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 12 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 13 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 14 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 15 | `source_date` | Required field "source_date" is empty |
| `nsq_alerts.csv` | 16 | `source_date` | Required field "source_date" is empty |
| `authorities.csv` | 3 | `source_date` | Required field "source_date" is empty |
| `authorities.csv` | 4 | `source_date` | Required field "source_date" is empty |

## 7. Warnings (6)

| File | Row | Column | Warning |
|---|---|---|---|
| `nsq_alerts.csv` | 2 | `salt_normalized` | salt_normalized is empty (allowed by spec when ambiguous; requires migration 0005 if DB column is NOT NULL) |
| `nsq_alerts.csv` | 11 | `salt_normalized` | salt_normalized is empty (allowed by spec when ambiguous; requires migration 0005 if DB column is NOT NULL) |
| `nsq_alerts.csv` | 12 | `salt_normalized` | salt_normalized is empty (allowed by spec when ambiguous; requires migration 0005 if DB column is NOT NULL) |
| `nsq_alerts.csv` | 13 | `batch_number` | batch_number is empty (kept with explanation in notes; will not match batch queries) |
| `nsq_alerts.csv` | 13 | `salt_normalized` | salt_normalized is empty (allowed by spec when ambiguous; requires migration 0005 if DB column is NOT NULL) |
| `barcodes.csv` | - | `-` | File has headers only (0 data rows) — skipped. |
