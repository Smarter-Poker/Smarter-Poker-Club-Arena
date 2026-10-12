-- a_club_bank_claim_is_not_a_player_transfer
--
-- A CLUB BANK CLAIM IS NOT A PLAYER-TO-PLAYER TRANSFER (2026-10-12). Full
-- account: docs/changelog/2026-10-12-a-club-bank-claim-is-not-a-player-transfer.md.
--
-- fn_union_integrity_sweep flags a "direct_chip_transfer" when one user moves
-- chips straight to another inside the union. On 2026-10-10 19:04 to 19:40 UTC
-- the deleted patterned house identities' wallets were closed into their club
-- banks (Club JAQK, SHARK CLUB, Midway Union): chip_transactions of type
-- club_bank_claim, metadata reason deleted_account, direction into_bank. Such
-- a row names the closed account as from_user_id and the club owner as
-- to_user_id, because the owner is the face of the club bank; the chips went
-- to the bank, not to a player. The sweep read them as 62 player transfers to
-- one user and raised two warnings (2026-10-10 19:35 and 2026-10-11 15:35).
--
-- club_bank_claim joins the movement types the sweep already reads as not
-- player-to-player (agent_to_player_transfer, rakeback, buyin, cashout). Every
-- other transfer is flagged exactly as before.
--
-- @live-proof: (SELECT position('''club_bank_claim''' IN pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure);
  v_old text := $a$AND ct.transaction_type NOT IN ('agent_to_player_transfer','rakeback','buyin','cashout')$a$;
  v_new text := $a$AND ct.transaction_type NOT IN ('agent_to_player_transfer','rakeback','buyin','cashout',
         -- A CLUB BANK CLAIM IS NOT A PLAYER TRANSFER (2026-10-12): to_user_id
         -- names the owner as the face of the club bank the chips went into.
         'club_bank_claim')$a$;
BEGIN
  IF position('''club_bank_claim''' IN v_src) > 0 THEN
    RAISE NOTICE 'BANK_CLAIM_NOT_TRANSFER already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '96d7eff01edb51381bcec29486081704' THEN
    RAISE EXCEPTION 'BANK_CLAIM_NOT_TRANSFER_PREIMAGE_CHANGED';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'BANK_CLAIM_NOT_TRANSFER_ANCHOR_CHANGED';
  END IF;
  EXECUTE replace(v_src, v_old, v_new);
END
$patch$;

DO $prove$
BEGIN
  IF position('''club_bank_claim''' IN pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'BANK_CLAIM_NOT_TRANSFER_RESULT_CHANGED';
  END IF;
END
$prove$;

COMMIT;
