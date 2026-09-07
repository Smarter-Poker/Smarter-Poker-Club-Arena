BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 6 OF 8 (UNION ACCOUNTING) - ONE SOURCE OF TRUTH, PART 2:
   THE UNION HAS ONE RAKE BASIS, AND THE STATEMENT DESCRIBES WHAT WAS PAID.
   ---------------------------------------------------------------------------
   THE WRITTEN RULE (Dan, 2026-09-03; CHIP-ACCOUNTING-ROADMAP decision 4b):
   a member club's share is 90% (per game type since 20260903) of the rake
   ITS PLAYERS generated at the union's cash tables, MTTs, spins and SNGs -
   cash by the seat the player sat through (ca_union_rake_attribution),
   tournaments by the club the player registered through (tournament_players).
   Round 1 (fn_union_weekly_rakeback_close) pays on exactly that.

   WHAT THE INVOICE DID INSTEAD. fn_union_club_invoice -> fn_union_eco_adjustment
   -> fn_union_reconciliation_report -> fn_union_rake_paid_readonly attributed
   every player's rake to the club of the player's EARLIEST club_members row
   (DISTINCT ON user_id ORDER BY joined_at). Nothing written anywhere says
   that; it predates the ruling. Measured on one identical window,
   2026-08-31 07:00 .. 2026-09-07 07:00 UTC (the last full Pacific week):

                      invoice basis (first-joined)   round-1 basis (seat played)
     Club JAQK                14,951.19                     285,808.43
     SHARK CLUB              633,214.79                     290,063.13

   The same 645,382.63 of treasury credits, carved two different ways. That
   is why weekly_invoices_enabled was set to 0 on 2026-09-07: a statement
   telling SHARK CLUB "your rakeback (90%) 569,893" when round 1 had paid
   261,056 is not a statement, it is a dispute. Under CLAUDE.md 10.8 rule 1
   this is one written rule and one unwritten default - the default is the
   defect.

   THE FIX. ONE function, fn_union_club_rake_basis(union, from, to), returns
   (club_id, game_type, rake_in, rate, payout) - the block round 1 has paid
   from since 20260903, lifted out unchanged. Round 1 now reads it (the probe
   below proves the rows are identical for the window above); the statement,
   the ECO adjustment and the reconciliation report read the SAME function.
   A closed period is read from its settlement record (totals.basis_detail,
   written by the close from the same rows) rather than recomputed, so a
   statement issued after the close describes what was paid even if the
   attribution tables move later - the witness that was there (10.9).

   NOT CHANGED. weekly_invoices_enabled stays as it is; whether to switch
   statements back on is Dan's. fn_union_rake_paid_readonly and
   fn_union_tournament_rake_by_club stay in place for their other callers;
   nothing in the invoice path reads them any more. */

DO $guard$
DECLARE bad text := '';
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure)) <> '68710ad5ff74f2151ea81fb75f6e2b15' THEN bad := bad || ' fn_union_weekly_rakeback_close'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz)'::regprocedure))       <> 'c5328a7800e4920409d349afa2d8bb08' THEN bad := bad || ' fn_union_eco_adjustment'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_reconciliation_report(uuid,timestamptz,timestamptz)'::regprocedure)) <> '34be684a8dd72e50cdd6ad3d96b40784' THEN bad := bad || ' fn_union_reconciliation_report'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_club_invoice(uuid,timestamptz,timestamptz)'::regprocedure))          <> 'eeaaf141c7950acc35f25d630d5698ed' THEN bad := bad || ' fn_union_club_invoice'; END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'changed since the 2026-09-07 21:40 UTC audit; re-read before applying:%', bad;
  END IF;
END $guard$;

/* 1. THE ONE BASIS. */
CREATE OR REPLACE FUNCTION public.fn_union_club_rake_basis(p_union_id uuid, p_start timestamptz, p_end timestamptz)
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

     This block is the one fn_union_weekly_rakeback_close paid from between
     20260903 and 20260907, moved here unchanged. */
  RETURN QUERY
  WITH raw AS (
    SELECT t.id, t.amount,
           substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM public.union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= p_start AND t.created_at < p_end
  ), credits AS (
    SELECT r.id, r.amount, r.tournament_id,
           CASE WHEN r.tournament_id IS NULL THEN 'cash'
                ELSE COALESCE(lower(tr.tournament_type), 'other') END AS game_type
      FROM raw r
      LEFT JOIN public.tournaments tr ON tr.id = r.tournament_id
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
     WHERE tp.tournament_id IN (SELECT c.tournament_id FROM credits c WHERE c.tournament_id IS NOT NULL)
     GROUP BY tp.tournament_id, tp.club_id
  ), tt AS (
    SELECT tw.tournament_id, sum(tw.w) AS total FROM tw GROUP BY tw.tournament_id
  ), tourney AS (
    SELECT tw.club_id, c.game_type, sum(c.amount * tw.w / NULLIF(tt.total, 0)) AS rake
      FROM credits c
      JOIN tw ON tw.tournament_id = c.tournament_id
      JOIN tt ON tt.tournament_id = c.tournament_id
     WHERE tw.club_id IS NOT NULL
     GROUP BY tw.club_id, c.game_type
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

REVOKE ALL ON FUNCTION public.fn_union_club_rake_basis(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_rake_basis(uuid, timestamptz, timestamptz) TO service_role;

/* 2. ROUND 1 READS IT, and writes the rows it paid from into the record. */
DO $close$
DECLARE
  v_def text; v_new text; v_a int; v_b int;
  v_end_anchor constant text := '   WHERE b.club_id <> p_union_id;';
  v_totals_anchor constant text := '''basis_by_club'', (SELECT COALESCE(jsonb_object_agg(club_id::text, rake_in), ''{}''::jsonb) FROM _uwrb),';
BEGIN
  v_def := pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure);

  -- the block starts at its own comment (which names the attribution table)
  v_a := position('  /* THE BASIS (Dan, 2026-09-03): each member club' IN v_def);
  v_b := position(v_end_anchor IN v_def);
  IF v_a = 0 OR v_b = 0 OR v_b < v_a THEN
    RAISE EXCEPTION 'close: basis block anchors not found (% / %)', v_a, v_b;
  END IF;

  v_new := left(v_def, v_a - 1)
    || '  DROP TABLE IF EXISTS _uwrb_by_type;' || E'\n'
    || '  /* THE BASIS (Dan, 2026-09-03) lives in fn_union_club_rake_basis since' || E'\n'
    || '     Phase 6 (20260907): the statement and the reconciliation report read' || E'\n'
    || '     the same function, so what is paid and what is described cannot' || E'\n'
    || '     diverge. The block that used to be here is that function, verbatim. */' || E'\n'
    || '  CREATE TEMP TABLE _uwrb_by_type ON COMMIT DROP AS' || E'\n'
    || '  SELECT b.club_id, b.game_type, b.rake_in, b.rate, b.payout' || E'\n'
    || '    FROM public.fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end) b;'
    || substr(v_def, v_b + length(v_end_anchor));

  IF position(v_totals_anchor IN v_new) = 0 THEN
    RAISE EXCEPTION 'close: totals anchor not found';
  END IF;
  v_new := replace(v_new, v_totals_anchor,
    v_totals_anchor || E'\n'
    || '                                     ''payout_by_club'', (SELECT COALESCE(jsonb_object_agg(club_id::text, payout), ''{}''::jsonb) FROM _uwrb),' || E'\n'
    || '                                     ''basis_detail'', (SELECT COALESCE(jsonb_agg(jsonb_build_object(''club_id'', club_id, ''game_type'', game_type, ''rake_in'', rake_in, ''rate'', rate, ''payout'', payout) ORDER BY club_id, game_type), ''[]''::jsonb) FROM _uwrb_by_type),');

  IF v_new = v_def THEN RAISE EXCEPTION 'close: nothing changed'; END IF;
  IF position('ca_union_rake_attribution' IN v_new) > 0 THEN
    RAISE EXCEPTION 'close: still carries its own copy of the basis';
  END IF;
  EXECUTE v_new;
END $close$;

/* 3. THE RECONCILIATION REPORT reads it (rake_paid per club). */
DO $recon$
DECLARE
  v_def text; v_new text;
  v_old constant text := '  rk AS (' || E'\n'
    || '    SELECT r.club_id, r.rake_paid' || E'\n'
    || '      FROM fn_union_rake_paid_readonly(p_union_id, p_start, p_end, true) r' || E'\n'
    || '  ),';
  v_rep constant text := '  rk AS (' || E'\n'
    || '    -- Phase 6 (20260907): the one basis, the same rows round 1 pays on.' || E'\n'
    || '    SELECT b.club_id, round(sum(b.rake_in), 2) AS rake_paid' || E'\n'
    || '      FROM public.fn_union_club_rake_basis(p_union_id, p_start, p_end) b' || E'\n'
    || '     GROUP BY b.club_id' || E'\n'
    || '  ),';
BEGIN
  v_def := pg_get_functiondef('public.fn_union_reconciliation_report(uuid,timestamptz,timestamptz)'::regprocedure);
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'reconciliation: rk anchor not found'; END IF;
  v_new := replace(v_def, v_old, v_rep);
  IF v_new = v_def THEN RAISE EXCEPTION 'reconciliation: nothing changed'; END IF;
  EXECUTE v_new;
END $recon$;

/* 4. THE ECO ADJUSTMENT reads it: rake_generated, the cash / tournament split
   and rake_earned (what round 1 pays: the per-game-type truncated payout)
   all come from the one basis. players_won is unchanged (realised net plus
   seated-stack delta). */
CREATE OR REPLACE FUNCTION public.fn_union_eco_adjustment(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
RETURNS TABLE(club_id uuid, club_name text, players_won numeric, rake_generated numeric, cash_players_won numeric, cash_rake numeric, tournament_rake numeric, total_rake_generated numeric, club_commission_rate numeric, rake_earned numeric, eco_base numeric, eco_rate numeric, eco_amount numeric, direction text, union_net_eco numeric, eco_base_mode text, baseline_cash_exact boolean, include_horses boolean, eco_enabled boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rate  numeric := fn_union_eco_rate(p_union_id);
  v_on    boolean := fn_union_eco_enabled(p_union_id);
  v_mode  text    := fn_union_eco_base_mode(p_union_id);
  v_horse boolean := fn_union_eco_include_horses(p_union_id);
  v_prev  jsonb   := fn_union_pnl_baseline(p_union_id, p_start);
  v_exact boolean;
BEGIN
  IF v_mode NOT IN ('club_cash_profit','net_invoice_position',
                    'winnings_plus_rake','winnings_only') THEN
    RAISE EXCEPTION 'unknown eco_base_mode: %', v_mode USING ERRCODE = '22023';
  END IF;

  v_exact := (v_prev IS NULL)
             OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_prev) e
                             WHERE NOT (e ? 'seated_end_cash'));

  RETURN QUERY
  WITH rep AS (
    SELECT r.club_id, r.club_name, r.settle_net, r.rake_paid
      FROM fn_union_reconciliation_report(p_union_id, p_start, p_end) r
  ),
  cash AS (
    SELECT c.club_id, c.realized_net, c.seated_stack
      FROM fn_union_pnl_cash_by_club(p_union_id, p_start, p_end, v_horse) c
  ),
  /* Phase 6 (20260907): ONE basis. The same rows round 1 pays on, per club,
     split by game type; rake_earned is the payout round 1 makes (per game
     type, truncated to the cent), not a rate applied to a different total. */
  basis AS (
    SELECT b.club_id,
           round(sum(b.rake_in), 2)                                          AS rake,
           round(COALESCE(sum(b.rake_in) FILTER (WHERE b.game_type = 'cash'), 0), 2)  AS cash_rake,
           round(COALESCE(sum(b.rake_in) FILTER (WHERE b.game_type <> 'cash'), 0), 2) AS tournament_rake,
           round(sum(b.payout), 2)                                           AS payout
      FROM fn_union_club_rake_basis(p_union_id, p_start, p_end) b
     GROUP BY b.club_id
  ),
  cash_base AS (
    SELECT (e->>'club_id')::uuid AS club_id,
           COALESCE((e->>'seated_end_cash')::numeric, (e->>'seated_end')::numeric)
             AS seated_start
      FROM jsonb_array_elements(COALESCE(v_prev, '[]'::jsonb)) e
  ),
  rb AS (
    SELECT uc.club_id, COALESCE(uc.club_commission_rate, 0.90) AS rate
      FROM union_clubs uc WHERE uc.union_id = p_union_id
  ),
  calc AS (
    SELECT rep.club_id, rep.club_name,
           round(rep.settle_net - rep.rake_paid, 2) AS players_won,
           COALESCE(bs.rake, 0)                     AS rake_generated,
           round(COALESCE(cash.realized_net, 0)
                 + (COALESCE(cash.seated_stack, 0)
                    - COALESCE(cb.seated_start, COALESCE(cash.seated_stack, 0))), 2)
             AS cash_players_won,
           COALESCE(bs.cash_rake, 0)                AS cash_rake,
           COALESCE(bs.tournament_rake, 0)          AS tournament_rake,
           COALESCE(bs.rake, 0)                     AS total_rake_generated,
           COALESCE(rb.rate, 0.90)                  AS club_commission_rate,
           COALESCE(bs.payout, 0)                   AS rake_earned
      FROM rep
      LEFT JOIN cash      ON cash.club_id = rep.club_id
      LEFT JOIN basis bs  ON bs.club_id = rep.club_id
      LEFT JOIN cash_base cb ON cb.club_id = rep.club_id
      LEFT JOIN rb        ON rb.club_id = rep.club_id
  ),
  based AS (
    SELECT calc.*,
           round(CASE v_mode
             WHEN 'club_cash_profit' THEN
               calc.rake_earned - calc.cash_players_won
             WHEN 'net_invoice_position' THEN
               calc.players_won + calc.rake_generated + calc.rake_earned
             WHEN 'winnings_plus_rake' THEN
               calc.players_won + calc.rake_generated
             ELSE
               calc.players_won
           END, 2) AS eco_base
      FROM calc
  ),
  amt AS (
    SELECT based.*, round(-v_rate * based.eco_base, 2) AS eco_amount FROM based
  ),
  agg AS (SELECT round(SUM(-amt.eco_amount), 2) AS union_net FROM amt)
  SELECT amt.club_id, amt.club_name, amt.players_won, amt.rake_generated,
         amt.cash_players_won, amt.cash_rake, amt.tournament_rake,
         amt.total_rake_generated, amt.club_commission_rate, amt.rake_earned,
         amt.eco_base, v_rate, amt.eco_amount,
         CASE WHEN amt.eco_amount < 0 THEN 'club pays union (profitable week)'
              WHEN amt.eco_amount > 0 THEN 'union pays club (losing week)'
              ELSE 'square' END::text,
         agg.union_net, v_mode, v_exact, v_horse, v_on
    FROM amt CROSS JOIN agg
   ORDER BY amt.eco_amount;
END;
$function$;

/* 5. THE STATEMENT LINES come from the one basis: rakeback_due is what round
   1 paid (per game type, truncated), union_fee_kept is the rest. */
CREATE OR REPLACE FUNCTION public.fn_union_club_invoice(p_union_id uuid, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
RETURNS TABLE(club_id uuid, club_name text, period_start timestamp with time zone, period_end timestamp with time zone, rake_generated numeric, union_fee_kept numeric, rakeback_due numeric, players_won numeric, player_pnl_net numeric, eco_amount numeric, eco_enabled boolean, presettled numeric, settled_in_chips numeric, outstanding numeric, net_position numeric, direction text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := COALESCE(p_start, fn_union_week_start());
  v_end   timestamptz := COALESCE(p_end, now());
BEGIN
  RETURN QUERY
  WITH eco AS (
    SELECT e.club_id, e.club_name, e.players_won, e.rake_generated,
           e.rake_earned, e.eco_base, e.eco_amount, e.eco_enabled
      FROM fn_union_eco_adjustment(p_union_id, v_start, v_end) e
  ),
  pre AS (
    -- Unapplied cash held against the running balance. Closed out by
    -- applied_settlement_id, never by age: a payment made during a week that
    -- did not settle must still reach the club's next statement.
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.received_at < v_end
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  ),
  calc AS (
    /* Phase 6 (20260907): rakeback_due IS round 1's payout for the club - the
       same fn_union_club_rake_basis rows, per game type, truncated to the
       cent - not a flat rate applied to a different rake total. */
    SELECT eco.club_id, eco.club_name,
           eco.rake_generated,
           round(eco.rake_generated - eco.rake_earned, 2) AS union_fee_kept,
           eco.rake_earned                                AS rakeback_due,
           eco.players_won,
           round(eco.players_won + eco.rake_generated, 2) AS player_pnl_net,
           CASE WHEN eco.eco_enabled THEN eco.eco_amount ELSE 0 END AS eco_amount,
           eco.eco_enabled,
           COALESCE(pre.amt, 0) AS presettled
      FROM eco
      LEFT JOIN pre   ON pre.club_id = eco.club_id
  )
  SELECT calc.club_id, calc.club_name, v_start, v_end,
         calc.rake_generated, calc.union_fee_kept, calc.rakeback_due,
         calc.players_won, calc.player_pnl_net,
         calc.eco_amount, calc.eco_enabled, calc.presettled,
         round(calc.player_pnl_net + calc.rakeback_due, 2) AS settled_in_chips,
         round(calc.eco_amount + calc.presettled, 2)       AS outstanding,
         round(calc.player_pnl_net + calc.rakeback_due
               + calc.eco_amount + calc.presettled, 2)     AS net_position,
         CASE WHEN round(calc.eco_amount + calc.presettled, 2) > 0
                THEN 'union owes club'
              WHEN round(calc.eco_amount + calc.presettled, 2) < 0
                THEN 'club owes union'
              ELSE 'square' END::text
    FROM calc
   ORDER BY calc.club_name;
END;
$function$;

/* 6. THE CASCADE's gate message no longer describes a disagreement that is gone. */
DO $casc$
DECLARE
  v_def text; v_new text;
  v_old constant text := '''reason'', ''weekly_invoices_disabled: invoice rake basis ''' || E'\n'
    || '                || ''(fn_union_rake_paid_readonly, first-joined club) disagrees with the ''' || E'\n'
    || '                || ''basis round 1 pays on (ca_union_rake_attribution, seat played). ''' || E'\n'
    || '                || ''Money moved; statement held pending reconciliation.'');';
  v_rep constant text := '''reason'', ''weekly_invoices_disabled: the union setting weekly_invoices_enabled is 0. ''' || E'\n'
    || '                || ''Since Phase 6 (20260907) the statement reads the same fn_union_club_rake_basis ''' || E'\n'
    || '                || ''rows round 1 pays on; switching statements back on is a setting, not a fix.'');';
BEGIN
  v_def := pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure);
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'cascade: reason anchor not found'; END IF;
  v_new := replace(v_def, v_old, v_rep);
  IF v_new = v_def THEN RAISE EXCEPTION 'cascade: nothing changed'; END IF;
  EXECUTE v_new;
END $casc$;

/* THE PROOF. For the last full Pacific week the function must return exactly
   the rows the old inline block returned - same clubs, same game types, same
   cents - and the statement lines must be those rows summed. Read-only. */
DO $proof$
DECLARE
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_from  constant timestamptz := '2026-08-31 07:00:00+00';
  v_to    constant timestamptz := '2026-09-07 07:00:00+00';
  v_n_fn int; v_n_old int; v_n_diff int; v_n_inv int; v_bad int; v_house int;
BEGIN
  CREATE TEMP TABLE zz_p6_old ON COMMIT DROP AS
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

  CREATE TEMP TABLE zz_p6_fn ON COMMIT DROP AS
  SELECT * FROM public.fn_union_club_rake_basis(v_union, v_from, v_to);

  SELECT count(*) INTO v_n_fn FROM zz_p6_fn;
  SELECT count(*) INTO v_n_old FROM zz_p6_old;
  SELECT count(*) INTO v_n_diff FROM (
    (SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6_fn EXCEPT SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6_old)
    UNION ALL
    (SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6_old EXCEPT SELECT club_id, game_type, rake_in, rate, payout FROM zz_p6_fn)) d;
  IF v_n_fn = 0 OR v_n_fn <> v_n_old OR v_n_diff <> 0 THEN
    RAISE EXCEPTION 'basis function disagrees with the block round 1 paid from: fn % rows, old % rows, % differing', v_n_fn, v_n_old, v_n_diff;
  END IF;
  SELECT count(*) INTO v_house FROM zz_p6_fn WHERE club_id = v_union;
  IF v_house <> 0 THEN RAISE EXCEPTION 'the union house club appears in its own basis'; END IF;

  -- the statement lines are the basis rows summed, to the cent
  SELECT count(*), count(*) FILTER (WHERE bad) INTO v_n_inv, v_bad FROM (
    SELECT i.club_id,
           (i.rake_generated <> COALESCE((SELECT round(sum(f.rake_in), 2) FROM zz_p6_fn f WHERE f.club_id = i.club_id), 0)
            OR i.rakeback_due <> COALESCE((SELECT round(sum(f.payout), 2) FROM zz_p6_fn f WHERE f.club_id = i.club_id), 0)
            OR i.union_fee_kept <> round(i.rake_generated - i.rakeback_due, 2)) AS bad
      FROM public.fn_union_club_invoice(v_union, v_from, v_to) i) x;
  IF v_n_inv = 0 OR v_bad <> 0 THEN
    RAISE EXCEPTION 'the statement does not describe the basis: % lines, % wrong', v_n_inv, v_bad;
  END IF;

  RAISE NOTICE 'phase 6 basis proof: % (club, game type) rows identical; % statement lines match to the cent', v_n_fn, v_n_inv;
END $proof$;

DO $assert$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_weekly_rakeback_close' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end)%' THEN RAISE EXCEPTION 'round 1 does not read the one basis'; END IF;
  IF v_src NOT LIKE '%''basis_detail''%' OR v_src NOT LIKE '%''payout_by_club''%' THEN RAISE EXCEPTION 'round 1 does not record the rows it paid from'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_eco_adjustment' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_club_rake_basis%' OR v_src LIKE '%fn_union_rake_paid_readonly%' OR v_src LIKE '%fn_union_tournament_rake_by_club%' THEN RAISE EXCEPTION 'the eco adjustment still has a second basis'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_reconciliation_report' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_club_rake_basis%' OR v_src LIKE '%fn_union_rake_paid_readonly%' THEN RAISE EXCEPTION 'the reconciliation report still has a second basis'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_club_invoice' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%rb_rate%' THEN RAISE EXCEPTION 'the statement still applies a flat rate'; END IF;
  IF has_function_privilege('anon', 'public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can read the union basis directly';
  END IF;
  -- CREATE OR REPLACE preserves grants; the two rewritten definers must still be service_role only
  IF has_function_privilege('anon', 'public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_union_club_invoice(uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_union_club_invoice(uuid,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role reached a rewritten invoice function';
  END IF;
END $assert$;

COMMIT;
