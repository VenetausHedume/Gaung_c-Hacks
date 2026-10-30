-- =============================================================================
-- MediCheck Migration 0004: Tamper-evident public log (hash chain + Merkle root)
--
-- Design notes
--  * canonical_json(payload) := payload::text. jsonb has a stable key order
--    (shorter keys first, then bytewise), so the same payload always renders identically.
--  * entry_hash = sha256_hex( prev_hash || payload::text || entry_type || iso_utc(created_at) )
--    where iso_utc = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"' in UTC. Genesis prev_hash = 64 zeros.
--  * The log is append-only. UPDATE/DELETE/TRUNCATE raise an exception for everyone
--    (including service role). Corrections are appended as new entries.
--  * The chain proves a record is unchanged after filing; NOT that it was true when filed.
--  * Limitation: a database owner could drop the trigger; periodic anchoring
--    (anchor_snapshots + scripts/anchor.ts) is what detects that.
--  * report_filed payloads hold NO pharmacy name/licence and NO free text: only a salted
--    pharmacy_ref (pepper kept in private_settings, readable only by definer functions).
--  * reports RLS (0002) does not restrict `id`, so clients may supply an explicit id.
--  * report_id uniqueness is enforced per report_filed entry (partial unique index) so that
--    later status_change / moderation_removed entries can reference the same report.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Hash helpers (built-in sha256, no dependency on where pgcrypto is installed)
-- -----------------------------------------------------------------------------
create or replace function public.sha256_hex(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select encode(sha256(convert_to(coalesce(p_text, ''), 'UTF8')), 'hex');
$$;

create or replace function public.iso_utc(p_ts timestamptz)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

create or replace function public.log_entry_hash(
    p_prev_hash text,
    p_payload jsonb,
    p_entry_type text,
    p_created_at timestamptz
)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select public.sha256_hex(
        p_prev_hash || p_payload::text || p_entry_type || public.iso_utc(p_created_at)
    );
$$;

-- -----------------------------------------------------------------------------
-- private_settings: secret pepper for pharmacy_ref. RLS on, NO policies, no grants:
-- only SECURITY DEFINER functions with a fixed search_path can read it.
-- -----------------------------------------------------------------------------
create table if not exists public.private_settings (
    key text primary key,
    value text not null
);

alter table public.private_settings enable row level security;
revoke all on public.private_settings from public, anon, authenticated, service_role;

insert into public.private_settings (key, value)
values ('log_pepper', gen_random_uuid()::text)
on conflict (key) do nothing;

-- pharmacy_ref = sha256_hex( upper(remove-whitespace(licence-or-name)) || pepper )
-- The public log stores only this reference, never the pharmacy name or licence number.
create or replace function public.pharmacy_ref(p_licence_or_name text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_pepper text;
begin
    if p_licence_or_name is null or btrim(p_licence_or_name) = '' then
        return null;
    end if;
    select value into v_pepper from public.private_settings where key = 'log_pepper';
    if v_pepper is null then
        raise exception 'log pepper is not configured';
    end if;
    return public.sha256_hex(upper(regexp_replace(p_licence_or_name, '\s', '', 'g')) || v_pepper);
end;
$$;

revoke execute on function public.pharmacy_ref(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- public_log
-- -----------------------------------------------------------------------------
create table if not exists public.public_log (
    seq bigint generated always as identity primary key,
    report_id uuid not null,
    entry_type text not null
        check (entry_type in ('report_filed', 'status_change', 'moderation_removed')),
    payload jsonb not null,
    prev_hash text not null,
    entry_hash text not null,
    created_at timestamptz not null default now()
);

create unique index if not exists public_log_report_filed_uniq
    on public.public_log (report_id) where entry_type = 'report_filed';
create index if not exists public_log_report_id_idx on public.public_log (report_id);

alter table public.public_log enable row level security;

drop policy if exists "Public read public_log" on public.public_log;
create policy "Public read public_log"
    on public.public_log for select
    to anon, authenticated
    using (true);

revoke all on public.public_log from public, anon, authenticated, service_role;
grant select on public.public_log to anon, authenticated, service_role;

-- Immutability: blocks everyone, including service role
create or replace function public.public_log_block_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    raise exception 'public_log is append-only: % is not allowed. Append a correcting entry instead.', tg_op
        using errcode = '42501';
end;
$$;

drop trigger if exists public_log_no_update_delete on public.public_log;
create trigger public_log_no_update_delete
    before update or delete on public.public_log
    for each row execute function public.public_log_block_mutation();

drop trigger if exists public_log_no_truncate on public.public_log;
create trigger public_log_no_truncate
    before truncate on public.public_log
    for each statement execute function public.public_log_block_mutation();

-- -----------------------------------------------------------------------------
-- Appending (the only write path)
-- -----------------------------------------------------------------------------
create or replace function public.append_log_entry(
    p_report_id uuid,
    p_entry_type text,
    p_payload jsonb
)
returns public.public_log
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_prev text;
    v_ts timestamptz := clock_timestamp();
    v_row public.public_log;
begin
    -- Serialise appends so the chain cannot fork
    perform pg_advisory_xact_lock(hashtextextended('medicheck_public_log', 0));

    select entry_hash into v_prev from public.public_log order by seq desc limit 1;
    v_prev := coalesce(v_prev, repeat('0', 64));

    insert into public.public_log (report_id, entry_type, payload, prev_hash, entry_hash, created_at)
    values (
        p_report_id, p_entry_type, p_payload, v_prev,
        public.log_entry_hash(v_prev, p_payload, p_entry_type, v_ts),
        v_ts
    )
    returning * into v_row;

    return v_row;
end;
$$;

-- Payload for report_filed: NON-PERSONAL fields only. Never the free-text description.
create or replace function public.build_report_log_payload(r public.reports)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_brand public.brand_products%rowtype;
begin
    if r.brand_product_id is not null then
        select * into v_brand from public.brand_products where id = r.brand_product_id;
    end if;

    return jsonb_build_object(
        'report_id', r.id,
        'report_type', r.report_type,
        -- anonymised: pharmacy name / licence stay only in the private reports table
        'pharmacy_ref', public.pharmacy_ref(coalesce(nullif(btrim(r.pharmacy_licence_no), ''), r.pharmacy_name)),
        'salt_normalized', v_brand.salt_normalized,
        'strength', v_brand.strength,
        'dosage_form', v_brand.dosage_form,
        'brand_name', v_brand.brand_name,
        'batch_number', r.batch_number,
        'filed_at', public.iso_utc(r.created_at)
    );
end;
$$;

create or replace function public.trg_report_to_public_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.append_log_entry(new.id, 'report_filed', public.build_report_log_payload(new));
    return new;
end;
$$;

drop trigger if exists reports_to_public_log on public.reports;
create trigger reports_to_public_log
    after insert on public.reports
    for each row execute function public.trg_report_to_public_log();

-- Service-role-only: append a correction (never edits earlier entries)
create or replace function public.append_log_correction(
    p_report_id uuid,
    p_entry_type text,
    p_payload jsonb
)
returns public.public_log
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_entry_type not in ('status_change', 'moderation_removed') then
        raise exception 'Corrections must be status_change or moderation_removed';
    end if;
    if not exists (select 1 from public.public_log where report_id = p_report_id and entry_type = 'report_filed') then
        raise exception 'No report_filed entry for report %', p_report_id;
    end if;
    return public.append_log_entry(
        p_report_id, p_entry_type,
        coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('report_id', p_report_id)
    );
end;
$$;

revoke execute on function public.append_log_entry(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.build_report_log_payload(public.reports) from public, anon, authenticated;
revoke execute on function public.append_log_correction(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.append_log_correction(uuid, text, jsonb) to service_role;

-- Backfill existing reports in created_at order (no reports are deleted)
do $$
declare
    r public.reports;
begin
    for r in
        select rp.* from public.reports rp
        where not exists (
            select 1 from public.public_log l where l.report_id = rp.id and l.entry_type = 'report_filed'
        )
        order by rp.created_at, rp.id
    loop
        perform public.append_log_entry(r.id, 'report_filed', public.build_report_log_payload(r));
    end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- anchor_snapshots + Merkle root
-- -----------------------------------------------------------------------------
create table if not exists public.anchor_snapshots (
    id uuid primary key default gen_random_uuid(),
    root_hash text not null,
    entry_count bigint not null,
    last_seq bigint not null,
    computed_at timestamptz not null default now(),
    anchor_method text not null default 'none' check (anchor_method in ('none', 'opentimestamps')),
    anchor_proof text null
);

alter table public.anchor_snapshots enable row level security;

drop policy if exists "Public read anchor_snapshots" on public.anchor_snapshots;
create policy "Public read anchor_snapshots"
    on public.anchor_snapshots for select
    to anon, authenticated
    using (true);

revoke all on public.anchor_snapshots from public, anon, authenticated;
grant select on public.anchor_snapshots to anon, authenticated;
grant select, insert, update on public.anchor_snapshots to service_role;

-- Merkle root over entry_hash values in seq order; pairwise sha256 of concatenated hex;
-- the last node is duplicated when a level has an odd count.
create or replace function public.compute_merkle_root(p_up_to_seq bigint default null)
returns text
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
    v_level text[];
    v_next text[];
    v_n int;
    v_i int;
begin
    select array_agg(entry_hash order by seq) into v_level
    from public.public_log
    where p_up_to_seq is null or seq <= p_up_to_seq;

    if v_level is null then
        return null;
    end if;

    while array_length(v_level, 1) > 1 loop
        v_n := array_length(v_level, 1);
        v_next := array[]::text[];
        v_i := 1;
        while v_i <= v_n loop
            v_next := v_next || public.sha256_hex(v_level[v_i] || coalesce(v_level[v_i + 1], v_level[v_i]));
            v_i := v_i + 2;
        end loop;
        v_level := v_next;
    end loop;

    return v_level[1];
end;
$$;

-- Service role only
create or replace function public.snapshot_log()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
    v_last bigint;
    v_count bigint;
    v_root text;
    v_row public.anchor_snapshots;
begin
    select max(seq), count(*) into v_last, v_count from public.public_log;
    if v_last is null then
        raise exception 'public_log is empty; nothing to snapshot';
    end if;
    v_root := public.compute_merkle_root(v_last);

    insert into public.anchor_snapshots (root_hash, entry_count, last_seq)
    values (v_root, v_count, v_last)
    returning * into v_row;

    return to_jsonb(v_row);
end;
$$;

revoke execute on function public.snapshot_log() from public, anon, authenticated;
grant execute on function public.snapshot_log() to service_role;

-- -----------------------------------------------------------------------------
-- Public RPCs (security invoker, stable)
-- -----------------------------------------------------------------------------
create or replace function public.get_receipt(p_report_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
    e public.public_log;
    v_filed timestamptz;
begin
    select * into e from public.public_log
    where report_id = p_report_id and entry_type = 'report_filed';
    if not found then
        return null;
    end if;

    v_filed := (e.payload->>'filed_at')::timestamptz;

    return jsonb_build_object(
        'report_id', e.report_id,
        'report', e.payload,
        'seq', e.seq,
        'entry_hash', e.entry_hash,
        'prev_hash', e.prev_hash,
        'filed_at', e.payload->>'filed_at',
        'sealed_at', public.iso_utc(e.created_at),
        'days_since_filing', greatest(0, floor(extract(epoch from (now() - v_filed)) / 86400))::int,
        'status', 'filed',
        'authority_response', null,
        'timeline', jsonb_build_array(
            jsonb_build_object('step', 'Report filed', 'at', e.payload->>'filed_at', 'sealed', true),
            jsonb_build_object('step', 'Fingerprint sealed in public log', 'at', public.iso_utc(e.created_at), 'sealed', true)
        ),
        -- Everything needed to recompute entry_hash independently
        'proof', jsonb_build_object(
            'entry_type', e.entry_type,
            'payload_canonical', e.payload::text,
            'sealed_at', public.iso_utc(e.created_at),
            'prev_hash', e.prev_hash,
            'entry_hash', e.entry_hash
        )
    );
end;
$$;

create or replace function public.verify_receipt(p_report_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
    e public.public_log;
    p public.public_log;
    v_has_prev boolean;
    v_ok boolean := true;
    v_bad text := 'This record or the log before it has been altered.';
begin
    select * into e from public.public_log
    where report_id = p_report_id and entry_type = 'report_filed';
    if not found then
        return jsonb_build_object('valid', false, 'message', 'No sealed record was found for this report.');
    end if;

    -- 1. own hash and payload binding
    if public.log_entry_hash(e.prev_hash, e.payload, e.entry_type, e.created_at) <> e.entry_hash
       or e.payload->>'report_id' <> e.report_id::text then
        v_ok := false;
    end if;

    -- 2. link to the previous entry (and that entry's own hash)
    select * into p from public.public_log where seq < e.seq order by seq desc limit 1;
    v_has_prev := found;
    if v_has_prev then
        if e.prev_hash <> p.entry_hash
           or public.log_entry_hash(p.prev_hash, p.payload, p.entry_type, p.created_at) <> p.entry_hash then
            v_ok := false;
        end if;
    elsif e.prev_hash <> repeat('0', 64) then
        v_ok := false;
    end if;

    if v_ok then
        return jsonb_build_object(
            'valid', true,
            'message', 'This record has not been changed since ' || to_char(e.created_at at time zone 'UTC', 'DD Mon YYYY') || '.'
        );
    end if;
    return jsonb_build_object('valid', false, 'message', v_bad);
end;
$$;

create or replace function public.verify_chain()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
    r public.public_log;
    v_expected_prev text := repeat('0', 64);
    v_checked bigint := 0;
begin
    for r in select * from public.public_log order by seq loop
        if r.prev_hash <> v_expected_prev
           or public.log_entry_hash(r.prev_hash, r.payload, r.entry_type, r.created_at) <> r.entry_hash then
            return jsonb_build_object('valid', false, 'entries_checked', v_checked, 'first_bad_seq', r.seq);
        end if;
        v_expected_prev := r.entry_hash;
        v_checked := v_checked + 1;
    end loop;
    return jsonb_build_object('valid', true, 'entries_checked', v_checked, 'first_bad_seq', null);
end;
$$;

create or replace function public.get_latest_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
    select to_jsonb(s) || jsonb_build_object(
        'entries_since_snapshot', (select count(*) from public.public_log l where l.seq > s.last_seq)
    )
    from public.anchor_snapshots s
    order by s.computed_at desc, s.id
    limit 1;
$$;

grant execute on function public.get_receipt(uuid) to anon, authenticated;
grant execute on function public.verify_receipt(uuid) to anon, authenticated;
grant execute on function public.verify_chain() to anon, authenticated;
grant execute on function public.get_latest_snapshot() to anon, authenticated;
grant execute on function public.compute_merkle_root(bigint) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- get_pharmacy_case: report counts per type for a pharmacy (last 90 days).
-- Input is the licence number (or the pharmacy name if no licence was given).
-- pharmacy_name is returned ONLY when threshold_met (>= 3 reports of the same type).
-- Counts are numbers of reports; reporters are not yet verified.
-- -----------------------------------------------------------------------------
create or replace function public.get_pharmacy_case(p_licence text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    c_window constant interval := interval '90 days';
    c_threshold constant int := 3;
    v_ref text := public.pharmacy_ref(p_licence);
    v_counts jsonb := '{}'::jsonb;
    v_total bigint := 0;
    v_max bigint := 0;
    v_met boolean;
    v_result jsonb;
    v_name text;
begin
    if v_ref is not null then
        select coalesce(jsonb_object_agg(t.report_type, t.c), '{}'::jsonb),
               coalesce(sum(t.c), 0),
               coalesce(max(t.c), 0)
        into v_counts, v_total, v_max
        from (
            select l.payload->>'report_type' as report_type, count(*) as c
            from public.public_log l
            where l.entry_type = 'report_filed'
              and l.payload->>'pharmacy_ref' = v_ref
              and (l.payload->>'filed_at')::timestamptz >= now() - c_window
            group by 1
        ) t;
    end if;

    v_met := v_max >= c_threshold;

    v_result := jsonb_build_object(
        'counts', v_counts,
        'total', v_total,
        'threshold_met', v_met,
        'window_days', 90,
        'note', 'Number of reports filed through MediCheck in the last 90 days. Reporters are not yet verified.'
    );

    if v_met then
        select r.pharmacy_name into v_name
        from public.public_log l
        join public.reports r on r.id = l.report_id
        where l.entry_type = 'report_filed' and l.payload->>'pharmacy_ref' = v_ref
        order by l.seq desc
        limit 1;
        v_result := v_result || jsonb_build_object('pharmacy_name', v_name);
    end if;

    return v_result;
end;
$$;

grant execute on function public.get_pharmacy_case(text) to anon, authenticated;
