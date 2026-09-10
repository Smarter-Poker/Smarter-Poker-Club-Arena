-- Expansion only; no money authority is enabled. Run outside a transaction.
CREATE INDEX CONCURRENTLY ca_cash_bank_legacy_record_key
 ON public.rake_records((md5('rake:'||table_id::text||':'||(metadata->>'hand_number'))::uuid))
 WHERE hand_id IS NULL;
