-- =============================================================================
-- deep_stack_locked_cash_catalog_v1
-- Applied to production via Supabase MCP 2026-09-01 13:34 UTC.
--
-- Dan, 2026-09-01: the LOCKED Deep Stack Society cash catalog -- every
-- approved variation at all 14 stake levels. 8 big-bet families were locked;
-- SEVEN are seeded (7 x 14 x 10 = 980 tables): the engine has no
-- 'crazy_pineapple' variant (grep of server/src: zero hits), so Crazy
-- Pineapple's 140 tables are BLOCKED ON ENGINE WORK and reported rather
-- than seeded as undealable rows.
--
-- The directive's premise that cash antes are new functionality is stale:
-- the engine already collects them (FIX-219 in ServerTableEngineDealing
-- honors ante_enabled per Bible V8 4.3; AnteMath pins the per-player
-- convention). ANTE tables set ante_bb=0.2 (the locked default) and
-- ante = greatest(round(0.2*bb,2), 0.01) so micro stakes never advertise a
-- sub-cent ante the ledger cannot represent.
--
-- Variation -> engine wiring (all pre-existing columns the engine reads):
--   CL      family-cap seats, plain
--   RIT     run_it_twice_enabled + allow_run_it_twice + run_it_twice
--   INS     insurance_enabled (+ RIT allowed, insurance rides all-ins)
--   VPIP    nit_game + maintain_percent_min=40 + maintain_hands=20
--   ARH     no_rathole
--   DEEP    100bb-500bb buy-ins
--   BOMB    bomb_pot_enabled, trigger 'timed' every 1800s, double board
--   BPO     bomb_pot_enabled, trigger 'bomb_pot_only', double board
--   ACTION  straddle_enabled + auto_utg_straddle, 2 straddles
--   ANTE    ante_enabled + ante_bb 0.2
--
-- $3/$6 and $4/$8 carry stake_tier 'high' in settings, per the locked
-- classification. Idempotent by settings->>'seed_key'
-- (dss:<fam>:<sb-bb>:<var>), never by display name. The interim catalog from
-- earlier today is retired first (soft delete; felt verified empty).
-- Verified on apply: retired 70, inserted 980, 98 per variation, all
-- assertions green.
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_open int; v_retired int; v_inserted int; v_total int; v_ante_bad int;
BEGIN
  SELECT count(*) INTO v_open
    FROM table_seats ts JOIN tables t ON t.id=ts.table_id
   WHERE t.club_id=v_club AND ts.left_at IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'refusing: % open seats on Deep Stack tables', v_open;
  END IF;

  UPDATE tables SET is_deleted=true, deleted_at=now(), status='closed'
   WHERE club_id=v_club AND tournament_id IS NULL
     AND coalesce(is_deleted,false)=false
     AND coalesce(settings->>'catalog','') <> 'dss-cash-v1';
  GET DIAGNOSTICS v_retired = ROW_COUNT;

  CREATE TEMP TABLE dss_fam (label text, variant text, cap int) ON COMMIT DROP;
  INSERT INTO dss_fam VALUES
    ('NLH','nlh',9), ('PLO','plo4',8), ('PLO5','plo5',7), ('PLO6','plo6',6),
    ('PLO8','plo8',8), ('Pineapple','pineapple',6), ('Short Deck','short_deck',6);

  CREATE TEMP TABLE dss_stake (disp text, key text, sb numeric, bb numeric, tier text) ON COMMIT DROP;
  INSERT INTO dss_stake VALUES
    ('$0.01/$0.02','0.01-0.02',0.01,0.02,'micro'),
    ('$0.02/$0.05','0.02-0.05',0.02,0.05,'micro'),
    ('$0.05/$0.10','0.05-0.10',0.05,0.10,'micro'),
    ('$0.10/$0.25','0.10-0.25',0.10,0.25,'small'),
    ('$0.25/$0.50','0.25-0.50',0.25,0.50,'small'),
    ('$0.50/$1','0.50-1',0.50,1.00,'small'),
    ('$1/$2','1-2',1.00,2.00,'mid'),
    ('$2/$5','2-5',2.00,5.00,'mid'),
    ('$3/$6','3-6',3.00,6.00,'high'),
    ('$4/$8','4-8',4.00,8.00,'high'),
    ('$5/$10','5-10',5.00,10.00,'high'),
    ('$10/$20','10-20',10.00,20.00,'high'),
    ('$25/$50','25-50',25.00,50.00,'high'),
    ('$50/$100','50-100',50.00,100.00,'high');

  CREATE TEMP TABLE dss_var (label text, key text) ON COMMIT DROP;
  INSERT INTO dss_var VALUES
    ('Classic','classic'), ('Run It Twice','rit'), ('Insurance','ins'),
    ('VPIP 40+','vpip'), ('Anti-Rathole','arh'), ('Deep Stack','deep'),
    ('Occasional Bomb Pot','bomb'), ('Bomb-Pot-Only','bpo'),
    ('Straddle Action','action'), ('Ante','ante');

  INSERT INTO tables (
    club_id, union_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in, max_players,
    status, is_private, is_template, auto_create_table,
    settings, rake_percent, rake_cap_bb, action_time_seconds,
    run_it_twice_enabled, allow_run_it_twice, run_it_twice,
    insurance_enabled,
    nit_game, maintain_percent_min, maintain_hands,
    no_rathole,
    bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_interval_seconds,
    bomb_pot_board_count, bomb_pot_double_board, bomb_pot_ante_multiplier,
    straddle_enabled, enable_straddle, allow_straddle, auto_utg_straddle, max_straddles,
    ante_enabled, ante_bb, ante,
    time_bank_enabled, auto_muck
  )
  SELECT
    v_club, NULL,
    f.label || ' ' || s.disp || ' ' || v.label,
    'cash', f.variant, s.disp,
    s.sb, s.bb,
    CASE WHEN v.key='deep' THEN s.bb*100 ELSE s.bb*40 END,
    CASE WHEN v.key='deep' THEN s.bb*500 ELSE s.bb*200 END,
    CASE WHEN v.key='classic' THEN f.cap ELSE least(6, f.cap) END,
    'waiting', false, false, false,
    jsonb_build_object(
      'seed_key', 'dss:'||lower(replace(f.label,' ',''))||':'||s.key||':'||v.key,
      'catalog', 'dss-cash-v1',
      'stake_tier', s.tier,
      'variation', v.key),
    -1, -1, 15,
    (v.key in ('rit','ins')), (v.key in ('rit','ins')), (v.key='rit'),
    (v.key='ins'),
    (v.key='vpip'), CASE WHEN v.key='vpip' THEN 40 ELSE NULL END,
    CASE WHEN v.key='vpip' THEN 20 ELSE NULL END,
    (v.key='arh'),
    (v.key in ('bomb','bpo')),
    CASE v.key WHEN 'bomb' THEN 'timed' WHEN 'bpo' THEN 'bomb_pot_only' ELSE 'every_n_hands' END,
    CASE WHEN v.key='bomb' THEN 1800 ELSE NULL END,
    CASE WHEN v.key in ('bomb','bpo') THEN 2 ELSE 1 END,
    (v.key in ('bomb','bpo')),
    2,
    (v.key='action'), true, true, (v.key='action'),
    CASE WHEN v.key='action' THEN 2 ELSE 1 END,
    (v.key='ante'),
    CASE WHEN v.key='ante' THEN 0.2 ELSE NULL END,
    CASE WHEN v.key='ante' THEN greatest(round(0.2*s.bb,2), 0.01) ELSE 0 END,
    true, true
  FROM dss_fam f CROSS JOIN dss_stake s CROSS JOIN dss_var v
  WHERE NOT EXISTS (
    SELECT 1 FROM tables t
     WHERE t.club_id=v_club
       AND t.settings->>'seed_key' = 'dss:'||lower(replace(f.label,' ',''))||':'||s.key||':'||v.key
       AND coalesce(t.is_deleted,false)=false);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT count(*) INTO v_total FROM tables
   WHERE club_id=v_club AND tournament_id IS NULL
     AND coalesce(is_deleted,false)=false;

  IF v_total <> 980 THEN
    RAISE EXCEPTION 'catalog wrong: retired=% inserted=% total=% (expected 980)',
      v_retired, v_inserted, v_total;
  END IF;

  IF (SELECT count(distinct settings->>'seed_key') FROM tables
       WHERE club_id=v_club AND coalesce(is_deleted,false)=false
         AND settings->>'catalog'='dss-cash-v1') <> 980 THEN
    RAISE EXCEPTION 'seed keys not unique/complete';
  END IF;
  IF EXISTS (SELECT 1 FROM tables WHERE club_id=v_club AND coalesce(is_deleted,false)=false
              AND stakes in ('$3/$6','$4/$8') AND settings->>'stake_tier' <> 'high') THEN
    RAISE EXCEPTION '3/6 or 4/8 not classified high';
  END IF;
  SELECT count(*) INTO v_ante_bad FROM tables
   WHERE club_id=v_club AND coalesce(is_deleted,false)=false
     AND ante_enabled AND (ante < 0.01 OR ante IS NULL);
  IF v_ante_bad <> 0 THEN
    RAISE EXCEPTION '% ante tables below minimum chip denomination', v_ante_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM tables t WHERE t.club_id=v_club AND coalesce(is_deleted,false)=false
              AND ((t.game_variant='plo5' AND t.max_players>7)
                OR (t.game_variant='plo6' AND t.max_players>6)
                OR (t.game_variant='plo4' AND t.max_players>8)
                OR (t.game_variant='plo8' AND t.max_players>8))) THEN
    RAISE EXCEPTION 'seat law violated';
  END IF;
  IF (SELECT count(*) FROM tables WHERE club_id=v_club AND coalesce(is_deleted,false)=false
        AND settings->>'variation'='bpo' AND bomb_pot_trigger_mode='bomb_pot_only') <> 98 THEN
    RAISE EXCEPTION 'bomb-pot-only wiring wrong';
  END IF;
END $$;
