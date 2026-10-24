-- 20261024233030_a_refunded_earlier_registration_is_not_a_second_entry.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file changes ONE reader,
-- smarter_private.f06_movement_never_dealt_prior. It schedules nothing,
-- retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS (2026-10-24)
--
-- c06ca679 "Happy Hour Bounty (NLH)": Table 20 (c30f589c) was created by
-- fn_ensure_late_registration_capacity at 22:51:47 UTC for one late
-- registrant, horse "ana" (5ba8dd2b), because all 19 x 9 = 171 chairs were
-- taken. Balancing parked it at 22:53:35 (break 97c2401a). Every re-admission
-- since (every 15 s) refuses
--
--   f06_movement_admission_unproven [55000]: F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN
--
-- and fn_f06_withdraw_unplaceable_park cannot help (a roster of one, no
-- permit, and it calls the same proof). She can never play, move or bust.
--
-- The entry proof requires exactly ONE funding receipt per player, counted as
--   registration_id = this registration OR user_id = this user.
-- ana has two `entry` receipts: 5e669178 for her current registration
-- d4c788b7 (5000 chips, valid), and 18f34c67 for an EARLIER registration
-- 1235d849 (2026-10-23 10:46) that no longer exists and was refunded
-- (refund-entitlement:f94899d3, 2026-10-23 13:20). The user_id arm counts the
-- refunded registration's receipt as if it were a second paid entry on this
-- one. 37 playing entrants across running events (15 in Happy Hour) carry the
-- same unregister -> refund -> register-again history, so any of them seated
-- alone at a never-dealt table jams the same way.
--
-- WHAT CHANGES
--
-- The uniqueness count now counts receipts of THIS registration, plus any
-- receipt of this user observed since this registration began. A receipt
-- observed before the current registration existed belongs to an earlier
-- registration of the same user; it granted none of the chips on this chair.
-- Everything that proves the chair's chips is unchanged: the current
-- registration's own latest receipt must still be an `entry` whose snapshots
-- equal the stack, the rebuys/add_on counters must still be 0, and any
-- rebuy/add-on ledger leg of this user in this event still refuses.
--
-- Read against production first: for ana the old count is 2 and the new count
-- is 1. Once installed, nothing is touched by hand: the engine's next normal
-- park re-admission (startParkedMovementEngine -> fn_f06_admit_parked_movement,
-- ~15 s) proves the park and the break moves her through ordinary move receipts.
--
-- The change is applied to the installed definition text and asserted on both
-- sides: the pre-image must be byte-for-byte the definition this was written
-- against, the post-image must be the pre-image with exactly this passage
-- replaced, and removing the passage reproduces the pre-image byte for byte.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $refunded_registration_is_not_a_second_entry$
DECLARE
  v_proc regprocedure := 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure;
  v_pre text;
  v_post text;
  v_old text := E' OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament\n AND (f.registration_id=registration.id OR f.user_id=registration.user_id))<>1\n';
  v_new text := E' OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament\n AND (f.registration_id=registration.id OR (f.user_id=registration.user_id AND f.observed_at>=registration.registered_at)))<>1\n';
BEGIN
  v_pre := pg_get_functiondef(v_proc);
  IF md5(v_pre) IS DISTINCT FROM '1952ea35ef547fd1102a4eca7ae1427e' THEN
    RAISE EXCEPTION 'PREIMAGE_MISMATCH: f06_movement_never_dealt_prior is not the definition this migration was written against (md5 %)', md5(v_pre)
      USING ERRCODE = '55000';
  END IF;
  IF (length(v_pre) - length(replace(v_pre, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'PREIMAGE_PASSAGE: the receipt-count passage does not appear exactly once'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE replace(v_pre, v_old, v_new);

  v_post := pg_get_functiondef(v_proc);
  IF v_post IS DISTINCT FROM replace(v_pre, v_old, v_new) THEN
    RAISE EXCEPTION 'POSTIMAGE_MISMATCH: installed definition is not the pre-image with exactly this passage replaced'
      USING ERRCODE = '55000';
  END IF;
  IF replace(v_post, v_new, v_old) IS DISTINCT FROM v_pre THEN
    RAISE EXCEPTION 'POSTIMAGE_NOT_REVERSIBLE' USING ERRCODE = '55000';
  END IF;
END
$refunded_registration_is_not_a_second_entry$;

COMMIT;
