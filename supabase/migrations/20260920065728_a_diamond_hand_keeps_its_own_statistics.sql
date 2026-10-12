-- 20260920065728_a_diamond_hand_keeps_its_own_statistics
--
-- Version reserved by scripts/reserve-migration-version.sh on 2026-09-20 for
-- the draft of this migration, which was never applied. Rebuilt against the
-- live database on 2026-09-29 (Diamond Arena Phase 10, line 1) and applied
-- once to kuklfnapbkmacvwxktbh.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ WHAT IS WRONG ════════════════════════════════════════════════════════
--
-- The per-hand stat table (ca_hand_player_stat) and the player-to-hand index
-- (ca_hand_player_idx) carry no club and no asset column. Every reader of the
-- stats page takes p_user and nothing else. So the first Diamond hand ever
-- dealt would add its profit, winnings, investment and rake to that player's
-- chip figures, and because the rows lose the distinction when they are
-- written, nothing afterwards could take the two apart. It has not happened
-- only because no Diamond hand has been dealt: read on 2026-09-29, no hand in
-- hand_history is at one of the 17 Diamond tables or in a Diamond tournament.
--
-- ═══ WHY THE 2026-09-20 DRAFT COULD NOT BE APPLIED AS WRITTEN ═════════════
--
-- 1. It edited the post-commit projection by substitution against a body
--    pinned on 2026-09-20. 20260922144812_a_members_profit_is_each_hands_own_net
--    changed that body, the pin no longer matches, and two of the draft's four
--    substitutions no longer have anything to match.
-- 2. The projection is not the only writer. The hand_history trigger
--    (trg_ca_stats_live_from_hand), the forward roll
--    (ca_roll_hand_stats_forward), the index refresh
--    (ca_refresh_hand_player_index) and the seat backfill
--    (ca_index_every_seat) write the same two tables. The forward roll and
--    the index refresh run from World Hub's club-stats-maintenance cron and
--    read hand_history up to now(), so they can reach a new hand before the
--    projection's outbox does; ON CONFLICT DO NOTHING then keeps THEIR row.
--    A label stamped by the projection alone would lose that race.
-- 3. It built two indexes and validated two check constraints inside the
--    transaction, under the ACCESS EXCLUSIVE lock ADD COLUMN takes. A
--    sequential scan of ca_hand_player_idx (17,930,742 rows) measured 9.5 s on
--    2026-09-29, before any index build. Every hand's projection writes that
--    table, and the service role's statement timeout is 8 s.
-- 4. It left the seven readers for later, but the client law
--    (tests/chip-and-diamond-figures-never-sum.law.test.ts) ties the client's
--    scope switch to this change, so the two have to land together.
--
-- ═══ WHAT THIS DOES ═══════════════════════════════════════════════════════
--
-- 1. The asset comes from the hand, for every writer. One BEFORE INSERT OR
--    UPDATE trigger on each table sets `asset` from the hand the row
--    describes: the asset of the club whose table the hand was dealt at (the
--    test the projection already makes for v_diamond), or of its tournament's
--    club if the table is gone. No writer has to remember it, a writer that
--    names an asset is overruled by the hand, and the projection and the four
--    other writers are not edited at all.
-- 2. The two tables gain `asset text NOT NULL DEFAULT 'chips'`. The constant
--    default is recorded in the catalogue, not written to 18 million rows,
--    and it is exact: no Diamond hand exists (asserted below, not assumed).
--    The check constraint is added NOT VALID for the same reason: every
--    existing row holds the default, and validating it would scan the index
--    table under an exclusive lock for no information.
-- 3. The eight readers learn p_asset text DEFAULT 'chips' as their last
--    parameter, so every existing caller keeps its answer, which today is the
--    whole table. An asset that is neither chips nor diamonds is refused. The
--    stat and index tables are filtered on the new column; ca_hand_facts and
--    ca_hand_transfers already carry club_id and are filtered on the club's
--    asset (a row with no club is a chip row, as it is in the projection);
--    the tournament block of the stats payload is filtered on the event's
--    club. The old signature is DROPPED first: CREATE OR REPLACE with an extra
--    defaulted parameter adds an overload, and every existing call would then
--    fail with "function is not unique".
-- 4. Retention keeps each asset its own window. The forward roll and the
--    prune keep the newest rows per player PER ASSET, so a player's Diamond
--    history is not eaten by their chip hands (the stats page reads the
--    newest 750 rows of the asset it asks for).
--
-- No new index. The readers filter rows they already fetch, except the
-- lifetime count and the pulse, which read ca_hand_player_idx. Measured on
-- 2026-09-29: the heaviest human account holds 1,714 index rows, so a
-- filtered read is milliseconds; the heaviest horse holds 40,551, where a
-- filtered read took 2.7 s against 12.6 ms index-only - and nobody opens a
-- horse's stats page. When human volume makes it matter, an index on
-- (user_id, asset, created_at DESC) must be built CONCURRENTLY, outside the
-- migration runner, which cannot run it.
--
-- Nothing is priced, no switch is touched, no Diamond moves, and neither the
-- projection nor any reader is on fn_ca_guard_watchlist().
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-29:
--   ca_player_stats_pulse          597a71ba51fa1275215f58ccbcc0e743
--   ca_player_stats_overview_v2    00958f66317d7bf0b968eeaf941ee25d
--   ca_player_stats_full           e4e260c9d2c79d044b4cc97df56b89a1
--   ca_player_ev_curve             621d063b10d00599ef4b73093a249e9f
--   ca_player_hand_grid            c80cd2b2538dae399d5ae34fab49f218
--   ca_player_class_hands          76807462a763a891f05c352e9e6b1a34
--   ca_player_rake_stats           90616705100e1788eced8e8651434aee
--   ca_player_nemesis              93615242887096b8ef88ef6c3d6bf8b4
--   ca_roll_hand_stats_forward     b43b23aa54713ea1a4bd8df8d20b64bc
--   ca_prune_hand_player_stat      c504360c93135dde6b059e9d46ec3b6f

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. PREFLIGHT: NO DIAMOND HAND EXISTS, SO THE DEFAULT IS EXACT
-- ---------------------------------------------------------------------------
DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is open; this migration expects both closed';
  END IF;
  IF EXISTS (SELECT 1
               FROM public.clubs c
               JOIN public.tables t ON t.club_id = c.id
               JOIN public.hand_history h ON h.table_id = t.id
              WHERE c.asset = 'diamonds')
     OR EXISTS (SELECT 1
                  FROM public.clubs c
                  JOIN public.tournaments tr ON tr.club_id = c.id
                  JOIN public.hand_history h ON h.tournament_id = tr.id
                 WHERE c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'a Diamond hand already exists; DEFAULT ''chips'' would mislabel its rows';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name IN ('ca_hand_player_stat', 'ca_hand_player_idx')
                AND column_name = 'asset') THEN
    RAISE EXCEPTION 'the stat tables already carry an asset column; re-derive this migration';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE ASSET OF A ROW IS THE ASSET OF ITS HAND
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_asset text;
BEGIN
  -- The club whose table the hand was dealt at decides, the same test the
  -- post-commit projection makes for v_diamond; if the table is gone, the
  -- tournament's club. A hand that cannot be found keeps what the writer
  -- gave, which is the column default: every writer reads the hand from
  -- hand_history in the same statement, so that does not arise.
  SELECT c.asset INTO v_asset
    FROM public.hand_history h
    LEFT JOIN public.tables t ON t.id = h.table_id
    LEFT JOIN public.tournaments tr ON tr.id = h.tournament_id
    JOIN public.clubs c ON c.id = coalesce(t.club_id, tr.club_id)
   WHERE h.id = NEW.hand_id;
  IF FOUND THEN
    NEW.asset := CASE WHEN v_asset = 'diamonds' THEN 'diamonds' ELSE 'chips' END;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset() IS
  'BEFORE INSERT OR UPDATE OF asset, hand_id on ca_hand_player_stat and ca_hand_player_idx: '
  'sets asset from the hand the row describes (its table''s club, else its tournament''s club), '
  'so every writer labels a Diamond hand as Diamond. 2026-09-29.';

-- ---------------------------------------------------------------------------
-- 3a. THE PULSE WATCHES ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_stats_pulse(uuid)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_stats_pulse(p_user uuid)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_stats_pulse(p_user uuid, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  PERFORM public.ca_assert_self(p_user);
$f$;
  v_new2 text := $f$  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
$f$;
  v_old3 text := $f$  FROM public.ca_hand_player_idx WHERE user_id = p_user;
$f$;
  v_new3 text := $f$  FROM public.ca_hand_player_idx WHERE user_id = p_user AND asset = p_asset;
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_stats_pulse(uuid) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '597a71ba51fa1275215f58ccbcc0e743' THEN
    RAISE EXCEPTION 'ca_player_stats_pulse is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_pulse: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_pulse: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_pulse: clause 3 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_stats_pulse(uuid);
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  v_new_oid := to_regprocedure('public.ca_player_stats_pulse(uuid,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_stats_pulse(uuid,text) was not created'; END IF;
  IF md5(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> '597a71ba51fa1275215f58ccbcc0e743' THEN
    RAISE EXCEPTION 'ca_player_stats_pulse: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_stats_pulse(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_pulse(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3b. THE STATS PAGE DOOR ASKS FOR ONE ASSET AND SAYS WHICH
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_stats_overview_v2(uuid,integer,text)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  PERFORM public.ca_assert_self(p_user);
$f$;
  v_new2 text := $f$  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
$f$;
  v_old3 text := $f$  v_result := public.ca_player_stats_full(p_user, v_days, p_tz);
$f$;
  v_new3 text := $f$  v_result := public.ca_player_stats_full(p_user, v_days, p_tz, p_asset);
$f$;
  v_old4 text := $f$      'target_user_id', p_user,
$f$;
  v_new4 text := $f$      'target_user_id', p_user,
      'asset', p_asset,
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_stats_overview_v2(uuid,integer,text) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '00958f66317d7bf0b968eeaf941ee25d' THEN
    RAISE EXCEPTION 'ca_player_stats_overview_v2 is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_overview_v2: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_overview_v2: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_overview_v2: clause 3 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old4, ''))) / length(v_old4);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_overview_v2: clause 4 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_stats_overview_v2(uuid, integer, text);
  EXECUTE replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4);
  v_new_oid := to_regprocedure('public.ca_player_stats_overview_v2(uuid,integer,text,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_stats_overview_v2(uuid,integer,text,text) was not created'; END IF;
  IF md5(replace(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4)) <> '00958f66317d7bf0b968eeaf941ee25d' THEN
    RAISE EXCEPTION 'ca_player_stats_overview_v2: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3c. THE STATS PAYLOAD READS ONE ASSET: HANDS, LIFETIME AND TOURNAMENTS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_stats_full(uuid,integer,text)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_stats_full(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  -- An unknown zone name falls back to UTC rather than failing the page.
$f$;
  v_new2 text := $f$  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
  -- An unknown zone name falls back to UTC rather than failing the page.
$f$;
  v_old3 text := $f$  FROM ca_hand_player_idx WHERE user_id = p_user;
$f$;
  v_new3 text := $f$  FROM ca_hand_player_idx WHERE user_id = p_user AND asset = p_asset;
$f$;
  v_old4 text := $f$  WHERE s.user_id = p_user
    AND (v_since IS NULL OR s.created_at >= v_since)
$f$;
  v_new4 text := $f$  WHERE s.user_id = p_user
    AND s.asset = p_asset
    AND (v_since IS NULL OR s.created_at >= v_since)
$f$;
  v_old5 text := $f$  WHERE tp.user_id = p_user
    AND (v_since IS NULL OR coalesce(t.start_time, tp.registered_at, now()) >= v_since)
$f$;
  v_new5 text := $f$  WHERE tp.user_id = p_user
    AND coalesce(t.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')
    AND (v_since IS NULL OR coalesce(t.start_time, tp.registered_at, now()) >= v_since)
$f$;
  v_old6 text := $f$  'user_id', p_user,
$f$;
  v_new6 text := $f$  'user_id', p_user,
  'asset', p_asset,
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_stats_full(uuid,integer,text) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'e4e260c9d2c79d044b4cc97df56b89a1' THEN
    RAISE EXCEPTION 'ca_player_stats_full is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_full: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_full: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_full: clause 3 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old4, ''))) / length(v_old4);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_full: clause 4 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old5, ''))) / length(v_old5);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_full: clause 5 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old6, ''))) / length(v_old6);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_stats_full: clause 6 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_stats_full(uuid, integer, text);
  EXECUTE replace(replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5), v_old6, v_new6);
  v_new_oid := to_regprocedure('public.ca_player_stats_full(uuid,integer,text,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_stats_full(uuid,integer,text,text) was not created'; END IF;
  IF md5(replace(replace(replace(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5), v_new6, v_old6)) <> 'e4e260c9d2c79d044b4cc97df56b89a1' THEN
    RAISE EXCEPTION 'ca_player_stats_full: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, integer, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3d. THE EV CURVE READS ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_ev_curve(uuid,integer,integer)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_ev_curve(p_user uuid, p_days integer DEFAULT NULL::integer, p_limit integer DEFAULT 5000)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_ev_curve(p_user uuid, p_days integer DEFAULT NULL::integer, p_limit integer DEFAULT 5000, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  PERFORM public.ca_assert_self(p_user);
$f$;
  v_new2 text := $f$  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
$f$;
  v_old3 text := $f$    WHERE f.user_id = p_user
      AND f.went_to_showdown = true
$f$;
  v_new3 text := $f$    WHERE f.user_id = p_user
      AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')
      AND f.went_to_showdown = true
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_ev_curve(uuid,integer,integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '621d063b10d00599ef4b73093a249e9f' THEN
    RAISE EXCEPTION 'ca_player_ev_curve is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_ev_curve: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_ev_curve: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_ev_curve: clause 3 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_ev_curve(uuid, integer, integer);
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  v_new_oid := to_regprocedure('public.ca_player_ev_curve(uuid,integer,integer,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_ev_curve(uuid,integer,integer,text) was not created'; END IF;
  IF md5(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> '621d063b10d00599ef4b73093a249e9f' THEN
    RAISE EXCEPTION 'ca_player_ev_curve: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_ev_curve(uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_ev_curve(uuid, integer, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3e. THE HAND GRID READS ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_hand_grid(uuid,text,text,integer)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_hand_grid(p_user uuid, p_position text DEFAULT NULL::text, p_variant text DEFAULT NULL::text, p_days integer DEFAULT NULL::integer)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_hand_grid(p_user uuid, p_position text DEFAULT NULL::text, p_variant text DEFAULT NULL::text, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  PERFORM public.ca_assert_self(p_user);
$f$;
  v_new2 text := $f$  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
$f$;
  v_old3 text := $f$    WHERE f.user_id = p_user
      AND f.hand_class IS NOT NULL
$f$;
  v_new3 text := $f$    WHERE f.user_id = p_user
      AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')
      AND f.hand_class IS NOT NULL
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_hand_grid(uuid,text,text,integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'c80cd2b2538dae399d5ae34fab49f218' THEN
    RAISE EXCEPTION 'ca_player_hand_grid is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hand_grid: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hand_grid: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hand_grid: clause 3 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_hand_grid(uuid, text, text, integer);
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  v_new_oid := to_regprocedure('public.ca_player_hand_grid(uuid,text,text,integer,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_hand_grid(uuid,text,text,integer,text) was not created'; END IF;
  IF md5(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> 'c80cd2b2538dae399d5ae34fab49f218' THEN
    RAISE EXCEPTION 'ca_player_hand_grid: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_hand_grid(uuid, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_hand_grid(uuid, text, text, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3f. THE HANDS BEHIND A GRID CELL ARE IN ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_class_hands(uuid,text,text,text,integer,integer)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_class_hands(p_user uuid, p_hand_class text, p_position text DEFAULT NULL::text, p_variant text DEFAULT NULL::text, p_days integer DEFAULT NULL::integer, p_limit integer DEFAULT 20)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_class_hands(p_user uuid, p_hand_class text, p_position text DEFAULT NULL::text, p_variant text DEFAULT NULL::text, p_days integer DEFAULT NULL::integer, p_limit integer DEFAULT 20, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  PERFORM public.ca_assert_self(p_user);
$f$;
  v_new2 text := $f$  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
$f$;
  v_old3 text := $f$        WHERE f.user_id = p_user
          AND f.hand_class = p_hand_class
$f$;
  v_new3 text := $f$        WHERE f.user_id = p_user
          AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')
          AND f.hand_class = p_hand_class
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_class_hands(uuid,text,text,text,integer,integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '76807462a763a891f05c352e9e6b1a34' THEN
    RAISE EXCEPTION 'ca_player_class_hands is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_class_hands: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_class_hands: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_class_hands: clause 3 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_class_hands(uuid, text, text, text, integer, integer);
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  v_new_oid := to_regprocedure('public.ca_player_class_hands(uuid,text,text,text,integer,integer,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_class_hands(uuid,text,text,text,integer,integer,text) was not created'; END IF;
  IF md5(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> '76807462a763a891f05c352e9e6b1a34' THEN
    RAISE EXCEPTION 'ca_player_class_hands: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_class_hands(uuid, text, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_class_hands(uuid, text, text, text, integer, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3g. RAKE PAID IS COUNTED IN ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_rake_stats(uuid,integer)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_rake_stats(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_rake_stats(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$BEGIN
  IF public.fn_caller_is_engine() THEN
$f$;
  v_new2 text := $f$BEGIN
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
  IF public.fn_caller_is_engine() THEN
$f$;
  v_old3 text := $f$    AND f.tournament_id IS NULL;
$f$;
  v_new3 text := $f$    AND f.tournament_id IS NULL
    AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds');
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_rake_stats(uuid,integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '90616705100e1788eced8e8651434aee' THEN
    RAISE EXCEPTION 'ca_player_rake_stats is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_rake_stats: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_rake_stats: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_rake_stats: clause 3 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_rake_stats(uuid, integer);
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  v_new_oid := to_regprocedure('public.ca_player_rake_stats(uuid,integer,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_rake_stats(uuid,integer,text) was not created'; END IF;
  IF md5(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> '90616705100e1788eced8e8651434aee' THEN
    RAISE EXCEPTION 'ca_player_rake_stats: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_rake_stats(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_rake_stats(uuid, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3h. HEAD-TO-HEAD FLOWS ARE NETTED IN ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_nemesis(uuid,integer,integer,integer)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_nemesis(p_user uuid, p_days integer DEFAULT NULL::integer, p_min_hands integer DEFAULT 25, p_limit integer DEFAULT 10)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_nemesis(p_user uuid, p_days integer DEFAULT NULL::integer, p_min_hands integer DEFAULT 25, p_limit integer DEFAULT 10, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  PERFORM public.ca_assert_self(p_user);
$f$;
  v_new2 text := $f$  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
$f$;
  v_old3 text := $f$    WHERE t.winner_id = p_user
$f$;
  v_new3 text := $f$    WHERE t.winner_id = p_user
      AND coalesce(t.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')
$f$;
  v_old4 text := $f$    WHERE t.loser_id = p_user
$f$;
  v_new4 text := $f$    WHERE t.loser_id = p_user
      AND coalesce(t.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')
$f$;
  v_old5 text := $f$    WHERE f.user_id = p_user
$f$;
  v_new5 text := $f$    WHERE f.user_id = p_user
      AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds')
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_nemesis(uuid,integer,integer,integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '93615242887096b8ef88ef6c3d6bf8b4' THEN
    RAISE EXCEPTION 'ca_player_nemesis is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_nemesis: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_nemesis: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_nemesis: clause 3 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old4, ''))) / length(v_old4);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_nemesis: clause 4 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old5, ''))) / length(v_old5);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_nemesis: clause 5 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_nemesis(uuid, integer, integer, integer);
  EXECUTE replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5);
  v_new_oid := to_regprocedure('public.ca_player_nemesis(uuid,integer,integer,integer,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_nemesis(uuid,integer,integer,integer,text) was not created'; END IF;
  IF md5(replace(replace(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3), v_new4, v_old4), v_new5, v_old5)) <> '93615242887096b8ef88ef6c3d6bf8b4' THEN
    RAISE EXCEPTION 'ca_player_nemesis: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_nemesis(uuid, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_nemesis(uuid, integer, integer, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4a. THE FORWARD ROLL KEEPS EACH ASSET ITS OWN WINDOW
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_roll_hand_stats_forward()');
  v_def text;
  v_n integer;
  v_old1 text := $f$row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn$f$;
  v_new1 text := $f$row_number() OVER (PARTITION BY user_id, asset ORDER BY created_at DESC) AS rn$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_roll_hand_stats_forward() is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'b43b23aa54713ea1a4bd8df8d20b64bc' THEN
    RAISE EXCEPTION 'ca_roll_hand_stats_forward is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_roll_hand_stats_forward: the retention rank occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> 'b43b23aa54713ea1a4bd8df8d20b64bc' THEN
    RAISE EXCEPTION 'ca_roll_hand_stats_forward: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 4b. THE PRUNE KEEPS EACH ASSET ITS OWN WINDOW
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_prune_hand_player_stat(integer)');
  v_def text;
  v_n integer;
  v_old1 text := $f$row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn$f$;
  v_new1 text := $f$row_number() OVER (PARTITION BY user_id, asset ORDER BY created_at DESC) AS rn$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_prune_hand_player_stat(integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'c504360c93135dde6b059e9d46ec3b6f' THEN
    RAISE EXCEPTION 'ca_prune_hand_player_stat is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_prune_hand_player_stat: the retention rank occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old1, v_new1);
  IF md5(replace(pg_get_functiondef(v_oid), v_new1, v_old1)) <> 'c504360c93135dde6b059e9d46ec3b6f' THEN
    RAISE EXCEPTION 'ca_prune_hand_player_stat: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

COMMENT ON FUNCTION public.ca_player_stats_full(uuid, integer, text, text) IS
  'The stats payload for one player in one asset (p_asset, chips or diamonds, default chips): the most recent 750 stat rows of that asset (exact settlement overlaid), lifetime index counts of that asset, daily series in p_tz (IANA; unknown names fall back to UTC), cash sessions (a new session starts after a 45-minute gap between the player''s cash hands; session profit is the sum of its hands'' settlements), positions, stakes, variants, and tournaments of that asset in the rolling window. Service role only; the browser reaches it through ca_player_stats_overview_v2.';
COMMENT ON FUNCTION public.ca_player_stats_overview_v2(uuid, integer, text, text) IS
  'The browser''s door to the stats payload: asserts auth.uid() = p_user, wraps ca_player_stats_full(p_user, p_days, p_tz, p_asset) and stamps the contract (scope, including the asset, quality, coverage). p_tz is the player''s IANA zone for day buckets; p_asset is chips (the default) or diamonds, and a chip figure and a Diamond figure are never summed.';
COMMENT ON FUNCTION public.ca_player_stats_pulse(uuid, text) IS
  'The stats page''s heartbeat: the newest hand of one asset (p_asset, default chips) in the player''s own index and a fingerprint of their tournament rows, as one string. The page polls it while visible and refetches when it changes. Owner only (ca_assert_self). Replaces the Realtime subscription on ca_hand_player_idx, which left the publication on 2026-09-04.';

-- ---------------------------------------------------------------------------
-- 5. THE TWO TABLES LEARN WHICH ASSET A ROW IS IN (index first, then stat:
--    the order every writer takes them in)
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_hand_player_idx
  ADD COLUMN asset text NOT NULL DEFAULT 'chips',
  ADD CONSTRAINT ca_hand_player_idx_asset_ck CHECK (asset IN ('chips', 'diamonds')) NOT VALID;
CREATE TRIGGER ca_hand_player_idx_takes_its_hands_asset
  BEFORE INSERT OR UPDATE OF asset, hand_id ON public.ca_hand_player_idx
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset();
COMMENT ON COLUMN public.ca_hand_player_idx.asset IS
  'The asset of the hand this row points at, set from the hand by fn_ca_hand_player_row_takes_its_hands_asset. Every stats read filters on it: a chip figure and a Diamond figure are never summed. Added 2026-09-29.';

ALTER TABLE public.ca_hand_player_stat
  ADD COLUMN asset text NOT NULL DEFAULT 'chips',
  ADD CONSTRAINT ca_hand_player_stat_asset_ck CHECK (asset IN ('chips', 'diamonds')) NOT VALID;
CREATE TRIGGER ca_hand_player_stat_takes_its_hands_asset
  BEFORE INSERT OR UPDATE OF asset, hand_id ON public.ca_hand_player_stat
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_hand_player_row_takes_its_hands_asset();
COMMENT ON COLUMN public.ca_hand_player_stat.asset IS
  'The asset this row''s money is denominated in, set from the hand by fn_ca_hand_player_row_takes_its_hands_asset. Every stats read filters on it: a chip figure and a Diamond figure are never summed. Added 2026-09-29.';

-- ---------------------------------------------------------------------------
-- 6. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record;
  v_oid oid;
  v_bad text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('ca_hand_player_stat', 'ca_hand_player_idx')
         AND column_name = 'asset' AND data_type = 'text' AND is_nullable = 'NO'
         AND column_default = '''chips''::text') <> 2 THEN
    RAISE EXCEPTION 'the asset column is not on both tables as written';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('ca_hand_player_stat_asset_ck', 'ca_hand_player_idx_asset_ck')
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE 'CHECK ((asset = ANY (ARRAY[''chips''::text, ''diamonds''::text])))%') <> 2 THEN
    RAISE EXCEPTION 'the asset check is not on both tables as written';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('ca_hand_player_stat_takes_its_hands_asset', 'ca_hand_player_idx_takes_its_hands_asset')
         AND tgrelid IN ('public.ca_hand_player_stat'::regclass, 'public.ca_hand_player_idx'::regclass)
         AND tgfoid = 'public.fn_ca_hand_player_row_takes_its_hands_asset()'::regprocedure
         AND tgenabled = 'O'
         AND (tgtype & 1) = 1      -- row
         AND (tgtype & 2) = 2      -- before
         AND (tgtype & 4) = 4      -- insert
         AND (tgtype & 16) = 16) <> 2 THEN   -- update
    RAISE EXCEPTION 'the asset trigger is not on both tables as written';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_hand_player_row_takes_its_hands_asset()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_hand_player_row_takes_its_hands_asset()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'the asset trigger function is reachable from a browser role';
  END IF;

  FOR r IN SELECT * FROM (VALUES
      ('ca_player_stats_pulse',       'ca_player_stats_pulse(uuid)',                                    'ca_player_stats_pulse(uuid,text)',                                    true),
      ('ca_player_stats_overview_v2', 'ca_player_stats_overview_v2(uuid,integer,text)',                 'ca_player_stats_overview_v2(uuid,integer,text,text)',                 true),
      ('ca_player_stats_full',        'ca_player_stats_full(uuid,integer,text)',                        'ca_player_stats_full(uuid,integer,text,text)',                        false),
      ('ca_player_ev_curve',          'ca_player_ev_curve(uuid,integer,integer)',                       'ca_player_ev_curve(uuid,integer,integer,text)',                       true),
      ('ca_player_hand_grid',         'ca_player_hand_grid(uuid,text,text,integer)',                    'ca_player_hand_grid(uuid,text,text,integer,text)',                    true),
      ('ca_player_class_hands',       'ca_player_class_hands(uuid,text,text,text,integer,integer)',     'ca_player_class_hands(uuid,text,text,text,integer,integer,text)',     true),
      ('ca_player_rake_stats',        'ca_player_rake_stats(uuid,integer)',                             'ca_player_rake_stats(uuid,integer,text)',                             true),
      ('ca_player_nemesis',           'ca_player_nemesis(uuid,integer,integer,integer)',                'ca_player_nemesis(uuid,integer,integer,integer,text)',                true)
    ) v(proname, old_sig, new_sig, browser)
  LOOP
    IF to_regprocedure('public.' || r.old_sig) IS NOT NULL THEN
      RAISE EXCEPTION '% survived; every existing call would be ambiguous', r.old_sig;
    END IF;
    v_oid := to_regprocedure('public.' || r.new_sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION '% is missing', r.new_sig; END IF;
    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = r.proname) <> 1 THEN
      RAISE EXCEPTION '% has more than one overload', r.proname;
    END IF;
    IF position('p_asset text DEFAULT ''chips''::text' IN pg_get_functiondef(v_oid)) = 0
       OR position('unknown stats asset' IN pg_get_functiondef(v_oid)) = 0 THEN
      RAISE EXCEPTION '% does not take and check its asset', r.proname;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION '% lost SECURITY DEFINER', r.proname;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') IS DISTINCT FROM r.browser THEN
      RAISE EXCEPTION '% does not have the browser grant it had', r.proname;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost its service-role grant', r.proname;
    END IF;
  END LOOP;

  IF position('PARTITION BY user_id, asset ORDER BY created_at DESC' IN pg_get_functiondef('public.ca_roll_hand_stats_forward()'::regprocedure)) = 0
     OR position('PARTITION BY user_id, asset ORDER BY created_at DESC' IN pg_get_functiondef('public.ca_prune_hand_player_stat(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'retention does not keep each asset its own window';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a Diamond switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond hand keeps its own statistics: both tables carry the hand''s asset, eight readers read one asset, retention keeps each its own window, nothing opened';
END $m$;

COMMIT;
