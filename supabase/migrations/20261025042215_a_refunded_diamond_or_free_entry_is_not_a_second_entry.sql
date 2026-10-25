-- 20261025042215_a_refunded_diamond_or_free_entry_is_not_a_second_entry.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file changes ONE reader, by an anchored edit of its
-- installed definition:
--   FUNCTION smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)
-- It schedules nothing, retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT IS STILL WRONG AFTER 20261024232734, READ FROM ROWS (2026-10-25)
--
-- 20261024232734 taught the never-dealt proof that an earlier pre-start
-- registration, gone and refunded, is not a second entry - but only for a
-- PAID CHIP entry refunded through posted chip_ledger 'refund' legs. Every
-- other receipt of the player in the event still refuses the chair with
-- F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN, which freezes a table that is
-- parked before it ever dealt (Happy Hour Bounty Table 20 sat 42 minutes on
-- exactly this refusal tonight; it is the only way a roster of 1 is released).
--
-- Measured over the last 14 days, earlier entry receipts of a vanished
-- registration that sit beside a later live entry of the same player:
--   chips, paid      872  refunded by chip_ledger legs  -> admitted since 232734
--   chips, free       42  refunded_chips 0 unregistration receipt -> REFUSED
--   diamonds, paid   852  refunded through the entry's own custody -> REFUSED
--   diamonds, free    70  custody released with no leg   -> REFUSED
-- (30 days: 852 + 70 diamond receipts, every one released with balance 0,
-- purpose tournament_entry, refund legs equal to the entry, nothing else
-- paid from the custody.) A diamond buy-in is refunded by
-- fn_unregister_from_tournament as a poker_diamond_tournament_ledger 'refund'
-- leg on the entry's custody, never as a chip_ledger leg, so the 232734 rule
-- can never see it.
--
-- RIGHT NOW (2026-10-25 ~03:40 UTC): 18 of 872 playing entries in RUNNING
-- events would be refused by the installed clause if their table were parked
-- before it dealt; all 18 are diamond re-registrations.
--
-- WHAT CHANGES
--
-- The other-receipt clause admits a whole earlier entry (operation entry,
-- amount >= 0, observed before this entry, registration gone) when its
-- buy-in provably came back:
--   chips, amount > 0 : unchanged - the posted chip refund legs from the
--                       event to the player before this entry sum to exactly
--                       the chip entries (the sum now counts chip receipts
--                       only, so a diamond amount is never compared to chips);
--   chips, amount = 0 : its own unregistration receipt (same registration,
--                       event and player), refunded_chips 0, settled before
--                       this entry;
--   diamonds          : its own custody (custody_result->>'custody_id'):
--                       same player and event, purpose tournament_entry,
--                       state released, balance 0, released before this
--                       entry, refund legs on that custody before this entry
--                       equal to the entry, and no leg other than entry/refund.
-- Anything else - a rebuy, an add-on, a later receipt, a surviving
-- registration, another asset, a refund that does not match - still refuses
-- exactly as before. The rebuy and arrival rules, the one-receipt-for-this-
-- registration rule, the roster and permit checks and the proof shape are
-- unchanged.
--
-- PROVED FIRST (CLAUDE.md 11.5), in ONE Supabase MCP call, ending in RAISE
-- (rolled back), helpers in pg_temp, the evaluation READ ONLY: the live
-- definition (def 63184403, body e0677c7a) was read, the passage found exactly
-- once and replaced (post-image def 35dbc3c7, body 2962ab89), the post-image
-- compiled, and the exact pre- and post-image clauses evaluated against every
-- playing entry-funded registration of every RUNNING event:
--   872 registrations; pre-image refuses 18 (all diamond re-registrations),
--   post-image refuses 0; no registration the pre-image admits is refused by
--   the post-image.
--
-- Release: no row is touched. The engine's existing park re-admission
-- (startParkedMovementEngine -> fn_f06_admit_parked_movement) takes the proof
-- on its next pass. No repair job, no abort, no seat write.
--
-- NOT TOUCHED: f06_movement_prior, f06_assert_movement,
-- fn_f06_admit_parked_movement, the registration, refund and custody paths.
--
-- Pinned by tests/a-refunded-diamond-or-free-entry-is-not-a-second-entry.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='2962ab899304584d3ad1ae1d14b3e8dc' AND md5(pg_get_functiondef(oid))='35dbc3c7dd7b152d8e55892b4af9ae3b' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $refunded_diamond_entry$
DECLARE
  v_fn  regprocedure := 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure;
  v_src text; v_find text; v_n integer; v_acl text; v_owner text; v_secdef boolean; v_config text[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig
    INTO v_src, v_acl, v_owner, v_secdef, v_config
    FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_src) <> '631844035961b4995aab130e8e53e6b6' THEN
    RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_PREIMAGE_DRIFT: f06_movement_never_dealt_prior is %, read it before re-running', md5(v_src);
  END IF;
  v_find := ' -- AN EARLIER REFUNDED ENTRY IS NOT A SECOND ENTRY (2026-10-24). Any other receipt' || chr(10)
         || ' -- of this player is admitted only as a whole earlier chip entry whose' || chr(10)
         || ' -- registration no longer exists and whose buy-in came back: the posted refund' || chr(10)
         || ' -- legs from this event to this player before this entry equal those entries.' || chr(10)
         || ' OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
         || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id' || chr(10)
         || ' AND (f.operation IS DISTINCT FROM ''entry'' OR f.asset IS DISTINCT FROM ''chips'' OR f.amount IS NULL OR f.amount<=0' || chr(10)
         || ' OR f.observed_at>=fund.observed_at OR f.registration_id IS NULL' || chr(10)
         || ' OR EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)))' || chr(10)
         || ' OR COALESCE((SELECT sum(f.amount) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
         || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id),0)' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_ANCHOR: the other-receipt clause was found % times, not once', v_n; END IF;
  v_src := replace(v_src, v_find,
       ' -- AN EARLIER REFUNDED ENTRY IS NOT A SECOND ENTRY (2026-10-24). Any other receipt' || chr(10)
    || ' -- of this player is admitted only as a whole earlier entry whose registration' || chr(10)
    || ' -- no longer exists and whose buy-in came back.' || chr(10)
    || ' -- A REFUNDED DIAMOND OR FREE ENTRY IS NOT A SECOND ENTRY (2026-10-25). A paid chip' || chr(10)
    || ' -- entry came back through the posted chip refund legs below; a free chip entry' || chr(10)
    || ' -- through its unregistration receipt; a diamond entry through its own entry' || chr(10)
    || ' -- custody, released before this entry, whose refund legs equal it and which paid' || chr(10)
    || ' -- nothing else.' || chr(10)
    || ' OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
    || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id' || chr(10)
    || ' AND (f.operation IS DISTINCT FROM ''entry'' OR f.asset IS NULL OR f.asset NOT IN (''chips'',''diamonds'') OR f.amount IS NULL OR f.amount<0' || chr(10)
    || ' OR f.observed_at>=fund.observed_at OR f.registration_id IS NULL' || chr(10)
    || ' OR EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)' || chr(10)
    || ' OR (f.asset=''chips'' AND f.amount=0 AND NOT EXISTS(SELECT 1 FROM public.tournament_unregistration_receipts u' || chr(10)
    || ' WHERE u.registration_id=f.registration_id AND u.tournament_id=p_tournament AND u.user_id=registration.user_id' || chr(10)
    || ' AND u.refunded_chips=0 AND u.settled_at<fund.observed_at))' || chr(10)
    || ' OR (f.asset=''diamonds'' AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody dc' || chr(10)
    || ' WHERE dc.id::text=f.custody_result->>''custody_id'' AND dc.user_id=registration.user_id AND dc.target_id=p_tournament' || chr(10)
    || ' AND dc.purpose=''tournament_entry'' AND dc.state=''released'' AND dc.balance=0 AND dc.released_at<fund.observed_at' || chr(10)
    || ' AND COALESCE((SELECT sum(d.amount) FROM public.poker_diamond_tournament_ledger d WHERE d.custody_id=dc.id' || chr(10)
    || ' AND d.kind=''refund'' AND d.tournament_id=p_tournament AND d.user_id=registration.user_id AND d.created_at<fund.observed_at),0)=f.amount' || chr(10)
    || ' AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger d WHERE d.custody_id=dc.id AND d.kind NOT IN (''entry'',''refund''))))))' || chr(10)
    || ' OR COALESCE((SELECT sum(f.amount) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament' || chr(10)
    || ' AND f.user_id=registration.user_id AND f.registration_id IS DISTINCT FROM registration.id AND f.asset=''chips''),0)' || chr(10));
  IF md5(v_src) <> '35dbc3c7dd7b152d8e55892b4af9ae3b' THEN
    RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_POSTIMAGE: the edited definition is %, not the proved post-image', md5(v_src);
  END IF;
  EXECUTE v_src;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '2962ab899304584d3ad1ae1d14b3e8dc'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> '35dbc3c7dd7b152d8e55892b4af9ae3b'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'F06_REFUNDED_DIAMOND_ENTRY_POSTIMAGE: installed body, owner, ACL or settings differ from the proved post-image';
  END IF;
END
$refunded_diamond_entry$;

COMMIT;
