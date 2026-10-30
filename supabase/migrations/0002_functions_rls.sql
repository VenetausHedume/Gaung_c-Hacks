-- =============================================================================
-- MediCheck Migration 0002: Row-Level Security (RLS) & RPC Functions
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enable Row-Level Security on ALL tables
-- -----------------------------------------------------------------------------
alter table public.brand_products enable row level security;
alter table public.barcodes enable row level security;
alter table public.ceiling_prices enable row level security;
alter table public.nsq_alerts enable row level security;
alter table public.jan_aushadhi_products enable row level security;
alter table public.authorities enable row level security;
alter table public.data_versions enable row level security;
alter table public.reports enable row level security;

-- -----------------------------------------------------------------------------
-- 2. RLS Policies
-- Public (anon + authenticated) SELECT on reference tables & data_versions
-- -----------------------------------------------------------------------------
drop policy if exists "Public read brand_products" on public.brand_products;
create policy "Public read brand_products"
    on public.brand_products for select
    to anon, authenticated
    using (true);

drop policy if exists "Public read barcodes" on public.barcodes;
create policy "Public read barcodes"
    on public.barcodes for select
    to anon, authenticated
    using (true);

drop policy if exists "Public read ceiling_prices" on public.ceiling_prices;
create policy "Public read ceiling_prices"
    on public.ceiling_prices for select
    to anon, authenticated
    using (true);

drop policy if exists "Public read nsq_alerts" on public.nsq_alerts;
create policy "Public read nsq_alerts"
    on public.nsq_alerts for select
    to anon, authenticated
    using (true);

drop policy if exists "Public read jan_aushadhi_products" on public.jan_aushadhi_products;
create policy "Public read jan_aushadhi_products"
    on public.jan_aushadhi_products for select
    to anon, authenticated
    using (true);

drop policy if exists "Public read authorities" on public.authorities;
create policy "Public read authorities"
    on public.authorities for select
    to anon, authenticated
    using (true);

drop policy if exists "Public read data_versions" on public.data_versions;
create policy "Public read data_versions"
    on public.data_versions for select
    to anon, authenticated
    using (true);

-- Anon INSERT only on reports (with strict text length checks);
-- NO anon SELECT, UPDATE, or DELETE policies on reports.
drop policy if exists "Anon insert reports" on public.reports;
create policy "Anon insert reports"
    on public.reports for insert
    to anon, authenticated
    with check (
        char_length(trim(pharmacy_name)) between 1 and 200
        and (pharmacy_licence_no is null or char_length(pharmacy_licence_no) <= 100)
        and report_type in (
            'sold_above_mrp',
            'price_above_ceiling',
            'out_of_stock',
            'suspect_batch_or_pack',
            'bill_refused'
        )
        and char_length(trim(description)) between 1 and 2000
        and (batch_number is null or char_length(batch_number) <= 100)
    );

-- -----------------------------------------------------------------------------
-- 3. Postgres RPC Functions (SECURITY INVOKER, STABLE)
-- -----------------------------------------------------------------------------

-- 3.1 search_brands(q text, lim int default 15)
-- Fuzzy match on brand_name and salt_normalized, ranked by trigram similarity.
create or replace function public.search_brands(
    q text,
    lim int default 15
)
returns table (
    id uuid,
    brand_name text,
    manufacturer text,
    salt_normalized text,
    strength text,
    dosage_form text,
    pack_size numeric,
    pack_unit text,
    printed_mrp numeric,
    price_per_unit numeric,
    mrp_source text,
    mrp_date date,
    schedule_status text,
    notes text,
    similarity_score real
)
language sql
stable
security invoker
set search_path = public
as $$
    with cleaned as (
        select trim(coalesce(q, '')) as query_str,
               least(greatest(coalesce(lim, 15), 1), 100) as max_rows
    )
    select
        bp.id,
        bp.brand_name,
        bp.manufacturer,
        bp.salt_normalized,
        bp.strength,
        bp.dosage_form,
        bp.pack_size,
        bp.pack_unit,
        bp.printed_mrp,
        bp.price_per_unit,
        bp.mrp_source,
        bp.mrp_date,
        bp.schedule_status,
        bp.notes,
        greatest(
            similarity(bp.brand_name, c.query_str),
            similarity(bp.salt_normalized, c.query_str),
            case
                when bp.brand_name ilike (c.query_str || '%') then 0.85::real
                when bp.salt_normalized ilike (c.query_str || '%') then 0.80::real
                when bp.brand_name ilike ('%' || c.query_str || '%') then 0.65::real
                when bp.salt_normalized ilike ('%' || c.query_str || '%') then 0.60::real
                else 0.0::real
            end
        ) as similarity_score
    from public.brand_products bp
    cross join cleaned c
    where c.query_str <> ''
      and (
          bp.brand_name % c.query_str
          or bp.salt_normalized % c.query_str
          or bp.brand_name ilike ('%' || c.query_str || '%')
          or bp.salt_normalized ilike ('%' || c.query_str || '%')
          or similarity(bp.brand_name, c.query_str) >= 0.15
          or similarity(bp.salt_normalized, c.query_str) >= 0.15
      )
    order by similarity_score desc, bp.brand_name asc
    limit (select max_rows from cleaned);
$$;

-- 3.2 lookup_by_barcode(code text)
-- Returns the matching brand_product row (or null / empty set if not found).
create or replace function public.lookup_by_barcode(
    code text
)
returns public.brand_products
language sql
stable
security invoker
set search_path = public
as $$
    select bp.*
    from public.barcodes b
    join public.brand_products bp on bp.id = b.brand_product_id
    where b.barcode = trim(coalesce(code, ''))
    limit 1;
$$;

-- 3.3 medicine_check(p_brand_product_id uuid, p_batch text default null)
-- Comprehensive price, ceiling, cheaper equivalents, and CDSCO batch check.
create or replace function public.medicine_check(
    p_brand_product_id uuid,
    p_batch text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
    -- Configurable GST allowance constant (default 5% = 0.05) since NPPA ceiling prices exclude GST
    c_gst_allowance constant numeric := 0.05;
    c_safety_note constant text := 'Information only. Do not change or stop a prescribed medicine without asking your doctor or pharmacist.';

    v_product public.brand_products%rowtype;
    v_ceiling public.ceiling_prices%rowtype;
    v_has_ceiling boolean := false;
    v_effective_ceiling_with_gst numeric := null;
    v_ceiling_status text := 'no_ceiling';
    v_gst_explanation text;

    v_equivalents jsonb := '[]'::jsonb;
    v_has_cheaper boolean := false;

    v_normalized_batch text := null;
    v_batch_alert record;
    v_batch_flagged boolean := false;
    v_batch_alert_json jsonb := null;
    v_mfr_salt_alert_count integer := 0;

    v_data_dates jsonb := '{}'::jsonb;
    v_labels text[] := array[]::text[];
begin
    -- 1. Fetch product
    select *
    into v_product
    from public.brand_products
    where id = p_brand_product_id;

    if not found then
        return null;
    end if;

    -- 2. Match NPPA ceiling price on (salt_normalized, strength, dosage_form) + compatible pack_unit
    select cp.*
    into v_ceiling
    from public.ceiling_prices cp
    where lower(cp.salt_normalized) = lower(v_product.salt_normalized)
      and lower(cp.strength) = lower(v_product.strength)
      and lower(cp.dosage_form) = lower(v_product.dosage_form)
      and (
          lower(cp.pack_unit) = lower(v_product.pack_unit)
          or trim(trailing 's' from lower(cp.pack_unit)) = trim(trailing 's' from lower(v_product.pack_unit))
      )
    order by cp.effective_date desc nulls last, cp.created_at desc
    limit 1;

    if found then
        v_has_ceiling := true;
        v_effective_ceiling_with_gst := round(v_ceiling.ceiling_price * (1 + c_gst_allowance), 4);

        if v_product.price_per_unit <= v_effective_ceiling_with_gst then
            v_ceiling_status := 'within';
            v_labels := array_append(v_labels, 'Within ceiling price');
        else
            v_ceiling_status := 'above';
            v_labels := array_append(v_labels, 'Above ceiling price');
        end if;

        v_gst_explanation := format(
            'NPPA ceiling prices exclude GST. A %s%% GST allowance is included when comparing unit price against the ceiling (base ceiling Rs %s/%s, effective threshold Rs %s/%s).',
            round(c_gst_allowance * 100, 1),
            round(v_ceiling.ceiling_price, 2),
            v_ceiling.pack_unit,
            round(v_effective_ceiling_with_gst, 2),
            v_ceiling.pack_unit
        );
    else
        v_ceiling_status := 'no_ceiling';
        v_labels := array_append(v_labels, 'No ceiling price available');
        v_gst_explanation := 'No scheduled NPPA ceiling price matched this salt, strength, dosage form, and unit. Non-scheduled medicines do not have a fixed ceiling price under DPCO.';
    end if;

    -- 3. Cheaper equivalents (same matching key, cheaper price_per_unit, from brand_products + jan_aushadhi_products)
    select coalesce(jsonb_agg(eq_row order by (eq_row->>'price_per_unit')::numeric asc), '[]'::jsonb)
    into v_equivalents
    from (
        -- Jan Aushadhi equivalents
        select jsonb_build_object(
            'id', ja.id,
            'name', ja.generic_name,
            'manufacturer', 'PMBJP (Jan Aushadhi)',
            'ja_product_code', ja.ja_product_code,
            'salt_normalized', ja.salt_normalized,
            'strength', ja.strength,
            'dosage_form', ja.dosage_form,
            'pack_size', ja.pack_size,
            'pack_unit', ja.pack_unit,
            'mrp', ja.mrp,
            'price_per_unit', ja.price_per_unit,
            'savings_per_unit', round(v_product.price_per_unit - ja.price_per_unit, 2),
            'savings_percent', case
                when v_product.price_per_unit > 0 then
                    round(((v_product.price_per_unit - ja.price_per_unit) / v_product.price_per_unit) * 100, 1)
                else 0
            end,
            'is_jan_aushadhi', true
        ) as eq_row
        from public.jan_aushadhi_products ja
        where lower(ja.salt_normalized) = lower(v_product.salt_normalized)
          and lower(ja.strength) = lower(v_product.strength)
          and lower(ja.dosage_form) = lower(v_product.dosage_form)
          and ja.price_per_unit < v_product.price_per_unit

        union all

        -- Other branded equivalents
        select jsonb_build_object(
            'id', bp2.id,
            'name', bp2.brand_name,
            'manufacturer', bp2.manufacturer,
            'ja_product_code', null,
            'salt_normalized', bp2.salt_normalized,
            'strength', bp2.strength,
            'dosage_form', bp2.dosage_form,
            'pack_size', bp2.pack_size,
            'pack_unit', bp2.pack_unit,
            'mrp', bp2.printed_mrp,
            'price_per_unit', bp2.price_per_unit,
            'savings_per_unit', round(v_product.price_per_unit - bp2.price_per_unit, 2),
            'savings_percent', case
                when v_product.price_per_unit > 0 then
                    round(((v_product.price_per_unit - bp2.price_per_unit) / v_product.price_per_unit) * 100, 1)
                else 0
            end,
            'is_jan_aushadhi', false
        ) as eq_row
        from public.brand_products bp2
        where bp2.id <> v_product.id
          and lower(bp2.salt_normalized) = lower(v_product.salt_normalized)
          and lower(bp2.strength) = lower(v_product.strength)
          and lower(bp2.dosage_form) = lower(v_product.dosage_form)
          and bp2.price_per_unit < v_product.price_per_unit
    ) combined;

    if jsonb_array_length(v_equivalents) > 0 then
        v_has_cheaper := true;
        v_labels := array_append(v_labels, 'Cheaper equivalent available');
    end if;

    -- 4. Batch check & Manufacturer+Salt info alert count
    select count(*)::integer
    into v_mfr_salt_alert_count
    from public.nsq_alerts na
    where lower(na.salt_normalized) = lower(v_product.salt_normalized)
      and lower(coalesce(na.manufacturer, '')) = lower(v_product.manufacturer);

    if p_batch is not null and trim(p_batch) <> '' then
        v_normalized_batch := upper(regexp_replace(p_batch, '\s', '', 'g'));

        select
            na.id,
            na.alert_month,
            na.category,
            na.drug_name,
            na.brand_name,
            na.batch_number,
            na.manufacturer,
            na.manufacturing_date,
            na.expiry_date,
            na.failure_reason,
            na.testing_lab,
            na.source_url,
            na.source_date
        into v_batch_alert
        from public.nsq_alerts na
        where na.batch_key = v_normalized_batch
        order by na.source_date desc nulls last, na.created_at desc
        limit 1;

        if found then
            v_batch_flagged := true;
            v_batch_alert_json := jsonb_build_object(
                'id', v_batch_alert.id,
                'alert_month', v_batch_alert.alert_month,
                'category', v_batch_alert.category,
                'drug_name', v_batch_alert.drug_name,
                'brand_name', v_batch_alert.brand_name,
                'batch_number', v_batch_alert.batch_number,
                'manufacturer', v_batch_alert.manufacturer,
                'manufacturing_date', v_batch_alert.manufacturing_date,
                'expiry_date', v_batch_alert.expiry_date,
                'failure_reason', v_batch_alert.failure_reason,
                'testing_lab', v_batch_alert.testing_lab,
                'source_url', v_batch_alert.source_url,
                'source_date', v_batch_alert.source_date
            );
            v_labels := array_append(v_labels, 'Batch flagged by CDSCO');
        else
            v_batch_flagged := false;
            v_labels := array_append(v_labels, 'Batch not found in latest CDSCO lists');
        end if;
    end if;

    -- 5. Dataset freshness dates from data_versions
    select coalesce(
        jsonb_object_agg(dv.dataset_name, dv.source_date),
        '{}'::jsonb
    )
    into v_data_dates
    from public.data_versions dv;

    -- 6. Build complete JSONB payload
    return jsonb_build_object(
        'product', jsonb_build_object(
            'id', v_product.id,
            'brand_name', v_product.brand_name,
            'manufacturer', v_product.manufacturer,
            'salt_normalized', v_product.salt_normalized,
            'strength', v_product.strength,
            'dosage_form', v_product.dosage_form,
            'pack_size', v_product.pack_size,
            'pack_unit', v_product.pack_unit,
            'printed_mrp', v_product.printed_mrp,
            'price_per_unit', v_product.price_per_unit,
            'mrp_source', v_product.mrp_source,
            'mrp_date', v_product.mrp_date,
            'schedule_status', v_product.schedule_status,
            'notes', v_product.notes
        ),
        'price', jsonb_build_object(
            'printed_mrp', v_product.printed_mrp,
            'price_per_unit', v_product.price_per_unit,
            'ceiling_status', v_ceiling_status,
            'gst_allowance_percent', round(c_gst_allowance * 100, 1),
            'effective_ceiling_per_unit_with_gst', v_effective_ceiling_with_gst,
            'gst_note', v_gst_explanation,
            'ceiling_row', case
                when v_has_ceiling then jsonb_build_object(
                    'id', v_ceiling.id,
                    'salt_normalized', v_ceiling.salt_normalized,
                    'strength', v_ceiling.strength,
                    'dosage_form', v_ceiling.dosage_form,
                    'pack_unit', v_ceiling.pack_unit,
                    'ceiling_price', v_ceiling.ceiling_price,
                    'gst_note', v_ceiling.gst_note,
                    'effective_date', v_ceiling.effective_date,
                    'notification_ref', v_ceiling.notification_ref,
                    'source_url', v_ceiling.source_url,
                    'source_date', v_ceiling.source_date
                )
                else null
            end
        ),
        'equivalents', v_equivalents,
        'batch', jsonb_build_object(
            'batch_queried', p_batch,
            'batch_key', v_normalized_batch,
            'checked', (p_batch is not null and trim(p_batch) <> ''),
            'flagged', v_batch_flagged,
            'alert', v_batch_alert_json,
            'manufacturer_salt_recent_alert_count', v_mfr_salt_alert_count,
            'manufacturer_salt_note', format(
                'Historical alert count (%s) for this manufacturer and salt is provided as background information only and does not flag your specific batch.',
                v_mfr_salt_alert_count
            )
        ),
        'data_dates', v_data_dates,
        'labels', to_jsonb(v_labels),
        'safety_note', c_safety_note
    );
end;
$$;

-- 3.4 get_authorities(p_state text default null, p_handles text default null)
-- Returns national authorities plus matching state/issue-type authorities.
create or replace function public.get_authorities(
    p_state text default null,
    p_handles text default null
)
returns setof public.authorities
language sql
stable
security invoker
set search_path = public
as $$
    select a.*
    from public.authorities a
    where (
        p_state is null
        or trim(p_state) = ''
        or lower(a.state) = 'all'
        or lower(a.state) = 'national'
        or a.state is null
        or lower(a.state) = lower(trim(p_state))
    )
    and (
        p_handles is null
        or trim(p_handles) = ''
        or a.handles ilike ('%' || trim(p_handles) || '%')
    )
    order by
        case
            when lower(coalesce(a.state, 'national')) in ('all', 'national') then 0
            else 1
        end asc,
        a.authority_name asc;
$$;

-- Grant execute permissions on RPC functions to anon and authenticated roles
grant execute on function public.search_brands(text, integer) to anon, authenticated;
grant execute on function public.lookup_by_barcode(text) to anon, authenticated;
grant execute on function public.medicine_check(uuid, text) to anon, authenticated;
grant execute on function public.get_authorities(text, text) to anon, authenticated;
