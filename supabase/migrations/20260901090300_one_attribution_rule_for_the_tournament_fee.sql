-- ═══════════════════════════════════════════════════════════════════════════
-- ONE ATTRIBUTION RULE FOR ca_club_tournament_daily.fee
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED (read-only session; see the pull request).
--
-- WHAT WAS REPORTED AND WHAT IS ACTUALLY TRUE. The brief for this work said
-- ca_club_tournament_daily.fee has "two contradictory attribution rules", on
-- the evidence that 38,261 of 56,379 tournament-day pairs differ from
-- rake_records by +137,445.96 chips. Both writers do fork:
--
--     metadata ? 'user_id'   -> credit the FULL rake_amount to each of that
--                               player's clubs
--     otherwise              -> split the rake pro-rata by
--                               club_players / total_players
--
-- and those two look incompatible. Measured against production on 2026-09-01,
-- they are not, and the difference matters because it decides whether there is
-- a number to repair:
--
--   1. EVERY user-less row IS A SPIN. 28,567 rows, 123,604.12 chips, all of
--      them metadata->>'kind' = 'spin_rake', and a spin_rake row is ONE ROW
--      FOR THE WHOLE FIELD -- buy_in 20 at rake_rate 0.08 with 3 entrants
--      writes a single 4.80, not three 1.60s. Every row that names a payer
--      (tournament_entry_fee, tournament_rebuy_fee, satellite_seat_entry_fee)
--      is one player's own fee.
--
--   2. SO THE PRO-RATA BRANCH IS THE MEMBER RULE, WRITTEN AS ARITHMETIC.
--      Split a field-wide fee equally among its entrants and give each
--      entrant's share to that entrant's clubs, and club c receives
--      rake/n * (entrants of c) = rake * club_players / total_players --
--      which is the pro-rata branch exactly, because
--      SUM(club_players) over clubs IS SUM(clubs) over entrants.
--
--   3. THE +137k IS THE DELIBERATE ATTRIBUTION, NOT DRIFT. Recomputing every
--      row through the member rule gives 372,774.11 against 232,567.92 of raw
--      rake -- a factor of 1.603 that IS the intended duplication:
--      20260831010001 states it in as many words, "a player's activity is
--      attributed to their home club in each union (and each standalone
--      club)". Comparing the rollup to raw rake_records was always going to
--      show that gap and it is not a defect.
--
--   4. AGAINST THE RULE ITSELF, THE ROLLUP IS ALMOST RIGHT. Over the whole
--      table, 108,363 of 108,507 (club, tournament, day) rows agree to the
--      cent. 144 drift: net +193.21 chips, 393.81 absolute, across ten days.
--      123 of them are rows the rollup holds that the rule no longer produces
--      (+290.79) and 21 are rows the rule produces that the rollup does not
--      hold at all (-97.58) -- fees that are simply absent from a club's
--      reporting.
--
--   5. AND THE 14,774 "ROLLUP ROWS WITH NO MATCHING rake_records" ARE NOT A
--      FEE PROBLEM. There are 14,803 of them today and EVERY ONE carries
--      fee = 0.00. They are winnings-only facts, written from
--      wallet_transactions for a tournament-day on which no rake landed.
--      Reported here because the brief counted them as missing fees and they
--      are not.
--
-- SO WHAT IS ACTUALLY WRONG.
--
--   A. NOTHING STATES THE RULE. It lives twice, as two forks in two
--      procedures, and it is only knowable by doing the algebra above. That is
--      why nobody could tell 137,445.96 chips of deliberate multi-union
--      attribution from 193.21 chips of real drift -- and the drift is the
--      part somebody is owed an answer about.
--
--   B. THE WRITERS SWALLOW. Both trigger functions end in
--      `EXCEPTION WHEN OTHERS THEN RAISE WARNING`, and a RAISE WARNING from a
--      trigger on a table written by the engine goes to the Postgres log and
--      nowhere a person looks. A fee that fails to roll up is gone
--      permanently, because rake_records is append-only, so the repair trigger
--      on UPDATE/DELETE never fires and nothing revisits the row.
--
--   C. NOTHING COMPARES THE TWO. There has never been a parity check between
--      the rollup and its source.
--
-- WHAT THIS MIGRATION DOES.
--
--   * ca_reporting_tournament_fee_split IS the rule, in one place, in prose
--     and in SQL, and it is the ONLY implementation. Both writers call it.
--   * The insert trigger files instead of warning, and says so when a fee
--     resolves to no club at all.
--   * fn_club_tournament_fee_parity_check compares the stored rollup against
--     the rule -- NOT against raw rake_records, which is the comparison that
--     cannot distinguish the deliberate duplication from the drift.
--
-- WHAT IT DOES NOT DO. It does not move a chip. The rule it writes down is the
-- rule both branches were already computing, so applying this file changes no
-- existing row and no future total. THE 144 DRIFTED ROWS ARE NOT REPAIRED
-- HERE: the repair is `SELECT public.ca_refresh_reporting_rollups(d, d)` over
-- the ten affected days, which is proposed in the pull request and deliberately
-- not run from a session that was told to keep production read-only.
--
-- ONE COST, STATED. The rebuild's rake half was set-based over pre-materialized
-- entrant CTEs; it now calls the rule per rake row. A one-or-two day repair
-- (the only kind the repair trigger raises) is a few thousand rows and is
-- unaffected; a full 400-day rebuild walks ~96,000 rows and takes minutes
-- rather than seconds. That is the price of having one implementation instead
-- of two, and a rebuild already holds advisory lock 918273645 for its whole
-- duration either way.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ── THE RULE ────────────────────────────────────────────────────────────────
--
-- A tournament rake chip is attributed to THE PLAYER WHO PAID IT, and a
-- player's activity lands in their home club in each union (earliest joined),
-- plus each standalone club they belong to. That is what
-- ca_reporting_tournament_clubs_for_user returns and what 20260831010001
-- established for Club Data's tournament surfaces.
--
-- A member of clubs in three unions therefore contributes their fee to three
-- clubs in full. That is intentional: each union's Club Data page is a view of
-- ITS OWN members' activity, and a union may not see a number reduced because
-- its member also plays somewhere else. The column is a per-club reporting
-- fact, not a share of a pot, and SUM(fee) across every club is not the
-- platform's rake and never was.
--
-- A fee that names no payer was paid by the whole field. It is split equally
-- among the entrants and each share then follows the same rule. Expressed per
-- club that is rake * club_players / total_players.
CREATE OR REPLACE FUNCTION public.ca_reporting_tournament_fee_split(
  p_tournament_id uuid,
  p_rake_amount   numeric,
  p_user_id       uuid
)
RETURNS TABLE (club_id uuid, fee numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.club_id, p_rake_amount
    FROM public.ca_reporting_tournament_clubs_for_user(p_user_id) c
   WHERE p_user_id IS NOT NULL
  UNION ALL
  SELECT ec.club_id,
         p_rake_amount * ec.club_players / NULLIF(t.total_players, 0)
    FROM (
      SELECT count(*)::numeric AS total_players
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
    ) t
    CROSS JOIN LATERAL (
      SELECT c.club_id, count(*)::numeric AS club_players
        FROM public.tournament_players tp
        CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
       WHERE tp.tournament_id = p_tournament_id
       GROUP BY c.club_id
    ) ec
   WHERE p_user_id IS NULL;
$function$;

COMMENT ON FUNCTION public.ca_reporting_tournament_fee_split(uuid, numeric, uuid) IS
  'THE attribution rule for ca_club_tournament_daily.fee. A rake chip is attributed to the payer; the payer''s activity lands in their home club in each union plus each standalone club. A field-wide fee (spin_rake) names no payer and is split equally among entrants first. Both writers call this and nothing else implements it.';

-- ── The filer, for the failures that used to be a RAISE WARNING ─────────────
-- Never raises: it is called from inside the exception handler of a trigger on
-- the money path, and a filer that can throw turns a lost reporting row into a
-- lost rake row. Throttled to one row per kind per hour so a systemic failure
-- is loud rather than deafening.
CREATE OR REPLACE FUNCTION public.fn_file_reporting_fee_finding(
  p_rake_record_id uuid,
  p_tournament_id  uuid,
  p_stat_date      date,
  p_kind           text,
  p_detail         text,
  p_fee            numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recent integer;
BEGIN
  SELECT count(*) INTO v_recent
    FROM public.ledger_reconcile_log l
   WHERE l.entity_type = 'club_tournament_fee_parity'
     AND l.metadata->>'kind' = p_kind
     AND l.run_ts > now() - interval '1 hour';

  IF v_recent > 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.ledger_reconcile_log
    (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
     severity, metadata, notes)
  VALUES
    (CURRENT_DATE, now(), 'club_tournament_fee_parity', NULL,
     COALESCE(p_fee, 0), 0, 'critical',
     jsonb_build_object(
       'kind', p_kind,
       'source', 'trg_ca_reporting_rake_insert',
       'rake_record_id', p_rake_record_id,
       'tournament_id', p_tournament_id,
       'stat_date', p_stat_date,
       'fee', p_fee,
       'parity_key', p_kind,
       'detail', left(COALESCE(p_detail, ''), 500)),
     'club tournament fee ' || p_kind || ': ' || left(COALESCE(p_detail, ''), 200)
       || ' (further findings of this kind suppressed for one hour)');
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_file_reporting_fee_finding could not file %: %', p_kind, SQLERRM;
END;
$function$;

-- ── Writer 1: the insert trigger ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day  date;
  v_uid  uuid;
  v_rows integer := 0;
  r      record;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount = 0
    THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(918273645);
  v_day := (NEW.created_at AT TIME ZONE 'UTC')::date;

  -- A malformed user_id is a fee whose payer cannot be identified. It is NOT
  -- silently demoted to the field-wide branch, because that would attribute
  -- one player's fee across everyone at the event.
  IF NEW.metadata ? 'user_id' THEN
    IF NEW.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      v_uid := (NEW.metadata->>'user_id')::uuid;
    ELSE
      PERFORM public.fn_file_reporting_fee_finding(
        NEW.id, NEW.tournament_id, v_day, 'unparseable_payer',
        'metadata.user_id is not a uuid: ' || COALESCE(NEW.metadata->>'user_id', 'null'),
        NEW.rake_amount);
      RETURN NULL;
    END IF;
  END IF;

  FOR r IN
    SELECT s.club_id, s.fee
      FROM public.ca_reporting_tournament_fee_split(
             NEW.tournament_id, NEW.rake_amount, v_uid) s
     WHERE s.club_id IS NOT NULL
  LOOP
    INSERT INTO public.ca_club_tournament_daily AS d
      (club_id, tournament_id, stat_date, fee, updated_at)
    VALUES (r.club_id, NEW.tournament_id, v_day, r.fee, now())
    ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
      SET fee = d.fee + EXCLUDED.fee, updated_at = now();
    v_rows := v_rows + 1;
  END LOOP;

  IF v_rows = 0 THEN
    -- The fee was taken and no club can report it. Under the old body this
    -- was indistinguishable from a quiet event.
    PERFORM public.fn_file_reporting_fee_finding(
      NEW.id, NEW.tournament_id, v_day, 'unattributable_fee',
      'no club resolves for this fee (payer in no club, or event with no entrants)',
      NEW.rake_amount);
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- NOT `RAISE WARNING`. Still non-fatal -- the rollup may never fail the rake
  -- write -- but no longer invisible.
  PERFORM public.fn_file_reporting_fee_finding(
    NEW.id, NEW.tournament_id, v_day, 'rollup_write_failed', SQLERRM, NEW.rake_amount);
  RETURN NULL;
END;
$function$;

-- ── Writer 2: the wholesale rebuild ─────────────────────────────────────────
--
-- Transcribed from production's definition read back with pg_get_functiondef
-- on 2026-09-01. ONE change: the rake_mapped CTE, which carried the second
-- copy of the fork, now calls ca_reporting_tournament_fee_split; the
-- entrant_totals and entrant_clubs CTEs existed only to feed that fork and are
-- gone with it. Everything else -- the player rollup, the winnings half, the
-- participant facts, the range guard, the advisory lock, the counts -- is
-- byte-for-byte what production runs today.
CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups_base(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start date := LEAST(p_start, p_end);
  v_end date := GREATEST(p_start, p_end);
  v_from timestamptz;
  v_to timestamptz;
  v_players bigint;
  v_tournaments bigint;
  v_participants bigint;
BEGIN
  IF v_start IS NULL OR v_end IS NULL OR v_end - v_start > 400 THEN
    RAISE EXCEPTION 'reporting refresh requires a 0-400 day range';
  END IF;
  PERFORM pg_advisory_xact_lock(918273645);
  v_from := v_start::timestamp AT TIME ZONE 'UTC';
  v_to := (v_end + 1)::timestamp AT TIME ZONE 'UTC';

  DELETE FROM public.ca_club_player_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_daily WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_player_daily WHERE stat_date BETWEEN v_start AND v_end;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id, cm.club_id
      FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id, club_id FROM home
    UNION
    SELECT user_id, club_id FROM standalone
  ), mapped AS MATERIALIZED (
    SELECT wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           h.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id AS tournament_id
      FROM public.wallet_transactions wt
      JOIN public.tables tb ON tb.id=wt.table_id AND tb.union_id IS NOT NULL
      JOIN home h ON h.union_id=tb.union_id AND h.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('buyin','cashout') AND wt.table_id IS NOT NULL
    UNION ALL
    SELECT wt.user_id,(wt.created_at AT TIME ZONE 'UTC')::date,
           a.club_id,wt.category,wt.type,wt.amount,wt.related_entity_id
      FROM public.wallet_transactions wt
      JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty')
       AND wt.related_entity_id IS NOT NULL
  )
  INSERT INTO public.ca_club_player_daily
    (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
  SELECT m.club_id,m.user_id,m.stat_date,
         SUM(CASE WHEN m.category IN ('buyin','cashout')
                  THEN CASE WHEN m.type='credit' THEN m.amount
                            WHEN m.type='debit' THEN -m.amount ELSE 0 END ELSE 0 END),
         SUM(CASE WHEN m.category='tournament_buyin' THEN -m.amount
                  WHEN m.category IN ('prize','bounty') THEN m.amount ELSE 0 END),now()
    FROM mapped m GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id)
           uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  ), wallet_mapped AS MATERIALIZED (
    SELECT a.club_id,wt.related_entity_id AS tournament_id,wt.user_id,
           (wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN wt.category='tournament_buyin' THEN -wt.amount ELSE wt.amount END AS winnings
      FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
     WHERE wt.created_at>=v_from AND wt.created_at<v_to
       AND wt.category IN ('tournament_buyin','prize','bounty')
       AND wt.related_entity_id IS NOT NULL
  ), rake_mapped AS MATERIALIZED (
    SELECT r.tournament_id,(r.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           s.club_id, s.fee
      FROM public.rake_records r
      CROSS JOIN LATERAL public.ca_reporting_tournament_fee_split(
        r.tournament_id, r.rake_amount,
        CASE WHEN r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             THEN (r.metadata->>'user_id')::uuid END) s
     WHERE r.created_at>=v_from AND r.created_at<v_to AND r.is_tournament
       AND r.tournament_id IS NOT NULL AND r.rake_amount<>0
  ), combined AS (
    SELECT wm.club_id,wm.tournament_id,wm.stat_date,0::numeric AS fee,
           sum(wm.winnings) AS winnings FROM wallet_mapped wm GROUP BY 1,2,3
    UNION ALL
    SELECT rm.club_id,rm.tournament_id,rm.stat_date,sum(rm.fee),0::numeric
      FROM rake_mapped rm WHERE rm.club_id IS NOT NULL GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_tournament_daily
    (club_id,tournament_id,stat_date,fee,winnings,updated_at)
  SELECT club_id,tournament_id,stat_date,sum(fee),sum(winnings),now()
    FROM combined GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id,cm.user_id) uc.union_id,cm.user_id,cm.club_id
      FROM public.club_members cm JOIN public.union_clubs uc ON uc.club_id=cm.club_id
     ORDER BY uc.union_id,cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id
  ), standalone AS MATERIALIZED (
    SELECT cm.user_id,cm.club_id FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=cm.club_id)
  ), affiliations AS MATERIALIZED (
    SELECT user_id,club_id FROM home UNION SELECT user_id,club_id FROM standalone
  )
  INSERT INTO public.ca_club_tournament_player_daily
    (club_id,tournament_id,user_id,stat_date,updated_at)
  SELECT DISTINCT a.club_id,wt.related_entity_id,wt.user_id,
         (wt.created_at AT TIME ZONE 'UTC')::date,now()
    FROM public.wallet_transactions wt JOIN affiliations a ON a.user_id=wt.user_id
   WHERE wt.created_at>=v_from AND wt.created_at<v_to
     AND wt.category IN ('tournament_buyin','prize','bounty')
     AND wt.related_entity_id IS NOT NULL;

  SELECT count(*) INTO v_players FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_tournaments FROM public.ca_club_tournament_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_participants FROM public.ca_club_tournament_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  RETURN jsonb_build_object('start',v_start,'end',v_end,'player_facts',v_players,
    'tournament_facts',v_tournaments,'participant_facts',v_participants,
    'refreshed_at',now());
END;
$function$;

-- ── The parity alarm ────────────────────────────────────────────────────────
--
-- Compares the STORED rollup against THE RULE, per (club, day). Not against
-- raw rake_records: that comparison shows the 1.603 multi-union factor on
-- every club every day, which is correct behaviour, and an alarm that fires on
-- correct behaviour teaches everybody to ignore it.
CREATE OR REPLACE FUNCTION public.fn_club_tournament_fee_parity_violations(
  p_days integer DEFAULT 7
)
RETURNS TABLE (club_id uuid, stat_date date, stored_fee numeric, rule_fee numeric, drift numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH span AS (
    SELECT (CURRENT_DATE - GREATEST(COALESCE(p_days, 7), 0))::date AS d0
  ),
  rule AS (
    SELECT s.club_id AS cid,
           (r.created_at AT TIME ZONE 'UTC')::date AS d,
           sum(s.fee) AS fee
      FROM public.rake_records r
      CROSS JOIN span
      CROSS JOIN LATERAL public.ca_reporting_tournament_fee_split(
        r.tournament_id, r.rake_amount,
        CASE WHEN r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             THEN (r.metadata->>'user_id')::uuid END) s
     WHERE r.is_tournament AND r.tournament_id IS NOT NULL AND r.rake_amount <> 0
       AND r.created_at >= span.d0
       AND s.club_id IS NOT NULL
     GROUP BY 1, 2
  ),
  stored AS (
    SELECT ctd.club_id AS cid, ctd.stat_date AS d, sum(ctd.fee) AS fee
      FROM public.ca_club_tournament_daily ctd CROSS JOIN span
     WHERE ctd.stat_date >= span.d0
     GROUP BY 1, 2
  )
  SELECT COALESCE(stored.cid, rule.cid),
         COALESCE(stored.d, rule.d),
         round(COALESCE(stored.fee, 0), 2),
         round(COALESCE(rule.fee, 0), 2),
         round(COALESCE(stored.fee, 0) - COALESCE(rule.fee, 0), 2)
    FROM rule FULL OUTER JOIN stored ON stored.cid = rule.cid AND stored.d = rule.d
   WHERE abs(COALESCE(stored.fee, 0) - COALESCE(rule.fee, 0)) > 0.01;
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_tournament_fee_parity_check(
  p_days integer DEFAULT 7
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_club_tournament_fee_parity_violations(p_days)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'club_tournament_fee_parity', v.club_id,
           v.rule_fee, v.stored_fee,
           CASE WHEN abs(v.drift) >= 1 THEN 'critical' ELSE 'warn' END,
           jsonb_build_object(
             'kind', CASE WHEN v.drift > 0 THEN 'rollup_overstates' ELSE 'rollup_understates' END,
             'source', 'fn_club_tournament_fee_parity_check',
             'club_id', v.club_id,
             'stat_date', v.stat_date,
             'drift', v.drift,
             'parity_key', v.club_id::text || ':' || v.stat_date::text),
           'club tournament fee for ' || v.stat_date::text || ' holds '
             || v.stored_fee::text || ' where the attribution rule gives '
             || v.rule_fee::text || ' (drift ' || v.drift::text
             || '); repair with ca_refresh_reporting_rollups on that day'
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'club_tournament_fee_parity'
          AND l.metadata->>'parity_key' = v.club_id::text || ':' || v.stat_date::text
          AND l.metadata->>'drift' = v.drift::text)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$function$;

-- None of these is a browser surface. The split function is read by the two
-- writers and the alarm; the alarm reads every club's rake.
REVOKE ALL ON FUNCTION public.ca_reporting_tournament_fee_split(uuid, numeric, uuid)         FROM PUBLIC, anon, authenticated;
-- Restated rather than assumed. CREATE OR REPLACE does not reset privileges, so
-- the rebuild keeps the ACL it already had ({postgres=X} -- no browser role has
-- ever held it), but a migration that says nothing reads as "open" to
-- check-definer-authorization and to the next person reading this file.
REVOKE ALL ON FUNCTION public.ca_refresh_reporting_rollups_base(date, date)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_file_reporting_fee_finding(uuid, uuid, date, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_tournament_fee_parity_violations(integer)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_tournament_fee_parity_check(integer)                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_reporting_tournament_fee_split(uuid, numeric, uuid)          TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_file_reporting_fee_finding(uuid, uuid, date, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_tournament_fee_parity_violations(integer)               TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_tournament_fee_parity_check(integer)                    TO service_role;

-- Daily at 03:25 UTC over the last seven days. Daily rather than hourly
-- because the rule walks every tournament rake row in the window, and a drift
-- that has stood for ten days does not need to be found within the hour -- it
-- needs to be found at all. The (club, day, drift) guard makes a repeated run
-- free and makes a repaired day stop reappearing on its own.
SELECT cron.unschedule('club-tournament-fee-parity-daily')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'club-tournament-fee-parity-daily');
SELECT cron.schedule('club-tournament-fee-parity-daily', '25 3 * * *',
                     $cron$SELECT public.fn_club_tournament_fee_parity_check(7);$cron$);

COMMIT;
