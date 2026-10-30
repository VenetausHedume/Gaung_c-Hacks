-- =============================================================================
-- MediCheck Migration 0006:
--   1. Community Page (place/area issue search + government progress tracking)
--   2. Government Authority Accounts & Progress Proof Uploads (sealed in public_log)
--   3. Phase 2 Pharmacy Verification (stock + fair-billing proof -> Verified Store suggestions)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Location columns on reports + updated build_report_log_payload
-- -----------------------------------------------------------------------------
ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS area text check (area is null or char_length(area) <= 150),
    ADD COLUMN IF NOT EXISTS city text check (city is null or char_length(city) <= 100),
    ADD COLUMN IF NOT EXISTS state text check (state is null or char_length(state) <= 100),
    ADD COLUMN IF NOT EXISTS pincode text check (pincode is null or char_length(pincode) <= 20);

CREATE INDEX IF NOT EXISTS idx_reports_location
    ON public.reports (lower(coalesce(state, '')), lower(coalesce(city, '')), lower(coalesce(area, '')), coalesce(pincode, ''));

-- Include non-personal location tags (area, city, state, pincode) in report_filed public_log payload.
-- Still NEVER includes pharmacy_name, pharmacy_licence_no, or free-text description.
CREATE OR REPLACE FUNCTION public.build_report_log_payload(r public.reports)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_brand public.brand_products%rowtype;
BEGIN
    IF r.brand_product_id IS NOT NULL THEN
        SELECT * INTO v_brand FROM public.brand_products WHERE id = r.brand_product_id;
    END IF;

    RETURN jsonb_build_object(
        'report_id', r.id,
        'report_type', r.report_type,
        'pharmacy_ref', public.pharmacy_ref(coalesce(nullif(btrim(r.pharmacy_licence_no), ''), r.pharmacy_name)),
        'salt_normalized', v_brand.salt_normalized,
        'strength', v_brand.strength,
        'dosage_form', v_brand.dosage_form,
        'brand_name', v_brand.brand_name,
        'batch_number', r.batch_number,
        'area', nullif(btrim(r.area), ''),
        'city', nullif(btrim(r.city), ''),
        'state', nullif(btrim(r.state), ''),
        'pincode', nullif(btrim(r.pincode), ''),
        'filed_at', public.iso_utc(r.created_at)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.build_report_log_payload(public.reports) FROM public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Supabase Storage Bucket for Proof Images (Government & Pharmacy Proofs)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
            'evidence_proofs',
            'evidence_proofs',
            true,
            10485760, -- 10 MB limit
            ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
        )
        ON CONFLICT (id) DO NOTHING;
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Government Authority Accounts & Official Progress Updates
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.government_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    authority_id uuid REFERENCES public.authorities(id) ON DELETE SET NULL,
    agency_name text NOT NULL CHECK (char_length(btrim(agency_name)) BETWEEN 2 AND 200),
    department text,
    state text, -- NULL for central agencies (NPPA / CDSCO)
    official_email text NOT NULL UNIQUE CHECK (char_length(btrim(official_email)) BETWEEN 5 AND 200),
    officer_name text,
    designation text,
    is_active boolean NOT NULL DEFAULT true,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.government_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read active government_accounts" ON public.government_accounts;
CREATE POLICY "Public read active government_accounts"
    ON public.government_accounts FOR SELECT
    TO anon, authenticated
    USING (is_active = true);

GRANT SELECT ON public.government_accounts TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.government_accounts TO service_role;

CREATE TABLE IF NOT EXISTS public.government_progress_updates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
    government_account_id uuid REFERENCES public.government_accounts(id) ON DELETE SET NULL,
    agency_name text NOT NULL CHECK (char_length(btrim(agency_name)) BETWEEN 2 AND 200),
    officer_designation text,
    status text NOT NULL CHECK (status IN ('acknowledged', 'investigating', 'action_taken', 'resolved')),
    action_taken text CHECK (action_taken IS NULL OR char_length(action_taken) <= 500),
    progress_note text NOT NULL CHECK (char_length(btrim(progress_note)) BETWEEN 1 AND 2000),
    proof_urls text[] NOT NULL DEFAULT '{}',
    log_seq bigint,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gov_updates_report_id
    ON public.government_progress_updates (report_id, created_at ASC);

ALTER TABLE public.government_progress_updates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read government_progress_updates" ON public.government_progress_updates;
CREATE POLICY "Public read government_progress_updates"
    ON public.government_progress_updates FOR SELECT
    TO anon, authenticated
    USING (true);

GRANT SELECT ON public.government_progress_updates TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.government_progress_updates TO service_role;

-- Post a government progress update + proof images and seal a 'status_change' entry in public_log.
-- Callable by an authenticated government_accounts user OR by service_role.
CREATE OR REPLACE FUNCTION public.post_government_progress(
    p_report_id uuid,
    p_status text,
    p_progress_note text,
    p_proof_urls text[] DEFAULT '{}',
    p_action_taken text DEFAULT NULL,
    p_government_account_id uuid DEFAULT NULL,
    p_agency_name text DEFAULT NULL,
    p_officer_designation text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_gov public.government_accounts%rowtype;
    v_agency text;
    v_designation text;
    v_gov_id uuid;
    v_log_entry public.public_log;
    v_update public.government_progress_updates;
    v_payload jsonb;
    v_clean_urls text[] := coalesce(p_proof_urls, '{}'::text[]);
BEGIN
    IF p_status NOT IN ('acknowledged', 'investigating', 'action_taken', 'resolved') THEN
        RAISE EXCEPTION 'Invalid status "%". Allowed: acknowledged, investigating, action_taken, resolved.', p_status
            USING ERRCODE = '22023';
    END IF;

    IF p_progress_note IS NULL OR char_length(btrim(p_progress_note)) < 1 THEN
        RAISE EXCEPTION 'progress_note is required.' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.public_log WHERE report_id = p_report_id AND entry_type = 'report_filed') THEN
        RAISE EXCEPTION 'No sealed report_filed entry found for report_id %', p_report_id
            USING ERRCODE = 'P0002';
    END IF;

    -- Resolve government account: check auth.uid() first, then p_government_account_id (if service_role)
    IF auth.uid() IS NOT NULL THEN
        SELECT * INTO v_gov
        FROM public.government_accounts
        WHERE user_id = auth.uid() AND is_active = true
        LIMIT 1;
    END IF;

    IF v_gov.id IS NULL AND p_government_account_id IS NOT NULL THEN
        SELECT * INTO v_gov
        FROM public.government_accounts
        WHERE id = p_government_account_id AND is_active = true
        LIMIT 1;
    END IF;

    -- Enforce authorization: caller must be a linked active government account OR service_role / postgres
    IF v_gov.id IS NULL AND coalesce( current_setting('request.jwt.claim.role', true), '' ) <> 'service_role'
       AND current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
        RAISE EXCEPTION 'Unauthorized: only verified government authority accounts can post official progress updates.'
            USING ERRCODE = '42501';
    END IF;

    v_gov_id := v_gov.id;
    v_agency := coalesce(nullif(btrim(p_agency_name), ''), v_gov.agency_name, 'Regulatory Authority');
    v_designation := coalesce(nullif(btrim(p_officer_designation), ''), v_gov.designation, 'Authorized Officer');

    -- Build canonical status_change payload for the tamper-evident public log
    v_payload := jsonb_build_object(
        'report_id', p_report_id,
        'status', p_status,
        'agency_name', v_agency,
        'officer_designation', v_designation,
        'action_taken', nullif(btrim(p_action_taken), ''),
        'progress_note', btrim(p_progress_note),
        'proof_urls', to_jsonb(v_clean_urls),
        'updated_at', public.iso_utc(now())
    );

    -- Append 'status_change' entry to public_log
    v_log_entry := public.append_log_entry(p_report_id, 'status_change', v_payload);

    -- Save structured update row
    INSERT INTO public.government_progress_updates (
        report_id,
        government_account_id,
        agency_name,
        officer_designation,
        status,
        action_taken,
        progress_note,
        proof_urls,
        log_seq
    )
    VALUES (
        p_report_id,
        v_gov_id,
        v_agency,
        v_designation,
        p_status,
        nullif(btrim(p_action_taken), ''),
        btrim(p_progress_note),
        v_clean_urls,
        v_log_entry.seq
    )
    RETURNING * INTO v_update;

    RETURN jsonb_build_object(
        'update_id', v_update.id,
        'report_id', v_update.report_id,
        'status', v_update.status,
        'agency_name', v_update.agency_name,
        'officer_designation', v_update.officer_designation,
        'action_taken', v_update.action_taken,
        'progress_note', v_update.progress_note,
        'proof_urls', to_jsonb(v_update.proof_urls),
        'log_seq', v_log_entry.seq,
        'entry_hash', v_log_entry.entry_hash,
        'sealed_at', public.iso_utc(v_log_entry.created_at)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_government_progress(uuid, text, text, text[], text, uuid, text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Upgrade get_receipt to include sealed government progress updates & proofs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_receipt(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    e public.public_log;
    v_filed timestamptz;
    v_latest_status text := 'filed';
    v_auth_response jsonb := null;
    v_timeline jsonb;
    v_gov_steps jsonb := '[]'::jsonb;
BEGIN
    SELECT * INTO e FROM public.public_log
    WHERE report_id = p_report_id AND entry_type = 'report_filed';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_filed := (e.payload->>'filed_at')::timestamptz;

    -- Collect any sealed status_change entries for this report
    SELECT
        coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'step', 'Government update (' || (sc.payload->>'status') || ') by ' || coalesce(sc.payload->>'agency_name', 'Authority')
                            || CASE WHEN sc.payload->>'action_taken' IS NOT NULL THEN ': ' || (sc.payload->>'action_taken') ELSE '' END,
                    'at', public.iso_utc(sc.created_at),
                    'sealed', true,
                    'status', sc.payload->>'status',
                    'agency_name', sc.payload->>'agency_name',
                    'progress_note', sc.payload->>'progress_note',
                    'proof_urls', coalesce(sc.payload->'proof_urls', '[]'::jsonb),
                    'seq', sc.seq,
                    'entry_hash', sc.entry_hash
                )
                ORDER BY sc.seq ASC
            ),
            '[]'::jsonb
        )
    INTO v_gov_steps
    FROM public.public_log sc
    WHERE sc.report_id = p_report_id AND sc.entry_type = 'status_change';

    -- Latest authority response (if any)
    SELECT
        sc.payload->>'status',
        jsonb_build_object(
            'status', sc.payload->>'status',
            'agency_name', sc.payload->>'agency_name',
            'officer_designation', sc.payload->>'officer_designation',
            'action_taken', sc.payload->>'action_taken',
            'progress_note', sc.payload->>'progress_note',
            'proof_urls', coalesce(sc.payload->'proof_urls', '[]'::jsonb),
            'responded_at', public.iso_utc(sc.created_at),
            'log_seq', sc.seq,
            'entry_hash', sc.entry_hash
        )
    INTO v_latest_status, v_auth_response
    FROM public.public_log sc
    WHERE sc.report_id = p_report_id AND sc.entry_type = 'status_change'
    ORDER BY sc.seq DESC
    LIMIT 1;

    v_latest_status := coalesce(v_latest_status, 'filed');

    v_timeline := jsonb_build_array(
        jsonb_build_object('step', 'Report filed', 'at', e.payload->>'filed_at', 'sealed', true),
        jsonb_build_object('step', 'Fingerprint sealed in public log', 'at', public.iso_utc(e.created_at), 'sealed', true)
    ) || coalesce(v_gov_steps, '[]'::jsonb);

    RETURN jsonb_build_object(
        'report_id', e.report_id,
        'report', e.payload,
        'seq', e.seq,
        'entry_hash', e.entry_hash,
        'prev_hash', e.prev_hash,
        'filed_at', e.payload->>'filed_at',
        'sealed_at', public.iso_utc(e.created_at),
        'days_since_filing', greatest(0, floor(extract(epoch from (now() - v_filed)) / 86400))::int,
        'status', v_latest_status,
        'authority_response', v_auth_response,
        'timeline', v_timeline,
        'proof', jsonb_build_object(
            'entry_type', e.entry_type,
            'payload_canonical', e.payload::text,
            'sealed_at', public.iso_utc(e.created_at),
            'prev_hash', e.prev_hash,
            'entry_hash', e.entry_hash
        )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_receipt(uuid) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Community Page RPC: search_community_issues
--    Lets patients search by place (area, city, state, pincode) or medicine/issue
--    and see reports, current status, and government progress + proof images.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_community_issues(
    p_place_query text DEFAULT NULL,
    p_state text DEFAULT NULL,
    p_status text DEFAULT NULL,
    p_report_type text DEFAULT NULL,
    p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_q text := nullif(lower(btrim(p_place_query)), '');
    v_state text := nullif(lower(btrim(p_state)), '');
    v_status text := nullif(lower(btrim(p_status)), '');
    v_type text := nullif(lower(btrim(p_report_type)), '');
    v_lim int := greatest(1, least(coalesce(p_limit, 25), 100));
    v_items jsonb := '[]'::jsonb;
    v_summary jsonb;
BEGIN
    WITH base_issues AS (
        SELECT
            l.seq,
            l.report_id,
            l.entry_hash,
            l.created_at AS sealed_at,
            (l.payload->>'filed_at')::timestamptz AS filed_at,
            l.payload->>'report_type' AS report_type,
            l.payload->>'pharmacy_ref' AS pharmacy_ref,
            l.payload->>'brand_name' AS brand_name,
            l.payload->>'salt_normalized' AS salt_normalized,
            l.payload->>'strength' AS strength,
            l.payload->>'dosage_form' AS dosage_form,
            l.payload->>'batch_number' AS batch_number,
            coalesce(r.area, l.payload->>'area') AS area,
            coalesce(r.city, l.payload->>'city') AS city,
            coalesce(r.state, l.payload->>'state') AS state,
            coalesce(r.pincode, l.payload->>'pincode') AS pincode,
            r.pharmacy_name AS private_pharmacy_name,
            -- Count reports for the same pharmacy_ref & report_type in last 90 days (for threshold check)
            (
                SELECT count(*)
                FROM public.public_log l2
                WHERE l2.entry_type = 'report_filed'
                  AND l2.payload->>'pharmacy_ref' = l.payload->>'pharmacy_ref'
                  AND l2.payload->>'report_type' = l.payload->>'report_type'
                  AND (l2.payload->>'filed_at')::timestamptz >= now() - interval '90 days'
            ) AS same_type_report_count,
            -- Latest status from status_change entries
            coalesce(
                (
                    SELECT sc.payload->>'status'
                    FROM public.public_log sc
                    WHERE sc.report_id = l.report_id AND sc.entry_type = 'status_change'
                    ORDER BY sc.seq DESC
                    LIMIT 1
                ),
                'filed'
            ) AS current_status,
            -- All government progress updates with proof images
            coalesce(
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'seq', sc.seq,
                            'status', sc.payload->>'status',
                            'agency_name', sc.payload->>'agency_name',
                            'officer_designation', sc.payload->>'officer_designation',
                            'action_taken', sc.payload->>'action_taken',
                            'progress_note', sc.payload->>'progress_note',
                            'proof_urls', coalesce(sc.payload->'proof_urls', '[]'::jsonb),
                            'updated_at', public.iso_utc(sc.created_at),
                            'entry_hash', sc.entry_hash,
                            'sealed', true
                        )
                        ORDER BY sc.seq ASC
                    )
                    FROM public.public_log sc
                    WHERE sc.report_id = l.report_id AND sc.entry_type = 'status_change'
                ),
                '[]'::jsonb
            ) AS government_updates
        FROM public.public_log l
        LEFT JOIN public.reports r ON r.id = l.report_id
        WHERE l.entry_type = 'report_filed'
    ),
    filtered AS (
        SELECT *
        FROM base_issues b
        WHERE (
            v_q IS NULL
            OR lower(coalesce(b.area, '')) LIKE '%' || v_q || '%'
            OR lower(coalesce(b.city, '')) LIKE '%' || v_q || '%'
            OR lower(coalesce(b.state, '')) LIKE '%' || v_q || '%'
            OR lower(coalesce(b.pincode, '')) LIKE '%' || v_q || '%'
            OR lower(coalesce(b.brand_name, '')) LIKE '%' || v_q || '%'
            OR lower(coalesce(b.salt_normalized, '')) LIKE '%' || v_q || '%'
            -- Only allow matching by pharmacy_name if threshold_met >= 3
            OR (b.same_type_report_count >= 3 AND lower(coalesce(b.private_pharmacy_name, '')) LIKE '%' || v_q || '%')
        )
        AND (v_state IS NULL OR lower(coalesce(b.state, '')) = v_state)
        AND (v_status IS NULL OR lower(b.current_status) = v_status)
        AND (v_type IS NULL OR lower(b.report_type) = v_type)
    )
    SELECT
        jsonb_build_object(
            'total_matching_reports', count(*),
            'filed_count', count(*) FILTER (WHERE current_status = 'filed'),
            'in_progress_count', count(*) FILTER (WHERE current_status IN ('acknowledged', 'investigating', 'action_taken')),
            'resolved_count', count(*) FILTER (WHERE current_status = 'resolved'),
            'with_government_response_count', count(*) FILTER (WHERE jsonb_array_length(government_updates) > 0)
        ),
        coalesce(
            (
                SELECT jsonb_agg(item_json ORDER BY f2.seq DESC)
                FROM (
                    SELECT
                        f.seq,
                        jsonb_build_object(
                            'seq', f.seq,
                            'report_id', f.report_id,
                            'entry_hash', f.entry_hash,
                            'filed_at', public.iso_utc(f.filed_at),
                            'sealed_at', public.iso_utc(f.sealed_at),
                            'days_since_filing', greatest(0, floor(extract(epoch from (now() - f.filed_at)) / 86400))::int,
                            'report_type', f.report_type,
                            'location', jsonb_build_object(
                                'area', f.area,
                                'city', f.city,
                                'state', f.state,
                                'pincode', f.pincode
                            ),
                            'medicine', jsonb_build_object(
                                'brand_name', f.brand_name,
                                'salt_normalized', f.salt_normalized,
                                'strength', f.strength,
                                'dosage_form', f.dosage_form,
                                'batch_number', f.batch_number
                            ),
                            'pharmacy_ref', f.pharmacy_ref,
                            'threshold_met', (f.same_type_report_count >= 3),
                            -- Reveal pharmacy_name only when threshold >= 3 reports of same type in 90 days
                            'pharmacy_name', CASE WHEN f.same_type_report_count >= 3 THEN f.private_pharmacy_name ELSE NULL END,
                            'current_status', f.current_status,
                            'government_updates', f.government_updates
                        ) AS item_json
                    FROM filtered f
                    ORDER BY f.seq DESC
                    LIMIT v_lim
                ) f2
            ),
            '[]'::jsonb
        )
    INTO v_summary, v_items
    FROM filtered;

    RETURN jsonb_build_object(
        'query', jsonb_build_object(
            'place_query', p_place_query,
            'state', p_state,
            'status', p_status,
            'report_type', p_report_type
        ),
        'summary', coalesce(v_summary, jsonb_build_object(
            'total_matching_reports', 0,
            'filed_count', 0,
            'in_progress_count', 0,
            'resolved_count', 0,
            'with_government_response_count', 0
        )),
        'items', coalesce(v_items, '[]'::jsonb),
        'note', 'The public log proves records are unchanged since filing. Pharmacy names are shown only when 3 or more reports of the same issue type exist within 90 days.'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_community_issues(text, text, text, text, integer) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Phase 2 Pharmacy Portal: Stock & Fair-Billing Proof -> Verified Pharmacies
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pharmacies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    pharmacy_name text NOT NULL CHECK (char_length(btrim(pharmacy_name)) BETWEEN 2 AND 200),
    licence_no text NOT NULL UNIQUE CHECK (char_length(btrim(licence_no)) BETWEEN 3 AND 100),
    address text CHECK (address IS NULL OR char_length(address) <= 500),
    area text NOT NULL CHECK (char_length(btrim(area)) BETWEEN 2 AND 150),
    city text NOT NULL CHECK (char_length(btrim(city)) BETWEEN 2 AND 100),
    state text NOT NULL CHECK (char_length(btrim(state)) BETWEEN 2 AND 100),
    pincode text NOT NULL CHECK (char_length(btrim(pincode)) BETWEEN 4 AND 20),
    phone text CHECK (phone IS NULL OR char_length(phone) <= 50),
    jan_aushadhi_available boolean NOT NULL DEFAULT false,
    essential_medicines_stocked integer NOT NULL DEFAULT 0 CHECK (essential_medicines_stocked >= 0),
    is_verified boolean NOT NULL DEFAULT false,
    verification_status text NOT NULL DEFAULT 'unverified'
        CHECK (verification_status IN ('unverified', 'pending_review', 'verified', 'rejected', 'revoked')),
    verified_at timestamptz,
    verified_until timestamptz,
    verification_score numeric(5, 2) NOT NULL DEFAULT 0,
    stock_proof_urls text[] NOT NULL DEFAULT '{}',
    billing_proof_urls text[] NOT NULL DEFAULT '{}',
    last_review_note text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pharmacies_verified_area
    ON public.pharmacies (is_verified, lower(state), lower(city), lower(area), pincode);

ALTER TABLE public.pharmacies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read pharmacies" ON public.pharmacies;
CREATE POLICY "Public read pharmacies"
    ON public.pharmacies FOR SELECT
    TO anon, authenticated
    USING (true);

GRANT SELECT ON public.pharmacies TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.pharmacies TO service_role;

CREATE TABLE IF NOT EXISTS public.pharmacy_verification_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pharmacy_id uuid NOT NULL REFERENCES public.pharmacies(id) ON DELETE CASCADE,
    submitted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    stock_proof_urls text[] NOT NULL CHECK (coalesce(array_length(stock_proof_urls, 1), 0) >= 1),
    billing_proof_urls text[] NOT NULL CHECK (coalesce(array_length(billing_proof_urls, 1), 0) >= 1),
    essential_medicines_stocked integer NOT NULL DEFAULT 0 CHECK (essential_medicines_stocked >= 0),
    jan_aushadhi_stocked boolean NOT NULL DEFAULT false,
    sample_brand_product_id uuid REFERENCES public.brand_products(id) ON DELETE SET NULL,
    sample_billed_unit_price numeric(12, 4) NOT NULL CHECK (sample_billed_unit_price > 0),
    sample_batch_number text,
    auto_check_passed boolean NOT NULL DEFAULT false,
    auto_check_details jsonb NOT NULL DEFAULT '{}'::jsonb,
    review_status text NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'approved', 'rejected')),
    reviewed_by_government_id uuid REFERENCES public.government_accounts(id) ON DELETE SET NULL,
    review_note text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_submissions_pharmacy_id
    ON public.pharmacy_verification_submissions (pharmacy_id, created_at DESC);

ALTER TABLE public.pharmacy_verification_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read approved pharmacy_verification_submissions" ON public.pharmacy_verification_submissions;
CREATE POLICY "Public read approved pharmacy_verification_submissions"
    ON public.pharmacy_verification_submissions FOR SELECT
    TO anon, authenticated
    USING (review_status = 'approved' OR auth.uid() = submitted_by);

GRANT SELECT ON public.pharmacy_verification_submissions TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.pharmacy_verification_submissions TO service_role;

-- Register or update a pharmacy profile
CREATE OR REPLACE FUNCTION public.register_pharmacy(
    p_pharmacy_name text,
    p_licence_no text,
    p_area text,
    p_city text,
    p_state text,
    p_pincode text,
    p_address text DEFAULT NULL,
    p_phone text DEFAULT NULL,
    p_jan_aushadhi_available boolean DEFAULT false,
    p_notes text DEFAULT NULL
)
RETURNS public.pharmacies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.pharmacies;
    v_lic text := upper(btrim(p_licence_no));
BEGIN
    IF v_lic IS NULL OR char_length(v_lic) < 3 THEN
        RAISE EXCEPTION 'Valid pharmacy licence_no is required.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.pharmacies (
        owner_user_id,
        pharmacy_name,
        licence_no,
        address,
        area,
        city,
        state,
        pincode,
        phone,
        jan_aushadhi_available,
        notes
    )
    VALUES (
        auth.uid(),
        btrim(p_pharmacy_name),
        v_lic,
        nullif(btrim(p_address), ''),
        btrim(p_area),
        btrim(p_city),
        btrim(p_state),
        btrim(p_pincode),
        nullif(btrim(p_phone), ''),
        coalesce(p_jan_aushadhi_available, false),
        nullif(btrim(p_notes), '')
    )
    ON CONFLICT (licence_no) DO UPDATE SET
        pharmacy_name = EXCLUDED.pharmacy_name,
        address = coalesce(EXCLUDED.address, public.pharmacies.address),
        area = EXCLUDED.area,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        pincode = EXCLUDED.pincode,
        phone = coalesce(EXCLUDED.phone, public.pharmacies.phone),
        jan_aushadhi_available = EXCLUDED.jan_aushadhi_available,
        notes = coalesce(EXCLUDED.notes, public.pharmacies.notes)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_pharmacy(text, text, text, text, text, text, text, text, boolean, text) TO anon, authenticated, service_role;

-- Submit stock & fair-billing proof for a pharmacy.
-- Automatically checks:
--   1. Required stock proof & billing proof images are attached and essential_medicines_stocked >= 5
--   2. sample_billed_unit_price <= printed MRP per unit AND <= NPPA ceiling + 5% GST allowance
--   3. sample_batch_number (if provided) is NOT flagged as NSQ/Spurious by CDSCO
--   4. Pharmacy does not have >= 3 reports of the same issue type in the last 90 days
-- When all 4 checks match (and p_auto_approve_if_matched is true), the pharmacy becomes VERIFIED!
CREATE OR REPLACE FUNCTION public.submit_pharmacy_verification(
    p_pharmacy_id uuid,
    p_stock_proof_urls text[],
    p_billing_proof_urls text[],
    p_essential_medicines_stocked integer,
    p_sample_brand_product_id uuid,
    p_sample_billed_unit_price numeric,
    p_sample_batch_number text DEFAULT NULL,
    p_jan_aushadhi_stocked boolean DEFAULT false,
    p_auto_approve_if_matched boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pharm public.pharmacies%rowtype;
    v_prod public.brand_products%rowtype;
    v_check jsonb;
    v_case jsonb;
    v_stock_ok boolean := false;
    v_mrp_ok boolean := false;
    v_ceiling_ok boolean := false;
    v_batch_ok boolean := true;
    v_complaint_ok boolean := true;
    v_all_passed boolean := false;
    v_effective_ceiling numeric;
    v_details jsonb;
    v_status text := 'pending';
    v_review_note text;
    v_sub public.pharmacy_verification_submissions;
    v_score numeric(5, 2) := 0;
BEGIN
    SELECT * INTO v_pharm FROM public.pharmacies WHERE id = p_pharmacy_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pharmacy % not found.', p_pharmacy_id USING ERRCODE = 'P0002';
    END IF;

    IF coalesce(array_length(p_stock_proof_urls, 1), 0) < 1 THEN
        RAISE EXCEPTION 'At least one stock proof image URL is required.' USING ERRCODE = '22023';
    END IF;

    IF coalesce(array_length(p_billing_proof_urls, 1), 0) < 1 THEN
        RAISE EXCEPTION 'At least one billing proof image URL is required.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_prod FROM public.brand_products WHERE id = p_sample_brand_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'sample_brand_product_id % not found in brand_products.', p_sample_brand_product_id
            USING ERRCODE = 'P0002';
    END IF;

    -- Run medicine_check to evaluate ceiling price + 5% GST and CDSCO batch alert status
    v_check := public.medicine_check(p_sample_brand_product_id, p_sample_batch_number);

    -- Check 1: Stock proof & essential medicine count (>= 5 essential medicines stocked)
    v_stock_ok := (coalesce(p_essential_medicines_stocked, 0) >= 5)
                  AND (coalesce(array_length(p_stock_proof_urls, 1), 0) >= 1);

    -- Check 2: Billed unit price <= printed MRP per unit
    v_mrp_ok := (p_sample_billed_unit_price > 0) AND (p_sample_billed_unit_price <= v_prod.price_per_unit);

    -- Check 3: Billed unit price <= NPPA ceiling + 5% GST (if scheduled / ceiling exists)
    v_effective_ceiling := (v_check->'price'->>'effective_ceiling_per_unit_with_gst')::numeric;
    IF v_effective_ceiling IS NULL THEN
        v_ceiling_ok := true;
    ELSE
        v_ceiling_ok := (p_sample_billed_unit_price <= v_effective_ceiling);
    END IF;

    -- Check 4: Batch is not flagged by CDSCO NSQ/Spurious list
    IF p_sample_batch_number IS NOT NULL AND btrim(p_sample_batch_number) <> '' THEN
        v_batch_ok := NOT coalesce((v_check->'batch'->>'flagged')::boolean, false);
    END IF;

    -- Check 5: No active complaint threshold breach (< 3 reports of same type in 90 days)
    v_case := public.get_pharmacy_case(v_pharm.licence_no);
    v_complaint_ok := NOT coalesce((v_case->>'threshold_met')::boolean, false);

    v_all_passed := v_stock_ok AND v_mrp_ok AND v_ceiling_ok AND v_batch_ok AND v_complaint_ok;

    IF v_all_passed THEN
        v_score := 85.0
            + CASE WHEN p_jan_aushadhi_stocked THEN 10.0 ELSE 0.0 END
            + least(5.0, greatest(0, (p_essential_medicines_stocked - 5) * 0.25));
    ELSE
        v_score := 25.0;
    END IF;

    v_details := jsonb_build_object(
        'stock_requirement_met', v_stock_ok,
        'essential_medicines_stocked', p_essential_medicines_stocked,
        'within_printed_mrp', v_mrp_ok,
        'within_nppa_ceiling_with_gst', v_ceiling_ok,
        'sample_product_brand', v_prod.brand_name,
        'sample_billed_unit_price', p_sample_billed_unit_price,
        'printed_unit_price', v_prod.price_per_unit,
        'effective_ceiling_unit_price', v_effective_ceiling,
        'batch_clean_in_cdsco', v_batch_ok,
        'no_complaint_threshold_breach', v_complaint_ok
    );

    IF v_all_passed AND coalesce(p_auto_approve_if_matched, true) THEN
        v_status := 'approved';
        v_review_note := 'Verified: stock proof and billing proof matched NPPA ceiling, MRP, and CDSCO batch quality checks.';
    ELSIF NOT v_all_passed THEN
        v_status := 'rejected';
        v_review_note := 'Verification checks did not pass: '
            || CASE WHEN NOT v_stock_ok THEN 'insufficient essential stock (<5); ' ELSE '' END
            || CASE WHEN NOT v_mrp_ok THEN 'billed unit price exceeds printed MRP; ' ELSE '' END
            || CASE WHEN NOT v_ceiling_ok THEN 'billed unit price exceeds NPPA ceiling + 5% GST; ' ELSE '' END
            || CASE WHEN NOT v_batch_ok THEN 'sample batch is flagged in CDSCO NSQ alerts; ' ELSE '' END
            || CASE WHEN NOT v_complaint_ok THEN 'pharmacy has 3+ unresolved reports in last 90 days; ' ELSE '' END;
    ELSE
        v_status := 'pending';
        v_review_note := 'Automated checks passed; awaiting manual authority review.';
    END IF;

    INSERT INTO public.pharmacy_verification_submissions (
        pharmacy_id,
        submitted_by,
        stock_proof_urls,
        billing_proof_urls,
        essential_medicines_stocked,
        jan_aushadhi_stocked,
        sample_brand_product_id,
        sample_billed_unit_price,
        sample_batch_number,
        auto_check_passed,
        auto_check_details,
        review_status,
        review_note,
        reviewed_at
    )
    VALUES (
        p_pharmacy_id,
        auth.uid(),
        p_stock_proof_urls,
        p_billing_proof_urls,
        p_essential_medicines_stocked,
        coalesce(p_jan_aushadhi_stocked, false),
        p_sample_brand_product_id,
        p_sample_billed_unit_price,
        nullif(btrim(p_sample_batch_number), ''),
        v_all_passed,
        v_details,
        v_status,
        v_review_note,
        CASE WHEN v_status IN ('approved', 'rejected') THEN now() ELSE NULL END
    )
    RETURNING * INTO v_sub;

    -- Update pharmacy verification status
    IF v_status = 'approved' THEN
        UPDATE public.pharmacies
        SET is_verified = true,
            verification_status = 'verified',
            verified_at = now(),
            verified_until = now() + interval '180 days',
            verification_score = v_score,
            essential_medicines_stocked = p_essential_medicines_stocked,
            jan_aushadhi_available = coalesce(p_jan_aushadhi_stocked, jan_aushadhi_available),
            stock_proof_urls = p_stock_proof_urls,
            billing_proof_urls = p_billing_proof_urls,
            last_review_note = v_review_note
        WHERE id = p_pharmacy_id
        RETURNING * INTO v_pharm;
    ELSIF v_status = 'rejected' THEN
        UPDATE public.pharmacies
        SET is_verified = false,
            verification_status = 'rejected',
            last_review_note = v_review_note
        WHERE id = p_pharmacy_id
        RETURNING * INTO v_pharm;
    ELSE
        UPDATE public.pharmacies
        SET verification_status = 'pending_review',
            last_review_note = v_review_note
        WHERE id = p_pharmacy_id
        RETURNING * INTO v_pharm;
    END IF;

    RETURN jsonb_build_object(
        'submission_id', v_sub.id,
        'pharmacy_id', v_pharm.id,
        'pharmacy_name', v_pharm.pharmacy_name,
        'licence_no', v_pharm.licence_no,
        'auto_check_passed', v_all_passed,
        'auto_check_details', v_details,
        'review_status', v_sub.review_status,
        'is_verified', v_pharm.is_verified,
        'verification_status', v_pharm.verification_status,
        'verification_score', v_pharm.verification_score,
        'verified_at', v_pharm.verified_at,
        'verified_until', v_pharm.verified_until,
        'review_note', v_review_note
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_pharmacy_verification(uuid, text[], text[], integer, uuid, numeric, text, boolean, boolean) TO anon, authenticated, service_role;

-- Manual authority review of a pharmacy submission
CREATE OR REPLACE FUNCTION public.review_pharmacy_verification(
    p_submission_id uuid,
    p_decision text,
    p_review_note text DEFAULT NULL,
    p_government_account_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sub public.pharmacy_verification_submissions%rowtype;
    v_pharm public.pharmacies%rowtype;
    v_gov public.government_accounts%rowtype;
BEGIN
    IF p_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'p_decision must be approved or rejected.' USING ERRCODE = '22023';
    END IF;

    IF auth.uid() IS NOT NULL THEN
        SELECT * INTO v_gov FROM public.government_accounts WHERE user_id = auth.uid() AND is_active = true LIMIT 1;
    END IF;
    IF v_gov.id IS NULL AND p_government_account_id IS NOT NULL THEN
        SELECT * INTO v_gov FROM public.government_accounts WHERE id = p_government_account_id AND is_active = true LIMIT 1;
    END IF;

    IF v_gov.id IS NULL AND coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
       AND current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
        RAISE EXCEPTION 'Unauthorized: only government authority accounts or service_role can review pharmacy verifications.'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_sub FROM public.pharmacy_verification_submissions WHERE id = p_submission_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Submission % not found.', p_submission_id USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.pharmacy_verification_submissions
    SET review_status = p_decision,
        reviewed_by_government_id = v_gov.id,
        review_note = coalesce(nullif(btrim(p_review_note), ''), review_note),
        reviewed_at = now()
    WHERE id = p_submission_id
    RETURNING * INTO v_sub;

    IF p_decision = 'approved' THEN
        UPDATE public.pharmacies
        SET is_verified = true,
            verification_status = 'verified',
            verified_at = now(),
            verified_until = now() + interval '180 days',
            essential_medicines_stocked = v_sub.essential_medicines_stocked,
            jan_aushadhi_available = v_sub.jan_aushadhi_stocked,
            stock_proof_urls = v_sub.stock_proof_urls,
            billing_proof_urls = v_sub.billing_proof_urls,
            last_review_note = v_sub.review_note
        WHERE id = v_sub.pharmacy_id
        RETURNING * INTO v_pharm;
    ELSE
        UPDATE public.pharmacies
        SET is_verified = false,
            verification_status = 'rejected',
            last_review_note = v_sub.review_note
        WHERE id = v_sub.pharmacy_id
        RETURNING * INTO v_pharm;
    END IF;

    RETURN jsonb_build_object(
        'submission_id', v_sub.id,
        'pharmacy_id', v_pharm.id,
        'pharmacy_name', v_pharm.pharmacy_name,
        'review_status', v_sub.review_status,
        'is_verified', v_pharm.is_verified,
        'verification_status', v_pharm.verification_status,
        'verified_at', v_pharm.verified_at,
        'review_note', v_sub.review_note
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.review_pharmacy_verification(uuid, text, text, uuid) TO authenticated, service_role;

-- Public RPC: Suggest verified pharmacies in a user's area / city / state / pincode
CREATE OR REPLACE FUNCTION public.get_verified_pharmacies(
    p_area_or_query text DEFAULT NULL,
    p_city text DEFAULT NULL,
    p_state text DEFAULT NULL,
    p_pincode text DEFAULT NULL,
    p_only_jan_aushadhi boolean DEFAULT false,
    p_limit integer DEFAULT 20
)
RETURNS SETOF public.pharmacies
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT p.*
    FROM public.pharmacies p
    WHERE p.is_verified = true
      AND p.verification_status = 'verified'
      AND (p.verified_until IS NULL OR p.verified_until >= now())
      AND (NOT coalesce(p_only_jan_aushadhi, false) OR p.jan_aushadhi_available = true)
      AND (
          nullif(btrim(p_area_or_query), '') IS NULL
          OR lower(p.area) LIKE '%' || lower(btrim(p_area_or_query)) || '%'
          OR lower(p.city) LIKE '%' || lower(btrim(p_area_or_query)) || '%'
          OR lower(p.state) LIKE '%' || lower(btrim(p_area_or_query)) || '%'
          OR lower(p.pincode) LIKE '%' || lower(btrim(p_area_or_query)) || '%'
          OR lower(p.pharmacy_name) LIKE '%' || lower(btrim(p_area_or_query)) || '%'
          OR lower(coalesce(p.address, '')) LIKE '%' || lower(btrim(p_area_or_query)) || '%'
      )
      AND (nullif(btrim(p_city), '') IS NULL OR lower(p.city) = lower(btrim(p_city)))
      AND (nullif(btrim(p_state), '') IS NULL OR lower(p.state) = lower(btrim(p_state)))
      AND (nullif(btrim(p_pincode), '') IS NULL OR lower(p.pincode) = lower(btrim(p_pincode)))
    ORDER BY
      p.jan_aushadhi_available DESC,
      p.verification_score DESC,
      p.verified_at DESC NULLS LAST,
      p.pharmacy_name ASC
    LIMIT greatest(1, least(coalesce(p_limit, 20), 100));
$$;

GRANT EXECUTE ON FUNCTION public.get_verified_pharmacies(text, text, text, text, boolean, integer) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Seed Fictional Sample Government Account & Sample Verified Pharmacies
--    (Clearly marked SAMPLE - NOT REAL DATA)
-- -----------------------------------------------------------------------------
INSERT INTO public.government_accounts (
    id, agency_name, department, state, official_email, officer_name, designation, is_active, notes
)
VALUES
    (
        '77777777-7777-4777-8777-777777777701',
        'Maharashtra Food and Drug Administration (Sample Cell)',
        'Drug Price & Quality Enforcement Wing',
        'Maharashtra',
        'sample-enforcement-mh@example.com',
        'Sample Nodal Officer',
        'Assistant Commissioner (Drugs) - Sample',
        true,
        'SAMPLE - NOT REAL DATA'
    ),
    (
        '77777777-7777-4777-8777-777777777702',
        'NPPA Pharma Jan Samadhan (Sample Desk)',
        'National Pharmaceutical Pricing Authority',
        NULL,
        'sample-nppa-desk@example.com',
        'Sample Central Officer',
        'Monitoring Officer - Sample',
        true,
        'SAMPLE - NOT REAL DATA'
    )
ON CONFLICT (official_email) DO NOTHING;

INSERT INTO public.pharmacies (
    id, pharmacy_name, licence_no, address, area, city, state, pincode, phone,
    jan_aushadhi_available, essential_medicines_stocked, is_verified, verification_status,
    verified_at, verified_until, verification_score, stock_proof_urls, billing_proof_urls,
    last_review_note, notes
)
VALUES
    (
        '88888888-8888-4888-8888-888888888801',
        'Sample Jan Aushadhi & Fair Price Kendra (Andheri)',
        'SAMPLE-MH-VER-001',
        'Shop 4, Sample Market Road, Andheri West',
        'Andheri West',
        'Mumbai',
        'Maharashtra',
        '400058',
        '022-00000101',
        true,
        42,
        true,
        'verified',
        now(),
        now() + interval '180 days',
        98.50,
        ARRAY['https://example.com/sample-proofs/andheri-stock-register.jpg'],
        ARRAY['https://example.com/sample-proofs/andheri-gst-invoice-within-ceiling.jpg'],
        'Verified: stock proof and billing proof matched NPPA ceiling, MRP, and CDSCO batch quality checks.',
        'SAMPLE - NOT REAL DATA'
    ),
    (
        '88888888-8888-4888-8888-888888888802',
        'Sample Civic Trust Medico (Dadar)',
        'SAMPLE-MH-VER-002',
        'Plot 12, Sample Station Road, Dadar East',
        'Dadar East',
        'Mumbai',
        'Maharashtra',
        '400014',
        '022-00000202',
        false,
        25,
        true,
        'verified',
        now(),
        now() + interval '180 days',
        90.00,
        ARRAY['https://example.com/sample-proofs/dadar-stock-shelf.jpg'],
        ARRAY['https://example.com/sample-proofs/dadar-gst-bill-coolpara.jpg'],
        'Verified: stock proof and billing proof matched NPPA ceiling, MRP, and CDSCO batch quality checks.',
        'SAMPLE - NOT REAL DATA'
    )
ON CONFLICT (licence_no) DO NOTHING;
