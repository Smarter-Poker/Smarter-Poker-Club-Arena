-- A Diamond bounty MTT rebuy settles the bounty owed for the bust before it
-- re-enters the player (process_tournament_rebuy -> fn_ca_settle_bounty_rebuy_generation_v1
-- -> fn_collect_bounty -> fn_credit_and_log -> fn_poker_diamond_tournament_pay
-- -> add_diamonds_to_balance). fn_guard_profile_privileged_columns admitted the
-- Diamond tournament charge and refund doors but not the payout door, so every
-- such rebuy under the player's JWT failed with
--   42501 profiles.diamonds is server-managed and cannot be modified by role postgres
-- (client_error_events TournamentService.Rebuy_RPC_outcome_unconfirmed, 2026-10-22).
--
-- fn_poker_diamond_tournament_pay is SECURITY DEFINER and executable only by
-- postgres, so no client can call it directly; naming it here admits exactly the
-- journaled payout that the server already decided, nothing else.
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  v_anchor text := $a$OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_refund[(]'$a$;
  v_new text;
BEGIN
  IF position('fn_poker_diamond_tournament_pay[(]' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_guard_profile_privileged_columns no longer names the Diamond tournament refund door';
  END IF;
  v_new := replace(v_def, v_anchor,
    v_anchor || E'\n     -- A Diamond bounty paid to the winner (also from a rebuy that settles the bust first).\n'
             || $a$     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_pay[(]'$a$);
  EXECUTE v_new;
END
$mig$;
