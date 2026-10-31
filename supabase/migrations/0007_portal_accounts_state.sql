-- =============================================================================
-- MediCheck Migration 0007: Portal backend
--   1. portal_accounts      - login accounts for citizens / pharmacies / government
--                             (pharmacy + government rows are created MANUALLY by the
--                              MediCheck team after identity verification - no self-signup)
--   2. portal_org_requests  - "please call me to verify my organisation" requests
--   3. portal_state         - shared live case state (citizen reports, pharmacy
--                             verification workflow, government updates)
--   4. portal_login / portal_register_citizen RPCs (bcrypt via pgcrypto)
--   5. evidence_proofs storage bucket (bill photos, proofs, billing exports)
-- All tables are locked down: only the server (service_role key) can touch them.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Accounts
-- -----------------------------------------------------------------------------
create table if not exists public.portal_accounts (
    id            uuid primary key default gen_random_uuid(),
    role          text not null check (role in ('citizen', 'pharmacy', 'gov')),
    identifier    text not null check (char_length(btrim(identifier)) between 3 and 200),
    display_name  text not null check (char_length(btrim(display_name)) between 2 and 200),
    phone         text,
    password_hash text not null,
    profile       jsonb not null default '{}'::jsonb,
    is_active     boolean not null default true,
    created_at    timestamptz not null default now()
);

create unique index if not exists uq_portal_accounts_role_identifier
    on public.portal_accounts (role, lower(identifier));
create unique index if not exists uq_portal_accounts_citizen_phone
    on public.portal_accounts (lower(phone)) where role = 'citizen' and phone is not null;

alter table public.portal_accounts enable row level security;
revoke all on public.portal_accounts from anon, authenticated;
grant all on public.portal_accounts to service_role;

-- -----------------------------------------------------------------------------
-- 2. Organisation (pharmacy / government) onboarding requests
-- -----------------------------------------------------------------------------
create table if not exists public.portal_org_requests (
    id             uuid primary key default gen_random_uuid(),
    role           text not null check (role in ('pharmacy', 'gov')),
    org_name       text not null,
    contact_person text not null,
    phone          text not null,
    area           text not null,
    status         text not null default 'new' check (status in ('new', 'called', 'approved', 'rejected')),
    created_at     timestamptz not null default now()
);

alter table public.portal_org_requests enable row level security;
revoke all on public.portal_org_requests from anon, authenticated;
grant all on public.portal_org_requests to service_role;

-- -----------------------------------------------------------------------------
-- 3. Shared live portal state (single JSON document, written only by the server)
-- -----------------------------------------------------------------------------
create table if not exists public.portal_state (
    id         text primary key,
    state      jsonb not null,
    updated_at timestamptz not null default now()
);

alter table public.portal_state enable row level security;
revoke all on public.portal_state from anon, authenticated;
grant all on public.portal_state to service_role;

-- -----------------------------------------------------------------------------
-- 4. Auth RPCs (callable ONLY with the server's service_role key)
-- -----------------------------------------------------------------------------
create or replace function public.portal_login(p_role text, p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    a public.portal_accounts%rowtype;
    ident text := lower(btrim(coalesce(p_identifier, '')));
begin
    if p_role not in ('citizen', 'pharmacy', 'gov') or ident = '' or coalesce(p_password, '') = '' then
        return null;
    end if;

    select * into a
    from public.portal_accounts
    where role = p_role
      and is_active
      and (lower(identifier) = ident or lower(coalesce(phone, '')) = ident)
    limit 1;

    if not found then
        return null;
    end if;

    if a.password_hash <> crypt(p_password, a.password_hash) then
        return null;
    end if;

    return jsonb_build_object(
        'user_id', a.id,
        'role', a.role,
        'display_name', a.display_name,
        'identifier', a.identifier,
        'profile', a.profile
    );
end;
$$;

create or replace function public.portal_register_citizen(p_name text, p_phone text, p_email text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_id uuid;
    v_email text := lower(btrim(coalesce(p_email, '')));
    v_phone text := btrim(coalesce(p_phone, ''));
begin
    if char_length(btrim(coalesce(p_name, ''))) < 2 then
        raise exception 'Name is required' using errcode = '22023';
    end if;
    if v_email = '' or position('@' in v_email) = 0 then
        raise exception 'A valid email is required' using errcode = '22023';
    end if;
    if char_length(coalesce(p_password, '')) < 8 then
        raise exception 'Password must be at least 8 characters' using errcode = '22023';
    end if;

    insert into public.portal_accounts (role, identifier, display_name, phone, password_hash)
    values ('citizen', v_email, btrim(p_name), nullif(v_phone, ''), crypt(p_password, gen_salt('bf')))
    returning id into v_id;

    return jsonb_build_object('user_id', v_id, 'display_name', btrim(p_name), 'identifier', v_email);
exception
    when unique_violation then
        raise exception 'already registered' using errcode = '23505';
end;
$$;

revoke execute on function public.portal_login(text, text, text) from public, anon, authenticated;
revoke execute on function public.portal_register_citizen(text, text, text, text) from public, anon, authenticated;
grant execute on function public.portal_login(text, text, text) to service_role;
grant execute on function public.portal_register_citizen(text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 5. Storage bucket for proofs (public read by URL; uploads go through the server)
-- -----------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
        insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        values (
            'evidence_proofs', 'evidence_proofs', true, 10485760,
            array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv']
        )
        on conflict (id) do update
            set allowed_mime_types = excluded.allowed_mime_types,
                file_size_limit = excluded.file_size_limit;
    end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Starter accounts for the live demo.
--    Pharmacy and government accounts are normally created by the MediCheck team after
--    verifying the organisation by phone. CHANGE OR DELETE THESE before real launch:
--      delete from public.portal_accounts where identifier in ('sundar@medicals.in','bbmp@karnataka.gov.in');
--    To add a real organisation later:
--      insert into public.portal_accounts (role, identifier, display_name, password_hash)
--      values ('pharmacy', 'owner@example.com', 'Shop Name', crypt('a-strong-password', gen_salt('bf')));
-- -----------------------------------------------------------------------------
insert into public.portal_accounts (role, identifier, display_name, password_hash, profile)
values
    ('pharmacy', 'sundar@medicals.in', 'Sundar Medicals', crypt('Pharmacy@123', gen_salt('bf')),
        '{"licence_no": "KA-BLR-KOR-001"}'::jsonb),
    ('gov', 'bbmp@karnataka.gov.in', 'BBMP Health Department', crypt('Gov@12345', gen_salt('bf')),
        '{"agency": "BBMP Health Department"}'::jsonb)
on conflict (role, lower(identifier)) do nothing;
