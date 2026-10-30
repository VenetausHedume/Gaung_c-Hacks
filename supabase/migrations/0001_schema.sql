-- =============================================================================
-- MediCheck Migration 0001: Core Schema & Indexes
-- =============================================================================

-- Enable required extensions
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- 1. brand_products
create table if not exists public.brand_products (
    id uuid primary key default gen_random_uuid(),
    brand_name text not null,
    manufacturer text not null,
    salt_normalized text not null,
    strength text not null,
    dosage_form text not null,
    pack_size numeric not null check (pack_size > 0),
    pack_unit text not null,
    printed_mrp numeric not null check (printed_mrp >= 0),
    price_per_unit numeric not null check (price_per_unit >= 0),
    mrp_source text,
    mrp_date date,
    schedule_status text not null default 'unknown'
        check (schedule_status in ('scheduled', 'non_scheduled', 'unknown')),
    notes text,
    created_at timestamptz not null default now()
);

-- 2. barcodes
create table if not exists public.barcodes (
    barcode text primary key,
    barcode_type text,
    brand_product_id uuid not null references public.brand_products(id) on delete cascade,
    pack_size numeric,
    source text,
    notes text,
    created_at timestamptz not null default now()
);

-- 3. ceiling_prices (NPPA DPCO ceiling prices)
create table if not exists public.ceiling_prices (
    id uuid primary key default gen_random_uuid(),
    salt_normalized text not null,
    strength text not null,
    dosage_form text not null,
    pack_unit text not null,
    ceiling_price numeric not null check (ceiling_price >= 0),
    gst_note text,
    effective_date date,
    notification_ref text,
    source_url text,
    source_date date,
    notes text,
    created_at timestamptz not null default now()
);

-- 4. nsq_alerts (CDSCO / State FDA Not of Standard Quality & Spurious alerts)
create table if not exists public.nsq_alerts (
    id uuid primary key default gen_random_uuid(),
    alert_month text not null,
    category text not null check (category in ('NSQ', 'SPURIOUS')),
    drug_name text not null,
    salt_normalized text not null,
    brand_name text,
    batch_number text not null,
    batch_key text generated always as (upper(regexp_replace(batch_number, '\s', '', 'g'))) stored,
    manufacturer text,
    manufacturing_date text,
    expiry_date text,
    failure_reason text,
    testing_lab text,
    source_url text,
    source_date date,
    notes text,
    created_at timestamptz not null default now()
);

-- 5. jan_aushadhi_products (PMBJP generic products)
create table if not exists public.jan_aushadhi_products (
    id uuid primary key default gen_random_uuid(),
    ja_product_code text not null unique,
    generic_name text not null,
    salt_normalized text not null,
    strength text not null,
    dosage_form text not null,
    pack_size numeric not null check (pack_size > 0),
    pack_unit text not null,
    mrp numeric not null check (mrp >= 0),
    price_per_unit numeric not null check (price_per_unit >= 0),
    source_url text,
    source_date date,
    notes text,
    created_at timestamptz not null default now()
);

-- 6. authorities (NPPA, CDSCO, State FDAs)
create table if not exists public.authorities (
    id uuid primary key default gen_random_uuid(),
    authority_name text not null,
    authority_type text not null,
    state text,
    complaint_url text,
    email text,
    phone text,
    handles text,
    source_url text,
    source_date date,
    notes text,
    created_at timestamptz not null default now()
);

-- 7. data_versions (dataset freshness tracking)
create table if not exists public.data_versions (
    dataset_name text primary key,
    loaded_on timestamptz not null default now(),
    source_date date not null,
    row_count integer not null default 0,
    notes text,
    created_at timestamptz not null default now()
);

-- 8. reports (patient-submitted issue reports)
create table if not exists public.reports (
    id uuid primary key default gen_random_uuid(),
    brand_product_id uuid references public.brand_products(id) on delete set null,
    pharmacy_name text not null
        check (char_length(trim(pharmacy_name)) between 1 and 200),
    pharmacy_licence_no text
        check (pharmacy_licence_no is null or char_length(pharmacy_licence_no) <= 100),
    report_type text not null
        check (report_type in (
            'sold_above_mrp',
            'price_above_ceiling',
            'out_of_stock',
            'suspect_batch_or_pack',
            'bill_refused'
        )),
    description text not null
        check (char_length(trim(description)) between 1 and 2000),
    batch_number text
        check (batch_number is null or char_length(batch_number) <= 100),
    created_at timestamptz not null default now()
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Matching key (salt_normalized, strength, dosage_form) on every table that has all 3 columns
create index if not exists idx_brand_products_match_key
    on public.brand_products (lower(salt_normalized), lower(strength), lower(dosage_form));

create index if not exists idx_brand_products_match_key_exact
    on public.brand_products (salt_normalized, strength, dosage_form);

create index if not exists idx_ceiling_prices_match_key
    on public.ceiling_prices (lower(salt_normalized), lower(strength), lower(dosage_form));

create index if not exists idx_ceiling_prices_match_key_exact
    on public.ceiling_prices (salt_normalized, strength, dosage_form);

create index if not exists idx_jan_aushadhi_match_key
    on public.jan_aushadhi_products (lower(salt_normalized), lower(strength), lower(dosage_form));

create index if not exists idx_jan_aushadhi_match_key_exact
    on public.jan_aushadhi_products (salt_normalized, strength, dosage_form);

-- Trigram indexes for fuzzy search on brand_products
create index if not exists idx_brand_products_brand_name_trgm
    on public.brand_products using gin (brand_name gin_trgm_ops);

create index if not exists idx_brand_products_salt_trgm
    on public.brand_products using gin (salt_normalized gin_trgm_ops);

-- Additional lookup indexes
create index if not exists idx_barcodes_brand_product_id
    on public.barcodes (brand_product_id);

create index if not exists idx_nsq_alerts_batch_key
    on public.nsq_alerts (batch_key);

create index if not exists idx_nsq_alerts_salt_mfr
    on public.nsq_alerts (lower(salt_normalized), lower(manufacturer));

create index if not exists idx_authorities_state
    on public.authorities (lower(state));
