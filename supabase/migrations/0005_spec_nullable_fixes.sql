-- =============================================================================
-- MediCheck Migration 0005: Spec Nullable Alignment (Idempotent)
-- Aligns column nullability with Data Sourcing Spec sections 3.2 and 3.3:
--   1. nsq_alerts.salt_normalized is optional ("Fill if clearly identifiable")
--   2. jan_aushadhi_products.ja_product_code is optional ("Official code if given")
-- =============================================================================

alter table public.nsq_alerts
    alter column salt_normalized drop not null;

alter table public.jan_aushadhi_products
    alter column ja_product_code drop not null;
