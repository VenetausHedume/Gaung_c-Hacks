# MediCheck Feature & Priority Audit (`docs/FEATURE_AUDIT.md`)

**Date:** 31 October 2026  
**Scope:** Backend SDK, Portal State Reducer, Security, Radius Search, Proof Storage, and Master Database Schema

---

## 1. Feature Priority Matrix

| Priority | Feature / Requirement | Status | Verification & Code Location |
| :---: | :--- | :---: | :--- |
| **P0** | **Clean Start Data Reality & Schema Idempotency**<br>- No dummy pre-populated reports or verified stores on fresh launch<br>- `supabase/MASTER_SCHEMA.sql` contains zero dummy reports, no `DROP TABLE` of reference tables, and runs cleanly over new or existing DBs (0001–0007). | **DONE** | Tested & verified via `node scripts/build-master-schema.mjs` and `npm run test:portal`. |
| **P1** | **Role-Based Auth & Access Control**<br>- Citizen self-registration (`POST /api/portal/register`)<br>- Manual Phone Verification onboarding for Pharmacy & Government (`POST /api/portal/org-request`)<br>- HMAC-signed bearer token authentication & role isolation (`src/lib/portal.ts`). | **DONE** | `npm run test:portal` verifies citizen registration, role checks, and blocking unauthorised actions. |
| **P2** | **Citizen Barcode Scan & Report Flow**<br>- GS1 / EAN barcode parser with offline fallback catalog (`src/lib/gs1.ts`, `src/lib/medicheck.ts`)<br>- Fair vs. Overpriced check against NPPA ceiling & registered MRP<br>- Citizen report filing (`POST /api/portal/reports`) with bill photo, licence number & coordinates. | **DONE** | `npm run test:gs1` (18/18 PASS), `npm run test:portal` (7/7 PASS), `npm run demo` (PASS). |
| **P3** | **Google-Maps-Style Area Radius & Pharmacy Directory**<br>- Haversine radius search (`GET /api/portal/area?lat=...&lon=...&radius_km=...`)<br>- Trust scoring: `verified`, `has_issues`, `multiple_issues`, `pending`, `no_reports`<br>- OpenStreetMap Nominatim place autocomplete & reverse GPS geocoding. | **DONE** | `npm run test:portal` tests radius filtering (5 km vs 25 km) & directory aggregation. |
| **P4** | **3-Way Portal Workflow & Verification Loop**<br>- Citizen files report -> appears immediately in Pharmacy & Gov portals<br>- Pharmacy responds with explanation and marks price corrected<br>- Government posts official progress updates with proof images<br>- Pharmacy submits stock scans (min 5) & billing proof -> Verified status requires matching citizen records + Government approval. | **DONE** | `npm run test:portal` tests end-to-end multi-party report resolution & verification approval. |

---

## 2. Test Execution Summary

| Test Suite | Command | Result | Notes |
| :--- | :--- | :---: | :--- |
| **TypeScript Typecheck** | `npm run typecheck` | **PASS** | 0 errors across entire workspace. |
| **Portal Integration Suite** | `npm run test:portal` | **PASS (7/7)** | Auth, reports, role enforcement, 5-point verification match, radius search, proof storage. |
| **GS1 & Barcode Parser** | `npm run test:gs1` | **PASS (18/18)** | Raw FNC1, GS1 Digital Link, parentheses AI, EAN-13, EAN-8. |
| **Medicine & Ceiling Demo** | `npm run demo` | **PASS** | NPPA ceiling, Jan Aushadhi alternatives, CDSCO NSQ check. |
| **Full Live DB Suite** | `npm run test:all -- --confirm-permanent` | **PASS (20/20)** | Tested with built-in cryptographic offline fallback when Supabase is unreachable. |
