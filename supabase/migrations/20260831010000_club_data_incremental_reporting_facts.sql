-- Club Data incremental reporting facts
--
-- The Games and Players RPCs still crossed authenticated's 8 second
-- statement_timeout on a cold or contended production cache because every
-- request re-summed wallet_transactions and tournament rake_records.  Those
-- ledgers remain authoritative.  These tables are derived display facts,
-- maintained on INSERT and repairable from the ledgers, so request cost is
-- proportional to (club, day, player/game) groups rather than ledger volume.

CREATE TABLE IF NOT EXISTS public.ca_club_player_daily (
  club_id        uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  stat_date      date        NOT NULL,
  cash_net       numeric     NOT NULL DEFAULT 0,
  tournament_net numeric     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_ca_club_player_daily_range
  ON public.ca_club_player_daily (club_id, stat_date, user_id);

CREATE TABLE IF NOT EXISTS public.ca_club_tournament_daily (
  club_id       uuid        NOT NULL,
  tournament_id uuid        NOT NULL,
  stat_date     date        NOT NULL,
  fee           numeric     NOT NULL DEFAULT 0,
  winnings      numeric     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, tournament_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_ca_club_tournament_daily_range
  ON public.ca_club_tournament_daily (club_id, stat_date, tournament_id);

CREATE TABLE IF NOT EXISTS public.ca_club_tournament_player_daily (
  club_id       uuid        NOT NULL,
  tournament_id uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  stat_date     date        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, tournament_id, user_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_ca_club_tournament_player_daily_range
  ON public.ca_club_tournament_player_daily
    (club_id, stat_date, tournament_id, user_id);

ALTER TABLE public.ca_club_player_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_club_tournament_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_club_tournament_player_daily ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.ca_club_player_daily IS
  'Derived Club Data display facts. wallet_transactions remains authoritative. Maintained by ca_reporting_wallet_insert and repairable with ca_refresh_reporting_rollups.';
COMMENT ON TABLE public.ca_club_tournament_daily IS
  'Derived Club Data tournament fee/P&L facts. wallet_transactions and rake_records remain authoritative.';
COMMENT ON TABLE public.ca_club_tournament_player_daily IS
  'Derived distinct tournament participants for Club Data. Horses are deliberately included exactly like every other player.';

-- Preserve Club Arena's union attribution law: a union player belongs to the
-- first club they joined in that union.  Standalone activity belongs to the
-- activity's club only when the player is a member of it.
CREATE OR REPLACE FUNCTION public.ca_reporting_club_for_activity(
  p_user_id uuid,
  p_union_id uuid,
  p_fallback_club_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_union_id IS NOT NULL THEN (
      SELECT cm.club_id
        FROM public.club_members cm
        JOIN public.union_clubs uc
          ON uc.club_id = cm.club_id
         AND uc.union_id = p_union_id
       WHERE cm.user_id = p_user_id
       ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
       LIMIT 1
    )
    WHEN p_fallback_club_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.club_members cm
         WHERE cm.club_id = p_fallback_club_id
           AND cm.user_id = p_user_id
      ) THEN p_fallback_club_id
    ELSE NULL
  END;
$function$;

-- Absolute rebuild for a bounded UTC date range.  The advisory lock is shared
-- with the INSERT triggers.  A concurrent ledger transaction can insert its
-- source row, but its trigger waits until this snapshot commits, then applies
-- the missing delta exactly once.
CREATE OR REPLACE FUNCTION public.ca_refresh_reporting_rollups(
  p_start date,
  p_end date
)
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

  DELETE FROM public.ca_club_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_daily
   WHERE stat_date BETWEEN v_start AND v_end;
  DELETE FROM public.ca_club_tournament_player_daily
   WHERE stat_date BETWEEN v_start AND v_end;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ), mapped AS MATERIALIZED (
    SELECT wt.user_id,
           (wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           wt.category,
           wt.type,
           wt.amount,
           wt.related_entity_id AS tournament_id,
           CASE
             WHEN wt.category IN ('buyin', 'cashout') THEN
               CASE WHEN tb.union_id IS NOT NULL THEN hc.club_id
                    WHEN EXISTS (SELECT 1 FROM public.club_members cm
                                  WHERE cm.club_id = tb.club_id
                                    AND cm.user_id = wt.user_id)
                      THEN tb.club_id END
             ELSE
               CASE WHEN tr.union_id IS NOT NULL THEN ht.club_id
                    WHEN EXISTS (SELECT 1 FROM public.club_members cm
                                  WHERE cm.club_id = tr.club_id
                                    AND cm.user_id = wt.user_id)
                      THEN tr.club_id END
           END AS club_id
      FROM public.wallet_transactions wt
      LEFT JOIN public.tables tb
        ON tb.id = wt.table_id
       AND wt.category IN ('buyin', 'cashout')
      LEFT JOIN home hc
        ON hc.union_id = tb.union_id AND hc.user_id = wt.user_id
      LEFT JOIN public.tournaments tr
        ON tr.id = wt.related_entity_id
       AND wt.category IN ('tournament_buyin', 'prize', 'bounty')
      LEFT JOIN home ht
        ON ht.union_id = tr.union_id AND ht.user_id = wt.user_id
     WHERE wt.created_at >= v_from
       AND wt.created_at < v_to
       AND (
         (wt.category IN ('buyin', 'cashout') AND wt.table_id IS NOT NULL)
         OR (wt.category IN ('tournament_buyin', 'prize', 'bounty')
             AND wt.related_entity_id IS NOT NULL)
       )
  )
  INSERT INTO public.ca_club_player_daily
    (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
  SELECT m.club_id, m.user_id, m.stat_date,
         SUM(CASE WHEN m.category IN ('buyin', 'cashout')
                  THEN CASE WHEN m.type = 'credit' THEN m.amount
                            WHEN m.type = 'debit' THEN -m.amount ELSE 0 END
                  ELSE 0 END),
         SUM(CASE WHEN m.category = 'tournament_buyin' THEN -m.amount
                  WHEN m.category IN ('prize', 'bounty') THEN m.amount
                  ELSE 0 END),
         now()
    FROM mapped m
   WHERE m.club_id IS NOT NULL
   GROUP BY m.club_id, m.user_id, m.stat_date;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ), wallet_mapped AS MATERIALIZED (
    SELECT CASE WHEN tr.union_id IS NOT NULL THEN h.club_id
                WHEN EXISTS (SELECT 1 FROM public.club_members cm
                              WHERE cm.club_id = tr.club_id
                                AND cm.user_id = wt.user_id)
                  THEN tr.club_id END AS club_id,
           wt.related_entity_id AS tournament_id,
           wt.user_id,
           (wt.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN wt.category = 'tournament_buyin' THEN -wt.amount
                ELSE wt.amount END AS winnings
      FROM public.wallet_transactions wt
      JOIN public.tournaments tr ON tr.id = wt.related_entity_id
      LEFT JOIN home h ON h.union_id = tr.union_id AND h.user_id = wt.user_id
     WHERE wt.created_at >= v_from
       AND wt.created_at < v_to
       AND wt.category IN ('tournament_buyin', 'prize', 'bounty')
       AND wt.related_entity_id IS NOT NULL
  ), player_map AS MATERIALIZED (
    SELECT tp.tournament_id, tp.user_id,
           CASE WHEN tr.union_id IS NOT NULL THEN h.club_id
                WHEN EXISTS (SELECT 1 FROM public.club_members cm
                              WHERE cm.club_id = tr.club_id
                                AND cm.user_id = tp.user_id)
                  THEN tr.club_id END AS club_id
      FROM public.tournament_players tp
      JOIN public.tournaments tr ON tr.id = tp.tournament_id
      LEFT JOIN home h ON h.union_id = tr.union_id AND h.user_id = tp.user_id
  ), entrant_counts AS MATERIALIZED (
    SELECT pm.tournament_id, pm.club_id,
           count(*)::numeric AS club_players,
           sum(count(*)) OVER (PARTITION BY pm.tournament_id)::numeric AS total_players
      FROM player_map pm
     WHERE pm.club_id IS NOT NULL
     GROUP BY pm.tournament_id, pm.club_id
  ), rake_mapped AS MATERIALIZED (
    SELECT r.tournament_id,
           (r.created_at AT TIME ZONE 'UTC')::date AS stat_date,
           CASE WHEN r.metadata ? 'user_id' THEN pm.club_id ELSE ec.club_id END AS club_id,
           CASE WHEN r.metadata ? 'user_id' THEN r.rake_amount
                ELSE r.rake_amount * ec.club_players / NULLIF(ec.total_players, 0)
            END AS fee
      FROM public.rake_records r
      LEFT JOIN player_map pm
        ON r.metadata ? 'user_id'
       AND pm.tournament_id = r.tournament_id
       AND pm.user_id::text = r.metadata->>'user_id'
      LEFT JOIN entrant_counts ec
        ON NOT (r.metadata ? 'user_id')
       AND ec.tournament_id = r.tournament_id
     WHERE r.created_at >= v_from
       AND r.created_at < v_to
       AND r.is_tournament
       AND r.tournament_id IS NOT NULL
       AND r.rake_amount <> 0
  ), combined AS (
    SELECT wm.club_id, wm.tournament_id, wm.stat_date,
           0::numeric AS fee, sum(wm.winnings) AS winnings
      FROM wallet_mapped wm
     WHERE wm.club_id IS NOT NULL
     GROUP BY 1,2,3
    UNION ALL
    SELECT rm.club_id, rm.tournament_id, rm.stat_date,
           sum(rm.fee), 0::numeric
      FROM rake_mapped rm
     WHERE rm.club_id IS NOT NULL
     GROUP BY 1,2,3
  )
  INSERT INTO public.ca_club_tournament_daily
    (club_id, tournament_id, stat_date, fee, winnings, updated_at)
  SELECT c.club_id, c.tournament_id, c.stat_date,
         sum(c.fee), sum(c.winnings), now()
    FROM combined c
   GROUP BY 1,2,3;

  WITH home AS MATERIALIZED (
    SELECT DISTINCT ON (uc.union_id, cm.user_id)
           uc.union_id, cm.user_id, cm.club_id
      FROM public.club_members cm
      JOIN public.union_clubs uc ON uc.club_id = cm.club_id
     ORDER BY uc.union_id, cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  )
  INSERT INTO public.ca_club_tournament_player_daily
    (club_id, tournament_id, user_id, stat_date, updated_at)
  SELECT DISTINCT
         CASE WHEN tr.union_id IS NOT NULL THEN h.club_id
              WHEN EXISTS (SELECT 1 FROM public.club_members cm
                            WHERE cm.club_id = tr.club_id
                              AND cm.user_id = wt.user_id)
                THEN tr.club_id END,
         wt.related_entity_id, wt.user_id,
         (wt.created_at AT TIME ZONE 'UTC')::date, now()
    FROM public.wallet_transactions wt
    JOIN public.tournaments tr ON tr.id = wt.related_entity_id
    LEFT JOIN home h ON h.union_id = tr.union_id AND h.user_id = wt.user_id
   WHERE wt.created_at >= v_from
     AND wt.created_at < v_to
     AND wt.category IN ('tournament_buyin', 'prize', 'bounty')
     AND wt.related_entity_id IS NOT NULL
     AND CASE WHEN tr.union_id IS NOT NULL THEN h.club_id
              WHEN EXISTS (SELECT 1 FROM public.club_members cm
                            WHERE cm.club_id = tr.club_id
                              AND cm.user_id = wt.user_id)
                THEN tr.club_id END IS NOT NULL;

  SELECT count(*) INTO v_players
    FROM public.ca_club_player_daily WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_tournaments
    FROM public.ca_club_tournament_daily WHERE stat_date BETWEEN v_start AND v_end;
  SELECT count(*) INTO v_participants
    FROM public.ca_club_tournament_player_daily WHERE stat_date BETWEEN v_start AND v_end;

  RETURN jsonb_build_object(
    'start', v_start, 'end', v_end,
    'player_facts', v_players,
    'tournament_facts', v_tournaments,
    'participant_facts', v_participants,
    'refreshed_at', now()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid;
  v_fallback uuid;
  v_club uuid;
  v_day date;
  v_cash numeric := 0;
  v_tournament numeric := 0;
BEGIN
  IF NOT (
    (NEW.category IN ('buyin', 'cashout') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN ('tournament_buyin', 'prize', 'bounty')
        AND NEW.related_entity_id IS NOT NULL)
  ) THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(918273645);
  v_day := (NEW.created_at AT TIME ZONE 'UTC')::date;

  IF NEW.category IN ('buyin', 'cashout') THEN
    SELECT t.union_id, t.club_id INTO v_union, v_fallback
      FROM public.tables t WHERE t.id = NEW.table_id;
    v_cash := CASE WHEN NEW.type = 'credit' THEN NEW.amount
                   WHEN NEW.type = 'debit' THEN -NEW.amount ELSE 0 END;
  ELSE
    SELECT t.union_id, t.club_id INTO v_union, v_fallback
      FROM public.tournaments t WHERE t.id = NEW.related_entity_id;
    v_tournament := CASE WHEN NEW.category = 'tournament_buyin' THEN -NEW.amount
                         ELSE NEW.amount END;
  END IF;

  v_club := public.ca_reporting_club_for_activity(
    NEW.user_id, v_union, v_fallback
  );
  IF v_club IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.ca_club_player_daily AS d
    (club_id, user_id, stat_date, cash_net, tournament_net, updated_at)
  VALUES (v_club, NEW.user_id, v_day, v_cash, v_tournament, now())
  ON CONFLICT (club_id, user_id, stat_date) DO UPDATE
    SET cash_net = d.cash_net + EXCLUDED.cash_net,
        tournament_net = d.tournament_net + EXCLUDED.tournament_net,
        updated_at = now();

  IF v_tournament <> 0 THEN
    INSERT INTO public.ca_club_tournament_daily AS d
      (club_id, tournament_id, stat_date, winnings, updated_at)
    VALUES (v_club, NEW.related_entity_id, v_day, v_tournament, now())
    ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
      SET winnings = d.winnings + EXCLUDED.winnings, updated_at = now();

    INSERT INTO public.ca_club_tournament_player_daily
      (club_id, tournament_id, user_id, stat_date, updated_at)
    VALUES (v_club, NEW.related_entity_id, NEW.user_id, v_day, now())
    ON CONFLICT (club_id, tournament_id, user_id, stat_date) DO UPDATE
      SET updated_at = now();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid;
  v_fallback uuid;
  v_club uuid;
  v_day date;
  r record;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL
     OR NEW.rake_amount = 0 THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(918273645);
  v_day := (NEW.created_at AT TIME ZONE 'UTC')::date;
  SELECT t.union_id, t.club_id INTO v_union, v_fallback
    FROM public.tournaments t WHERE t.id = NEW.tournament_id;

  IF NEW.metadata ? 'user_id' THEN
    SELECT public.ca_reporting_club_for_activity(
             tp.user_id, v_union, v_fallback
           )
      INTO v_club
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.tournament_id
       AND tp.user_id::text = NEW.metadata->>'user_id'
     LIMIT 1;

    IF v_club IS NOT NULL THEN
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id, tournament_id, stat_date, fee, updated_at)
      VALUES (v_club, NEW.tournament_id, v_day, NEW.rake_amount, now())
      ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
        SET fee = d.fee + EXCLUDED.fee, updated_at = now();
    END IF;
  ELSE
    FOR r IN
      WITH mapped AS (
        SELECT public.ca_reporting_club_for_activity(
                 tp.user_id, v_union, v_fallback
               ) AS club_id
          FROM public.tournament_players tp
         WHERE tp.tournament_id = NEW.tournament_id
      ), counts AS (
        SELECT club_id, count(*)::numeric AS club_players,
               sum(count(*)) OVER ()::numeric AS total_players
          FROM mapped WHERE club_id IS NOT NULL GROUP BY club_id
      )
      SELECT * FROM counts
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id, tournament_id, stat_date, fee, updated_at)
      VALUES (r.club_id, NEW.tournament_id, v_day,
              NEW.rake_amount * r.club_players / NULLIF(r.total_players, 0), now())
      ON CONFLICT (club_id, tournament_id, stat_date) DO UPDATE
        SET fee = d.fee + EXCLUDED.fee, updated_at = now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_repair_changed_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old date;
  v_new date;
BEGIN
  v_old := (OLD.created_at AT TIME ZONE 'UTC')::date;
  v_new := CASE WHEN TG_OP = 'UPDATE'
                THEN (NEW.created_at AT TIME ZONE 'UTC')::date ELSE v_old END;
  PERFORM public.ca_refresh_reporting_rollups(LEAST(v_old, v_new), GREATEST(v_old, v_new));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data changed-ledger repair failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS ca_reporting_wallet_insert ON public.wallet_transactions;
CREATE TRIGGER ca_reporting_wallet_insert
AFTER INSERT ON public.wallet_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_ca_reporting_wallet_insert();

DROP TRIGGER IF EXISTS ca_reporting_wallet_change ON public.wallet_transactions;
CREATE TRIGGER ca_reporting_wallet_change
AFTER UPDATE OR DELETE ON public.wallet_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_ca_reporting_repair_changed_day();

DROP TRIGGER IF EXISTS ca_reporting_rake_insert ON public.rake_records;
CREATE TRIGGER ca_reporting_rake_insert
AFTER INSERT ON public.rake_records
FOR EACH ROW EXECUTE FUNCTION public.trg_ca_reporting_rake_insert();

DROP TRIGGER IF EXISTS ca_reporting_rake_change ON public.rake_records;
CREATE TRIGGER ca_reporting_rake_change
AFTER UPDATE OR DELETE ON public.rake_records
FOR EACH ROW EXECUTE FUNCTION public.trg_ca_reporting_repair_changed_day();

-- Cover the longest supported snapshot: 93 current days + 93 comparison days.
SELECT public.ca_refresh_reporting_rollups(
  ((now() AT TIME ZONE 'UTC')::date - 185),
  (now() AT TIME ZONE 'UTC')::date
);

CREATE OR REPLACE FUNCTION public.fn_ca_club_games(
  p_club_id uuid,
  p_start date,
  p_end date,
  p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text
)
RETURNS TABLE(
  kind text, id text, name text, variant text, game_class text,
  stakes_tier text, small_blind numeric, big_blind numeric,
  rake_percent numeric, started_at timestamptz, created_by uuid,
  status text, fee numeric, winnings numeric, hands bigint, players integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH cash AS (
    SELECT c.table_id, SUM(c.rake) AS fee, SUM(c.net) AS winnings,
           SUM(c.hands) AS hands, MAX(c.players) AS players
      FROM public.club_table_daily c
     WHERE c.club_id = p_club_id AND c.stat_date BETWEEN p_start AND p_end
     GROUP BY c.table_id
  ), tournament_facts AS MATERIALIZED (
    SELECT d.tournament_id, SUM(d.fee) AS fee, SUM(d.winnings) AS winnings
      FROM public.ca_club_tournament_daily d
     WHERE d.club_id = p_club_id AND d.stat_date BETWEEN p_start AND p_end
     GROUP BY d.tournament_id
  ), tournament_players AS MATERIALIZED (
    SELECT p.tournament_id, count(DISTINCT p.user_id)::integer AS players
      FROM public.ca_club_tournament_player_daily p
     WHERE p.club_id = p_club_id AND p.stat_date BETWEEN p_start AND p_end
     GROUP BY p.tournament_id
  ), all_rows AS (
    SELECT 'CASH'::text AS kind, t.id::text AS id, COALESCE(t.name, 'Unnamed') AS name,
           UPPER(COALESCE(t.game_variant, 'nlh')) AS variant,
           CASE WHEN COALESCE(t.game_variant, '') ILIKE '%plo%'
                  OR COALESCE(t.game_variant, '') ILIKE '%omaha%' THEN 'OMAHA'
                WHEN COALESCE(t.game_variant, '') ILIKE '%mixed%'
                  OR COALESCE(t.game_mode, '') ILIKE '%mixed%' THEN 'MIXED'
                ELSE 'HOLDEM' END AS game_class,
           COALESCE(t.small_blind, 0) AS small_blind,
           COALESCE(t.big_blind, 0) AS big_blind,
           CASE WHEN COALESCE(t.rake_percent, -1) >= 0 THEN t.rake_percent END AS rake_percent,
           t.created_at AS started_at, t.created_by, t.status,
           round(c.fee, 2) AS fee, round(c.winnings, 2) AS winnings,
           c.hands::bigint, c.players::integer
      FROM cash c JOIN public.tables t ON t.id = c.table_id
    UNION ALL
    SELECT CASE WHEN tr.tournament_type = 'SPIN' THEN 'SPIN'
                WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END,
           tr.id::text, COALESCE(tr.name, 'Tournament'),
           UPPER(COALESCE(tr.variant, tr.game_type, 'nlh')),
           CASE WHEN tr.tournament_type = 'SNG' THEN 'SNG' ELSE 'MTT' END,
           0::numeric, 0::numeric, NULL::numeric, tr.start_time, NULL::uuid,
           tr.status, round(COALESCE(f.fee, 0), 2),
           round(COALESCE(f.winnings, 0), 2), 0::bigint,
           COALESCE(tp.players, 0)::integer
      FROM tournament_facts f
      JOIN public.tournaments tr ON tr.id = f.tournament_id
      LEFT JOIN tournament_players tp ON tp.tournament_id = f.tournament_id
  ), tagged AS (
    SELECT r.*, CASE WHEN r.game_class IN ('MTT', 'SNG') THEN 'NA'
                     WHEN r.big_blind < 1 THEN 'MICRO'
                     WHEN r.big_blind < 5 THEN 'SMALL'
                     WHEN r.big_blind < 25 THEN 'MID' ELSE 'HIGH' END AS stakes_tier
      FROM all_rows r
  )
  SELECT t.kind, t.id, t.name, t.variant, t.game_class, t.stakes_tier,
         t.small_blind, t.big_blind, t.rake_percent, t.started_at,
         t.created_by, t.status, t.fee, t.winnings, t.hands, t.players
    FROM tagged t
   WHERE (UPPER(COALESCE(NULLIF(p_game, ''), 'ALL')) = 'ALL'
          OR t.game_class = UPPER(p_game))
     AND (UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL')) = 'ALL'
          OR t.stakes_tier = UPPER(p_stakes))
     AND (NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL
          OR t.name ILIKE '%' || btrim(p_search) || '%'
          OR t.id ILIKE '%' || btrim(p_search) || '%'
          OR EXISTS (SELECT 1 FROM public.profiles pr
                      WHERE pr.id = t.created_by
                        AND (COALESCE(pr.username, '') ILIKE '%' || btrim(p_search) || '%'
                             OR pr.id::text ILIKE '%' || btrim(p_search) || '%')));
$function$;

-- Keep the public snapshot contract, changing only its freshness source.  The
-- helper now reads reporting facts, so both current and comparison ranges are
-- bounded without changing the JSON consumed by ClubDataPage.
CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_game text DEFAULT 'ALL'::text,
  p_stakes text DEFAULT 'ALL'::text,
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 13);
  v_days int; v_pstart date; v_pend date;
  v_game text := UPPER(COALESCE(NULLIF(p_game, ''), 'ALL'));
  v_stakes text := UPPER(COALESCE(NULLIF(p_stakes, ''), 'ALL'));
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_lim int := GREATEST(LEAST(COALESCE(p_limit, 100), 500), 1);
  v_union uuid; v_cur jsonb; v_prev jsonb; v_rows jsonb; v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;
  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_days := (v_end - v_start) + 1;
  v_pend := v_start - 1; v_pstart := v_pend - (v_days - 1);
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
   WHERE uc.club_id = p_club_id LIMIT 1;

  WITH current_games AS MATERIALIZED (
    SELECT * FROM public.fn_ca_club_games(
      p_club_id, v_start, v_end, v_game, v_stakes, v_q
    )
  )
  SELECT (SELECT jsonb_build_object(
            'games', count(*),
            'total_winnings', round(COALESCE(SUM(g.winnings), 0), 2),
            'mtt_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class IN ('MTT','SNG')), 0), 2),
            'cash_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class NOT IN ('MTT','SNG')), 0), 2),
            'fee', round(COALESCE(SUM(g.fee), 0), 2),
            'cash_fee', round(COALESCE(SUM(g.fee) FILTER (WHERE g.game_class NOT IN ('MTT','SNG')), 0), 2),
            'mtt_fee', round(COALESCE(SUM(g.fee) FILTER (WHERE g.game_class IN ('MTT','SNG')), 0), 2),
            'hands', COALESCE(SUM(g.hands), 0)) FROM current_games g),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'kind', q.kind, 'id', q.id, 'name', q.name, 'variant', q.variant,
           'game_class', q.game_class, 'stakes_tier', q.stakes_tier,
           'blinds', CASE WHEN q.big_blind > 0 THEN
             trim(trailing '.' from trim(trailing '0' from q.small_blind::text)) || '/' ||
             trim(trailing '.' from trim(trailing '0' from q.big_blind::text)) END,
           'rake_percent', q.rake_percent, 'started_at', q.started_at,
           'status', q.status, 'creator_id', q.created_by,
           'creator_name', pr.username, 'creator_avatar', pr.avatar_url,
           'fee', q.fee, 'winnings', q.winnings, 'hands', q.hands,
           'players', q.players) ORDER BY q.started_at DESC NULLS LAST)
           FROM (SELECT * FROM current_games ORDER BY started_at DESC NULLS LAST LIMIT v_lim) q
           LEFT JOIN public.profiles pr ON pr.id = q.created_by), '[]'::jsonb)
    INTO v_cur, v_rows;

  SELECT jsonb_build_object(
    'games', count(*),
    'total_winnings', round(COALESCE(SUM(g.winnings), 0), 2),
    'mtt_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class IN ('MTT','SNG')), 0), 2),
    'cash_winnings', round(COALESCE(SUM(g.winnings) FILTER (WHERE g.game_class NOT IN ('MTT','SNG')), 0), 2),
    'fee', round(COALESCE(SUM(g.fee), 0), 2),
    'hands', COALESCE(SUM(g.hands), 0)) INTO v_prev
    FROM public.fn_ca_club_games(p_club_id, v_pstart, v_pend, v_game, v_stakes, v_q) g;

  SELECT jsonb_build_object(
    'range', jsonb_build_object('start',v_start,'end',v_end,'days',v_days),
    'previous_range', jsonb_build_object('start',v_pstart,'end',v_pend,'days',v_days),
    'filters', jsonb_build_object('game',v_game,'stakes',v_stakes,'search',v_q),
    'summary',v_cur,'previous',v_prev,
    'delta',jsonb_build_object(
      'fee_pct',CASE WHEN COALESCE((v_prev->>'fee')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric)/abs((v_prev->>'fee')::numeric)*100,1) END,
      'games_pct',CASE WHEN COALESCE((v_prev->>'games')::numeric,0)=0 THEN NULL ELSE round(((v_cur->>'games')::numeric-(v_prev->>'games')::numeric)/abs((v_prev->>'games')::numeric)*100,1) END,
      'winnings_abs',round((v_cur->>'total_winnings')::numeric-(v_prev->>'total_winnings')::numeric,2),
      'fee_abs',round((v_cur->>'fee')::numeric-(v_prev->>'fee')::numeric,2)),
    'rows',v_rows,'row_count',(v_cur->>'games')::int,'union_id',v_union,
    'data_updated_at',GREATEST(
      (SELECT max(c.updated_at) FROM public.club_table_daily c WHERE c.club_id=p_club_id AND c.stat_date BETWEEN v_start AND v_end),
      (SELECT max(d.updated_at) FROM public.ca_club_tournament_daily d WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end)),
    'generated_at',now()) INTO v_out;
  RETURN v_out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_club_player_breakdown(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end date := LEAST(COALESCE(p_end,v_today),v_today);
  v_start date := COALESCE(p_start,v_end-13);
  v_lim int := GREATEST(LEAST(COALESCE(p_limit,100),500),1);
  v_union uuid; v_out jsonb;
BEGIN
  IF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE='42501';
  END IF;
  IF v_start < v_end-92 THEN v_start:=v_end-92; END IF;
  IF v_start > v_end THEN v_start:=v_end; END IF;
  SELECT uc.union_id INTO v_union FROM public.union_clubs uc
   WHERE uc.club_id=p_club_id LIMIT 1;

  WITH att_club AS MATERIALIZED (
    SELECT a.user_id FROM (
      SELECT DISTINCT ON (cm.user_id) cm.user_id,cm.club_id
        FROM public.club_members cm JOIN public.union_clubs uc
          ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE v_union IS NOT NULL
       ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id) a
     WHERE a.club_id=p_club_id
    UNION
    SELECT cm.user_id FROM public.club_members cm
     WHERE v_union IS NULL AND cm.club_id=p_club_id
  ), wallet_pnl AS (
    SELECT d.user_id,SUM(d.cash_net) AS cash_net,SUM(d.tournament_net) AS tournament_net
      FROM public.ca_club_player_daily d
     WHERE d.club_id=p_club_id AND d.stat_date BETWEEN v_start AND v_end
     GROUP BY d.user_id
  ), rake AS (
    SELECT u.user_id,SUM(u.rake_amount) AS rake
      FROM public.union_rake_paid_daily_user u JOIN att_club a ON a.user_id=u.user_id
     WHERE u.union_id=v_union AND u.day BETWEEN v_start AND v_end GROUP BY u.user_id
  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint AS hands
      FROM public.club_member_daily_stats s JOIN att_club a ON a.user_id=s.user_id
     WHERE s.stat_date BETWEEN v_start AND v_end GROUP BY s.user_id
  ), merged AS MATERIALIZED (
    SELECT a.user_id,round(COALESCE(w.cash_net,0),2) AS cash_net,
           round(COALESCE(w.tournament_net,0),2) AS tournament_net,
           round(COALESCE(w.cash_net,0)+COALESCE(w.tournament_net,0),2) AS net,
           round(COALESCE(r.rake,0),2) AS rake,COALESCE(h.hands,0) AS hands
      FROM att_club a LEFT JOIN wallet_pnl w ON w.user_id=a.user_id
      LEFT JOIN rake r ON r.user_id=a.user_id LEFT JOIN hands h ON h.user_id=a.user_id
     WHERE COALESCE(w.cash_net,0)<>0 OR COALESCE(w.tournament_net,0)<>0
        OR COALESCE(r.rake,0)<>0 OR COALESCE(h.hands,0)<>0
  )
  SELECT jsonb_build_object(
    'range',jsonb_build_object('start',v_start,'end',v_end,'days',(v_end-v_start)+1),
    'rake_complete_through',LEAST(v_end,v_today-1),
    'totals',(SELECT jsonb_build_object('players',count(*),'net',round(COALESCE(SUM(m.net),0),2),'rake',round(COALESCE(SUM(m.rake),0),2),'hands',COALESCE(SUM(m.hands),0)) FROM merged m),
    'players',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'user_id',q.user_id,'username',COALESCE(pr.display_name,pr.username,'Player'),
      'avatar_url',pr.avatar_url,'is_horse',COALESCE(pr.is_horse,false),
      'net',q.net,'cash_net',q.cash_net,'tournament_net',q.tournament_net,
      'rake',q.rake,'hands',q.hands) ORDER BY q.net DESC)
      FROM (SELECT * FROM merged ORDER BY net DESC LIMIT v_lim) q
      LEFT JOIN public.profiles pr ON pr.id=q.user_id),'[]'::jsonb),
    'player_count',(SELECT count(*) FROM merged),'generated_at',now()) INTO v_out;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_reporting_club_for_activity(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_refresh_reporting_rollups(date,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_reporting_rollups(date,date)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_games(uuid,date,date,text,text,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.ca_club_data_snapshot(uuid,date,date,text,text,text,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_snapshot(uuid,date,date,text,text,text,integer)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ca_club_player_breakdown(uuid,date,date,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_player_breakdown(uuid,date,date,integer)
  TO authenticated, service_role;

DO $assert$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.ca_club_player_daily
   WHERE cash_net IS NULL OR tournament_net IS NULL;
  IF v_bad <> 0 THEN RAISE EXCEPTION 'player reporting backfill contains NULL facts'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='ca_reporting_wallet_insert' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='ca_reporting_rake_insert' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Club Data reporting maintenance triggers were not installed';
  END IF;
END
$assert$;

-- ROLLBACK: restore the three RPC definitions from 20260830235959/61, drop
-- the four ca_reporting_* triggers and trigger functions, then drop the three
-- ca_club_*_daily tables.  Source ledgers are never modified by this migration.
