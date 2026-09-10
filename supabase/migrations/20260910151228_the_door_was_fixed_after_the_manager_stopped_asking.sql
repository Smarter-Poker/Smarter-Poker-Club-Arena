-- the_door_was_fixed_after_the_manager_stopped_asking
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- a_place_is_not_a_bounty landed at 14:58 and the door immediately started
-- accepting the busts it had been refusing: absent players across the ten
-- stalled events fell from 62 to 27 in seven minutes. Then it stopped, with 27
-- still unrecorded and nothing wrong with any of them.
--
-- WHY IT STOPPED, read rather than guessed:
--   * the door accepts them. A rolled-back DO-block probe called
--     fn_claim_tournament_bounty_elimination for six of the stuck candidates
--     and every one returned ok:true, claimed:true, obligation_id:null,
--     bounty_blocked:'exact_pot_claimants_not_found'. Nothing committed - the
--     probe ends in RAISE EXCEPTION, which is the success case (CLAUDE.md 11.5).
--   * none of them is blocked: 0 are behind a newer generation, 0 have an
--     unresolved chain, 0 have an open rebuy prompt, 0 lack an atomic commit,
--     0 lack a settlement receipt, 0 have a live seat, 0 have had their hand
--     pruned, and fn_ca_latest_committed_knockout_candidate names each of them.
--   * and there is NO PENDING WAKE for any of those events: zero unconsumed
--     rows in tournament_manager_wakes, one wake in five minutes across all
--     ten, while 58 busts were recorded elsewhere on the platform in the same
--     five minutes. The engine is healthy. It has simply not been asked.
--
-- That is the whole of it. Before 14:58 the door refused these players, the
-- bust pass passed over each one after BUST_REFUSAL_SKIP_AFTER refusals - which
-- is the correct behaviour that stops one refusal freezing an event - and the
-- manager acknowledged its sweep as complete. A complete sweep consumes its
-- wake. In an event where nothing else is happening, nothing generates another.
-- So the managers stopped asking, minutes before the answer changed.
--
-- THE CAUSE IS ALREADY FIXED. This is the damage: ten events whose managers
-- have no reason to look again. One wake each, through the platform's own
-- scheduling mechanism, is what tells them there is work - the same thing
-- a_manager_sweeps_itself_once_when_it_adopts_the_event did this morning, and
-- for the same reason.
--
-- It is not a repair job (CLAUDE.md 10.12). It repairs nothing and writes no
-- money. It emits the signal the live path already runs on, once, for events
-- that provably have unrecorded busts right now, and then it is over. Nothing
-- is scheduled and nothing recurs.
--
-- Bounded on purpose: only events that are RUNNING, that
-- fn_ca_absent_tournament_players is currently reporting, and that actually
-- hold a `pending` knockout candidate. If a later run finds nothing to wake it
-- raises, because a wake for an event with no work is a wake nobody should
-- have sent.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_t record;
  v_woken integer := 0;
  v_pending integer;
BEGIN
  -- the door must already be the fixed one, or waking a manager just
  -- reproduces the refusals it stopped for
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname = 'fn_claim_bounty_legacy_candidate_20260907'
       AND position('A PLACE IS NOT A BOUNTY' IN pg_get_functiondef(p.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'the knockout door has not been corrected; waking a manager would only repeat the refusals';
  END IF;

  FOR v_t IN
    SELECT DISTINCT a.tournament_id
      FROM public.fn_ca_absent_tournament_players() a
      JOIN public.tournaments t ON t.id = a.tournament_id
     WHERE t.status = 'RUNNING'
       AND EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c
          WHERE c.tournament_id = a.tournament_id AND c.state = 'pending')
     ORDER BY a.tournament_id
  LOOP
    PERFORM public.fn_emit_tournament_manager_wake(v_t.tournament_id, 'late_registration');
    v_woken := v_woken + 1;
  END LOOP;

  IF v_woken = 0 THEN
    RAISE EXCEPTION 'no event has an unrecorded bust to wake for; this migration had nothing to do and should not have been written';
  END IF;

  SELECT count(*) INTO v_pending
    FROM public.tournament_knockout_candidates c
    JOIN public.tournaments t ON t.id = c.tournament_id
   WHERE t.status = 'RUNNING' AND c.state = 'pending';

  RAISE NOTICE 'woke % manager(s); % knockout candidate(s) are pending across all running events', v_woken, v_pending;
END
$body$;

COMMIT;
