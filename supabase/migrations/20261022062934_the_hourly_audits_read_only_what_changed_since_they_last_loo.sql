-- 20261022062934_the_hourly_audits_read_only_what_changed_since_they_last_loo.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE HOURLY AUDITS STOP HOLDING THE HOT TABLES FOR MINUTES (2026-10-22)
--
-- Full account: docs/changelog/2026-10-22-the-hourly-audits-stop-holding-the-hot-tables.md
--
-- cron.job_run_details, six hours to 04:10 UTC 2026-10-22, and what each run
-- spends its time on (read-only measurement on production; every probe a
-- single DO block that ended in RAISE, so nothing it touched was kept):
--
--   155 rake-bbj-invariant-audit-hourly  :38  avg 213 s  max 265 s
--       fn_rake_bbj_invariants 11 s. fn_bbj_reconcile_all: 1,889 pools in
--       5.7 s, plus the union pool, whose cumulative journal is 5.0M legs.
--       Its first call in a cron session is planned with the pool and the
--       opening timestamp as values, and the planner takes a created_at
--       range scan of every BBJ leg since 2026-09-04 for the rare-label
--       branch (2.36M rows removed by filter): 60-112 s. The generic plan of
--       the same statement reads the pool's own partial indexes: 5 s.
--   156 rake-attribution-drift-audit-hourly :47  avg 97 s  max 134 s
--       fn_rake_attribution_drift is LANGUAGE sql SECURITY DEFINER, so it is
--       never inlined and its window arrives as a parameter. The planner
--       prices a million hands and hash-joins all 9.2M rake_attributions
--       rows: 105 s for 9,000 hands. The same query planned with the window's
--       value is a nested loop on idx_rake_attributions_hand_id: 4 s.
--   128 club-rake-rollup-catchup  :25  avg 157 s  max 217 s
--       fn_club_table_daily_catchup(2) recounts every day's contribution
--       keys (7-20 s a day, two days) and then rebuilds yesterday on every
--       run anyway (fn_ca_reporting_rollups_from_facts, over 100 s): 24
--       rebuilds a day of a day that stopped changing at midnight. The
--       recount itself decides nothing since the rollups moved to
--       ca_club_data_fact (source_rows is now the facts' per-table maximum,
--       557,947 stored against 714,953 counted for 2026-10-21).
--   233 ca-conservation-sweep-hourly  :52  avg 99 s
--       fn_bbj_promo_bank_check reads bbj_contributions (3.4M rows) three
--       times, 12-26 s; fn_ca_payout_rows_without_money(3) is LANGUAGE sql,
--       so its window is a parameter and it scans every payout ever paid,
--       13-55 s; fn_unaccounted_seat_exits scans 6M wallet_transactions for
--       1,052 corrections, 2.5 s; the rest are small or cold-cache reads.
--   123 union-integrity-sweep  :35  avg 87 s  max 129 s
--       fn_union_integrity_sweep's co-seating signal reads every seat joined
--       in 24 hours (87,000, all but a few dozen of them horses' seats, by a
--       sequential scan of table_seats) and joins each to its table: 41 s.
--       It starts in the same minute as ca-diamond-health-watch-hourly and
--       ca-escrow-shadow-hourly.
--
-- WHAT CHANGES. Every check keeps its coverage, its rows and its verdict.
--   1. fn_bbj_reconcile always plans generically (one SET on the function).
--   2. fn_rake_attribution_drift is the same query in plpgsql, planned with
--      the window's value (force_custom_plan).
--   3. fn_bbj_promo_bank_check reads the contributions once, not three times.
--   4. fn_club_table_daily_catchup rebuilds a complete day when what it is
--      built from has moved (facts, raked hands and attributions,
--      fingerprinted in the new club_table_daily_refresh_marks), on the first
--      run that sees it, and once more on the first run twelve hours after
--      the day closed. Today is still the triggers' and still skipped. The
--      ledger-against-rollup check of every complete day is unchanged.
--   5. fn_union_integrity_sweep finds co-seated pairs from the seats of
--      players who are not horses (every counted pair has one), through
--      idx_table_seats_user. Same pairs, same counts, same order and limit.
--   6. fn_ca_payout_rows_without_money (conservation sweep, 13-55 s) is the
--      same query in plpgsql, planned with its three-day window's value, and
--      three indexes built concurrently before the transaction give it and
--      fn_unaccounted_seat_exits an index range instead of a full scan.
--   7. union-integrity-sweep starts at :33, two minutes before the two
--      watches that share :35. Nothing else is rescheduled.
--
-- No repair, backfill or new job (CLAUDE.md 10.12): this is the same nets,
-- reading less. Horses are counted exactly as before (10.5).
--
-- Pinned-preimage substitution, as 20261016013849: each live
-- pg_get_functiondef md5 is pinned, each anchor occurs exactly once, the
-- postimage md5 is asserted, and owner, SECURITY DEFINER and grants are proven
-- unchanged. Qualified natively by scripts/ci/test-the-hourly-audits-stop-holding-the-hot-tables.py.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_rake_attribution_drift(integer)'::regprocedure)) = '6a2f93c5f4370088fa0ea3634d44e780' AND md5(pg_get_functiondef('public.fn_bbj_promo_bank_check()'::regprocedure)) = '4e9689ec8ea8101765165de1b35b52c7' AND md5(pg_get_functiondef('public.fn_club_table_daily_catchup(integer)'::regprocedure)) = 'b00340b52d843fce3c7f5e4532133b89' AND md5(pg_get_functiondef('public.fn_union_integrity_sweep(uuid,integer)'::regprocedure)) = '2d206e82cdc6c2459621ace94808eae6' AND md5(pg_get_functiondef('public.fn_bbj_reconcile(uuid)'::regprocedure)) = '516d3dbfab2ab31588907ef4934771e3' AND md5(pg_get_functiondef('public.fn_ca_payout_rows_without_money(integer)'::regprocedure)) = '7d1f46dce13044b7cb90823ed08e1be4' AND EXISTS (SELECT 1 FROM cron.job WHERE jobid = 123 AND active AND schedule = '33 * * * *'))

-- Three conservation-sweep reads that scan a whole table today (built one at
-- a time, outside the transaction, before it is sent):
--   fn_ca_payout_rows_without_money reads tournament_payouts (876k rows) and
--   wallet_credit_idempotency (1.3M) end to end for three days of payouts;
--   fn_unaccounted_seat_exits reads all 6M wallet_transactions for 1,052
--   seat-exit corrections. Same queries; they now have an index each.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_payouts_paid_money ON public.tournament_payouts (paid_at) WHERE amount > 0 AND user_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_credit_idempotency_created ON public.wallet_credit_idempotency (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_seat_exit_corrections ON public.wallet_transactions (user_id) INCLUDE (description) WHERE type = 'credit' AND description LIKE 'Correction: seat exit %';

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- The fingerprint of the last rebuild of each complete reporting day.
-- Written only by fn_club_table_daily_catchup; read by nothing else.
CREATE TABLE public.club_table_daily_refresh_marks (
  stat_date date PRIMARY KEY,
  facts_fingerprint text NOT NULL,
  refreshed_at timestamptz NOT NULL
);
ALTER TABLE public.club_table_daily_refresh_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_table_daily_refresh_marks FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.club_table_daily_refresh_marks IS
  'Fingerprint (facts, raked hands, attributions) of each complete day fn_club_table_daily_catchup last rebuilt; a day is rebuilt again only when it moves. Migration 20261022062934.';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[], p_cfg text[])
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
                    AND p.proconfig IS NOT DISTINCT FROM COALESCE(p_cfg, v_cfg)) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

-- 1. The BBJ meter plans generically.
DO $r$
BEGIN
  IF md5(pg_get_functiondef('public.fn_bbj_reconcile(uuid)'::regprocedure)) <> '48bb2fe0db2df27ffb0776970dc528b6' THEN
    RAISE EXCEPTION 'fn_bbj_reconcile(uuid) is not the pinned text';
  END IF;
END $r$;
ALTER FUNCTION public.fn_bbj_reconcile(uuid) SET plan_cache_mode = 'force_generic_plan';
DO $r$
BEGIN
  IF md5(pg_get_functiondef('public.fn_bbj_reconcile(uuid)'::regprocedure)) <> '516d3dbfab2ab31588907ef4934771e3' THEN
    RAISE EXCEPTION 'fn_bbj_reconcile(uuid) does not read back as the postimage';
  END IF;
END $r$;

-- 2. The attribution drift read is planned with its window.
SELECT pg_temp.ca_audit_subst(
  'public.fn_rake_attribution_drift(integer)',
  'a0aa202661e9e9ec1b80ef893ec4f6e3', '6a2f93c5f4370088fa0ea3634d44e780',
  ARRAY[$od0$  SELECT r.hand_id,
         r.rake_amount,
         COALESCE(SUM(ra.weighted_rake_credit), 0) AS allocated,
         round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) AS difference
    FROM public.rake_records r
    LEFT JOIN public.rake_attributions ra ON ra.hand_id = r.hand_id
   WHERE r.rake_method = 'WEIGHTED_CONTRIBUTED'
     AND r.hand_id IS NOT NULL
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND r.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))
   GROUP BY r.hand_id, r.rake_amount
  HAVING round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) <> 0;
$function$
$od0$,
        $od1$ LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
$od1$],
  ARRAY[$nd0$#variable_conflict use_column
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1));
BEGIN
  /* THE WINDOW IS A VALUE WHEN THE QUERY IS PLANNED (2026-10-22). As a
     LANGUAGE sql SECURITY DEFINER function this query was planned with the
     window as an unknown parameter, priced at a million hands, and hash-joined
     every one of the 9.2M rake_attributions rows: 105 s for the 9,000 hands
     of a two-hour window (rake-attribution-drift-audit-hourly, 97 s average).
     Planned with the window's value (force_custom_plan), each hand reads its
     own attributions through idx_rake_attributions_hand_id: about 4 s.
     The query, its rows, columns and rounding are unchanged. */
  RETURN QUERY
  SELECT r.hand_id,
         r.rake_amount,
         COALESCE(SUM(ra.weighted_rake_credit), 0) AS allocated,
         round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) AS difference
    FROM public.rake_records r
    LEFT JOIN public.rake_attributions ra ON ra.hand_id = r.hand_id
   WHERE r.rake_method = 'WEIGHTED_CONTRIBUTED'
     AND r.hand_id IS NOT NULL
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND r.created_at > v_since
   GROUP BY r.hand_id, r.rake_amount
  HAVING round(r.rake_amount - COALESCE(SUM(ra.weighted_rake_credit), 0), 2) <> 0;
END
$function$
$nd0$,
        $nd1$ LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
$nd1$],
  ARRAY['search_path=public', 'plan_cache_mode=force_custom_plan']);

-- 3. The promo bank check reads the contributions once.
SELECT pg_temp.ca_audit_subst(
  'public.fn_bbj_promo_bank_check()',
  '94b115192b2b6c2196808b614917fd12', '4e9689ec8ea8101765165de1b35b52c7',
  ARRAY[$op0$  WITH t AS (
    SELECT
      (SELECT COALESCE(sum(promo_portion),0) FROM bbj_contributions)                             AS contributed,
$op0$,
        $op1$      (SELECT COALESCE(sum(amount),0) FROM bbj_contributions
        WHERE main_portion IS NULL AND backup_portion IS NULL AND promo_portion IS NULL)         AS pre_triple_bank,
$op1$,
        $op2$      (SELECT CASE WHEN COALESCE(sum(amount),0) > 0
                   THEN COALESCE(sum(promo_portion),0) / sum(amount) ELSE 0 END
         FROM bbj_contributions WHERE promo_portion IS NOT NULL)                                 AS observed_rate
$op2$],
  ARRAY[$np0$  /* ONE READ OF THE CONTRIBUTIONS (2026-10-22). The three contribution
     figures were three full scans of bbj_contributions (3.4M rows, 12-25 s
     inside the hourly conservation sweep). They are one scan now; each figure
     is the same aggregate over the same rows it was before. */
  WITH c AS (
    SELECT COALESCE(sum(promo_portion),0) AS contributed,
           COALESCE(sum(amount) FILTER (WHERE main_portion IS NULL AND backup_portion IS NULL
                                          AND promo_portion IS NULL),0) AS pre_triple_bank,
           COALESCE(sum(amount) FILTER (WHERE promo_portion IS NOT NULL),0) AS rated_amount,
           COALESCE(sum(promo_portion) FILTER (WHERE promo_portion IS NOT NULL),0) AS rated_promo
      FROM bbj_contributions
  ), t AS (
    SELECT
      (SELECT c.contributed FROM c)                                                             AS contributed,
$np0$,
        $np1$      (SELECT c.pre_triple_bank FROM c)                                                         AS pre_triple_bank,
$np1$,
        $np2$      (SELECT CASE WHEN c.rated_amount > 0
                   THEN c.rated_promo / c.rated_amount ELSE 0 END
         FROM c)                                                                                AS observed_rate
$np2$],
  NULL);

-- 4. A complete reporting day is rebuilt when it moves.
SELECT pg_temp.ca_audit_subst(
  'public.fn_club_table_daily_catchup(integer)',
  'a33a8f453c08478ce314625649e2b42f', 'b00340b52d843fce3c7f5e4532133b89',
  ARRAY[$oc0$  v_stored bigint;
  v_actual bigint;
$oc0$,
        $oc1$  FOR d IN SELECT gs::date FROM generate_series(v_today - (v_n - 1), v_today, interval '1 day') gs LOOP
    SELECT COALESCE(SUM(c.source_rows), 0) INTO v_stored
      FROM club_table_daily c WHERE c.stat_date = d;

    -- The same reading of contributions the refresh uses (uuid-keyed rows,
    -- plus one synthetic row per hand with no usable contribution), so a
    -- stored count matches an actual count exactly when nothing has changed.
    SELECT (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
        CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.player_contributions IS NOT NULL
         AND r.rake_amount > 0
         AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) x
            WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    ) + (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.rake_amount > 0
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) e
            WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
    ) INTO v_actual;

    IF d >= v_today - 1 OR v_stored IS DISTINCT FROM v_actual THEN
      PERFORM fn_club_table_daily_refresh_day(d);
      v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
    END IF;

$oc1$],
  ARRAY[$nc0$  v_mark text;
  v_f text; v_h text; v_a text;
  v_lo timestamptz;
  v_hi timestamptz;
$nc0$,
        $nc1$  FOR d IN SELECT gs::date FROM generate_series(v_today - (v_n - 1), v_today, interval '1 day') gs LOOP
    /* A COMPLETE DAY IS REBUILT WHEN WHAT IT IS BUILT FROM HAS MOVED
       (2026-10-22). Yesterday was rebuilt on every run, 24 times a day,
       whether or not anything had changed, and before deciding that, every
       day in the window was recounted from its contribution keys even though
       the answer was ignored for yesterday and today: 100-200 s of every
       club-rake-rollup-catchup run, reading clubs, tables and the day's rake
       for minutes. A complete day is now rebuilt on the first run that sees
       it, whenever its facts, raked hands or rake attributions change (their
       count, sums and latest write are fingerprinted in
       club_table_daily_refresh_marks), and once more on the first run twelve
       hours after the day closed, so anything that settles late is read. Today
       is the triggers' and fn_club_table_daily_refresh_day skips it, exactly
       as before. */
    IF d >= v_today THEN
      PERFORM fn_club_table_daily_refresh_day(d);
      v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
    ELSE
      v_lo := (d::timestamp AT TIME ZONE 'UTC');
      v_hi := ((d + 1)::timestamp AT TIME ZONE 'UTC');
      -- Three reads, each one index range (about 0.2 s apiece).
      SELECT concat_ws('|', count(*), sum(x.fee), sum(x.buyins), sum(x.cashouts),
                       sum(x.winnings), max(x.last_at))
        INTO v_f
        FROM ca_club_data_fact x
       WHERE x.club_id = ANY (ARRAY(SELECT k.id FROM clubs k)) AND x.stat_date = d;
      SELECT concat_ws('|', count(*), sum(r.rake_amount))
        INTO v_h
        FROM rake_records r
       WHERE r.created_at >= v_lo AND r.created_at < v_hi AND r.rake_amount > 0;
      SELECT concat_ws('|', count(*), sum(ra.rake_amount))
        INTO v_a
        FROM rake_attributions ra
       WHERE ra.club_id = ANY (ARRAY(SELECT k.id FROM clubs k))
         AND ra.created_at >= v_lo AND ra.created_at < v_hi;
      v_mark := md5(concat_ws('#', v_f, v_h, v_a));
      IF NOT EXISTS (SELECT 1 FROM club_table_daily_refresh_marks m
                      WHERE m.stat_date = d AND m.facts_fingerprint = v_mark
                        AND (m.refreshed_at >= v_hi + interval '12 hours'
                             OR now() < v_hi + interval '12 hours')) THEN
        PERFORM fn_club_table_daily_refresh_day(d);
        INSERT INTO club_table_daily_refresh_marks (stat_date, facts_fingerprint, refreshed_at)
        VALUES (d, v_mark, now())
        ON CONFLICT (stat_date) DO UPDATE
          SET facts_fingerprint = EXCLUDED.facts_fingerprint,
              refreshed_at = EXCLUDED.refreshed_at;
        v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
      END IF;
    END IF;

$nc1$],
  NULL);

-- 5. Co-seating is found from the seats of players who are not horses.
SELECT pg_temp.ca_audit_subst(
  'public.fn_union_integrity_sweep(uuid,integer)',
  'b3adb49ea93ac361b16c3c7ed19a865d', '2d206e82cdc6c2459621ace94808eae6',
  ARRAY[$os0$  -- Co-seating, excluding horse-vs-horse (simulated players always co-seat).
  SELECT COALESCE(jsonb_agg(y), '[]'::jsonb) INTO v_coseat_flags FROM (
    SELECT jsonb_build_object('player_a', a.user_id, 'player_b', b.user_id,
                              'shared_tables', count(DISTINCT a.table_id)) AS y
      FROM table_seats a
      JOIN table_seats b ON b.table_id = a.table_id AND b.user_id > a.user_id
      JOIN tables t ON t.id = a.table_id AND t.union_id = p_union_id
      LEFT JOIN profiles pa ON pa.id = a.user_id
      LEFT JOIN profiles pb ON pb.id = b.user_id
     WHERE a.joined_at >= v_from AND b.joined_at >= v_from
       AND NOT (COALESCE(pa.is_horse,false) AND COALESCE(pb.is_horse,false))
     GROUP BY a.user_id, b.user_id
    HAVING count(DISTINCT a.table_id) >= 8
     ORDER BY count(DISTINCT a.table_id) DESC
     LIMIT 20
  ) s2;
$os0$],
  ARRAY[$ns0$  -- Co-seating, excluding horse-vs-horse (simulated players always co-seat).
  /* EVERY PAIR THIS COUNTS HAS A PLAYER WHO IS NOT A HORSE (2026-10-22), so
     the pairs are found from those players' seats, read through
     idx_table_seats_user, and their tablemates through idx_table_seats_table.
     It read every seat joined in the window (87,000 a day, all but a few
     dozen of them horses' seats, with no index on joined_at) and joined each
     one to its table: 41 s cold inside union-integrity-sweep. A seat whose
     player has no profile row cannot exist (fk_table_seats_user_id_profiles)
     and a seat with no player cannot pair. Same pairs, same counts, same
     order and limit. */
  SELECT COALESCE(jsonb_agg(y), '[]'::jsonb) INTO v_coseat_flags FROM (
    SELECT jsonb_build_object('player_a', pr.a, 'player_b', pr.b,
                              'shared_tables', count(DISTINCT pr.table_id)) AS y
      FROM (SELECT LEAST(h.user_id, o.user_id) AS a, GREATEST(h.user_id, o.user_id) AS b,
                   h.table_id
              FROM profiles hp
              CROSS JOIN LATERAL (
                SELECT ts.user_id, ts.table_id
                  FROM table_seats ts
                 WHERE ts.user_id = hp.id AND ts.joined_at >= v_from) h
              JOIN tables t ON t.id = h.table_id AND t.union_id = p_union_id
              JOIN table_seats o ON o.table_id = h.table_id AND o.user_id <> h.user_id
                                AND o.joined_at >= v_from
             WHERE NOT COALESCE(hp.is_horse, false)) pr
     GROUP BY pr.a, pr.b
    HAVING count(DISTINCT pr.table_id) >= 8
     ORDER BY count(DISTINCT pr.table_id) DESC
     LIMIT 20
  ) s2;
$ns0$],
  NULL);

-- 6. Payout rows are read for the window asked, planned with its value.
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_payout_rows_without_money(integer)',
  'f5cf519b32f61707d283d634c39190f2', '7d1f46dce13044b7cb90823ed08e1be4',
  ARRAY[$op0$    SELECT p.tournament_id, t.name, p.user_id, p.position, p.source, p.amount, p.paid_at, p.idempotency_key
      FROM public.tournament_payouts p
      JOIN public.tournaments t ON t.id = p.tournament_id
     WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay',
                        'hu_shortfall', 'late_reg_adjustment', 'final_table_deal', 'bubble_protection')
       AND p.user_id IS NOT NULL
       AND p.amount > 0
       AND p.paid_at > now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1))
       AND p.paid_at > (SELECT min(created_at) FROM public.wallet_credit_idempotency)
       AND (p.idempotency_key IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency w
                            WHERE w.key = p.idempotency_key))
     ORDER BY p.paid_at DESC;
  $function$
$op0$,
        $op1$ LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
$op1$],
  ARRAY[$np0$#variable_conflict use_column
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1));
BEGIN
  /* THE WINDOW IS A VALUE WHEN THE QUERY IS PLANNED (2026-10-22). As a
     LANGUAGE sql SECURITY DEFINER function the window arrived as an unknown
     parameter, so the three days the conservation sweep asks for were read as
     every payout ever paid: a sequential scan of tournament_payouts (876k
     rows) and of wallet_credit_idempotency for its earliest row, 13-55 s.
     Planned with its value, the window reads idx_tournament_payouts_paid_money
     and the earliest row reads idx_wallet_credit_idempotency_created. Same
     query, same rows, same order. */
  RETURN QUERY
    SELECT p.tournament_id, t.name, p.user_id, p.position, p.source, p.amount, p.paid_at, p.idempotency_key
      FROM public.tournament_payouts p
      JOIN public.tournaments t ON t.id = p.tournament_id
     WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay',
                        'hu_shortfall', 'late_reg_adjustment', 'final_table_deal', 'bubble_protection')
       AND p.user_id IS NOT NULL
       AND p.amount > 0
       AND p.paid_at > v_since
       AND p.paid_at > (SELECT min(w0.created_at) FROM public.wallet_credit_idempotency w0)
       AND (p.idempotency_key IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency w
                            WHERE w.key = p.idempotency_key))
     ORDER BY p.paid_at DESC;
END
$function$
$np0$,
        $np1$ LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
$np1$],
  ARRAY['search_path=public, pg_temp', 'plan_cache_mode=force_custom_plan']);

-- 7. union-integrity-sweep starts at :33.
DO $j$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job j
                  WHERE j.jobid = 123 AND j.jobname = 'union-integrity-sweep' AND j.active
                    AND j.schedule = '35 * * * *'
                    AND md5(j.command) = 'fad2554bd572612f594c24b809dad49c') THEN
    RAISE EXCEPTION 'preimage: cron job 123 is not the job read on 2026-10-22';
  END IF;
END $j$;

SELECT cron.alter_job(123, schedule := '33 * * * *');

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job j
                  WHERE j.jobid = 123 AND j.active AND j.schedule = '33 * * * *'
                    AND md5(j.command) = 'fad2554bd572612f594c24b809dad49c') THEN
    RAISE EXCEPTION 'cron job 123 is not as intended';
  END IF;
END $post$;

COMMIT;
