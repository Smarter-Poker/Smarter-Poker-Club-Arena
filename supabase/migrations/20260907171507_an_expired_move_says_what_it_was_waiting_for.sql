-- 20260907171507_an_expired_move_says_what_it_was_waiting_for.sql
--
-- AN EXPIRED MOVE SAYS WHAT IT WAS WAITING FOR.
--
-- Every other terminal state of a seat move carries a reason:
-- destination_unavailable, destination_full, player_not_seated, deadlock
-- detected. Expiry carried none. Measured over six hours on production: 29
-- moves expired with `note` NULL, against 76 cancellations that all said why.
--
-- It is the one outcome you most need explained, because three completely
-- different failures land in it and the row cannot tell them apart: the player
-- left before the hand boundary, the player busted and is in a rebuy window,
-- or the engine simply never executed a move it was handed. The first two are
-- ordinary. The third is an engine defect, and it has been invisible.
--
-- 10.86 rule 1: "I could not tell" is a distinct outcome and must have its own
-- name. Here it had no name at all.
--
-- HOW THIS IS APPLIED. fn_cash_cluster_tick is 37,872 characters and there is
-- exactly ONE expiry site in it. Rather than retype the function - which is how
-- a 37KB body acquires a typo nobody sees - this migration takes the definition
-- the previous migration installed and performs a single, asserted string
-- substitution on it. It fails if the search text is not found exactly once, so
-- it can never half-apply or silently no-op.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

DO $patch$
DECLARE
  v_old text;
  v_new text;
  v_find text;
  v_repl text;
  v_hits integer;
BEGIN
  v_old := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  v_find := '  UPDATE public.cash_seat_moves SET state = ''expired''
   WHERE game_id = g.id AND state = ''pending'' AND expires_at <= v_now;';

  v_repl := '  -- AN EXPIRED MOVE SAYS WHAT IT WAS WAITING FOR (2026-09-07). Three
  -- different failures land here and the row could not tell them apart.
  UPDATE public.cash_seat_moves m SET state = ''expired'',
         note = CASE
                  WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                                    WHERE ts.table_id = m.from_table_id
                                      AND ts.user_id = m.player_id AND ts.left_at IS NULL)
                    THEN ''player_left_before_boundary''
                  WHEN EXISTS (SELECT 1 FROM public.table_seats ts
                                WHERE ts.table_id = m.from_table_id
                                  AND ts.user_id = m.player_id AND ts.left_at IS NULL
                                  AND coalesce(ts.stack, 0) = 0)
                    THEN ''player_busted_before_boundary''
                  ELSE ''engine_did_not_execute_before_expiry''
                END
   WHERE m.game_id = g.id AND m.state = ''pending'' AND m.expires_at <= v_now;';

  SELECT count(*) INTO v_hits FROM regexp_matches(v_old, regexp_replace(v_find, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one expiry site in fn_cash_cluster_tick, found %', v_hits;
  END IF;

  v_new := replace(v_old, v_find, v_repl);
  IF v_new = v_old THEN
    RAISE EXCEPTION 'the substitution changed nothing';
  END IF;
  IF position('engine_did_not_execute_before_expiry' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement text is not in the new definition';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('engine_did_not_execute_before_expiry' in v_def) = 0 THEN
    RAISE EXCEPTION 'the live function does not carry the expiry note';
  END IF;
  IF position('UPDATE public.cash_seat_moves SET state = ''expired''' in v_def) <> 0 THEN
    RAISE EXCEPTION 'the old noteless expiry is still in the live function';
  END IF;
END $assert$;

-- CREATE OR REPLACE keeps the grants a live function has; restating them
-- protects the next database this file is replayed into. The controller tick is
-- engine-only and no browser role has ever been able to reach it.
REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

COMMIT;
