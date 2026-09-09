-- 20260909071226_the_rebuy_chain_lost_two_links.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  TWO LINKS FELL OUT OF THE REBUY CHAIN, AND ONE OF THEM WAS THE CLEAN-UP
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `process_tournament_rebuy` is a stack of wrappers, each one renaming its
-- predecessor to `..._before_<what_it_added>` and calling it. Read live today,
-- the chain is:
--
--   process_tournament_rebuy
--     -> _before_maintenance_announcement_gate
--         -> _before_one_minute_addon
--             -> _before_atomic_live_seat_lock          (the core)
--
-- and TWO functions are stranded, called by nothing at all:
--
--   _before_atomic_pool_gate  ->  _before_bounty_guard_20260907
--                                    -> _before_one_minute_addon
--
-- `_before_maintenance_announcement_gate` (added 2026-09-08 by
-- 20260908042800) re-implemented the lifecycle/clock gate itself and then
-- called `_before_one_minute_addon` directly, with this reasoning in its body:
--
--     /* Call the audited money core directly. The superseded one-minute
--        wrapper is retained under its historical name but had closed rebuys at
--        the base level even during the add-on clock. ... */
--
-- The clock fix was right. What went with it was not intended: `_before_one_-
-- minute_addon` is not the core, it is a LOWER wrapper, and jumping to it drops
-- the two layers above it. Everything those layers did stopped happening:
--
--   1. `fn_after_tournament_rebuy` - its ONLY caller is `_before_atomic_pool_-
--      gate`. It resolves the player's pending knockout candidate to
--      'rebought' and clears `rebuy_prompt_until`.
--   2. The bounty guard: "Bounty Settlement Pending - Rebuy Or Re-Entry Cannot
--      Replace This Entry Generation Yet".
--   3. "A Zero-Stack Bounty Entry Cannot Take An Add-On".
--   4. "Bubble Protection Already Paid - This Result Cannot Be Resurrected".
--   5. `fn_emit_tournament_manager_wake` after a successful purchase.
--
-- MEASURED ON PRODUCTION 2026-09-09 07:0x, across every RUNNING tournament.
-- `rebuy_prompt_until` is cleared by exactly one statement on the platform, the
-- last line of `fn_after_tournament_rebuy`:
--
--     rebought players whose prompt is STILL SET : 70
--     rebought players whose prompt was cleared  :  1
--
-- That is what a function nobody calls looks like. Alongside it, 147 entrants
-- were `playing` with no seat and 57 of those were holding chips - the
-- seatless-phantom population `poker_tournament_seatless_phantoms` counts - and
-- their knockout candidates stayed `pending` for ever because the one thing
-- that resolves them was unreachable.
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--
-- GUARD 1 re-links the chain: `_before_maintenance_announcement_gate` calls
-- `_before_atomic_pool_gate` instead of `_before_one_minute_addon`. Its own
-- lifecycle/clock gate still runs first and still passes the authoritative
-- `v_t.current_level` down, so the 2026-09-08 clock fix is preserved exactly -
-- `_before_atomic_pool_gate` forwards `p_current_level` unchanged, and
-- `_before_one_minute_addon` is still reached underneath. Nothing is bypassed
-- and nothing is re-ordered; two layers are put back where they belong.
--
-- Every restored layer is strictly MORE restrictive - four extra refusals - plus
-- one extra action that only resolves rows and clears a prompt. It cannot pay
-- anyone more, credit any extra chips, or open any window that was closed.
--
-- GUARD 2 removes the one way the restored layer could hurt a player. As
-- written, `fn_after_tournament_rebuy` RAISES `integrity_constraint_violation`
-- when a player carries more than one unresolved knockout generation - and it
-- runs AFTER the wallet debit and the chip credit, in the same transaction, so
-- the raise rolls the whole rebuy back. Re-linking the chain without this would
-- turn a dormant refusal into a live one that takes a player's rebuy away.
--
-- The correct reading is already written down, in
-- `fn_eliminate_tournament_player_atomic` earlier today:
--
--     MORE THAN ONE PENDING GENERATION IS A REBUY, NOT AN AMBIGUITY. The unique
--     constraint is (tournament_id, eliminated_user_id, seat_joined_at), so two
--     pending rows for one player are two DIFFERENT seat generations: the
--     player busted, bought back in, took a new chair and busted again. The
--     older generation is therefore settled by definition - it is what
--     'rebought' means.
--
-- So this applies the same rule in the same words: resolve every pending
-- generation rather than refusing. The money side is unaffected, because the
-- bounty guard restored by GUARD 1 sits ABOVE this and still refuses a rebuy
-- while the latest generation's bounty obligation is unsettled.
--
-- HOW THE EDIT IS MADE. Both functions are read LIVE with pg_get_functiondef
-- and changed by literal replace, with the anchor asserted first, so a body
-- that has moved on since this was written aborts rather than being silently
-- rewritten from a stale copy. Established by
-- 20260828041248_the_union_law_check_follows_the_money.sql.

BEGIN;

-- ── GUARD 2 first: make the restored layer safe before it is reachable ─────
DO $guard2$
DECLARE
  v_def text;
  v_new text;
  v_anchor text := 'RAISE EXCEPTION ''rebuy has % unresolved knockout generations for tournament %, user %''';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_after_tournament_rebuy';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_after_tournament_rebuy is missing; refusing to guess at its body';
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_after_tournament_rebuy no longer raises on multiple generations; the body has moved on and this edit must be rewritten against it';
  END IF;
  -- Sibling landmarks: prove this is the function we think it is before editing.
  IF position('state=''rebought''' IN v_def) = 0
     OR position('rebuy_prompt_until=NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_after_tournament_rebuy is missing its rebought/prompt statements; refusing to edit';
  END IF;

  v_new := replace(
    v_def,
    '  IF v_count>1 THEN
    RAISE EXCEPTION ''rebuy has % unresolved knockout generations for tournament %, user %'',
      v_count,p_tournament_id,p_user_id USING ERRCODE=''integrity_constraint_violation'';
  END IF;
  IF v_count=1 THEN
    UPDATE public.tournament_knockout_candidates
       SET state=''rebought'',resolved_at=clock_timestamp()
     WHERE id=v_candidate;
  END IF;',
    '  -- MORE THAN ONE PENDING GENERATION IS A REBUY, NOT AN AMBIGUITY
  -- (2026-09-09, the same rule fn_eliminate_tournament_player_atomic states).
  -- The unique constraint is (tournament_id, eliminated_user_id,
  -- seat_joined_at), so two pending rows for one player are two DIFFERENT seat
  -- generations: busted, bought back in, took a new chair, busted again. Every
  -- one of them is historical the moment this rebuy commits - that is what
  -- ''rebought'' means - so all of them resolve.
  --
  -- This used to RAISE, and it runs AFTER the wallet debit and the chip credit
  -- in the same transaction, so the raise rolled the whole rebuy back and the
  -- player could never buy in again. The bounty guard one layer above still
  -- refuses a rebuy while the latest generation owes an unsettled bounty, so
  -- nothing here decides money.
  IF v_count>0 THEN
    UPDATE public.tournament_knockout_candidates
       SET state=''rebought'',resolved_at=COALESCE(resolved_at,clock_timestamp())
     WHERE tournament_id=p_tournament_id
       AND eliminated_user_id=p_user_id
       AND state=''pending'';
  END IF;'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'fn_after_tournament_rebuy replacement matched nothing; aborting rather than shipping an unchanged body';
  END IF;
  EXECUTE v_new;
END;
$guard2$;

-- ── GUARD 1: put the two dropped links back in the chain ───────────────────
DO $guard1$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'process_tournament_rebuy_before_maintenance_announcement_gate';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'process_tournament_rebuy_before_maintenance_announcement_gate is missing; refusing to guess at its body';
  END IF;

  -- The layer being restored must exist, and must still lead to the clean-up.
  IF to_regprocedure('public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'process_tournament_rebuy_before_atomic_pool_gate is missing; there is nothing to re-link to';
  END IF;
  IF position('fn_after_tournament_rebuy' IN
        (SELECT pg_get_functiondef(
           to_regprocedure('public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)')::oid))) = 0 THEN
    RAISE EXCEPTION 'the pool gate no longer calls fn_after_tournament_rebuy; re-linking would not restore the clean-up';
  END IF;

  IF position('RETURN public.process_tournament_rebuy_before_one_minute_addon(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the maintenance-announcement gate no longer delegates to _before_one_minute_addon; the chain has changed and this edit must be rewritten against it';
  END IF;
  -- Sibling landmark: its own lifecycle gate must still be there, because that
  -- is what makes calling the pool gate safe rather than a re-ordering.
  IF position('Tournament is not accepting rebuys or re-entries' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the maintenance-announcement gate is missing its lifecycle gate; refusing to edit';
  END IF;

  v_new := replace(
    v_def,
    '  RETURN public.process_tournament_rebuy_before_one_minute_addon(
    p_tournament_id, p_user_id, p_rebuy_type, p_cost, p_chips,
    v_t.current_level, p_client_token);',
    '  /* THE CHAIN, PUT BACK (2026-09-09). This used to call
       _before_one_minute_addon directly, calling it "the audited money core".
       It is not the core - it is a LOWER wrapper - and jumping to it dropped
       the two layers above it, which nothing else calls: the atomic pool gate
       and the bounty guard. With them went fn_after_tournament_rebuy (whose
       only caller is the pool gate), the refusal to replace an entry
       generation whose bounty is unsettled, the zero-stack add-on refusal, the
       bubble-protection resurrection refusal, and the manager wake.

       Measured before this: 70 rebought players still carried
       rebuy_prompt_until, which only fn_after_tournament_rebuy clears, against
       ONE whose prompt had been cleared.

       The lifecycle/clock gate above still runs first and still passes the
       authoritative v_t.current_level down; the pool gate forwards
       p_current_level unchanged and _before_one_minute_addon is still reached
       underneath it, so the 2026-09-08 add-on-clock fix is preserved exactly. */
    RETURN public.process_tournament_rebuy_before_atomic_pool_gate(
    p_tournament_id, p_user_id, p_rebuy_type, p_cost, p_chips,
    v_t.current_level, p_client_token);'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'the re-link replacement matched nothing; aborting rather than shipping an unchanged body';
  END IF;
  EXECUTE v_new;
END;
$guard1$;

-- ── Prove the chain now reaches the clean-up ───────────────────────────────
DO $proof$
DECLARE
  v_gate text;
  v_pool text;
BEGIN
  SELECT pg_get_functiondef(
           to_regprocedure('public.process_tournament_rebuy_before_maintenance_announcement_gate(uuid,uuid,text,numeric,numeric,integer,text)')::oid)
    INTO v_gate;
  SELECT pg_get_functiondef(
           to_regprocedure('public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)')::oid)
    INTO v_pool;

  IF position('process_tournament_rebuy_before_atomic_pool_gate(' IN v_gate) = 0 THEN
    RAISE EXCEPTION 'post-check: the gate still does not call the pool gate';
  END IF;
  IF position('fn_after_tournament_rebuy' IN v_pool) = 0 THEN
    RAISE EXCEPTION 'post-check: the pool gate does not call fn_after_tournament_rebuy';
  END IF;
  IF position('rebuy has % unresolved knockout generations' IN
       (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='fn_after_tournament_rebuy')) <> 0 THEN
    RAISE EXCEPTION 'post-check: fn_after_tournament_rebuy still raises on multiple generations';
  END IF;
END;
$proof$;

COMMIT;
