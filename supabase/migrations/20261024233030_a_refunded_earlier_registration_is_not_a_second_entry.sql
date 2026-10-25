-- 20261024233030_a_refunded_earlier_registration_is_not_a_second_entry.sql
--
-- SUPERSEDED BY 20261024232734_a_refunded_earlier_entry_is_not_a_second_entry
-- (PR #7974). This file now only ASSERTS; it changes nothing.
--
-- History, so the migration ledger and the database agree:
--
-- 2026-10-24 23:34 UTC this version was installed in production to release
-- Happy Hour Bounty (NLH) Table 20 (c30f589c), where one late registrant
-- (horse "ana") could never play, move or bust: the never-dealt entry proof
-- (smarter_private.f06_movement_never_dealt_prior) counted a refunded earlier
-- registration's funding receipt as a second paid entry. The installed body
-- ignored receipts observed before the current registration began. The park
-- was admitted within a minute and she was moved to a full table.
--
-- Another session fixed the same incident in parallel with a stricter rule
-- (#7974: an earlier receipt is admitted only as a whole chip entry whose
-- registration is gone and whose buy-in the posted refunds returned in full).
-- #7974 merged first, so on 2026-10-25 (~02:25 UTC) production was returned
-- to the exact pre-image (md5 1952ea35...) and #7974's own body installed on
-- top of it, under #7974's name. Production now holds #7974's post-image.
--
-- In version order this file runs AFTER 20261024232734, so a rebuild applies
-- #7974 first and this file then confirms that is what the database holds.
--
-- @live-proof: md5(pg_get_functiondef('smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure)) = '631844035961b4995aab130e8e53e6b6'

BEGIN;

DO $refunded_registration_superseded$
BEGIN
  IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
       WHERE p.oid = 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure)
     IS DISTINCT FROM '631844035961b4995aab130e8e53e6b6' THEN
    RAISE EXCEPTION 'F06_REFUNDED_REGISTRATION_SUPERSEDED: f06_movement_never_dealt_prior is not the 20261024232734 post-image'
      USING ERRCODE = '55000';
  END IF;
END
$refunded_registration_superseded$;

COMMIT;
