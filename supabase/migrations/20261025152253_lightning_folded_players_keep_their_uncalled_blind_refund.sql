-- 20261025152253_lightning_folded_players_keep_their_uncalled_blind_refund.sql
-- Version reserved by scripts/reserve-migration-version.sh.
--
-- A folded forced bet may exceed the last caller's entire stack. The normal
-- HandController returns that UNCALLED excess, including to a folded blind,
-- and Lightning already sends it in hand_row.returned_uncalled. The SQL fold
-- check ignored that existing fact and froze FLO8 hand
-- 737715a1-c486-45dc-ad1c-279b1215752c on 2026-10-25: 0.25 committed,
-- 0.24 finally contributed, 0.01 returned, zero won. Conservation held.
--
-- Accept only the declared return of the player's own unmatched chips:
-- final contribution + returned = original committed_at_fold;
-- final stack = original stack - committed_at_fold + returned; won = 0.
-- Missing or mismatched refunds and awards to a folder still freeze.
-- No settlement, fold commitment, chip, seat, wallet or old hand is rewritten.
-- The original atomic physical settlement and request receipt remain owners.
--
-- Both exact deployed predecessors are supported: the maintained zero-payer
-- producer, and that same producer with the already-installed private stats
-- facts block. Replace only the identical fold predicate; preserve that block.
-- One short function-only transaction; no lock on a hot table. Existing engine
-- callers already send returned_uncalled, so no engine activation is needed.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $patch$
DECLARE
  src text := pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure);
  old_clause constant text := $old$WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
                  WHERE jsonb_typeof(x -> 'committed_at_fold') = 'number'
                    AND (x ->> 'stack_after')::numeric
                        IS DISTINCT FROM (x ->> 'stack_before')::numeric - (x ->> 'committed_at_fold')::numeric)
      THEN 'fold_commitment'$old$;
  new_clause constant text := $new$WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
                  WHERE jsonb_typeof(x -> 'committed_at_fold') = 'number'
                    AND (
                      (x ->> 'won')::numeric IS DISTINCT FROM 0::numeric
                      OR (x ->> 'contributed')::numeric
                           + coalesce((v_row_in -> 'returned_uncalled' ->> (x ->> 'player_id'))::numeric, 0)
                         IS DISTINCT FROM (x ->> 'committed_at_fold')::numeric
                      OR (x ->> 'stack_after')::numeric
                         IS DISTINCT FROM (x ->> 'stack_before')::numeric - (x ->> 'committed_at_fold')::numeric
                           + coalesce((v_row_in -> 'returned_uncalled' ->> (x ->> 'player_id'))::numeric, 0)
                    ))
      THEN 'fold_commitment'$new$;
BEGIN
  IF md5(src) NOT IN ('0670ed75762f05e7ad3346a1c95e84dc', 'e6cc04d7031ed3fa1454df89c45533a1') THEN
    RAISE EXCEPTION 'lightning_fold_refund_preimage_changed: %', md5(src) USING ERRCODE = '55000';
  END IF;
  IF (length(src)-length(replace(src,old_clause,'')))/length(old_clause) <> 1 THEN
    RAISE EXCEPTION 'lightning_fold_refund_predicate_not_unique' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(src,old_clause,new_clause);
END $patch$;

-- Preserve service-only settlement authority; no new callable door.
REVOKE ALL ON FUNCTION public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb) TO service_role;

-- @live-proof: md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)) IN ('769f2b46a70fb0a035777e1ceff5bad7','d66cc7cdcfd286fbed16127a6798931d') AND NOT has_function_privilege('authenticated','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','EXECUTE') AND has_function_privilege('service_role','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','EXECUTE')

COMMIT;
