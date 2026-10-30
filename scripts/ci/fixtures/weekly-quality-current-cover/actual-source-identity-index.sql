CREATE INDEX accounting_tournament_source_identity_keys_cover ON public.accounting_tournament_fee_sources USING btree (id) INCLUDE (tournament_id, rake_record_id);
