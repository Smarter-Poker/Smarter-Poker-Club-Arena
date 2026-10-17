-- 20261016013849_a_club_bank_send_is_not_a_player_transfer.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CLUB BANK SEND IS NOT A PLAYER TRANSFER (2026-10-16)
--
-- fn_union_integrity_sweep raised a warning at 18:35 UTC on 2026-10-15
-- (financial_alerts cc0387d7, operational_alert_events 254619) for union
-- fade0000 with 739 "direct_chip_transfer" signals: one per horse, 10,000.00
-- each, all from the owner account. Read from production on 2026-10-16:
--
--   * those rows are chip_transactions of transaction_type 'club_bank_send',
--     notes "Owner Horse Wallet Reset To 10,000 (Dan, 2026-10-15)", sent from
--     the club banks of 2a1132b9 (416, from 17:37), fade0000 (323, from
--     17:38), a0000000 (580, from 17:49) and a41434bb (584, from 18:02);
--   * every one carries metadata bank_before / bank_after: the chips left the
--     CLUB BANK, and from_user_id names the owner only as the face of that
--     bank, exactly as to_user_id does on a 'club_bank_claim';
--   * the sweep's direct-transfer signal already excludes 'club_bank_claim'
--     for that reason (2026-10-12) but not its mirror 'club_bank_send', so
--     every owner payout from a club bank reads as the owner dumping chips to
--     a player.
--
-- The detector fired on a non-defect, so the detector is the defect. The fix
-- adds 'club_bank_send' to the same exclusion list, beside the claim. Player
-- to player transfers, agent rosters and co-seating are unchanged.
--
-- Pinned-preimage substitution: the live pg_get_functiondef md5 is pinned,
-- the one anchor occurs exactly once, the postimage md5 was derived
-- read-only on production with replace(), and owner, SECURITY DEFINER,
-- search_path and grants are proven unchanged after the replace.
--
-- Regression: scripts/ci/test-a-club-bank-send-is-not-a-dump.py on native
-- PostgreSQL (the live definition captured 2026-10-16, md5 8b7ba9bc...), run
-- by .github/workflows/a-club-bank-send-is-not-a-dump.yml.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) = 'b3adb49ea93ac361b16c3c7ed19a865d'

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_bank_send_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_bank_send_subst(
  'public.fn_union_integrity_sweep(uuid,integer)',
  '8b7ba9bcadeb38bc7021cf04af28a877', 'b3adb49ea93ac361b16c3c7ed19a865d',
  ARRAY[$bo1$         'club_bank_claim')$bo1$],
  ARRAY[$bn1$         'club_bank_claim',
         -- A CLUB BANK SEND IS NOT A PLAYER TRANSFER EITHER (2026-10-16): the
         -- chips leave the club bank (metadata bank_before/bank_after), and
         -- from_user_id names the owner as the face of that bank, exactly as
         -- to_user_id does on a claim. The owner's 2026-10-15 horse wallet
         -- reset (one send of 10,000 to every live horse from four club
         -- banks) was raised as 739 "direct chip transfers" from the owner.
         'club_bank_send')$bn1$]
);

COMMIT;
