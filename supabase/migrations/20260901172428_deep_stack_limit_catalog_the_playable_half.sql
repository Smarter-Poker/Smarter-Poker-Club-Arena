-- =============================================================================
-- deep_stack_limit_catalog_the_playable_half
-- Applied to production via Supabase MCP 2026-09-01 17:24 UTC.
--
-- The locked catalog's Limit section names eight families across a 13-stake
-- fixed-limit ladder with six variations. The engine today deals exactly TWO
-- of those families: flh and flo8 (seat law 8) -- stud, razz, badugi and 2-7
-- triple draw do not exist as variants, and Kill / Half-Kill pots have no
-- engine support, so seeding them would list games that cannot deal (the
-- crazy-pineapple lesson). Seeded what can actually run: FLH + FLO8 at all
-- 13 locked limit stakes in the three engine-real variations (Classic
-- 6-Max, Classic Full Ring, Deep Buy-In) = 78 tables, taking Deep Stack to
-- 1,058 cash tables. Fixed-limit stakes name SMALL BET / BIG BET; blinds
-- derive sb = small bet / 2, bb = small bet. Buy-ins 20-100 big bets
-- (200-500 for Deep). Idempotent by settings->>'seed_key'.
-- Assertions green on apply: inserted 78, total 1,058, flo8 seat law held.
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_inserted int; v_total int;
BEGIN
  CREATE TEMP TABLE dss_lfam (label text, variant text, cap int) ON COMMIT DROP;
  INSERT INTO dss_lfam VALUES ('FLH','flh',9), ('FLO8','flo8',8);

  CREATE TEMP TABLE dss_lstake (disp text, key text, smallbet numeric, tier text) ON COMMIT DROP;
  INSERT INTO dss_lstake VALUES
    ('$0.02/$0.04','0.02-0.04',0.02,'micro'), ('$0.05/$0.10','0.05-0.10',0.05,'micro'),
    ('$0.10/$0.20','0.10-0.20',0.10,'micro'), ('$0.25/$0.50','0.25-0.50',0.25,'small'),
    ('$0.50/$1','0.50-1',0.50,'small'), ('$1/$2','1-2',1.00,'small'),
    ('$2/$4','2-4',2.00,'mid'), ('$3/$6','3-6',3.00,'high'), ('$4/$8','4-8',4.00,'high'),
    ('$5/$10','5-10',5.00,'high'), ('$10/$20','10-20',10.00,'high'),
    ('$20/$40','20-40',20.00,'high'), ('$50/$100','50-100',50.00,'high');

  CREATE TEMP TABLE dss_lvar (label text, key text, seats_rule text, deep boolean) ON COMMIT DROP;
  INSERT INTO dss_lvar VALUES
    ('Classic 6-Max','classic6','six',false),
    ('Classic Full Ring','classicfr','cap',false),
    ('Deep Buy-In','deep','six',true);

  INSERT INTO tables (
    club_id, union_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in, max_players,
    status, is_private, is_template, auto_create_table,
    settings, rake_percent, rake_cap_bb, action_time_seconds,
    bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_double_board,
    enable_straddle, allow_straddle, straddle_enabled,
    ante_enabled, ante, time_bank_enabled, auto_muck
  )
  SELECT
    v_club, NULL,
    f.label || ' ' || s.disp || ' ' || v.label,
    'cash', f.variant, s.disp,
    round(s.smallbet/2,2), s.smallbet,
    CASE WHEN v.deep THEN s.smallbet*2*200 ELSE s.smallbet*2*20 END,
    CASE WHEN v.deep THEN s.smallbet*2*500 ELSE s.smallbet*2*100 END,
    CASE WHEN v.seats_rule='six' THEN least(6, f.cap) ELSE f.cap END,
    'waiting', false, false, false,
    jsonb_build_object(
      'seed_key','dss:'||f.variant||':'||s.key||':'||v.key,
      'catalog','dss-cash-v1','stake_tier',s.tier,'variation',v.key,
      'betting_structure','fixed_limit'),
    -1, -1, 15,
    1, 'every_n_hands', false,
    false, false, false,
    false, 0, true, true
  FROM dss_lfam f CROSS JOIN dss_lstake s CROSS JOIN dss_lvar v
  WHERE NOT EXISTS (
    SELECT 1 FROM tables t
     WHERE t.club_id=v_club
       AND t.settings->>'seed_key' = 'dss:'||f.variant||':'||s.key||':'||v.key
       AND coalesce(t.is_deleted,false)=false);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT count(*) INTO v_total FROM tables
   WHERE club_id=v_club AND tournament_id IS NULL
     AND coalesce(is_deleted,false)=false;

  IF v_inserted <> 78 OR v_total <> 1058 THEN
    RAISE EXCEPTION 'limit seed wrong: inserted=% (expected 78) total=% (expected 1058)', v_inserted, v_total;
  END IF;

  IF EXISTS (SELECT 1 FROM tables WHERE club_id=v_club AND game_variant='flo8'
              AND coalesce(is_deleted,false)=false AND max_players > 8) THEN
    RAISE EXCEPTION 'flo8 seat law violated';
  END IF;
END $$;
