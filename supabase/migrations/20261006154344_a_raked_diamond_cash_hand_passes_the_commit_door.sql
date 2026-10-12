-- 20261006154344_a_raked_diamond_cash_hand_passes_the_commit_door.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS FOUND (2026-10-06, before the Diamond cash switch reopens).
--
-- Dan opened Diamond cash games for his certified run, and authorised
-- reopening them on 2026-10-06 ("YES, GO AHEAD AND PROCEED") once a Diamond
-- cash hand is proved to settle with its rake through the real path. The
-- engine now sends the settler's three rake facts (#6268) and prices the hand
-- by the owner's settings (#6288); engine.smarter.poker/health serves release
-- 9fdbf692, which contains both.
--
-- The proof was run before opening anything: one real NLH 1/2 hand, played by
-- the engine's own HandController under production's ca_diamond_economics rows
-- and handed to the engine's own postHandTasks and logHandHistory, whose exact
-- request (pot 400, flop seen, rake 15, the three facts on both seats, a null
-- chip rake obligation) was replayed against production in ONE ROLLED-BACK
-- transaction through the engine's two calls: fn_ca_retain_hand_submission,
-- then fn_ca_commit_hand_submission. The buy-ins, the lease, the hand number
-- and the Diamond settler all accepted it - the settler recomputed the same
-- 15 - and then the 12-argument door refused the whole hand:
--
--   atomic hand commit refused (post_commit_fee_mismatch)
--
-- THE CAUSE, read from the live body of fn_ca_commit_hand_settlement. Two of
-- its rules contradict each other for every raked Diamond cash hand:
--
--   1. The Diamond refusal (DIAMOND PHASE 8) requires a Diamond cash hand's
--      p_post_commit_obligations->'rake' to be null. Correctly: that object
--      drives the CHIP rake leg (rake_records, club distribution), which a
--      Diamond must never reach.
--   2. The fee binding requires (p_rake > 0) to equal "a rake object is
--      present", and the six clauses after it compare that object's amount,
--      bbj, pot, num_players, contributions and returned_uncalled to the hand.
--
-- With p_rake > 0, rule 1 forces the object to null and rule 2 then refuses
-- the hand. Before 20261005183028 every Diamond hand had p_rake = 0, so the
-- contradiction could not be reached; since #6288 every Diamond hand that
-- reaches a flop with a rakeable pot reaches it. With cash open, every such
-- hand would have been refused after the engine had already played it.
--
-- THE FIX, AT THE LINE. The seven chip-rake clauses bind a CHIP hand exactly
-- as before; they are wrapped in NOT v_diamond, the door's own flag for a
-- Diamond cash table (asset diamonds, no tournament). A Diamond cash hand's
-- rake is bound where it is settled: fn_poker_diamond_settle_cash_hand
-- recomputes it from the owner's published settings, refuses any other number
-- by name, and writes its WEIGHTED_CONTRIBUTED accrual inside this same
-- transaction, asserting the shares sum to it. The Diamond rule here is the
-- null chip object, stated again so the check stays total.
--
-- WHAT DOES NOT CHANGE. For a chip hand, and for every tournament hand
-- (Diamond tournaments included - v_diamond is false for them), the condition
-- is logically identical: NOT false AND (X) is X. The BBJ clauses are not
-- touched: a Diamond hand's p_bbj is refused non-zero by its settler and its
-- bbj_contribution object must be null, so (0 > 0) IS DISTINCT FROM false is
-- false, exactly as today. No other function changes. No switch moves:
-- cash_games_enabled is read false and stays false here; reopening it is its
-- own migration, applied only after this one is live.
--
-- METHOD. The live body is pinned by md5 and edited in place by two exact
-- anchors, each required to occur once; the derived post-image is pinned too,
-- and owner, SECURITY DEFINER, settings and grants must read back unchanged
-- (the estate's pg_temp.ca_audit_subst). fn_ca_commit_hand_settlement is not
-- on fn_ca_guard_watchlist(), so no redefinition is declared.
--
-- PINNED LIVE md5(pg_get_functiondef(...)), re-read 2026-10-07 after
-- 20261006184554_a_retired_cash_hand_keeps_its_original_custody was applied.
-- That migration edits this same door in its time-bank loop, nowhere near
-- the two anchors below, so only the pins move: both anchors still occur
-- exactly once, and the edit is the same edit.
--   public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)
--     before 650b8ff04411a9974ae96ef245645705
--     after  ad4eadeb4df8113db0ba2b598d219aaf
--
-- @live-proof: (SELECT position('OR (v_diamond' in pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure)) > 0 AND position('IF (NOT v_diamond AND (' in pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure)) > 0)

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

-- The door, edited at its two anchors.
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
  '650b8ff04411a9974ae96ef245645705', 'ad4eadeb4df8113db0ba2b598d219aaf',
  ARRAY[$o$  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
$o$,
$o$             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
$o$],
  ARRAY[$n$  IF (NOT v_diamond AND (
       (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
$n$,
$n$             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )))
     /* A RAKED DIAMOND CASH HAND IS NOT A CHIP RAKE OBLIGATION (2026-10-06).
        The seven clauses above bind a CHIP rake to the chip post-commit leg
        that pays it out, and they bind it unchanged. A Diamond cash hand has
        no such leg: fn_poker_diamond_settle_cash_hand recomputes its rake
        from the owner's settings and accrues it per payer inside this same
        transaction, and the Diamond refusal above requires its chip rake
        object to be null. Bound to a chip object as well, every raked
        Diamond hand refused here as post_commit_fee_mismatch. Its own rule,
        the null object, is stated again here so this check stays total. */
     OR (v_diamond
         AND jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null')
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
$n$]);

-- Nothing else moved: the switch is where it was found, and this transaction
-- changed exactly the one body it names.
DO $check$
BEGIN
  IF (SELECT cash_games_enabled FROM public.ca_arena_settings WHERE id = 1) IS NOT FALSE THEN
    RAISE EXCEPTION 'cash_games_enabled is not false; this migration opens nothing and expects it closed';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure))
     <> 'ad4eadeb4df8113db0ba2b598d219aaf' THEN
    RAISE EXCEPTION 'the commit door does not read back as the derived post-image';
  END IF;
END
$check$;

COMMIT;
