-- 20261016101854_a_chip_rake_finding_is_measured_again.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CHIP RAKE FINDING IS MEASURED AGAIN (2026-10-16)
--
-- The Oct 14 daily digest said "53/54 drift incidents are open past their
-- deadline". Read on 2026-10-16: 54 open past deadline, and 52 of them are the
-- Lightning Internal Pilot's 2026-10-15 rake-law storm - 50 per-hand
-- ledger_reconcile_log:over_spec / bbj_over_spec incidents on "Lightning Pilot
-- NLH 9" and "Lightning Pilot NLH 6", plus the two storm counters for those
-- sources. 20261015222121_a_lightning_hand_counts_every_player_dealt_in
-- already proved the money right (0 of 597 raked hands over or under spec,
-- priced with the players actually dealt in) and fixed the line that wrote
-- the undercount. Re-read today: all 50 flagged hands have
-- rake_records.num_players smaller than hand_history.players; across 133,482
-- cash hands of the last 48 hours exactly 148 rows disagree, all of them that
-- window, none after 22:30 UTC, and none the other way.
--
-- Two lines kept the storm alive after the fix:
--
-- 1. fn_rake_law_violations priced a hand with COALESCE(rr.num_players, ...),
--    so the 148 settled-as-recorded rows read over spec for as long as they
--    sit in any window. It now prices with GREATEST(rr.num_players,
--    jsonb_array_length(hh.players)): num_players can undercount and never
--    overcounts, and on every other hand the two are equal, so nothing else
--    moves. Measured read-only: the two pilot tables, 683 flopped hands from
--    20:00 to 21:10 UTC, priced this way: 0 over, 0 under, 0 BBJ over, 0 BBJ
--    under.
--
-- 2. fn_ca_remeasure_entity could only re-measure a club treasury or a
--    Diamond table. Every chip rake_law finding came back "could not tell",
--    so fn_ca_escalate_reconcile_criticals re-filed it at :52 every hour for
--    its full 36-hour lookback (the storm counters "recurred" 70 and 60 times,
--    the last at 09:52 UTC today, from log rows written before 21:40 UTC
--    yesterday). It now measures a chip cash table the way the law does, over
--    the same 36 hours, so a fixed condition is superseded at the next tick
--    and a live one is filed on fresh numbers. Measured read-only: both pilot
--    tables measure ok; one table's 1,097 hands take about 3 seconds.
--
-- Then the 52 incidents are closed as verified_remeasured, each only after the
-- new re-measure says ok for its table inside this transaction. No chips move:
-- no player was over-raked and no drop was taken over spec, so there is
-- nothing to refund (CLAUDE.md 10.9). Settled rake_records rows are not
-- rewritten.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545 /
-- 20261015222121. Each live text must hash to today's measured md5, each anchor
-- must occur exactly once (measured read-only on production 2026-10-16: 1 and
-- 1), and each result must hash to the postimage derived read-only with
-- replace(); owner, security, settings and grants must not move.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_rake_law_violations(interval)'::regprocedure)) = '437308bc0bcfe73383342344e895ba0e')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_remeasure_entity(text,uuid)'::regprocedure)) = '8222efcb6206a4b4b6358f8b6f3fc0be')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

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
  'public.fn_rake_law_violations(interval)',
  'a3e1fde3f45140c91640389d419ed553', '437308bc0bcfe73383342344e895ba0e',
  ARRAY[$o$COALESCE(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,$o$],
  ARRAY[$n$/* EVERY PLAYER DEALT IN (2026-10-16). rake_records.num_players can undercount
              a hand (fn_lightning_settle_hand counted payers, not players dealt,
              until 20261015222121; 148 rows recorded that way are kept as
              settled), and never overcounts it. hand_history.players is the
              dealt list, so price with the larger of the two. */
           GREATEST(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,$n$]
);

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_remeasure_entity(text,uuid)',
  '03e547f65a2d4c43fd52ac92787111ba', '8222efcb6206a4b4b6358f8b6f3fc0be',
  ARRAY[$o$  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
$o$],
  ARRAY[$n$  /* A CHIP RAKE FINDING IS MEASURED AGAIN (2026-10-16). On a chip cash table
     the rake law is fn_effective_rake and fn_effective_bbj_drop, priced with
     the number of players dealt in, so measure every flopped hand of the last
     36 hours (the escalator's lookback) exactly the way fn_rake_law_violations
     does. Without this branch every chip rake_law finding was "could not
     tell" and the hourly escalator re-filed it for 36 hours after the cause
     was fixed: the Lightning pilot's 2026-10-15 storm recurred every hour.
     ledger_balance is the rake and drop the law allows, stored_balance the
     rake and drop the hands recorded. A flopped hand with no dealt count is
     unreadable, and unreadable is a finding, never ok. */
  IF p_entity_type = 'rake_law' AND p_entity_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tables t LEFT JOIN public.clubs c ON c.id = t.club_id
                  WHERE t.id = p_entity_id AND t.tournament_id IS NULL
                    AND COALESCE(c.asset = 'diamonds', false) = false) THEN
    RETURN QUERY
      WITH h AS (
        SELECT hh.pot_size AS pot,
               COALESCE(hh.rake_amount, 0) AS rake,
               COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) AS bbj,
               t.small_blind AS sb, t.big_blind AS bb, t.club_id, t.id AS tid,
               t.max_players AS seats,
               lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
               GREATEST(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,
               CASE WHEN t.rake_percent >= 0 THEN t.rake_percent
                    WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END AS ov_pct,
               CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb
                    WHEN c.rake_cap >= 0 THEN c.rake_cap END AS ov_cap_bb
          FROM public.hand_history hh
          JOIN public.tables t ON t.id = hh.table_id
          LEFT JOIN public.clubs c ON c.id = t.club_id
          LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
         WHERE hh.table_id = p_entity_id
           AND hh.tournament_id IS NULL
           AND hh.created_at > now() - interval '36 hours'
           AND hh.created_at < now() - interval '5 minutes'
           AND COALESCE(array_length(hh.community_cards, 1), 0)
                 + COALESCE(array_length(hh.community_cards2, 1), 0) >= 3
      ), f AS (
        SELECT h.*, e.rake AS exp_rake
          FROM h
          LEFT JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb, h.seats) e
            ON h.dealt IS NOT NULL
      ), fb AS (
        SELECT f.*,
               CASE WHEN f.dealt IS NOT NULL
                    THEN public.fn_effective_bbj_drop(f.bb, f.dealt, true, f.club_id, f.tid, f.variant, f.sb, f.pot, f.rake)
               END AS exp_bbj
          FROM f
      )
      SELECT true,
             COALESCE(sum(fb.exp_rake + fb.exp_bbj), 0),
             COALESCE(sum(fb.rake + fb.bbj), 0),
             CASE WHEN bool_or(fb.dealt IS NULL
                               OR abs(fb.rake - fb.exp_rake) > 0.005
                               OR abs(fb.bbj - fb.exp_bbj) > 0.005)
                  THEN 'critical' ELSE 'ok' END
        FROM fb;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
$n$]
);

-- Close the pilot storm, table by table, only on a fresh all-clear.
DO $close$
DECLARE
  v_tables uuid[];
  t uuid;
  m record;
  v_closed integer;
  v_ref text := 'migration 20261015222121_a_lightning_hand_counts_every_player_dealt_in';
BEGIN
  SELECT array_agg(DISTINCT i.entity_id) INTO v_tables
    FROM public.ca_drift_incidents i
   WHERE i.resolved_at IS NULL
     AND i.source IN ('ledger_reconcile_log:over_spec', 'ledger_reconcile_log:bbj_over_spec')
     AND i.entity_type = 'rake_law' AND i.entity_id IS NOT NULL;

  IF v_tables IS NULL THEN
    RAISE NOTICE 'no open chip rake_law incidents: nothing to close';
    RETURN;
  END IF;

  FOREACH t IN ARRAY v_tables LOOP
    SELECT * INTO m FROM public.fn_ca_remeasure_entity('rake_law', t);
    IF NOT COALESCE(m.measurable, false) OR m.severity IS DISTINCT FROM 'ok' THEN
      RAISE EXCEPTION 'rake_law % re-measures as % (measurable %), not ok: refusing to close', t, m.severity, m.measurable;
    END IF;
  END LOOP;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved',
         resolved_at = now(),
         closure_basis = 'verified_remeasured',
         root_cause = 'fn_lightning_settle_hand recorded rake_records.num_players as the number of payers, not the number dealt in, so the rake-law monitor priced 148 Lightning pilot hands of 2026-10-15 with too few players; the rake and drops taken were correct.',
         correction_ref = v_ref,
         resolution = 'No chips moved. The recording line was fixed in 20261015222121; 20261016101854 makes the monitor price with the players dealt in and lets the escalator re-measure a chip table. Re-measured at close: every hand on this table in the last 36 hours is on spec.'
   WHERE i.resolved_at IS NULL
     AND i.source IN ('ledger_reconcile_log:over_spec', 'ledger_reconcile_log:bbj_over_spec')
     AND i.entity_type = 'rake_law' AND i.entity_id = ANY (v_tables);
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved',
         resolved_at = now(),
         closure_basis = 'verified_remeasured',
         root_cause = 'Storm counter for the 2026-10-15 Lightning pilot rake-law findings: the escalator could not re-measure a chip rake_law entity, so it re-filed the stale findings every hour after the cause was fixed.',
         correction_ref = v_ref,
         resolution = 'No chips moved. Every capped finding was a Lightning pilot table that now re-measures on spec; 20261016101854 lets the escalator re-measure a chip table, so a fixed condition is superseded instead of re-counted.'
   WHERE i.resolved_at IS NULL
     AND i.dedupe_key IN ('storm:ledger_reconcile_log:over_spec', 'storm:ledger_reconcile_log:bbj_over_spec')
     AND NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents o
                      WHERE o.resolved_at IS NULL
                        AND o.source = i.source
                        AND o.id <> i.id
                        AND o.dedupe_key NOT LIKE 'storm:%');

  RAISE NOTICE 'closed % per-hand incidents on % tables', v_closed, array_length(v_tables, 1);
END
$close$;

COMMIT;
