-- ===========================================================================
--  A MYSTERY BOUNTY OF TEN OR FEWER ENTRIES PAYS 50 / 30 / 20
-- ===========================================================================
--
-- Dan, 2026-10-05, verbatim:
--   "MYSTERY BOUNTY OF 10 OR FEWER DON'T GET CHESTS, ITS TREATING LIKE A
--    SINGLE TABLE TOURNAMENTS WITH 50 30 20 PAYOUT PERCENTAGES"
--
-- READ ON PRODUCTION 2026-10-05 (last seven days): every mystery bounty with
-- 10 or fewer entries paid 100% to first; 11-20 paid 64/36. The ladder an MTT
-- is paid by is written by the DATABASE, not the engine:
--
--   * fn_finalize_tournament_entry_pool_locked (md5 d8aa6508707a5da0b3b61cc85b644e2f) is the
--     atomic entry close. For every non-Spin MTT whose payout terms are not
--     yet committed it writes tournaments.payout_structure =
--     fn_ca_payout_structure(field, percent) and snapshots it into
--     tournament_entry_close_receipts. The engine pays from that stored ladder
--     (server/src/tournament/payoutStructure.ts: "Do not reconstruct a funded
--     ladder here"), the client displays it (RewardsTab ->
--     resolvePayoutStructure), and the reprice of anyone who busted during
--     late registration reads the same snapshot.
--   * fn_ca_fund_overlay_on_lock (md5 52773a5c7b5011bb82e0518f50b461b5), the start trigger,
--     writes the provisional ladder from the field at start with the same
--     generator; the entry close then supersedes it.
--
-- fn_ca_payout_structure pays the top 10/15/20% of the field: at 10 or fewer
-- players that is one place.
--
-- THE CHANGE. In both callers, a mystery bounty whose TOTAL ENTRIES are
-- 1..10 and whose field has at least 3 players is paid exactly
-- [{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}];
-- every other event calls fn_ca_payout_structure(field, percent) exactly as
-- before. Total entries are the entry rows plus every rebuy/re-entry on them
-- (count(*) + sum(GREATEST(rebuys,0))), the count the engine's mystery
-- activation reads (totalEntriesFromRows, #6178), so "no chests" and "50/30/20"
-- are decided on one number. Fewer than 3 players keeps the existing rule (one
-- place): a third place nobody can finish in would only move its 20% to the
-- residual of place 2. The percentages sum to 100 and place 3, the last place,
-- takes the cent residual in fn_tournament_place_prize_exact and
-- computePlacePrize, so the pool is paid to the cent.
--
-- The rule is written inline rather than as a new helper function so this
-- migration declares no new object; it changes two existing functions only.
--
-- HOW: exact substitution through the pg_temp helper of 20261004224309
-- (copied from 20261005111115): preimage md5 pinned, each anchor proved to
-- occur exactly once, postimage md5 computed read-only on production
-- 2026-10-05, owner/security/settings/grants asserted unmoved. Nothing else in
-- either function moves. Events whose terms are already committed keep their
-- stored ladder (that branch is untouched), so no running or settled event is
-- re-priced. No money moves here. Horses are entries exactly like humans
-- (CLAUDE.md 10.5).
--
-- The engine half (no chests at 10 or fewer entries, every activation mode)
-- is claude/small-field-mystery-20261005.
--
-- Apply outside the :50-:03 break window (CLAUDE.md 2 rule 8).
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)'::regprocedure)) = '4b536704f1210d9a94efb1a8c7be4467' AND md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure)) = '3f55869778cc3c02ca1406fa22c908d4')

BEGIN;

SET LOCAL lock_timeout = '3s';
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

SELECT pg_temp.ca_audit_subst(
  'public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)',
  'd8aa6508707a5da0b3b61cc85b644e2f', '4b536704f1210d9a94efb1a8c7be4467',
  ARRAY[$o$    v_structure := public.fn_ca_payout_structure(
      v_field,COALESCE(v_t.payout_percent,10));
$o$],
  ARRAY[$n$    /* A MYSTERY BOUNTY OF 10 OR FEWER ENTRIES PAYS 50/30/20 (Dan, 2026-10-05:
       "MYSTERY BOUNTY OF 10 OR FEWER DON'T GET CHESTS, ITS TREATING LIKE A
       SINGLE TABLE TOURNAMENTS WITH 50 30 20 PAYOUT PERCENTAGES"). Entries
       are the entry rows plus every rebuy and re-entry on them, the count
       the engine's mystery activation reads (totalEntriesFromRows). Fewer
       than three players keeps the field ladder below. */
    v_structure := CASE
      WHEN COALESCE(v_t.is_mystery_bounty,false) AND v_field>=3
       AND (SELECT (count(*)+COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0))::integer
              FROM public.tournament_players tp
             WHERE tp.tournament_id=p_tournament_id) BETWEEN 1 AND 10
      THEN '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb
      ELSE public.fn_ca_payout_structure(
      v_field,COALESCE(v_t.payout_percent,10)) END;
$n$]);

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_fund_overlay_on_lock()',
  '52773a5c7b5011bb82e0518f50b461b5', '3f55869778cc3c02ca1406fa22c908d4',
  ARRAY[$o$      v_places := GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));
$o$, $o$        NEW.payout_structure := public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text;
$o$],
  ARRAY[$n$      /* Same rule as the entry close: a mystery bounty of 10 or fewer
         entries (rows plus rebuys) with at least 3 players pays 50/30/20
         (Dan, 2026-10-05). */
      v_places := CASE
        WHEN COALESCE(NEW.is_mystery_bounty,false) AND v_entrants >= 3
         AND (SELECT (count(*)+COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0))::integer
                FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id) BETWEEN 1 AND 10
        THEN 3
        ELSE GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int)) END;
$n$, $n$        NEW.payout_structure := CASE
          WHEN COALESCE(NEW.is_mystery_bounty,false) AND v_entrants >= 3
           AND (SELECT (count(*)+COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0))::integer
                  FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id) BETWEEN 1 AND 10
          THEN '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb::text
          ELSE public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text END;
$n$]);

COMMIT;
