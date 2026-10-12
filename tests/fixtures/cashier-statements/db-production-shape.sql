-- The production shape the statement reads and the 2026-09-23 fixture
-- predates, for scripts/ci/test-cashier-statement-db-postgres.py: the
-- real-name columns fn_arena_name compares against, public.fn_arena_name
-- (production's pg_get_functiondef text, md5 2b7a84c23987cb7c923dde302f9ea998,
-- read 2026-10-09 and again 2026-10-11), and production's statement indexes
-- (pg_get_indexdef, read 2026-10-09; re-read read-only 2026-10-11 after
-- #6615 installed): the per-user receipt indexes with their INCLUDE columns,
-- the receipt and ledger totals covers, #6615's ledger direction cover, the
-- bounded idempotency arm and the type lookup.
ALTER TABLE public.profiles ADD COLUMN first_name text, ADD COLUMN last_name text, ADD COLUMN full_name text;
CREATE OR REPLACE FUNCTION public.fn_arena_name(p_alias text, p_username text, p_display_name text, p_first_name text, p_last_name text, p_full_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH real_name AS (
    SELECT COALESCE(
             NULLIF(btrim(p_full_name), ''),
             NULLIF(btrim(concat_ws(' ',
               NULLIF(btrim(p_first_name), ''),
               NULLIF(btrim(p_last_name),  ''))), '')
           ) AS rn
  )
  SELECT COALESCE(
           NULLIF(btrim(p_alias), ''),
           NULLIF(btrim(p_username), ''),
           CASE
             WHEN NULLIF(btrim(p_display_name), '') IS NOT NULL
              AND (SELECT rn FROM real_name) IS NOT NULL
              AND lower(btrim(p_display_name)) = lower((SELECT rn FROM real_name))
             THEN NULL
             ELSE NULLIF(btrim(p_display_name), '')
           END,
           'Player')
$function$;
DROP INDEX public.chip_transactions_club_from_created_idx, public.chip_transactions_club_to_created_idx;
CREATE INDEX chip_transactions_club_from_created_idx ON public.chip_transactions USING btree (club_id, from_user_id, created_at DESC) INCLUDE (amount, transaction_type, to_user_id, notes);
CREATE INDEX chip_transactions_club_to_created_idx ON public.chip_transactions USING btree (club_id, to_user_id, created_at DESC) INCLUDE (amount, transaction_type, from_user_id, notes);
CREATE INDEX idx_chip_tx_club_time_totals ON public.chip_transactions USING btree (club_id, created_at DESC) INCLUDE (amount, from_user_id, to_user_id);
CREATE INDEX idx_chip_tx_club_time_idempotency_key ON public.chip_transactions USING btree (club_id, created_at, ((metadata ->> 'idempotency_key'::text))) WHERE (metadata ? 'idempotency_key'::text);
CREATE INDEX idx_chip_tx_type_user_created ON public.chip_transactions USING btree (transaction_type, to_user_id, created_at);
CREATE INDEX idx_chip_ledger_cashier_totals_cover ON public.chip_ledger USING btree (club_id, created_at DESC) INCLUDE (id, amount, from_entity_id, to_entity_id) WHERE ((status = 'posted'::text) AND (category = ANY (ARRAY['buyin'::text, 'addon'::text, 'rebuy'::text, 'tournament_prize'::text, 'bounty'::text, 'refund'::text, 'spin_entry'::text, 'spin_prize'::text, 'promo'::text, 'promo_send'::text, 'treasury_transfer'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'overlay'::text, 'reversal'::text, 'correction'::text, 'adjustment'::text, 'leaderboard_payout'::text])));
CREATE INDEX idx_chip_ledger_cashier_direction_totals ON public.chip_ledger USING btree (club_id, created_at DESC) INCLUDE (amount, from_entity_id, to_entity_id) WHERE ((status = 'posted'::text) AND (category = ANY (ARRAY['buyin'::text, 'addon'::text, 'rebuy'::text, 'tournament_prize'::text, 'bounty'::text, 'refund'::text, 'spin_entry'::text, 'spin_prize'::text, 'promo'::text, 'promo_send'::text, 'treasury_transfer'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'overlay'::text, 'reversal'::text, 'correction'::text, 'adjustment'::text, 'leaderboard_payout'::text])));
