#!/usr/bin/env python3
"""Prove the Diamond cash rake path on an isolated PostgreSQL 17, through the real doors.

Never connects to production and needs no credential. It starts a cluster of its
own inside a temporary directory it creates and destroys, with listen_addresses
empty and a socket nobody else can name, so there is no environment variable
that could point it at a real database. PG_BIN selects which PostgreSQL 17
binaries run and is the only thing it reads from the environment.

WHAT THIS IS FOR. Phase 9 line (b), the cash-game half:
docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 5. The migration
20261005151712 answers B4 to B13 from the chip schedule and builds the settings
table, the accrual, the sweep, the settler's recompute and the chip-table fence.

HOW IT PROVES IT. The fixture world is loaded, then the INSTALLED Diamond settler
is loaded from production's own pg_get_functiondef text (md5
3aab9170062e97840afc7d15999691ad as read 2026-10-05), and the BEFORE cases
reproduce its refusal of any rake at all - a regression that only ever passes
proves nothing about the thing it claims to change. The migration is then applied
verbatim, including its own closing assertion blocks, and the AFTER cases play
raked hands through fn_poker_diamond_settle_cash_hand itself, replay them, sweep
them through fn_ca_diamond_sweep_cash_rake, and assert the Diamond identity
closes before and after every one.

THE MUTATION CASES. Several cases exist only to prove an assertion asserts: the
engine's rake is moved by one Diamond and the settler must refuse it; the facts
are removed and it must refuse; a loss is made larger than the contribution that
explains it and it must refuse; the deltas are made to conserve to zero while a
rake is claimed and it must refuse. An error is the success case in each.

EVERY AMOUNT HERE THAT IS NOT A RAKE IS A FIXTURE AMOUNT chosen to be legible
(1000 buy-ins, 100 bets). The rake figures are not fixture amounts: they come out
of ca_diamond_economics, which is the whole point.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / 'tests' / 'sql'
SCHEMA = SQL_DIR / 'poker-diamond-cash-rake-schema.sql'
DOORS = SQL_DIR / 'poker-diamond-cash-rake-doors.sql'
MIGRATION = ROOT / 'supabase' / 'migrations' / \
    '20261005183028_diamond_cash_rake_reads_the_owner_settings.sql'
# The SHARED settings table and its readers, which the A-lane applied as
# 20261005151918 at 17:25 UTC on 2026-10-05. The migration under test extends
# this one; it does not build a settings table of its own. Loaded here so the
# fixture's readers are the ones production runs, not a stand-in.
ECONOMICS = ROOT / 'supabase' / 'migrations' / \
    '20261005151918_diamond_economics_records_the_owner_answers.sql'
# The version that merged and then refused itself on apply. It must stay marked
# and must never run; this runner checks the marker and never applies it.
SUPERSEDED = ROOT / 'supabase' / 'migrations' / \
    '20261005151712_diamond_cash_rake_economics_and_accrual.sql'
# The live kind map, whose text the migration restates with two lines added.
KIND_MAP = ROOT / 'supabase' / 'migrations' / \
    '20260920141807_the_diamond_kind_map_names_the_spins_perks.sql'

PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
PACKAGED_BINDIRS = ('/usr/lib/postgresql/17/bin', '/usr/pgsql-17/bin')
ENV = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}

ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81'   # the Diamond Arena, as production has it
CHIP_CLUB = '00000000-0000-0000-0000-0000000000c1'
# A, B, C, D in uuid order, which is also the order the remainder rule breaks
# ties in. C is a horse.
P_A = '00000000-0000-0000-0000-00000000000a'
P_B = '00000000-0000-0000-0000-00000000000b'
P_C = '00000000-0000-0000-0000-00000000000c'
P_D = '00000000-0000-0000-0000-00000000000d'
T_20 = '00000000-0000-0000-0000-0000000000t1'.replace('t1', '21')
T_2 = '00000000-0000-0000-0000-000000000022'
T_300 = '00000000-0000-0000-0000-000000000023'


def bin_path(name: str) -> str:
    for bindir in (PG_BIN,) + PACKAGED_BINDIRS:
        candidate = pathlib.Path(bindir) / name
        if candidate.exists():
            return str(candidate)
    found = shutil.which(name)
    if not found:
        raise SystemExit(f'PostgreSQL 17 tool not found: {name} (set PG_BIN)')
    return found


# ---------------------------------------------------------------------------
# The fixture world. The Diamond Arena with four players, two Diamond cash
# tables at 10/20 and 1/2, every player's buy-in in custody with its purchase
# lot reserved against it, and the identity closing exactly.
# ---------------------------------------------------------------------------
SEED = f"""
INSERT INTO public.clubs (id,name,asset,is_platform) VALUES
  ('{ARENA}','Diamond Arena','diamonds',true),
  ('{CHIP_CLUB}','A Member Club','chips',false);

INSERT INTO public.profiles (id,username,diamonds,is_horse) VALUES
  ('{P_A}','player_a',0,false),
  ('{P_B}','player_b',0,false),
  ('{P_C}','horse_c', 0,true),
  ('{P_D}','player_d',0,false);

INSERT INTO public.tables (id,club_id,game_variant,status,small_blind,big_blind,max_players) VALUES
  ('{T_20}','{ARENA}','nlh','running',10,20,9),
  ('{T_2}', '{ARENA}','nlh','running', 1, 2,6);

INSERT INTO public.ca_arena_settings (id,club_id,cash_games_enabled,tournaments_enabled)
VALUES (1,'{ARENA}',false,true);

INSERT INTO public.ca_diamond_house (id,balance) VALUES (1,0);

-- Each player bought their Diamonds (the register issued them) and then bought
-- in, so the wallet is 0 and the Diamonds are in custody. Nothing here is a
-- price: 1000 is a legible buy-in.
DO $$
DECLARE
  v_seat uuid; v_occ uuid; v_cust uuid; v_lot uuid; v_supply numeric := 0;
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('{P_A}'::uuid,'{T_20}'::uuid,1000::bigint),
    ('{P_A}'::uuid,'{T_2}'::uuid, 1000::bigint),
    ('{P_B}'::uuid,'{T_20}'::uuid,1000::bigint),
    ('{P_B}'::uuid,'{T_2}'::uuid, 1000::bigint),
    ('{P_C}'::uuid,'{T_20}'::uuid,1000::bigint),
    ('{P_D}'::uuid,'{T_20}'::uuid,1000::bigint)
  ) AS t(uid,tid,amount) LOOP
    v_seat := gen_random_uuid(); v_occ := gen_random_uuid();
    INSERT INTO public.table_seats (id,table_id,user_id,occupancy_id,joined_at,stack)
      VALUES (v_seat,r.tid,r.uid,v_occ,'2026-10-05 10:00:00+00',r.amount);
    INSERT INTO public.poker_diamond_custody
      (user_id,arena_id,purpose,target_id,entry_key,balance,state,seat_id,seat_joined_at,occupancy_id)
      VALUES (r.uid,'{ARENA}','cash_seat',r.tid,
              'seat:'||v_seat::text,r.amount,'active',v_seat,'2026-10-05 10:00:00+00',v_occ)
      RETURNING id INTO v_cust;
    INSERT INTO public.diamond_purchase_lots (user_id,purchase_id,issued,arena_reserved)
      VALUES (r.uid,gen_random_uuid(),r.amount::integer,r.amount) RETURNING id INTO v_lot;
    INSERT INTO public.poker_diamond_lot_reservations (custody_id,lot_id,amount)
      VALUES (v_cust,v_lot,r.amount);
    v_supply := v_supply + r.amount;
    INSERT INTO public.ca_mint_ledger
      (op_id,action,asset,holder_type,holder_id,holder_label,amount,
       balance_before,balance_after,supply_after,reason)
      VALUES ('fixture-buy:'||v_cust::text,'mint','diamonds','player',r.uid,'fixture',
              r.amount,0,0,v_supply,'fixture: the player bought these diamonds');
  END LOOP;
END $$;

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM public.fn_ca_diamond_register_vs_supply();
  IF v.difference <> 0 THEN
    RAISE EXCEPTION 'the fixture does not close: register %, meter %', v.register_net, v.meter_total;
  END IF;
  IF v.meter_total <> 6000 THEN
    RAISE EXCEPTION 'the fixture holds % diamonds, not the 6000 it seeded', v.meter_total;
  END IF;
  RAISE NOTICE 'PASS: the fixture closes - register 6000, arena float 6000, house 0, wallets 0';
END $$;
"""

# ---------------------------------------------------------------------------
# One fixture helper. It builds the settler's payload out of the LIVE seats so
# no case has to track a stack across cases by hand, and it calls the real door.
# ---------------------------------------------------------------------------
HELPER = """
-- FIXTURE ONLY. Builds the exact payload the engine would send and calls
-- fn_poker_diamond_settle_cash_hand itself. p_plan is
--   { "<user_id>": {"delta": n, "contributed": n, "dealt_in": bool}, ... }
-- and anyone absent from it sat the hand out with no delta and no contribution.
-- p_facts false omits the three fact keys entirely, which is how the BEFORE
-- cases and the missing-facts case call the door.
CREATE OR REPLACE FUNCTION public.fx_cash_hand(
  p_table uuid, p_hand bigint, p_plan jsonb, p_saw_flop boolean, p_rake numeric,
  p_facts boolean DEFAULT true, p_flop_override jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $fx$
DECLARE v_stacks jsonb; v_row record; v_e jsonb;
BEGIN
  v_stacks := '[]'::jsonb;
  FOR v_row IN
    SELECT s.user_id, s.id AS seat_id, s.joined_at, s.stack
      FROM public.table_seats s
     WHERE s.table_id = p_table AND s.left_at IS NULL
     ORDER BY s.user_id
  LOOP
    v_e := jsonb_build_object(
      'user_id', v_row.user_id,
      'seat_id', v_row.seat_id,
      'seat_joined_at', to_char(v_row.joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'stack_before', v_row.stack::bigint,
      'stack', (v_row.stack + COALESCE((p_plan->(v_row.user_id::text)->>'delta')::bigint,0))::bigint);
    IF p_facts THEN
      v_e := v_e || jsonb_build_object(
        'contributed', COALESCE((p_plan->(v_row.user_id::text)->>'contributed')::bigint,0),
        'dealt_in', COALESCE((p_plan->(v_row.user_id::text)->>'dealt_in')::boolean,false),
        'hand_saw_flop', COALESCE((p_flop_override->>(v_row.user_id::text))::boolean, p_saw_flop));
    END IF;
    v_stacks := v_stacks || jsonb_build_array(v_e);
  END LOOP;
  RETURN public.fn_poker_diamond_settle_cash_hand(p_table, p_hand, v_stacks, p_rake, 0, NULL, 0);
END $fx$;

-- FIXTURE ONLY. A redelivery of a hand already settled has to present the
-- payload the ENGINE sent, not one rebuilt from seats that have since moved, so
-- this reconstructs it from the receipt the settler stored. p_contrib_override
-- changes one player's claimed contribution, which is how the mismatch case
-- proves a replay cannot quietly restate the hand.
CREATE OR REPLACE FUNCTION public.fx_replay(
  p_table uuid, p_hand bigint, p_rake numeric, p_contrib_override jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $fx$
DECLARE v_req jsonb; v_stacks jsonb;
BEGIN
  SELECT request INTO v_req FROM public.poker_diamond_hand_receipts
   WHERE table_id=p_table AND hand_number=p_hand;
  IF v_req IS NULL THEN RAISE EXCEPTION 'fixture: no receipt to replay'; END IF;
  SELECT jsonb_agg(
    jsonb_build_object(
      'user_id', st->>'user_id',
      'seat_id', st->>'seat_id',
      'seat_joined_at', st->>'seat_joined_at',
      'stack_before', (st->>'stack_before')::bigint,
      'stack', (st->>'stack')::bigint,
      'contributed', COALESCE((p_contrib_override->>(st->>'user_id'))::bigint,
                              (c->>'contributed')::bigint),
      'dealt_in', (c->>'dealt_in')::boolean,
      'hand_saw_flop', (v_req->'rake_facts'->>'saw_flop')::boolean)
    ORDER BY st->>'user_id')
    INTO v_stacks
    FROM jsonb_array_elements(v_req->'stacks') st
    JOIN jsonb_array_elements(v_req->'rake_facts'->'contributions') c
      ON c->>'user_id' = st->>'user_id';
  RETURN public.fn_poker_diamond_settle_cash_hand(p_table, p_hand, v_stacks, p_rake, 0, NULL, 0);
END $fx$;
"""


BEFORE = f"""
-- The INSTALLED settler refuses any rake at all. This is the state the design
-- calls layer 5, and it is what the migration changes.
DO $$
BEGIN
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1000001,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',360,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 40, false);
    RAISE EXCEPTION 'the installed settler took a rake and it must refuse one';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: before the migration, the installed settler refuses a raked hand (diamond_plain_cash_hand_required)';
  END;
  IF public.fn_ca_arena_diamonds() <> 6000 THEN
    RAISE EXCEPTION 'the installed float reads %, not 6000', public.fn_ca_arena_diamonds();
  END IF;
  RAISE NOTICE 'PASS: before the migration, the arena float is custody plus open spin days and nothing else';
END $$;
"""

SETTINGS = """
-- Every answer is readable, by the A-lane's own reader, at the name and scope
-- the settler will ask for, and an unpriced stake refuses.
DO $$
BEGIN
  IF public.fn_ca_diamond_economic_on('cash_rake_enabled','all') IS NOT TRUE THEN
    RAISE EXCEPTION 'B4 is not yes';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_percent','all') <> 10 THEN
    RAISE EXCEPTION 'B5 is not 10 percent';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_percent_three_handed','all') <> 10 THEN
    RAISE EXCEPTION 'B7 three-handed is not the ordinary 10 percent';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_percent_heads_up','all') <> 5 THEN
    RAISE EXCEPTION 'B7 heads-up is not 5 percent';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_cap','bb:20') <> 300 THEN
    RAISE EXCEPTION 'the 10/20 cap is not 300 Diamonds';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_cap_heads_up','bb:20') <> 150 THEN
    RAISE EXCEPTION 'the 10/20 heads-up cap is not 150 Diamonds';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_cap','bb:2') <> 30
     OR public.fn_ca_diamond_economic('cash_rake_cap_heads_up','bb:2') <> 15 THEN
    RAISE EXCEPTION 'the 1/2 caps are not 30 and 15 Diamonds';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_cap_heads_up','bb:5') <> 37 THEN
    RAISE EXCEPTION 'the 2/5 heads-up cap is not the floored 37 Diamonds';
  END IF;
  IF public.fn_ca_diamond_economic_on('cash_rake_no_flop_no_drop','all') IS NOT TRUE THEN
    RAISE EXCEPTION 'B8 is not yes';
  END IF;
  IF public.fn_ca_diamond_economic('cash_rake_min_pot','all') <> 0 THEN
    RAISE EXCEPTION 'B9 is not zero';
  END IF;
  IF public.fn_ca_diamond_economic_text('cash_rake_rounding','all') <> 'down' THEN
    RAISE EXCEPTION 'B10 is not down';
  END IF;
  IF public.fn_ca_diamond_economic_text('cash_rake_destination','all') <> 'ca_diamond_house' THEN
    RAISE EXCEPTION 'B11 is not the house';
  END IF;
  IF public.fn_ca_diamond_economic('rakeback_percent','all') <> 0
     OR public.fn_ca_diamond_economic_on('rake_earns_vip_points','all') IS NOT FALSE THEN
    RAISE EXCEPTION 'B12 or B13 is not none';
  END IF;
  RAISE NOTICE 'PASS: B4 to B13 all read back by name, including the one floored heads-up cap (bb:5 -> 37)';

  -- THE READER NEVER FALLS BACK FROM A STAKE TO all (the A-lane's words).
  BEGIN
    PERFORM public.fn_ca_diamond_economic('cash_rake_cap','bb:7');
    RAISE EXCEPTION 'an unpriced stake returned a cap';
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN
    RAISE NOTICE 'PASS: an unpriced stake refuses by name, and never falls back to all or to another stake';
  END;

  -- THE ROWS WENT INTO THE SHARED TABLE, beside the A-lane's line (a) answers,
  -- and did not replace them.
  IF (SELECT count(*) FROM public.ca_diamond_economics WHERE name LIKE 'guarantee%') < 9 THEN
    RAISE EXCEPTION 'the cash rake rows displaced the A-lane''s guarantee answers';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_economics
              WHERE btrim(approved_quote)='' OR btrim(basis)='') THEN
    RAISE EXCEPTION 'a recorded answer has no quote or no basis';
  END IF;
  RAISE NOTICE 'PASS: the fourteen cash rake answers sit beside line (a) in ONE table, each with its quote and derivation';
END $$;
"""

RAKED_HAND = f"""
-- FOUR DEALT IN at 10/20. A pot of 400 is raked 10 percent, which is 40
-- Diamonds, well under the 300 cap. Every contributor put in a quarter of the
-- pot, so each is attributed 10. One of them is a horse.
DO $$
DECLARE v jsonb; v_float numeric; v_diff numeric;
BEGIN
  v := public.fx_cash_hand('{T_20}',1000001,
    jsonb_build_object('{P_A}',jsonb_build_object('delta',260,'contributed',100,'dealt_in',true),
                       '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                       '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                       '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
    true, 40);
  IF (v->>'rake')::numeric <> 40 OR (v->>'rake_accrued')::bigint <> 40 THEN
    RAISE EXCEPTION 'the settler banked % rake, not 40', v->>'rake_accrued';
  END IF;
  IF (v->>'net_deltas')::numeric <> -40 THEN
    RAISE EXCEPTION 'the receipt does not say the stacks are short by the rake';
  END IF;
  IF (SELECT count(*) FROM public.ca_diamond_rake_accrual
       WHERE table_id='{T_20}' AND hand_number=1000001) <> 4 THEN
    RAISE EXCEPTION 'the rake was not attributed to all four contributors';
  END IF;
  IF (SELECT count(DISTINCT amount) FROM public.ca_diamond_rake_accrual
       WHERE hand_number=1000001) <> 1
     OR (SELECT min(amount) FROM public.ca_diamond_rake_accrual WHERE hand_number=1000001) <> 10 THEN
    RAISE EXCEPTION 'an equal quarter of the pot was not attributed an equal quarter of the rake';
  END IF;
  RAISE NOTICE 'PASS: a 400 pot at 10/20 is raked 40, attributed 10 to each of its four contributors';

  -- CLAUDE.md 10.5. The horse paid and is on the ledger like anyone.
  IF NOT EXISTS (SELECT 1 FROM public.ca_diamond_rake_accrual a JOIN public.profiles p ON p.id=a.user_id
                  WHERE a.hand_number=1000001 AND p.is_horse AND a.amount=10) THEN
    RAISE EXCEPTION 'the horse was left out of the rake attribution (CLAUDE.md 10.5)';
  END IF;
  RAISE NOTICE 'PASS: the horse is attributed its 10 Diamonds of rake exactly as the three humans are';

  -- THE DIAMONDS ARE STILL ALL THERE. Custody is down 40, the accrual holds 40,
  -- the float is unchanged and the identity closes.
  IF (SELECT sum(balance) FROM public.poker_diamond_custody) <> 5960 THEN
    RAISE EXCEPTION 'custody holds %, not the 5960 that is 6000 less the rake',
      (SELECT sum(balance) FROM public.poker_diamond_custody);
  END IF;
  v_float := public.fn_ca_arena_diamonds();
  IF v_float <> 6000 THEN
    RAISE EXCEPTION 'the arena float reads % after the rake, not 6000', v_float;
  END IF;
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff <> 0 THEN RAISE EXCEPTION 'the identity broke on the first raked hand (%)', v_diff; END IF;
  RAISE NOTICE 'PASS: custody 5960 plus accrual 40 is the same 6000 float, and the identity closes';

  -- The house has not been touched: that is R4, one write per sweep.
  IF (SELECT balance FROM public.ca_diamond_house WHERE id=1) <> 0 THEN
    RAISE EXCEPTION 'the raked hand wrote the house row, which R4 forbids';
  END IF;
  RAISE NOTICE 'PASS: the raked hand never locked or wrote ca_diamond_house row 1 (design R4)';
END $$;
"""

REPLAY = f"""
-- A REPLAY MOVES NOTHING TWICE. The redelivery presents the payload the engine
-- sent, reconstructed from the receipt, because the seats have moved since.
DO $$
DECLARE v jsonb; v_custody numeric; v_accrual numeric; v_lots numeric;
BEGIN
  SELECT sum(balance) INTO v_custody FROM public.poker_diamond_custody;
  SELECT sum(amount) INTO v_accrual FROM public.ca_diamond_rake_accrual;
  SELECT sum(consumed) INTO v_lots FROM public.diamond_purchase_lots;
  v := public.fx_replay('{T_20}',1000001,40);
  IF COALESCE((v->>'replay')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the redelivered hand was not recognised as a replay';
  END IF;
  IF (SELECT sum(balance) FROM public.poker_diamond_custody) <> v_custody THEN
    RAISE EXCEPTION 'the replay moved custody';
  END IF;
  IF (SELECT sum(amount) FROM public.ca_diamond_rake_accrual) <> v_accrual THEN
    RAISE EXCEPTION 'the replay accrued the rake a second time';
  END IF;
  IF (SELECT sum(consumed) FROM public.diamond_purchase_lots) <> v_lots THEN
    RAISE EXCEPTION 'the replay consumed a purchase lot a second time';
  END IF;
  IF (SELECT count(*) FROM public.ca_diamond_rake_accrual WHERE hand_number=1000001) <> 4 THEN
    RAISE EXCEPTION 'the replay wrote more accrual rows';
  END IF;
  RAISE NOTICE 'PASS: the replay returns the first receipt and moves no Diamond, no lot and no accrual row';

  -- A REPLAY CANNOT QUIETLY RESTATE THE HAND. Two ways, and each is caught by a
  -- different rule, which is why both are here.
  --
  --   (1) A restatement that changes the POT is caught by the recompute before
  --       the receipt is even read: the rake no longer matches the settings.
  BEGIN
    PERFORM public.fx_replay('{T_20}',1000001,40, jsonb_build_object('{P_A}',200));
    RAISE EXCEPTION 'a replay that doubled a contribution settled';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: a replay that restates the pot is caught by the recompute, before the receipt';
  END;
  --   (2) A restatement that keeps the pot, the rake and the dealt count exactly
  --       right, and only moves one Diamond of contribution from the winner to a
  --       loser, passes every arithmetic check and is still refused - because the
  --       facts are part of the request the receipt stored.
  BEGIN
    PERFORM public.fx_replay('{T_20}',1000001,40,
      jsonb_build_object('{P_A}',99,'{P_B}',101));
    RAISE EXCEPTION 'a replay that moved one Diamond of attribution settled';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: a replay that only moves who paid the rake is refused as a payload mismatch';
  END;
END $$;
"""


SHORT_HANDED_AND_CAP = f"""
-- HEADS UP. Two dealt in out of four seated: the bracket is dealt:2, so the
-- percentage is 5 and the cap is 150. A pot of 200 is raked 10.
DO $$
DECLARE v jsonb;
BEGIN
  v := public.fx_cash_hand('{T_20}',1000002,
    jsonb_build_object('{P_A}',jsonb_build_object('delta',90,'contributed',100,'dealt_in',true),
                       '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
    true, 10);
  IF (v->>'rake_accrued')::bigint <> 10 THEN
    RAISE EXCEPTION 'heads up raked %, not the 5 percent of 200 that is 10', v->>'rake_accrued';
  END IF;
  IF (SELECT count(*) FROM public.ca_diamond_rake_accrual WHERE hand_number=1000002) <> 2 THEN
    RAISE EXCEPTION 'the heads-up rake was attributed to more than its two contributors';
  END IF;
  RAISE NOTICE 'PASS: two dealt in is priced at 5 percent from the dealt:2 scope, not 10, with four seated';

  -- Ten percent of the same pot would have been 20. The sat-out players were
  -- not counted as dealt in, which is the whole point of the bracket.
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900002,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',80,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 20);
    RAISE EXCEPTION 'a heads-up pot was raked at the full percentage';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: the full 10 percent on a heads-up pot is refused (diamond_cash_rake_disagrees)';
  END;
END $$;

-- THE CAP BINDS, AND IT IS THIS STAKE'S CAP AT THIS BRACKET. Two players are
-- dealt in at 1/2, so the cap is the heads-up 15 and the percentage is 5. Five
-- percent of a 2000 pot is 100, and the cap holds it to 15. Both halves of the
-- answer are proved by one hand: the cap binds, and it is read from
-- bb:2/dealt:2 rather than from bb:2 or from the 10/20 table next door.
DO $$
DECLARE v jsonb;
BEGIN
  -- First, the 10/20 table's heads-up cap of 150. It must not reach this table.
  -- This is tried BEFORE the real hand, while both stacks are still whole, so a
  -- refusal leaves the fixture exactly where it was.
  BEGIN
    PERFORM public.fx_cash_hand('{T_2}',1900003,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',850,'contributed',1000,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-1000,'contributed',1000,'dealt_in',true)),
      true, 150);
    RAISE EXCEPTION 'the 1/2 table was raked at the 10/20 cap';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: another stake''s cap cannot reach this stake - each stake is its own scope';
  END;
  v := public.fx_cash_hand('{T_2}',1000003,
    jsonb_build_object('{P_A}',jsonb_build_object('delta',985,'contributed',1000,'dealt_in',true),
                       '{P_B}',jsonb_build_object('delta',-1000,'contributed',1000,'dealt_in',true)),
    true, 15);
  IF (v->>'rake_accrued')::bigint <> 15 THEN
    RAISE EXCEPTION 'the 1/2 heads-up cap did not bind: raked %', v->>'rake_accrued';
  END IF;
  RAISE NOTICE 'PASS: at 1/2 heads up, a 2000 pot is capped at 15 Diamonds, not raked 100';
END $$;

-- NO FLOP, NO DROP. The pot is large enough to rake and is not raked.
DO $$
DECLARE v jsonb;
BEGIN
  v := public.fx_cash_hand('{T_20}',1000004,
    jsonb_build_object('{P_A}',jsonb_build_object('delta',30,'contributed',30,'dealt_in',true),
                       '{P_B}',jsonb_build_object('delta',-20,'contributed',20,'dealt_in',true),
                       '{P_C}',jsonb_build_object('delta',-10,'contributed',10,'dealt_in',true)),
    false, 0);
  IF (v->>'rake_accrued')::bigint <> 0 THEN
    RAISE EXCEPTION 'a hand that never saw a flop was raked';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rake_accrual WHERE hand_number=1000004) THEN
    RAISE EXCEPTION 'a pre-flop hand wrote an accrual row';
  END IF;
  RAISE NOTICE 'PASS: a hand that ends before the flop is raked nothing (B8)';
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900004,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',24,'contributed',30,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-20,'contributed',20,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-10,'contributed',10,'dealt_in',true)),
      false, 6);
    RAISE EXCEPTION 'a pre-flop hand was raked';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: raking a pre-flop hand is refused, so B8 is a rule and not a comment';
  END;
END $$;
"""

REMAINDER = f"""
-- THE REMAINDER RULE, ON A POT THAT DOES NOT DIVIDE. Three dealt in at 10/20
-- contribute 34, 33 and 34 for a pot of 101, raked 10 percent floored, so 10
-- Diamonds. The proportional shares are 3.366, 3.267 and 3.366: each takes 3,
-- which is 9, and the one Diamond left over goes to the largest remainder. Two
-- of the three tie on it (34 and 34), and the tie is broken by user_id
-- ascending, so player A takes it and the horse C does not.
--
--   A  contributed 34  base floor(10*34/101)=3  remainder (340 mod 101)=37  -> 4
--   B  contributed 33  base floor(10*33/101)=3  remainder (330 mod 101)=27  -> 3
--   C  contributed 34  base floor(10*34/101)=3  remainder (340 mod 101)=37  -> 3
DO $$
DECLARE v jsonb;
BEGIN
  v := public.fx_cash_hand('{T_20}',1000005,
    jsonb_build_object('{P_A}',jsonb_build_object('delta',57,'contributed',34,'dealt_in',true),
                       '{P_B}',jsonb_build_object('delta',-33,'contributed',33,'dealt_in',true),
                       '{P_C}',jsonb_build_object('delta',-34,'contributed',34,'dealt_in',true)),
    true, 10);
  IF (v->>'rake_accrued')::bigint <> 10 THEN
    RAISE EXCEPTION 'a 101 pot raked %, not 10', v->>'rake_accrued';
  END IF;
  IF (SELECT amount FROM public.ca_diamond_rake_accrual
       WHERE hand_number=1000005 AND user_id='{P_A}') <> 4 THEN
    RAISE EXCEPTION 'the leftover Diamond did not go to the largest remainder with the lowest user_id';
  END IF;
  IF (SELECT amount FROM public.ca_diamond_rake_accrual
       WHERE hand_number=1000005 AND user_id='{P_B}') <> 3
     OR (SELECT amount FROM public.ca_diamond_rake_accrual
       WHERE hand_number=1000005 AND user_id='{P_C}') <> 3 THEN
    RAISE EXCEPTION 'the proportional shares are not 4, 3 and 3';
  END IF;
  IF (SELECT sum(amount) FROM public.ca_diamond_rake_accrual WHERE hand_number=1000005) <> 10 THEN
    RAISE EXCEPTION 'the shares do not sum to the rake';
  END IF;
  RAISE NOTICE 'PASS: 34/33/34 of a 101 pot splits 10 Diamonds of rake as 4, 3 and 3, and sums exactly';
  -- The player who sat the hand out is attributed nothing.
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rake_accrual
              WHERE hand_number=1000005 AND user_id='{P_D}') THEN
    RAISE EXCEPTION 'a player who contributed nothing was attributed rake';
  END IF;
  RAISE NOTICE 'PASS: a player who contributed nothing is attributed nothing';
END $$;
"""

MUTATIONS = f"""
-- THE CASES THAT EXIST ONLY TO PROVE AN ASSERTION ASSERTS. An error is the
-- success case in every one of them.
DO $$
BEGIN
  -- One Diamond more than the settings produce.
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900011,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',259,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 41);
    RAISE EXCEPTION 'the settler took the engine''s number on trust';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: 41 where the settings say 40 is refused - the settler really does recompute';
  END;

  -- One Diamond less.
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900012,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',261,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 39);
    RAISE EXCEPTION 'the settler admitted an under-rake';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: 39 where the settings say 40 is refused too - the rule is equality, not a ceiling';
  END;

  -- No facts at all, with the switch on.
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900013,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',260,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 40, false);
    RAISE EXCEPTION 'a hand with no rake facts settled';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: with the switch on, a hand that carries no rake facts is refused by name';
  END;

  -- An unraked hand with no facts is refused too: a zero nobody can verify is
  -- not a verified zero.
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900014,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',0,'contributed',0,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',0,'contributed',0,'dealt_in',true)),
      true, 0, false);
    RAISE EXCEPTION 'an unverifiable zero rake settled';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: an unverifiable zero is refused as well, so the engine cannot silently stop raking';
  END;

  -- The elements disagree about whether one hand saw a flop.
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900015,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',260,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 40, true, jsonb_build_object('{P_D}', false));
    RAISE EXCEPTION 'a payload whose elements disagree about the flop settled';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: one hand cannot both have seen a flop and not seen one';
  END;

  -- A player loses more than the contribution that is supposed to explain it.
  BEGIN
    -- The deltas conserve to minus 30 and 10 percent of the claimed 301 pot IS
    -- 30, so this hand passes conservation and the recompute. It is refused on
    -- the one thing left: B lost 100 while the facts claim B put in 1.
    PERFORM public.fx_cash_hand('{T_20}',1900016,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',270,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',1,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 30);
    RAISE EXCEPTION 'a loss larger than its contribution settled';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: a player cannot lose more than the contribution the facts claim for them';
  END;

  -- The stacks conserve to zero while a rake is claimed.
  BEGIN
    PERFORM public.fx_cash_hand('{T_20}',1900017,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',300,'contributed',100,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                         '{P_D}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
      true, 40);
    RAISE EXCEPTION 'a hand whose stacks conserve to zero took a rake';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: the conservation rule is minus the rake, not zero, and it refuses the old shape';
  END;

  -- The jackpot and insurance amounts are still held at zero.
  BEGIN
    PERFORM public.fn_poker_diamond_settle_cash_hand('{T_20}',1900018,'[]'::jsonb,0,1,NULL,0);
    RAISE EXCEPTION 'a jackpot drop was admitted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: a Diamond jackpot drop is still refused - B14 to B22 are not answered';
  END;
  BEGIN
    PERFORM public.fn_poker_diamond_settle_cash_hand('{T_20}',1900019,'[]'::jsonb,0,0,NULL,1);
    RAISE EXCEPTION 'insurance was admitted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS: Diamond insurance is still refused, for ever';
  END;
END $$;

-- AN UNPRICED STAKE REFUSES BY NAME RATHER THAN BEING RAKED AT SOME OTHER CAP.
-- This table is created AFTER the migration on purpose: the migration's own
-- closing block refuses to commit while any live Diamond stake has no cap.
INSERT INTO public.tables (id,club_id,game_variant,status,small_blind,big_blind,max_players)
VALUES ('{T_300}','{ARENA}','nlh','running',150,300,6);
DO $$
DECLARE v_seat uuid; v_occ uuid;
BEGIN
  v_seat := gen_random_uuid(); v_occ := gen_random_uuid();
  INSERT INTO public.table_seats (id,table_id,user_id,occupancy_id,joined_at,stack)
    VALUES (v_seat,'{T_300}','{P_A}',v_occ,'2026-10-05 11:00:00+00',0);
  v_seat := gen_random_uuid(); v_occ := gen_random_uuid();
  INSERT INTO public.table_seats (id,table_id,user_id,occupancy_id,joined_at,stack)
    VALUES (v_seat,'{T_300}','{P_B}',v_occ,'2026-10-05 11:00:00+00',0);
  BEGIN
    PERFORM public.fx_cash_hand('{T_300}',1900020,
      jsonb_build_object('{P_A}',jsonb_build_object('delta',0,'contributed',0,'dealt_in',true),
                         '{P_B}',jsonb_build_object('delta',0,'contributed',0,'dealt_in',true)),
      true, 0);
    RAISE EXCEPTION 'a stake with no published cap was settled';
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN
    RAISE NOTICE 'PASS: a Diamond stake nobody priced refuses with diamond_economics_unset, by name';
  END;
END $$;
"""


SWEEP = f"""
-- THE SWEEP. One spend row per payer, one house mint for the whole sweep, and
-- the identity closing afterwards. 40 + 10 + 15 + 0 + 10 = 75 Diamonds of rake have
-- accrued over four raked hands.
DO $$
DECLARE v jsonb; v_accrued bigint; v_diff numeric; v_houses bigint;
BEGIN
  SELECT sum(amount) INTO v_accrued FROM public.ca_diamond_rake_accrual WHERE swept_at IS NULL;
  IF v_accrued <> 75 THEN
    RAISE EXCEPTION '% Diamonds accrued, not the 75 the raked hands took', v_accrued;
  END IF;
  IF public.fn_ca_arena_diamonds() <> 6000 THEN
    RAISE EXCEPTION 'the float moved before the sweep';
  END IF;

  v := public.fn_ca_diamond_sweep_cash_rake('the fixture sweep');
  IF (v->>'amount')::bigint <> 75 OR (v->>'destination') <> 'ca_diamond_house' THEN
    RAISE EXCEPTION 'the sweep moved % to %', v->>'amount', v->>'destination';
  END IF;
  IF (SELECT balance FROM public.ca_diamond_house WHERE id=1) <> 75 THEN
    RAISE EXCEPTION 'the house holds %, not 75', (SELECT balance FROM public.ca_diamond_house WHERE id=1);
  END IF;

  -- ONE house write for the whole sweep (R4), not one per hand or per payer.
  SELECT count(*) INTO v_houses FROM public.ca_mint_ledger
   WHERE asset='diamonds' AND holder_type='house' AND op_id LIKE 'poker-cash-rake-sweep:%';
  IF v_houses <> 1 THEN
    RAISE EXCEPTION 'the sweep wrote % house register rows, not 1', v_houses;
  END IF;
  RAISE NOTICE 'PASS: 75 Diamonds of rake crossed to the house in ONE house write, over four raked hands';

  -- One spend row per payer, and the register retired each one from that player.
  IF (SELECT count(*) FROM public.diamond_transactions WHERE type='cash_rake') <> 4 THEN
    RAISE EXCEPTION 'the sweep wrote % payer spend rows, not one per payer',
      (SELECT count(*) FROM public.diamond_transactions WHERE type='cash_rake');
  END IF;
  IF (SELECT COALESCE(sum(m.amount),0) FROM public.ca_mint_ledger m
       JOIN public.diamond_transactions t ON t.id=m.diamond_tx_id
      WHERE m.action='burn' AND m.holder_type='player' AND t.type='cash_rake') <> 75 THEN
    RAISE EXCEPTION 'the register did not retire 75 Diamonds from the players';
  END IF;
  RAISE NOTICE 'PASS: one spend row per payer, and the register retired all 75 from the payers themselves';

  -- CLAUDE.md 10.5 again, on the way out.
  IF NOT EXISTS (SELECT 1 FROM public.diamond_transactions t JOIN public.profiles p ON p.id=t.user_id
                  WHERE t.type='cash_rake' AND p.is_horse) THEN
    RAISE EXCEPTION 'the horse was left out of the sweep (CLAUDE.md 10.5)';
  END IF;
  RAISE NOTICE 'PASS: the horse has its own spend row in the sweep, like every other payer';

  -- Wallets never moved: these Diamonds were never in profiles.diamonds.
  IF (SELECT sum(diamonds) FROM public.profiles) <> 0 THEN
    RAISE EXCEPTION 'the sweep touched a player wallet';
  END IF;
  IF public.fn_ca_arena_diamonds() <> 5925 THEN
    RAISE EXCEPTION 'the float reads % after the sweep, not 5925', public.fn_ca_arena_diamonds();
  END IF;
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff <> 0 THEN RAISE EXCEPTION 'the identity broke on the sweep (%)', v_diff; END IF;
  RAISE NOTICE 'PASS: float 5925 plus house 75 is the same 6000, and the identity closes to zero';

  -- The rows are stamped, and a second sweep moves nothing.
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rake_accrual WHERE swept_at IS NULL) THEN
    RAISE EXCEPTION 'the sweep left a row unstamped';
  END IF;
  v := public.fn_ca_diamond_sweep_cash_rake('the second fixture sweep');
  IF (v->>'amount')::bigint <> 0 OR COALESCE((v->>'nothing_to_sweep')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the second sweep moved %', v->>'amount';
  END IF;
  IF (SELECT balance FROM public.ca_diamond_house WHERE id=1) <> 75 THEN
    RAISE EXCEPTION 'the second sweep credited the house again';
  END IF;
  SELECT count(*) INTO v_houses FROM public.ca_mint_ledger
   WHERE asset='diamonds' AND holder_type='house' AND op_id LIKE 'poker-cash-rake-sweep:%';
  IF v_houses <> 1 THEN
    RAISE EXCEPTION 'the second sweep wrote a second house register row';
  END IF;
  RAISE NOTICE 'PASS: a second sweep moves nothing twice - no spend row, no house row, no balance';
END $$;

-- A HAND RAKED AFTER A SWEEP ACCRUES AGAIN AND SWEEPS AGAIN.
DO $$
DECLARE v jsonb; v_diff numeric;
BEGIN
  v := public.fx_cash_hand('{T_20}',1000006,
    jsonb_build_object('{P_A}',jsonb_build_object('delta',170,'contributed',100,'dealt_in',true),
                       '{P_B}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true),
                       '{P_C}',jsonb_build_object('delta',-100,'contributed',100,'dealt_in',true)),
    true, 30);
  IF (v->>'rake_accrued')::bigint <> 30 THEN
    RAISE EXCEPTION 'the hand after the sweep raked %', v->>'rake_accrued';
  END IF;
  v := public.fn_ca_diamond_sweep_cash_rake('the third fixture sweep');
  IF (v->>'amount')::bigint <> 30 THEN
    RAISE EXCEPTION 'the second real sweep moved %, not 30', v->>'amount';
  END IF;
  IF (SELECT balance FROM public.ca_diamond_house WHERE id=1) <> 105 THEN
    RAISE EXCEPTION 'the house holds %, not 105', (SELECT balance FROM public.ca_diamond_house WHERE id=1);
  END IF;
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff <> 0 THEN RAISE EXCEPTION 'the identity broke on the second sweep (%)', v_diff; END IF;
  RAISE NOTICE 'PASS: rake taken after a sweep accrues again and sweeps again; the house holds 105';
END $$;
"""

APPEND_ONLY_AND_FENCES = f"""
-- THE ACCRUAL IS APPEND ONLY, AND SWEPT ONCE.
DO $$
BEGIN
  BEGIN
    UPDATE public.ca_diamond_rake_accrual SET amount=amount+1 WHERE id=(SELECT min(id) FROM public.ca_diamond_rake_accrual);
    RAISE EXCEPTION 'an accrual amount was edited';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: an accrued amount cannot be edited';
  END;
  BEGIN
    DELETE FROM public.ca_diamond_rake_accrual WHERE id=(SELECT min(id) FROM public.ca_diamond_rake_accrual);
    RAISE EXCEPTION 'an accrual row was deleted';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: an accrual row cannot be deleted';
  END;
  BEGIN
    UPDATE public.ca_diamond_rake_accrual SET swept_at=NULL, sweep_id=NULL
     WHERE id=(SELECT min(id) FROM public.ca_diamond_rake_accrual);
    RAISE EXCEPTION 'a swept row was un-swept, which would sweep it twice';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RAISE NOTICE 'PASS: a swept row cannot be un-swept, so the same Diamond cannot be swept twice';
  END;
END $$;

-- NEVER A CHIP TABLE. The four chip rake tables refuse a Diamond Arena row by
-- name, and still take a member club's rows.
DO $$
DECLARE t text; v_n integer := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY['rake_records','rake_attributions','rake_distribution_legs','club_wallets']
  LOOP
    BEGIN
      EXECUTE format('INSERT INTO public.%I (club_id) VALUES (%L)', t, '{ARENA}');
      RAISE EXCEPTION '% took a Diamond Arena row', t;
    EXCEPTION WHEN SQLSTATE '23514' THEN
      v_n := v_n + 1;
    END;
    EXECUTE format('INSERT INTO public.%I (club_id) VALUES (%L)', t, '{CHIP_CLUB}');
  END LOOP;
  IF v_n <> 4 THEN RAISE EXCEPTION 'only % of the 4 chip rake tables refused', v_n; END IF;
  RAISE NOTICE 'PASS: all four chip rake tables refuse a Diamond Arena row and still take a member club''s';
  IF (SELECT count(*) FROM public.rake_records) <> 1 THEN
    RAISE EXCEPTION 'the fence broke the chip path';
  END IF;
  RAISE NOTICE 'PASS: so B13 is no by construction - Diamond rake can never reach the VIP points trigger';
END $$;

-- THE DECLARATION, AND THE SWITCHES.
DO $$
DECLARE v_cash boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ca_guard_defs
                  WHERE proname='fn_poker_diamond_settle_cash_hand'
                    AND declared_ref='20261005183028_diamond_cash_rake_reads_the_owner_settings') THEN
    RAISE EXCEPTION 'the watched settler was redefined without declaring it';
  END IF;
  RAISE NOTICE 'PASS: the watched settler''s redefinition is declared against its migration';
  SELECT cash_games_enabled INTO v_cash FROM public.ca_arena_settings WHERE id=1;
  IF v_cash IS NOT FALSE THEN
    RAISE EXCEPTION 'cash_games_enabled is not false and this lane must never open it';
  END IF;
  RAISE NOTICE 'PASS: cash_games_enabled is still closed, exactly as the fixture found it';
END $$;
"""


def main() -> int:
    tmp = tempfile.mkdtemp(prefix='ca-diamond-cash-rake-pg17-')
    data = pathlib.Path(tmp) / 'data'
    sock = pathlib.Path(tmp) / 'sock'
    sock.mkdir(parents=True, exist_ok=True)
    passes = 0

    # The live kind map, sliced out of the migration that last redefined it, so
    # the fixture starts from the map production runs and the migration's own
    # restatement is what changes it.
    km = KIND_MAP.read_text()
    kind_map = km[km.index('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket'):]
    kind_map = kind_map[:kind_map.index('COMMENT ON FUNCTION public.fn_diamond_kind_bucket')]
    if len(kind_map) < 500:
        raise SystemExit('the live kind map could not be sliced out of 20260920141807')

    # The version that merged and then refused itself on apply must still say
    # so, and this runner must never be the thing that runs it. A marker that
    # names no successor is the easiest lie to tell about a migration that
    # simply never applied, so it is read rather than assumed.
    head = SUPERSEDED.read_text()[:400]
    if '-- SUPERSEDED BY 20261005183028' not in head:
        raise SystemExit(
            f'{SUPERSEDED.name} does not carry "-- SUPERSEDED BY 20261005183028" in its head')
    if 'THIS FILE MUST NEVER RUN' not in head:
        raise SystemExit(f'{SUPERSEDED.name} does not say it must never run')
    print('  PASS: the superseded 20261005151712 is marked, names its successor, and never runs here')
    passes += 1

    # THE SHARED SETTINGS MIGRATION, NARROWED TO ITS OWN SECTIONS 1 TO 6.
    # Its section 7 pins the md5 of fn_poker_diamond_create_tournament and the
    # other tournament doors, which belong to the A-lane's own fixtures and are
    # not in this one; section 7 proves nothing about a cash rake. Sections 1 to
    # 6 - the table, the units rule, the append-only guard, the two readers, the
    # choice lists and the twenty line (a) answers - are loaded verbatim, which
    # is everything the migration under test extends.
    #
    # The cut is asserted, not assumed: a narrowing that silently stops matching
    # would quietly load the whole file again (and fail) or nothing at all.
    _econ = ECONOMICS.read_text()
    _cut = _econ.index("-- 7. EVERY EDIT LANDED")
    _rule = _econ.rindex("-- " + "-" * 73, 0, _cut)
    economics = _econ[:_rule] + "\nCOMMIT;\n"
    # The pins live in md5(pg_get_functiondef(...)) comparisons. The door NAMES
    # also appear in the A-lane's own basis prose, which is why the check is on
    # the pin expression and not on the names.
    if "md5(pg_get_functiondef(" in economics:
        raise SystemExit("the economics narrowing no longer removes section 7's md5 pins")
    if "md5(pg_get_functiondef(" not in _econ[_rule:]:
        raise SystemExit("the economics migration no longer pins any door in its section 7; the cut is in the wrong place")
    for _needed in ("CREATE TABLE public.ca_diamond_economics",
                    "fn_ca_diamond_economics_units_of",
                    "fn_ca_diamond_economic_text",
                    "fn_ca_diamond_economic_on",
                    "guarantee_overlay_account"):
        if _needed not in economics:
            raise SystemExit(f"the economics narrowing dropped {_needed}, which is load-bearing")

    try:
        subprocess.run([bin_path('initdb'), '-D', str(data), '-U', 'postgres',
                        '-A', 'trust', '--no-sync', '--locale=C', '--encoding=UTF8'],
                       check=True, capture_output=True, text=True, env=ENV)
        started = subprocess.run(
            [bin_path('pg_ctl'), '-D', str(data), '-w', '-l', str(pathlib.Path(tmp) / 'pg.log'),
             '-o', f'-k {sock} -c listen_addresses= -c fsync=off', 'start'],
            capture_output=True, text=True, env=ENV)
        if started.returncode:
            print(started.stdout)
            print(started.stderr, file=sys.stderr)
            log = pathlib.Path(tmp) / 'pg.log'
            if log.exists():
                print(log.read_text(), file=sys.stderr)
            raise SystemExit('could not start the isolated PostgreSQL 17 cluster')
        try:
            version = subprocess.run(
                [bin_path('psql'), '-X', '-At', '-h', str(sock), '-U', 'postgres',
                 '-d', 'postgres', '-c', 'SHOW server_version'],
                check=True, capture_output=True, text=True, env=ENV).stdout.strip()
            print(f'Isolated cluster: PostgreSQL {version}')
            if not version.startswith('17'):
                print(f'WARNING: expected PostgreSQL 17, got {version}', file=sys.stderr)

            def psql(sql: str, label: str) -> int:
                nonlocal passes
                r = subprocess.run(
                    [bin_path('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                     '-h', str(sock), '-U', 'postgres', '-d', 'postgres', '-f', '-'],
                    input=sql, text=True, capture_output=True, timeout=300, env=ENV)
                if r.returncode:
                    print(r.stdout)
                    print(r.stderr, file=sys.stderr)
                    raise SystemExit(f'{label} failed')
                n = 0
                for line in r.stderr.splitlines():
                    if 'PASS:' in line:
                        print('  ' + line.split('PASS:', 1)[1].strip())
                        n += 1
                passes += n
                return n

            print('\nThe fixture world and the installed doors, in production\'s own text:')
            psql(SCHEMA.read_text(), 'fixture schema')
            psql(DOORS.read_text(), 'installed doors')
            psql(kind_map + ';', 'the live kind map')
            psql(SEED, 'fixture seed')
            psql(HELPER, 'the fixture payload helper')

            print('\nTHE SHARED SETTINGS TABLE, as the A-lane applied it (20261005151918):')
            psql(economics, 'the shared Diamond economics table')

            print('\nBEFORE - the six layers as production has them:')
            psql(BEFORE, 'the installed settler refuses any rake')

            print(f'\nAPPLYING {MIGRATION.name} verbatim, with its own closing blocks:')
            psql(MIGRATION.read_text(), 'the migration')
            print('  the migration committed, including its own assertion blocks')
            passes += 1

            print('\nTHE ANSWERS - B4 to B13, read back by name and scope:')
            psql(SETTINGS, 'the recorded answers')

            print('\nA RAKED HAND, THROUGH THE REAL SETTLER:')
            psql(RAKED_HAND, 'a raked hand')
            psql(REPLAY, 'a replay')
            psql(SHORT_HANDED_AND_CAP, 'short-handed, the cap, and no flop no drop')
            psql(REMAINDER, 'the remainder rule')

            print('\nMUTATIONS - an error is the success case:')
            psql(MUTATIONS, 'the mutation cases')

            print('\nTHE SWEEP - one house write, and a second sweep that moves nothing:')
            psql(SWEEP, 'the sweep')

            print('\nAPPEND ONLY, THE FENCE, AND THE SWITCHES:')
            psql(APPEND_ONLY_AND_FENCES, 'append-only, the fence and the switches')

            # One contiguous literal: the wrapper's proof line has to be findable
            # in this source, and tests/unit/diamondAcceptanceCi.test.ts is what
            # fails if it is split across two string pieces.
            print(f'\n{passes} Diamond cash rake checks passed on isolated PostgreSQL 17; this is a fixture proof, not a production certification.')
            return 0
        finally:
            subprocess.run([bin_path('pg_ctl'), '-D', str(data), '-w', '-m', 'immediate', 'stop'],
                           capture_output=True, text=True, env=ENV)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
