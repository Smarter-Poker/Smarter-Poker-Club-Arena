-- 20261015222121_a_lightning_hand_counts_every_player_dealt_in
--
-- Reserved by scripts/new-migration.mjs on 2026-10-15 22:21:21 UTC.
--
-- A LIGHTNING HAND COUNTS EVERY PLAYER DEALT IN, NOT EVERY PAYER (2026-10-15)
--
-- The storm. ledger_reconcile_log:over_spec (190 open rows) and
-- ledger_reconcile_log:bbj_over_spec (146), their 25 + 25 drift_incident
-- receipts, two fn_rake_bbj_audit rows (I1_drop_under_3_dealt, n = 2) and one
-- "0.02 chip drift: reporting_mismatch" notification, all filed from 20:38 UTC
-- on 2026-10-15. Every finding names one of two tables of the private
-- Lightning Internal Pilot club: "Lightning Pilot NLH 9" (0.02/0.04) and
-- "Lightning Pilot NLH 6" (0.01/0.02). The hands run from 20:11:51 to
-- 20:53:25 UTC, which is exactly the window the two pilot Clusters dealt
-- Lightning hands: an operator set worker_mode = 'form' at 20:10:42 ("Lightning
-- Phase 3 Stage 2 form mode on the private pilot"), the first lightning_hand
-- formed at 20:10:55 and the last at 20:52:59. No migration and no engine
-- release lands in that window (the engine shipped 818b10c at 18:02 and
-- a2ccc04 at 21:05). No r5 migration caused it.
--
-- The money is right. Of the 597 raked hands the two tables recorded between
-- 20:00 and 21:00, priced with the number of players actually dealt in
-- (hand_history.players = lightning_hand.player_count = the hand's
-- lightning_hand_player rows, equal on all 597), 0 are over spec, 0 under
-- spec, 0 BBJ over and 0 BBJ under. Every contribution map sums to its pot,
-- and no folder who put a chip in is missing from one. Nobody was over-raked
-- and no BBJ drop was taken over spec, so there is nothing to refund.
--
-- The record is wrong. In 148 of those hands rake_records.num_players is
-- smaller than the number dealt in (hand a5998a9c: four dealt, two folded
-- preflop without posting, num_players 2). Both monitors read it as the dealt
-- count: fn_rake_law_violations prices with COALESCE(rr.num_players, ...) and
-- fn_rake_bbj_invariants I1 counts drops "under 3 dealt" from it. With 2 they
-- apply the heads-up percentage and the BBJ minimum-dealt rule, so a correct
-- 0.03 rake reads as "took 0.03 where the spec says 0.01" and a correct 0.02
-- drop as BBJ over spec.
--
-- The line. fn_lightning_settle_hand builds the hand's post-commit envelope
-- "exactly as the engine builds them for a physical hand", and sets
--   'num_players', (SELECT count(*) FROM jsonb_object_keys(v_contrib))
-- where v_contrib keeps only participants whose contribution is > 0. A fast
-- folder who never put a chip in is dealt in but not a payer, so he drops out
-- of the count. The physical engine's map carries every dealt-in player (a
-- zero for a folder), which is why no physical hand disagreed (0 of
-- about 80,000 raked cash hands in the 30 hours to 22:00 UTC).
--
-- The fix: num_players is v_n, the count of this hand's lightning_hand_player
-- rows, which step 3 of the same function has already proved names every
-- participant exactly once. v_contrib is unchanged: the weighted attribution
-- and the promo playthrough still read only payers. The 148 historical rows
-- are left as recorded (CLAUDE.md 10.9: a settled record is never rewritten
-- to look tidy); the last of them leaves fn_rake_law_violations' one-hour
-- window at 21:58 UTC and fn_rake_bbj_invariants' two-hour window at 22:53.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (fcd616a9...), the anchor must
-- occur exactly once (measured read-only on production 2026-10-15: 1), and
-- the result must hash to the postimage derived read-only on production with
-- replace() (0432654c...); owner, SECURITY DEFINER, proconfig and grants must
-- not move.
--
-- Regression: scripts/ci/test-lightning-hand-counts-every-player-dealt-in.py
-- (native PostgreSQL), run by
-- .github/workflows/lightning-hand-counts-every-player-dealt-in.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)) = '0432654c1fd742eeedb2920140cda3b5')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_audit_subst(
  'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)',
  'fcd616a9a339d8a25ab72bfa822678f7', '0432654c1fd742eeedb2920140cda3b5',
  ARRAY[$o$                'num_players', (SELECT count(*) FROM jsonb_object_keys(v_contrib)),
$o$],
  ARRAY[$n$                -- EVERY PARTICIPANT DEALT IN, NOT EVERY PAYER (2026-10-15). The
                -- rake law prices a hand by how many were dealt; a fast-folder
                -- who never put a chip in is still dealt, and v_contrib leaves
                -- him out. v_n is this hand's lightning_hand_player count.
                'num_players', v_n,
$n$]
);

COMMIT;
