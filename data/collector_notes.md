# MediCheck demo seed dataset - collector notes

## Scope

This is a deliberately small showcase seed, not the complete production collection. It is intended to let the patient-app team demonstrate core data flows: formulation price lookup, Jan Aushadhi comparison, batch alert lookup, authority routing, and the shape of the barcode table.

## Files and current seed sizes

- `ceiling_prices.csv`: 17 NPPA scheduled-formulation rows selected from the supplied `All Drugs Ceiling Prices.xlsx`.
- `nsq_alerts.csv`: 15 batch-alert rows selected from supplied CDSCO monthly files for April, May, June, July and September 2026.
- `jan_aushadhi_products.csv`: 17 product rows selected from the supplied PMBI product-list CSV snapshot dated 2026-10-30.
- `brand_products.csv`: 9 branded packs with MRP, pack size and manufacturer details found in pharmacy listings / NPPA Pharma Sahi Daam-derived company-filed price listings.
- `barcodes.csv`: header only; no real barcode-to-pack evidence was supplied, so no barcode values have been fabricated.
- `authorities.csv`: 3 initial routing/contact entries (NPPA/PJS, CDSCO, Telangana DCA).

## Source provenance

- NPPA ceiling rows are from the supplied `All Drugs Ceiling Prices.xlsx`; values and notification reference are cross-checked against the official Gazette order S.O. 1575(E), dated 2026-03-25: https://nppa.gov.in/uploads/tender/0fd8be342c35d5a46a13b281cadc5e4f.pdf
- The official NPPA order states that the revised ceiling prices are effective from 2026-04-01 and are exclusive of applicable GST. `source_date` is the Gazette publication date 2026-03-25; `effective_date` is 2026-04-01.
- Ten NPPA formulation entries were cross-checked against the official Gazette text layer: paracetamol 500/650 mg, telmisartan 40 mg, amlodipine 5 mg, metformin 500 mg, atorvastatin 10 mg, azithromycin 500 mg, albendazole 400 mg, omeprazole 20 mg capsule, domperidone 10 mg and levothyroxine 100 mcg. The PDF screenshot endpoint failed during verification, but the official PDF text layer was searchable and the corresponding entries were checked.
- CDSCO rows are selected from the supplied monthly source files and point to the official public NSQ listing: https://cdscoonline.gov.in/CDSCO/viewPublicNSQDrug
- The supplied CDSCO files contain April, May, June, July and September 2026 data. August 2026 and October 2026 monthly exports were not present in the ZIP, so the six-month coverage requirement is not met. This is explicitly a sample only.
- The CDSCO monthly files show their alert month but do not state the individual list publication/last-updated date. `source_date` is therefore left blank on those rows, with an explanation in `notes`, rather than inventing a date.
- Jan Aushadhi rows are selected from the supplied PMBI product list dated 2026-10-30; the source URL points to the official PMBI product-list portal: https://janaushadhi.gov.in/product-portfolio/product-view-list. Pack size and unit are parsed from `Unit Size`; `price_per_unit` is computed as MRP divided by pack size.
- Branded-pack MRPs are drawn from the linked pharmacy listings or the linked NPPA Pharma Sahi Daam-derived company-filed MRP listing. The `mrp_date` is the listing's displayed last-updated / read date. MRP is not the discounted selling price. These figures should be checked against a physical pack before production use.
- Authority contacts are from official NPPA, CDSCO and Telangana DCA pages. Where the official page did not expose a publication/last-updated date, `source_date` is left blank and the note says why.

## Matching / limitations

- All normalized product rows use a consistent `salt_normalized | strength | dosage_form` key for the exact matches included in this demo.
- Brand products in this seed intentionally include some records whose exact match does not exist in the NPPA seed (for example, Pan 40 tablet: the supplied NPPA file contains pantoprazole injection 40 mg, not the tablet). Its `schedule_status` is `unknown` rather than asserting a ceiling price.
- `Allegra 120` is normalised as `fexofenadine`; the PMBI product is labelled fexofenadine hydrochloride, so it is not treated as an exact equivalent in this seed.
- NSQ alert `salt_normalized` is filled only where the source wording is clear. Ambiguous, malformed or mixed-combination entries remain blank.
- A source row with batch value `Not Mentioned` is kept with an empty `batch_number` and a note, as required by the spec.
- Barcode data is intentionally empty. The specification itself states that there is no complete public India barcode-to-medicine database; seed only from a physical pack scan or verified GS1 source.

## Not yet completed (by design)

- Full 100-200 brand master list.
- Full six-month rolling CDSCO alert coverage (August file missing in supplied archive; October export not supplied).
- 20 or more brand rows matched to NPPA ceiling rows (this demo has fewer).
- 15 brand rows matched to Jan Aushadhi equivalents (this demo has fewer than the final acceptance target, although the sample includes several working matches).
- Verified barcode mappings.
- Full multi-state authority directory.

## Demo safety note

This dataset is for software demonstration and database integration testing only. It is not a medicine recommendation, substitution recommendation, live inventory feed, or complete current safety database. Any patient-facing price or batch-warning result should show its source date and indicate that data coverage is partial. A missing alert in this seed must never be interpreted as proof that a batch is safe.
