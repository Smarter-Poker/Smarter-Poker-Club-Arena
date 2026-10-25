-- 20261024232734_a_refunded_earlier_entry_is_not_a_second_entry.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file changes ONE reader, by an anchored edit of its
-- installed definition:
--   FUNCTION smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)
-- It schedules nothing, retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS (2026-10-24)
--
-- c06ca679 "Happy Hour Bounty (NLH)": Table 20 (c30f589c) was parked before
-- it ever dealt (break 97c2401a, park_requested 22:53:35 UTC) with one player
-- seated, 5ba8dd2b, 5,000 chips, registration d4c788b7. Every re-admission of
-- the park is refused:
--
--   f06_movement_admission_unproven [55000]: F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN
--
-- The player can neither play, move nor bust, while 20 other tables deal.
-- fn_f06_withdraw_unplaceable_park needs a roster of 2 to 10, so nothing else
-- releases a roster of 1.
--
-- Every entry_proven clause passes except one: the proof counts this player's
-- funding receipts in the event, by registration OR by user, and requires 1.
-- There are 2. The other (18f34c67, 2026-10-23 10:46, entry, 10.00 chips)
-- belongs to an earlier pre-start registration, 1235d849, which no longer
-- exists: its buy-in came back on the chip ledger (refund e9b668b9, posted,
-- 10.00, event to player, 2026-10-23 13:20). The player registered again late
-- at 22:51:47 (receipt 5e669178, ledger 44069213) and was seated here.
-- A refunded entry whose registration is gone is not chip evidence on this
-- chair. In the last 2 days 917 user/event pairs carried 2 entry receipts, so
-- any never-dealt park of such a late entry freezes the same way.
--
-- WHAT CHANGES
--
-- The one-receipt clause counts the receipts of THIS registration (still
-- exactly 1). Any other receipt of the player in the event is admitted only
-- if every one is a whole earlier chip entry (operation entry, asset chips,
-- positive amount, observed before this entry) whose registration no longer
-- exists, and the posted refund legs from the event to the player recorded
-- before this entry sum to exactly those entries. Anything else - a rebuy,
-- an add-on, a diamond receipt, a later receipt, a surviving registration, a
-- refund that does not match - still refuses exactly as before. The rebuy and
-- arrival rules, the roster and permit checks and the returned proof shape
-- are unchanged.
--
-- PROVED FIRST (CLAUDE.md 11.5), in ONE Supabase MCP call each, ending in
-- RAISE (rolled back), helpers in pg_temp, row locks stripped, READ ONLY:
--   pre-image  (def 1952ea35, body 3637b6a4) on Table 20:
--              F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN
--   post-image (def 63184403, body e0677c7a) on Table 20:
--              roster 1, first_hand true, permits [], entry 5ba8dd2b receipt
--              5e669178 (registration d4c788b7, 5,000 chips)
--
-- Release: no row is touched. The engine's existing park re-admission
-- (startParkedMovementEngine -> fn_f06_admit_parked_movement) takes the proof
-- on its next pass and the break moves the player through the normal move
-- receipts. No repair job, no abort, no seat write.
--
-- NOT TOUCHED: f06_movement_prior, f06_assert_movement,
-- fn_f06_admit_parked_movement, the registration and refund paths.
--
-- Pinned by tests/a-refunded-earlier-entry-is-not-a-second-entry.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='e0677c7a9a3e1bbed2cd00026caee54a' AND md5(pg_get_functiondef(oid))='631844035961b4995aab130e8e53e6b6' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $refunded_entry$
DECLARE
  v_fn  regprocedure := 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure;
  v_src text; v_find text; v_n integer; v_acl text; v_owner text; v_secdef boolean; v_config text[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig
    INTO v_src, v_acl, v_owner, v_secdef, v_config
    FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_src) <> '1952ea35ef547fd1102a4eca7ae1427e' THEN
    RAISE EXCEPTION 'F06_REFUNDED_ENTRY_PREIMAGE_DRIFT: f06_movement_never_dealt_prior is %, read it before re-running', md5(v_src);
  END IF;
  v_find := ' OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
         || ' AND (f.registration_id=registration.id OR f.user_id=registration.user_id))<>1' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'F06_REFUNDED_ENTRY_ANCHOR: the one-receipt clause was found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       ' OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
    || ' AND f.registration_id=registration.id)<>1' || chr(10)
    || ' -- AN EARLIER REFUNDED ENTRY IS NOT A SECOND ENTRY (2026-10-24). Any other receipt' || chr(10)
    || ' -- of this player is admitted only as a whole earlier chip entry whose' || chr(10)
    || ' -- registration no longer exists and whose buy-in came back: the posted refund' || chr(10)
    || ' -- legs from this event to this player before this entry equal those entries.' || chr(10)
    || ' OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
    || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id' || chr(10)
    || ' AND (f.operation IS DISTINCT FROM ''entry'' OR f.asset IS DISTINCT FROM ''chips'' OR f.amount IS NULL OR f.amount<=0' || chr(10)
    || ' OR f.observed_at>=fund.observed_at OR f.registration_id IS NULL' || chr(10)
    || ' OR EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)))' || chr(10)
    || ' OR COALESCE((SELECT sum(f.amount) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
    || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id),0)' || chr(10)
    || ' IS DISTINCT FROM COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l WHERE l.tournament_id=p_tournament' || chr(10)
    || ' AND l.category=''refund'' AND l.status=''posted'' AND l.from_entity_id=p_tournament AND l.to_entity_id=registration.user_id' || chr(10)
    || ' AND l.created_at<fund.observed_at),0)' || chr(10));
  IF md5(v_src) <> '631844035961b4995aab130e8e53e6b6' THEN
    RAISE EXCEPTION 'F06_REFUNDED_ENTRY_POSTIMAGE: the edited definition is %, not the proved post-image', md5(v_src);
  END IF;
  EXECUTE v_src;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> 'e0677c7a9a3e1bbed2cd00026caee54a'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> '631844035961b4995aab130e8e53e6b6'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'F06_REFUNDED_ENTRY_POSTIMAGE: installed body, owner, ACL or settings differ from the proved post-image';
  END IF;
END
$refunded_entry$;

COMMIT;
