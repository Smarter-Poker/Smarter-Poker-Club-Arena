BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 6 OF 8 (UNION ACCOUNTING) - THE VERIFICATION PASS, 2026-09-08.
   ---------------------------------------------------------------------------
   Dan: "do a deep dive and verify that everything you've built in the previous
   phase is 100% fully built, coded, wired in and tested." Five defects found in
   Phase 6's own work and one it exposed. Each is fixed here, at the source.

   1. THE ONE BASIS WAS TOO SLOW FOR THE PEOPLE WHO READ IT. fn_union_club_rake_basis
      computes a full Pacific week from 251,895 treasury credits and 57,508
      tournaments in 15-25 seconds even after two new indexes
      (idx_ca_union_rake_attr_basis, idx_tournament_players_basis, built
      CONCURRENTLY 2026-09-07 22:46 UTC; cash part 7.6s -> 0.3s). Round 1 has a
      two-minute budget and does not care. fn_union_reconciliation_report is
      callable by a signed-in union lead with an eight-second statement timeout
      and went from ~7s (P&L 6s + the old rollup) to 31.5s. A closed period was
      already instant (the witness). The open week was not.

      So: the open week is SNAPSHOTTED. fn_union_rake_basis_refresh computes the
      one function live and stores its rows (union_rake_basis_snapshot); the
      hourly integrity sweep refreshes it (World Hub CLAUDE.md 11.3: the sweep
      is the home for periodic union work); every reader gets the snapshot for
      an open window whose start matches and whose end is at or after the
      snapshot's 'through'. Round 1 passes p_live := true and never reads a
      snapshot: it computes at close time and stores the witness, as before.
      The snapshot is the function's own output, stored - not a second formula.

   2. fn_union_money_report attributed "rake this week" and "what each club is
      owed at the next close" to the HOSTING club with a flat rate - a third
      basis, on an authenticated report, written by another agent at 21:08
      2026-09-07 while Phase 6 was in flight. It now reads the one basis.

   3. fn_union_issue_weekly_invoices honoured neither the settlement floor nor
      weekly_invoices_enabled - only the cascade did - and the Open Claw safety
      net (/api/club-arena/union-invoice?action=send, Mon 13:00 UTC) calls the
      function directly. It also issued a statement saying "rakeback already
      moved in chips" for a period whose round 1 had not run. All three guards
      now live in the function: floor, setting, and a final union_rakeback_close
      for exactly that period.

   4. THE GHOST-TWIN RULE WAS TOO LOOSE. Hand numbers below 1,000,000 recurred
      per table before 2026-07-31 (uq_hand_history_global_hand_number is unique
      only from 1,000,000 up). Of 2,574 loose twins, 2,478 carry a global
      number and match exactly one linked row; the 96 small-numbered ones match
      up to several hands and are not provably the same hand (63 multi-link).
      The rule now requires a global number, lives in ONE function
      (fn_rake_record_is_ghost_twin), and is read by fn_rakeback_recompute_day
      AND by the payer's cold fallback scan in fn_close_settlement_period, which
      carried a second copy of the row predicate.

   5. Nothing in Phase 6 recorded the two indexes in a migration file. They are
      declared here (IF NOT EXISTS: already built concurrently, this is a no-op
      that keeps the repo file equal to what production has). */

DO $guard$
DECLARE bad text := '';
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz)'::regprocedure)) <> '79f4ccde0cb361cc918123c5f618c9d8' THEN bad := bad || ' fn_union_club_rake_basis'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure)) <> '13c0fc89a9a3fc1a9f5d9f88ecd6bfa8' THEN bad := bad || ' fn_union_weekly_rakeback_close'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_money_report(uuid)'::regprocedure)) <> '6deb281db70e827a582f023793058128' THEN bad := bad || ' fn_union_money_report'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) <> 'd40af7075f1831c342abf0cb20468634' THEN bad := bad || ' fn_union_issue_weekly_invoices'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) <> '37e2a3d08faa3117f841d0d807505f38' THEN bad := bad || ' fn_union_integrity_sweep_all'; END IF;
  IF md5(pg_get_functiondef('public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure)) <> '27c6f49bb424aa74d7901bd643ccdb8f' THEN bad := bad || ' fn_rakeback_recompute_day'; END IF;
  IF md5(pg_get_functiondef('public.fn_close_settlement_period(uuid)'::regprocedure)) <> '4c4ee6f81d6c45327a711ef9e9652aa5' THEN bad := bad || ' fn_close_settlement_period'; END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'changed since the 2026-09-08 01:57 UTC audit; re-read before applying:%', bad; END IF;
END $guard$;

/* 5. the indexes, on the record */
CREATE INDEX IF NOT EXISTS idx_ca_union_rake_attr_basis
  ON public.ca_union_rake_attribution (union_id, played_at) INCLUDE (club_id, rake_share) WHERE club_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournament_players_basis
  ON public.tournament_players (tournament_id) INCLUDE (club_id, rebuys, add_on);

/* 1. the snapshot of the open week */
CREATE TABLE IF NOT EXISTS public.union_rake_basis_snapshot (
  union_id     uuid        NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  through      timestamptz NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  compute_ms   integer,
  detail       jsonb       NOT NULL,
  PRIMARY KEY (union_id, period_start, period_end)
);
ALTER TABLE public.union_rake_basis_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.union_rake_basis_snapshot FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.union_rake_basis_snapshot TO service_role;
COMMENT ON TABLE public.union_rake_basis_snapshot IS
  'The open week''s fn_union_club_rake_basis rows, stored hourly by fn_union_rake_basis_refresh from the integrity sweep. Readers of an open window get these; round 1 never does (p_live). A closed period is read from ca_settlements.totals.basis_detail instead.';

DROP FUNCTION public.fn_union_club_rake_basis(uuid, timestamptz, timestamptz);

CREATE FUNCTION public.fn_union_club_rake_basis(p_union_id uuid, p_start timestamptz, p_end timestamptz, p_live boolean DEFAULT false)
RETURNS TABLE(club_id uuid, game_type text, rake_in numeric, rate numeric, payout numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sref text;
BEGIN
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN;
  END IF;

  /* THE WITNESS FIRST. A period that has been closed stored the rows it was
     paid from; a statement for that period describes THAT, never a
     recomputation over attribution tables that may since have moved. */
  v_sref := p_union_id::text || ':'
    || to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  IF EXISTS (SELECT 1 FROM public.ca_settlements s
              WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
                AND s.state = 'final' AND s.external_ref = v_sref
                AND s.totals ? 'basis_detail') THEN
    RETURN QUERY
      SELECT (d->>'club_id')::uuid, d->>'game_type',
             (d->>'rake_in')::numeric, (d->>'rate')::numeric, (d->>'payout')::numeric
        FROM public.ca_settlements s
        CROSS JOIN LATERAL jsonb_array_elements(s.totals->'basis_detail') d
       WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
         AND s.state = 'final' AND s.external_ref = v_sref;
    RETURN;
  END IF;

  /* THE SNAPSHOT SECOND (Phase 6 verification, 20260908). An OPEN window is
     served from the hourly snapshot when its start matches and its end is at
     or after the snapshot's 'through' - a reader with an eight-second budget
     gets the same rows the sweep computed within the hour. Round 1 passes
     p_live and never reads this: it computes at close time and stores the
     witness above. */
  IF NOT p_live THEN
    IF EXISTS (SELECT 1 FROM public.union_rake_basis_snapshot s
                WHERE s.union_id = p_union_id AND s.period_start = p_start
                  AND p_end >= s.through AND p_end <= s.period_end
                  AND s.computed_at > now() - interval '3 hours') THEN
      RETURN QUERY
        SELECT (d->>'club_id')::uuid, d->>'game_type',
               (d->>'rake_in')::numeric, (d->>'rate')::numeric, (d->>'payout')::numeric
          FROM public.union_rake_basis_snapshot s
          CROSS JOIN LATERAL jsonb_array_elements(s.detail) d
         WHERE s.union_id = p_union_id AND s.period_start = p_start
           AND p_end >= s.through AND p_end <= s.period_end
           AND s.computed_at > now() - interval '3 hours';
      RETURN;
    END IF;
  END IF;

  /* THE BASIS (Dan, 2026-09-03): each member club's share is the rake ITS
     PLAYERS generated at the union's tables - cash from
     ca_union_rake_attribution (the seat the player sat through, captured
     hourly), tournaments / SNGs / spins from tournament_players (each
     treasury credit that names a tournament, split by entries: 1 + rebuys +
     add-on). The union's own house club and anything unattributed stay
     with the union.

     THE RATE (Dan, 2026-09-03): resolved per game type per club, falling back
     to club_commission_rate and then to 0.90. Truncated to the cent per
     (club, game type) so a remainder stays with the union.

     Same arithmetic as the block round 1 paid from between 20260903 and
     20260907 (proven row-identical below); the tournament split now groups
     the credits per tournament BEFORE joining tournaments and
     tournament_players, which is the same sum in far fewer rows. */
  RETURN QUERY
  WITH raw AS (
    SELECT t.amount,
           substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM public.union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= p_start AND t.created_at < p_end
  ), tsum AS (
    SELECT r.tournament_id, sum(r.amount) AS amt
      FROM raw r WHERE r.tournament_id IS NOT NULL GROUP BY r.tournament_id
  ), tgame AS (
    SELECT s.tournament_id, s.amt, COALESCE(lower(tr.tournament_type), 'other') AS game_type
      FROM tsum s LEFT JOIN public.tournaments tr ON tr.id = s.tournament_id
  ), cash AS (
    SELECT a.club_id, 'cash'::text AS game_type, sum(a.rake_share) AS rake
      FROM public.ca_union_rake_attribution a
     WHERE a.union_id = p_union_id
       AND a.played_at >= p_start AND a.played_at < p_end
       AND a.club_id IS NOT NULL
     GROUP BY a.club_id
  ), tw AS (
    SELECT tp.tournament_id, tp.club_id,
           sum(1 + COALESCE(tp.rebuys, 0) + CASE WHEN tp.add_on THEN 1 ELSE 0 END)::numeric AS w
      FROM public.tournament_players tp
      JOIN tsum s ON s.tournament_id = tp.tournament_id
     GROUP BY tp.tournament_id, tp.club_id
  ), tt AS (
    SELECT tw.tournament_id, sum(tw.w) AS total FROM tw GROUP BY tw.tournament_id
  ), tourney AS (
    SELECT tw.club_id, g.game_type, sum(g.amt * tw.w / NULLIF(tt.total, 0)) AS rake
      FROM tgame g
      JOIN tw ON tw.tournament_id = g.tournament_id
      JOIN tt ON tt.tournament_id = g.tournament_id
     WHERE tw.club_id IS NOT NULL
     GROUP BY tw.club_id, g.game_type
  ), basis AS (
    SELECT x.club_id, x.game_type, sum(x.rake) AS rake_in FROM (
      SELECT cash.club_id, cash.game_type, cash.rake FROM cash
      UNION ALL
      SELECT tourney.club_id, tourney.game_type, tourney.rake FROM tourney) x
     GROUP BY x.club_id, x.game_type
  )
  SELECT b.club_id,
         b.game_type,
         round(b.rake_in, 2) AS rake_in,
         COALESCE(
           CASE b.game_type
             WHEN 'cash'      THEN uc.rate_cash
             WHEN 'mtt'       THEN uc.rate_mtt
             WHEN 'sng'       THEN uc.rate_sng
             WHEN 'spin'      THEN uc.rate_spin
             WHEN 'satellite' THEN uc.rate_satellite
             ELSE NULL
           END,
           uc.club_commission_rate,
           0.90) AS rate,
         trunc(round(b.rake_in, 2)
               * COALESCE(
                   CASE b.game_type
                     WHEN 'cash'      THEN uc.rate_cash
                     WHEN 'mtt'       THEN uc.rate_mtt
                     WHEN 'sng'       THEN uc.rate_sng
                     WHEN 'spin'      THEN uc.rate_spin
                     WHEN 'satellite' THEN uc.rate_satellite
                     ELSE NULL
                   END,
                   uc.club_commission_rate,
                   0.90)
               * 100) / 100 AS payout
    FROM basis b
    JOIN public.union_clubs uc ON uc.union_id = p_union_id AND uc.club_id = b.club_id
   WHERE b.club_id <> p_union_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_club_rake_basis(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_rake_basis(uuid, timestamptz, timestamptz, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_refresh(p_union_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_through timestamptz; v_t0 timestamptz := clock_timestamp(); v_detail jsonb; v_n int;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_platform_admin()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;
  v_through := LEAST(p_end, now());
  IF v_through <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'window_not_open_yet');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true) b;

  INSERT INTO public.union_rake_basis_snapshot (union_id, period_start, period_end, through, computed_at, compute_ms, detail)
  VALUES (p_union_id, p_start, p_end, v_through, now(),
          (extract(epoch from clock_timestamp() - v_t0) * 1000)::int, v_detail)
  ON CONFLICT (union_id, period_start, period_end) DO UPDATE
    SET through = EXCLUDED.through, computed_at = EXCLUDED.computed_at,
        compute_ms = EXCLUDED.compute_ms, detail = EXCLUDED.detail;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'period_start', p_start,
                            'period_end', p_end, 'through', v_through, 'rows', v_n,
                            'compute_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_union_rake_basis_refresh(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_rake_basis_refresh(uuid, timestamptz, timestamptz) TO service_role;

/* round 1 computes live, always */
DO $close$
DECLARE v_def text; v_new text;
  v_old constant text := 'FROM public.fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end) b;';
  v_rep constant text := 'FROM public.fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end, true) b;';
BEGIN
  v_def := pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure);
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'close: basis call anchor not found'; END IF;
  v_new := replace(v_def, v_old, v_rep);
  IF v_new = v_def THEN RAISE EXCEPTION 'close: nothing changed'; END IF;
  EXECUTE v_new;
END $close$;

/* the sweep refreshes the open week, every hour, for every union */
DO $sweep$
DECLARE v_def text; v_new text;
  v_anchor constant text := '    -- Age and chase what is past due, before enforcement reads it.';
  v_block constant text :=
       '    -- The open week''s rake basis, snapshotted so every reader with an' || E'\n'
    || '    -- eight-second budget gets the rows the one function computed within' || E'\n'
    || '    -- the hour (Phase 6 verification, 20260908). Never stops the sweep.' || E'\n'
    || '    BEGIN' || E'\n'
    || '      PERFORM public.fn_union_rake_basis_refresh(u.id, public.fn_union_week_start(now()),' || E'\n'
    || '                                                 public.fn_union_week_start(now()) + interval ''7 days'');' || E'\n'
    || '    EXCEPTION WHEN OTHERS THEN' || E'\n'
    || '      INSERT INTO financial_alerts (source, severity, message, context)' || E'\n'
    || '      VALUES (''fn_union_rake_basis_refresh'', ''warning'',' || E'\n'
    || '              ''Refreshing the open-week rake basis snapshot failed for a union'',' || E'\n'
    || '              jsonb_build_object(''union_id'', u.id, ''error'', SQLERRM));' || E'\n'
    || '    END;' || E'\n\n';
BEGIN
  v_def := pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure);
  IF position(v_anchor IN v_def) = 0 THEN RAISE EXCEPTION 'sweep: anchor not found'; END IF;
  v_new := replace(v_def, v_anchor, v_block || v_anchor);
  IF v_new = v_def THEN RAISE EXCEPTION 'sweep: nothing changed'; END IF;
  EXECUTE v_new;
END $sweep$;

/* 2. the money report reads the one basis */
DO $money$
DECLARE v_def text; v_new text;
  v_old_join constant text :=
       '      LEFT JOIN (' || E'\n'
    || '        SELECT club_id, SUM(amount) amt FROM union_wallet_transactions' || E'\n'
    || '         WHERE union_id = v_union_id AND wallet=''rake_wallet'' AND direction=''credit''' || E'\n'
    || '           AND tx_type=''rake'' AND created_at >= v_week_start' || E'\n'
    || '         GROUP BY club_id) t ON t.club_id = c.id';
  v_new_join constant text :=
       '      LEFT JOIN (' || E'\n'
    || '        -- Phase 6 (20260908): the one basis - the rows the next close pays on,' || E'\n'
    || '        -- by the club of the PLAYER, per game type - from the hourly snapshot.' || E'\n'
    || '        SELECT b.club_id, SUM(b.rake_in) amt, SUM(b.payout) pay' || E'\n'
    || '          FROM public.fn_union_club_rake_basis(v_union_id, v_week_start, now()) b' || E'\n'
    || '         GROUP BY b.club_id) t ON t.club_id = c.id';
  v_old_proj constant text := '''projected_rakeback'', trunc(COALESCE(t.amt,0) * COALESCE(uc.club_commission_rate,0.90) * 100)/100,';
  v_new_proj constant text := '''projected_rakeback'', round(COALESCE(t.pay,0),2),';
BEGIN
  v_def := pg_get_functiondef('public.fn_union_money_report(uuid)'::regprocedure);
  IF position(v_old_join IN v_def) = 0 THEN RAISE EXCEPTION 'money report: join anchor not found'; END IF;
  IF position(v_old_proj IN v_def) = 0 THEN RAISE EXCEPTION 'money report: projection anchor not found'; END IF;
  v_new := replace(replace(v_def, v_old_join, v_new_join), v_old_proj, v_new_proj);
  IF v_new = v_def THEN RAISE EXCEPTION 'money report: nothing changed'; END IF;
  EXECUTE v_new;
END $money$;

/* 3. the statement function carries its own guards */
DO $inv$
DECLARE v_def text; v_new text;
  v_anchor constant text := '  v_due := v_to + interval ''3 days'';';
  v_block constant text :=
       '  /* THE GUARDS LIVE HERE, NOT ONLY IN THE CASCADE (Phase 6 verification,' || E'\n'
    || '     20260908). The Open Claw safety net calls this function directly. */' || E'\n'
    || '  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f' || E'\n'
    || '              WHERE f.union_id = p_union_id AND v_from < f.earliest_period_start) THEN' || E'\n'
    || '    RETURN jsonb_build_object(''success'', false, ''error'', ''before_settlement_floor'',' || E'\n'
    || '                              ''period_start'', v_from, ''period_end'', v_to);' || E'\n'
    || '  END IF;' || E'\n'
    || '  IF public.fn_union_setting(p_union_id, ''weekly_invoices_enabled'', 1) <> 1 THEN' || E'\n'
    || '    RETURN jsonb_build_object(''success'', false, ''error'', ''weekly_invoices_disabled'',' || E'\n'
    || '                              ''period_start'', v_from, ''period_end'', v_to);' || E'\n'
    || '  END IF;' || E'\n'
    || '  -- A statement says "rakeback already moved in chips". It is issued only for a' || E'\n'
    || '  -- period whose round 1 is final, and then it reads that round''s own rows.' || E'\n'
    || '  IF NOT EXISTS (SELECT 1 FROM public.ca_settlements s' || E'\n'
    || '                  WHERE s.settlement_type = ''union_rakeback_close'' AND s.union_id = p_union_id' || E'\n'
    || '                    AND s.state = ''final''' || E'\n'
    || '                    AND s.external_ref = p_union_id::text || '':''' || E'\n'
    || '                      || to_char(v_from at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS"Z"'') || ''..''' || E'\n'
    || '                      || to_char(v_to   at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS"Z"'')) THEN' || E'\n'
    || '    RETURN jsonb_build_object(''success'', false, ''error'', ''period_not_closed'',' || E'\n'
    || '                              ''period_start'', v_from, ''period_end'', v_to);' || E'\n'
    || '  END IF;' || E'\n\n';
BEGIN
  v_def := pg_get_functiondef('public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
  IF position(v_anchor IN v_def) = 0 THEN RAISE EXCEPTION 'invoices: anchor not found'; END IF;
  v_new := replace(v_def, v_anchor, v_block || v_anchor);
  IF v_new = v_def THEN RAISE EXCEPTION 'invoices: nothing changed'; END IF;
  EXECUTE v_new;
END $inv$;

/* 4. one ghost-twin rule, in one place */
CREATE OR REPLACE FUNCTION public.fn_rake_record_is_ghost_twin(p_hand_id uuid, p_table_id uuid, p_metadata jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  /* A null-hand rake_records row is a ghost twin when the same table carries a
     LINKED row for the same GLOBAL hand number. Hand numbers are unique only
     from 1,000,000 up (uq_hand_history_global_hand_number); below that they
     recurred per table before 2026-07-31 and a match proves nothing. */
  SELECT p_hand_id IS NULL
     AND p_table_id IS NOT NULL
     AND COALESCE(p_metadata->>'hand_number', '') ~ '^[0-9]{1,18}$'
     AND (p_metadata->>'hand_number')::bigint >= 1000000
     AND EXISTS (SELECT 1 FROM public.rake_records l
                  WHERE l.table_id = p_table_id AND l.hand_id IS NOT NULL
                    AND l.metadata->>'hand_number' = p_metadata->>'hand_number');
$function$;
REVOKE ALL ON FUNCTION public.fn_rake_record_is_ghost_twin(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_record_is_ghost_twin(uuid, uuid, jsonb) TO service_role;

DO $day$
DECLARE v_def text; v_new text; v_n int;
  v_old constant text := E'\n'
    || '       /* ONE HAND, ONE RECORD (Phase 6, 20260907): a null-hand row whose' || E'\n'
    || '          (table, hand number) also has a linked row is that hand''s ghost' || E'\n'
    || '          twin from a second atomic_distribute_rake call. The linked row is' || E'\n'
    || '          the hand; the twin counted it twice. */' || E'\n'
    || '       AND NOT (r.hand_id IS NULL AND r.table_id IS NOT NULL' || E'\n'
    || '                AND r.metadata->>''hand_number'' IS NOT NULL' || E'\n'
    || '                AND EXISTS (SELECT 1 FROM rake_records l' || E'\n'
    || '                             WHERE l.table_id = r.table_id AND l.hand_id IS NOT NULL' || E'\n'
    || '                               AND l.metadata->>''hand_number'' = r.metadata->>''hand_number''))';
  v_rep constant text := E'\n'
    || '       -- ONE HAND, ONE RECORD: the rule is fn_rake_record_is_ghost_twin (20260908)' || E'\n'
    || '       AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)';
BEGIN
  v_def := pg_get_functiondef('public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure);
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 2 THEN RAISE EXCEPTION 'recompute_day: expected the loose rule twice, found %', v_n; END IF;
  v_new := replace(v_def, v_old, v_rep);
  EXECUTE v_new;
END $day$;

DO $payer$
DECLARE v_def text; v_new text;
  v_anchor constant text := '       AND (r.player_contributions ? v_period.user_id::text)';
  v_rep constant text := '       AND (r.player_contributions ? v_period.user_id::text)' || E'\n'
    || '       AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)';
BEGIN
  v_def := pg_get_functiondef('public.fn_close_settlement_period(uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'payer: fallback anchor not found exactly once';
  END IF;
  v_new := replace(v_def, v_anchor, v_rep);
  EXECUTE v_new;
END $payer$;

/* THE PROOFS */
DO $proof$
DECLARE
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_from  constant timestamptz := '2026-08-31 07:00:00+00';
  v_to    constant timestamptz := '2026-09-07 07:00:00+00';
  v_n_fn int; v_n_old int; v_n_diff int; v_res jsonb; v_t0 timestamptz; v_ms int; v_snap int; v_live int; v_r jsonb;
  v_ws timestamptz := public.fn_union_week_start(now());
BEGIN
  -- (a) the restructured live path equals the block round 1 paid from, to the cent
  CREATE TEMP TABLE zz_p6v_old ON COMMIT DROP AS
  WITH raw AS (
    SELECT t.id, t.amount, substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM public.union_wallet_transactions t
     WHERE t.union_id = v_union AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= v_from AND t.created_at < v_to
  ), credits AS (
    SELECT r.id, r.amount, r.tournament_id,
           CASE WHEN r.tournament_id IS NULL THEN 'cash' ELSE COALESCE(lower(tr.tournament_type), 'other') END AS game_type
      FROM raw r LEFT JOIN public.tournaments tr ON tr.id = r.tournament_id
  ), cash AS (
    SELECT a.club_id, 'cash'::text AS game_type, sum(a.rake_share) AS rake
      FROM public.ca_union_rake_attribution a
     WHERE a.union_id = v_union AND a.played_at >= v_from AND a.played_at < v_to AND a.club_id IS NOT NULL
     GROUP BY a.club_id
  ), tw AS (
    SELECT tp.tournament_id, tp.club_id,
           sum(1 + COALESCE(tp.rebuys, 0) + CASE WHEN tp.add_on THEN 1 ELSE 0 END)::numeric AS w
      FROM public.tournament_players tp
     WHERE tp.tournament_id IN (SELECT tournament_id FROM credits WHERE tournament_id IS NOT NULL)
     GROUP BY tp.tournament_id, tp.club_id
  ), tt AS (SELECT tournament_id, sum(w) AS total FROM tw GROUP BY tournament_id
  ), tourney AS (
    SELECT tw.club_id, c.game_type, sum(c.amount * tw.w / NULLIF(tt.total, 0)) AS rake
      FROM credits c JOIN tw ON tw.tournament_id = c.tournament_id JOIN tt ON tt.tournament_id = c.tournament_id
     WHERE tw.club_id IS NOT NULL GROUP BY tw.club_id, c.game_type
  ), basis AS (
    SELECT club_id, game_type, sum(rake) AS rake_in FROM (
      SELECT club_id, game_type, rake FROM cash UNION ALL SELECT club_id, game_type, rake FROM tourney) x
     GROUP BY club_id, game_type
  )
  SELECT b.club_id, b.game_type, round(b.rake_in, 2) AS rake_in,
         COALESCE(CASE b.game_type WHEN 'cash' THEN uc.rate_cash WHEN 'mtt' THEN uc.rate_mtt WHEN 'sng' THEN uc.rate_sng
                                   WHEN 'spin' THEN uc.rate_spin WHEN 'satellite' THEN uc.rate_satellite ELSE NULL END,
                  uc.club_commission_rate, 0.90) AS rate,
         trunc(round(b.rake_in, 2) * COALESCE(CASE b.game_type WHEN 'cash' THEN uc.rate_cash WHEN 'mtt' THEN uc.rate_mtt WHEN 'sng' THEN uc.rate_sng
                                   WHEN 'spin' THEN uc.rate_spin WHEN 'satellite' THEN uc.rate_satellite ELSE NULL END,
                  uc.club_commission_rate, 0.90) * 100) / 100 AS payout
    FROM basis b JOIN public.union_clubs uc ON uc.union_id = v_union AND uc.club_id = b.club_id
   WHERE b.club_id <> v_union;

  v_t0 := clock_timestamp();
  CREATE TEMP TABLE zz_p6v_fn ON COMMIT DROP AS
  SELECT * FROM public.fn_union_club_rake_basis(v_union, v_from, v_to, true);
  v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;

  SELECT count(*) INTO v_n_fn FROM zz_p6v_fn;
  SELECT count(*) INTO v_n_old FROM zz_p6v_old;
  SELECT count(*) INTO v_n_diff FROM (
    (SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6v_fn EXCEPT SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6v_old)
    UNION ALL
    (SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6v_old EXCEPT SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6v_fn)) d;
  IF v_n_fn = 0 OR v_n_fn <> v_n_old OR v_n_diff <> 0 THEN
    RAISE EXCEPTION 'restructured basis disagrees with the block round 1 paid from: fn % rows, old % rows, % differing', v_n_fn, v_n_old, v_n_diff;
  END IF;
  RAISE NOTICE 'live basis for a full week: % rows identical, % ms', v_n_fn, v_ms;

  -- (b) the snapshot: refresh the open week, then the auto path serves it, fast, and it equals live
  v_res := public.fn_union_rake_basis_refresh(v_union, v_ws, v_ws + interval '7 days');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'refresh failed: %', v_res;
  END IF;
  v_t0 := clock_timestamp();
  SELECT count(*) INTO v_snap FROM public.fn_union_club_rake_basis(v_union, v_ws, now());
  v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;
  IF v_ms > 2000 THEN RAISE EXCEPTION 'the snapshot path took % ms; it is meant to be instant', v_ms; END IF;
  SELECT count(*) INTO v_n_diff FROM (
    (SELECT club_id, game_type, rake_in, rate, payout FROM public.fn_union_club_rake_basis(v_union, v_ws, now())
     EXCEPT SELECT club_id, game_type, rake_in, rate, payout FROM public.fn_union_club_rake_basis(v_union, v_ws, (v_res->>'through')::timestamptz, true))
    UNION ALL
    (SELECT club_id, game_type, rake_in, rate, payout FROM public.fn_union_club_rake_basis(v_union, v_ws, (v_res->>'through')::timestamptz, true)
     EXCEPT SELECT club_id, game_type, rake_in, rate, payout FROM public.fn_union_club_rake_basis(v_union, v_ws, now()))) d;
  IF v_n_diff <> 0 THEN RAISE EXCEPTION 'snapshot rows differ from a live computation through the same instant: %', v_n_diff; END IF;
  RAISE NOTICE 'snapshot: % rows served in % ms, computed in % ms', v_snap, v_ms, v_res->>'compute_ms';

  -- (c) the statement refuses a floored period and a disabled setting
  v_r := public.fn_union_issue_weekly_invoices(v_union, v_from, v_to, false);
  IF COALESCE((v_r->>'success')::boolean, true) IS NOT FALSE OR v_r->>'error' NOT IN ('before_settlement_floor', 'weekly_invoices_disabled') THEN
    RAISE EXCEPTION 'the statement function did not refuse a floored period: %', v_r;
  END IF;

  -- (d) the money report runs inside a browser budget (called as the service
  --     role, the way the World Hub API calls it; the claim is transaction-local)
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_t0 := clock_timestamp();
  v_r := public.fn_union_money_report(v_union);
  v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;
  IF v_ms > 6000 THEN RAISE EXCEPTION 'fn_union_money_report took % ms', v_ms; END IF;
  IF (v_r->'clubs'->0) IS NULL OR (v_r->'clubs'->0->>'projected_rakeback') IS NULL THEN
    RAISE EXCEPTION 'the money report lost its clubs block: %', left(v_r::text, 300);
  END IF;
  RAISE NOTICE 'money report: % ms', v_ms;

  -- (e) the ghost rule: a global-numbered twin is one, a small-numbered one is not
  IF NOT EXISTS (SELECT 1 FROM public.rake_records r WHERE r.hand_id IS NULL AND NOT r.is_tournament
                   AND r.created_at >= '2026-08-20' AND public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata) LIMIT 1) THEN
    RAISE EXCEPTION 'the ghost rule finds no twin where 2,478 are known';
  END IF;
  IF public.fn_rake_record_is_ghost_twin(NULL, gen_random_uuid(), '{"hand_number": "57"}'::jsonb) THEN
    RAISE EXCEPTION 'the ghost rule accepted a small hand number';
  END IF;
END $proof$;

DO $assert$
DECLARE v_src text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_union_club_rake_basis' AND pronamespace = 'public'::regnamespace AND pronargs = 3) THEN
    RAISE EXCEPTION 'the three-argument basis is still declared; calls would be ambiguous';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_weekly_rakeback_close' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end, true)%' THEN RAISE EXCEPTION 'round 1 could read a snapshot'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_integrity_sweep_all' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_rake_basis_refresh%' THEN RAISE EXCEPTION 'the sweep does not refresh the snapshot'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_money_report' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_club_rake_basis%' OR v_src LIKE '%club_commission_rate,0.90) * 100)/100%' THEN RAISE EXCEPTION 'the money report still has its own basis'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_issue_weekly_invoices' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%before_settlement_floor%' OR v_src NOT LIKE '%weekly_invoices_disabled%' OR v_src NOT LIKE '%period_not_closed%' THEN RAISE EXCEPTION 'the statement function lacks a guard'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_rakeback_recompute_day' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%AND EXISTS (SELECT 1 FROM rake_records l%' OR v_src NOT LIKE '%fn_rake_record_is_ghost_twin%' THEN RAISE EXCEPTION 'recompute_day still carries its own ghost rule'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_close_settlement_period' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_rake_record_is_ghost_twin%' THEN RAISE EXCEPTION 'the payer fallback still counts twins'; END IF;
  IF has_function_privilege('anon', 'public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role reaches the basis or its refresh';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.union_rake_basis_snapshot) THEN RAISE EXCEPTION 'no snapshot was stored'; END IF;
END $assert$;

COMMIT;
