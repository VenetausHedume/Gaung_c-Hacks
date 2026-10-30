-- =============================================================================
-- MediCheck Migration 0003: Align with data spec
--  A1. authorities.handles = comma-separated {price, shortage, quality, bill_refusal}
--  A2. authorities.state is NULL for central bodies
--  A3. normalize_pack_unit() used everywhere pack units are compared
--  Also: nsq_alerts.batch_number becomes nullable (rows with notes only)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A3. Reusable pack-unit normaliser: lowercase, strip leading "per ", strip trailing "s"
--     'per tablet' = 'tablet' = 'tablets' = 'Tablets'
-- -----------------------------------------------------------------------------
create or replace function public.normalize_pack_unit(u text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
    select nullif(
        regexp_replace(
            regexp_replace(lower(btrim(coalesce(u, ''))), '^per\s+', ''),
            's$', ''
        ),
        ''
    );
$$;

grant execute on function public.normalize_pack_unit(text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- nsq_alerts: allow empty batch_number (generated batch_key becomes NULL)
-- -----------------------------------------------------------------------------
alter table public.nsq_alerts alter column batch_number drop not null;

-- -----------------------------------------------------------------------------
-- A1 + A2: authorities data shape
-- -----------------------------------------------------------------------------
comment on column public.authorities.handles is
    'Comma-separated list (no spaces) of issue types handled, from: price, shortage, quality, bill_refusal.';
comment on column public.authorities.state is
    'NULL for central bodies; state name for state_drug_controller rows.';

-- Convert legacy rows (old report-type / pipe format, state = All/National)
update public.authorities
set state = null
where state is not null and lower(btrim(state)) in ('all', 'national');

update public.authorities a
set handles = (
    select string_agg(distinct m.h, ',' order by m.h)
    from unnest(string_to_array(regexp_replace(a.handles, '\s*[|,]\s*', ',', 'g'), ',')) as t(raw)
    cross join lateral (
        select case t.raw
            when 'sold_above_mrp'        then 'price'
            when 'price_above_ceiling'   then 'price'
            when 'out_of_stock'          then 'shortage'
            when 'suspect_batch_or_pack' then 'quality'
            when 'bill_refused'          then 'bill_refusal'
            else t.raw
        end as h
    ) m
)
where a.handles is not null;

alter table public.authorities drop constraint if exists authorities_handles_check;
alter table public.authorities
    add constraint authorities_handles_check
    check (
        handles is null
        or handles ~ '^(price|shortage|quality|bill_refusal)(,(price|shortage|quality|bill_refusal))*$'
    ) not valid;

-- -----------------------------------------------------------------------------
-- get_authorities: new signature (adds p_report_type); drop the old overload first
-- -----------------------------------------------------------------------------
drop function if exists public.get_authorities(text, text);

create or replace function public.get_authorities(
    p_state text default null,
    p_handles text default null,
    p_report_type text default null
)
returns setof public.authorities
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
    v_report_handle text := null;
    v_handle text := nullif(lower(btrim(coalesce(p_handles, ''))), '');
begin
    -- report_type -> handle mapping
    if p_report_type is not null and btrim(p_report_type) <> '' then
        v_report_handle := case btrim(p_report_type)
            when 'sold_above_mrp'        then 'price'
            when 'price_above_ceiling'   then 'price'
            when 'out_of_stock'          then 'shortage'
            when 'suspect_batch_or_pack' then 'quality'
            when 'bill_refused'          then 'bill_refusal'
            else null
        end;
        if v_report_handle is null then
            raise exception 'Unknown report_type: %', p_report_type;
        end if;
    end if;

    return query
    select a.*
    from public.authorities a
    where (
            a.state is null  -- central bodies always included
            or (nullif(btrim(coalesce(p_state, '')), '') is not null
                and lower(btrim(a.state)) = lower(btrim(p_state)))
          )
      and (v_handle is null
           or v_handle = any (string_to_array(replace(coalesce(a.handles, ''), ' ', ''), ',')))
      and (v_report_handle is null
           or v_report_handle = any (string_to_array(replace(coalesce(a.handles, ''), ' ', ''), ',')))
    order by (a.state is not null) asc, a.authority_name asc;
end;
$$;

grant execute on function public.get_authorities(text, text, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- medicine_check: uses normalize_pack_unit for ceiling AND equivalents matching
-- -----------------------------------------------------------------------------
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
    -- Configurable GST allowance (0.05 = 5%). NPPA ceiling prices exclude GST.
    c_gst_allowance constant numeric := 0.05;
    c_safety_note constant text := 'Information only. Do not change or stop a prescribed medicine without asking your doctor or pharmacist.';

    v_product public.brand_products%rowtype;
    v_ceiling public.ceiling_prices%rowtype;
    v_has_ceiling boolean := false;
    v_effective_ceiling_with_gst numeric := null;
    v_ceiling_status text := 'no_ceiling';
    v_gst_explanation text;

    v_equivalents jsonb := '[]'::jsonb;

    v_normalized_batch text := null;
    v_batch_alert record;
    v_batch_flagged boolean := false;
    v_batch_alert_json jsonb := null;
    v_mfr_salt_alert_count integer := 0;

    v_data_dates jsonb := '{}'::jsonb;
    v_labels text[] := array[]::text[];
begin
    select * into v_product from public.brand_products where id = p_brand_product_id;
    if not found then
        return null;
    end if;

    -- Ceiling: matching key + compatible (normalised) pack unit
    select cp.* into v_ceiling
    from public.ceiling_prices cp
    where lower(cp.salt_normalized) = lower(v_product.salt_normalized)
      and lower(cp.strength) = lower(v_product.strength)
      and lower(cp.dosage_form) = lower(v_product.dosage_form)
      and public.normalize_pack_unit(cp.pack_unit) = public.normalize_pack_unit(v_product.pack_unit)
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
        v_labels := array_append(v_labels, 'No ceiling price available');
        v_gst_explanation := 'No scheduled NPPA ceiling price matched this salt, strength, dosage form, and unit. Non-scheduled medicines do not have a fixed ceiling price under DPCO.';
    end if;

    -- Cheaper equivalents (same key + compatible pack unit), Jan Aushadhi and branded
    select coalesce(jsonb_agg(eq_row order by (eq_row->>'price_per_unit')::numeric asc), '[]'::jsonb)
    into v_equivalents
    from (
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
            'savings_percent', case when v_product.price_per_unit > 0
                then round(((v_product.price_per_unit - ja.price_per_unit) / v_product.price_per_unit) * 100, 1)
                else 0 end,
            'is_jan_aushadhi', true
        ) as eq_row
        from public.jan_aushadhi_products ja
        where lower(ja.salt_normalized) = lower(v_product.salt_normalized)
          and lower(ja.strength) = lower(v_product.strength)
          and lower(ja.dosage_form) = lower(v_product.dosage_form)
          and public.normalize_pack_unit(ja.pack_unit) = public.normalize_pack_unit(v_product.pack_unit)
          and ja.price_per_unit < v_product.price_per_unit

        union all

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
            'savings_percent', case when v_product.price_per_unit > 0
                then round(((v_product.price_per_unit - bp2.price_per_unit) / v_product.price_per_unit) * 100, 1)
                else 0 end,
            'is_jan_aushadhi', false
        ) as eq_row
        from public.brand_products bp2
        where bp2.id <> v_product.id
          and lower(bp2.salt_normalized) = lower(v_product.salt_normalized)
          and lower(bp2.strength) = lower(v_product.strength)
          and lower(bp2.dosage_form) = lower(v_product.dosage_form)
          and public.normalize_pack_unit(bp2.pack_unit) = public.normalize_pack_unit(v_product.pack_unit)
          and bp2.price_per_unit < v_product.price_per_unit
    ) combined;

    if jsonb_array_length(v_equivalents) > 0 then
        v_labels := array_append(v_labels, 'Cheaper equivalent available');
    end if;

    -- Info-only count for manufacturer + salt (NOT a flag)
    select count(*)::integer into v_mfr_salt_alert_count
    from public.nsq_alerts na
    where lower(na.salt_normalized) = lower(v_product.salt_normalized)
      and lower(coalesce(na.manufacturer, '')) = lower(v_product.manufacturer);

    -- Batch check
    if p_batch is not null and btrim(p_batch) <> '' then
        v_normalized_batch := upper(regexp_replace(p_batch, '\s', '', 'g'));

        select na.id, na.alert_month, na.category, na.drug_name, na.brand_name, na.batch_number,
               na.manufacturer, na.manufacturing_date, na.expiry_date, na.failure_reason,
               na.testing_lab, na.source_url, na.source_date
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
            v_labels := array_append(v_labels, 'Batch not found in latest CDSCO lists');
        end if;
    end if;

    select coalesce(jsonb_object_agg(dv.dataset_name, dv.source_date), '{}'::jsonb)
    into v_data_dates
    from public.data_versions dv;

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
            'ceiling_row', case when v_has_ceiling then jsonb_build_object(
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
            ) else null end
        ),
        'equivalents', v_equivalents,
        'batch', jsonb_build_object(
            'batch_queried', p_batch,
            'batch_key', v_normalized_batch,
            'checked', (p_batch is not null and btrim(p_batch) <> ''),
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

grant execute on function public.medicine_check(uuid, text) to anon, authenticated;
