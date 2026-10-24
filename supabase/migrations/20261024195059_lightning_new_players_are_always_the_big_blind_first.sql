-- @live-proof: (SELECT position('NEW PLAYERS ARE ALWAYS THE BIG BLIND FIRST' IN pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure))>0 AND position('''newcomer'',sl.last_bb_at IS NULL' IN pg_get_functiondef('public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)'::regprocedure))>0 AND position('first_entry_is_always_big_blind' IN pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure))>0)
-- 20261024195059_lightning_new_players_are_always_the_big_blind_first.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-24, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST." In
-- Lightning, a player's first hand after entering the pool is dealt with them
-- in the big blind.
--
-- Read from production (the three hours before 19:00 UTC): of 359 new pool
-- slots, 337 were the big blind in their first hand, 18 the small blind and 4
-- held no blind. Every exception was a hand where two or more never-dealt
-- players were formed together. Three causes, all in fn_lightning_match_plan:
--
--   1. The first-entry rule was OFF. fn_lightning_config defaulted
--      first_entry_rule to 'any_seat' and no live game names the key, so the
--      plan's FIRST-ENTRY block never ran. The 337 were the big blind only
--      because fn_lightning_blind_order ranks last_bb_at NULLS FIRST, so a
--      newcomer is usually first in line; when two arrived together, the
--      second was the next in P2 order and became the small blind.
--   2. "Newcomer" meant "no lightning_blind_ledger row in this Cluster, ever"
--      (bl.player_id IS NULL), which is not "new to this sitting": a player
--      who comes back to the pool keeps their old ledger row.
--   3. Even when on, the rule held a newcomer only while holding cost the pass
--      no hand (v_g2 = v_g), so a pass of twelve with four newcomers dealt two
--      of them outside the big blind.
--
-- THE FIX, at the line that decides it (CLAUDE.md 10.11/10.12):
--
--   - fn_lightning_config: first_entry_rule is 'big_blind' always. It is not a
--     tunable any more: a ruleset that names anything else, 'any_seat'
--     included, is listed under `invalid` with reason
--     'first_entry_is_always_big_blind' and big_blind is used, so the config
--     reports what the plan does.
--   - fn_lightning_match_plan: a newcomer is a pool slot that has never been
--     the big blind (lightning_pool_slot.last_bb_at IS NULL, the same key
--     fn_lightning_blind_order already ranks first). The plan no longer reads
--     the rule as a switch. A newcomer who is not one of the pass's big blinds
--     is held (WAITING_FOR_BB / FIRST_ENTRY_WAITS_FOR_BB) EVEN WHEN THAT COSTS
--     THE PASS A HAND. Holding shrinks the pass, so the big-blind set is taken
--     again and a newcomer pushed out of it is held too, until it settles. The
--     single exception: a hold that would leave the pass no hand at all is not
--     taken, so a pool of only newcomers still deals (one hand has one big
--     blind) and never deadlocks.
--   - fn_lightning_matcher_snapshot: the snapshot's `newcomer` is the same
--     last_bb_at IS NULL, so the engine's TypeScript port
--     (server/src/lightning/LightningMatcherModel.ts) reads the same key.
--
-- A held newcomer is first in P2 order (last_bb_at NULLS FIRST, then the
-- slot's age), so they are the next pass's big blind; nobody waits behind a
-- queue that does not move. Horses are players (CLAUDE.md 10.5): nothing here
-- reads a horse marker. No money, seat or ledger row is written; this is the plan.
--
-- Applied as md5-guarded text replacements of the live definitions (the house
-- pattern from 20261023230001 and 20261024073506), so a drifted source aborts
-- instead of overwriting someone else's change. No object is declared.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $source$
DECLARE r record; s text; n text; i integer; k integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_lightning_config(uuid)', '45820f318003a41165874c4d2200cfdf'),
    ('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)', '1e263d6ce31237c5cca0efafd9f9ffd3'),
    ('public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)', 'e7e8ec4a542f15bac6a207cd51a98051')
  ) x(sig, want) LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'Lightning source changed; requalify the first-entry big blind before installation: %', r.sig;
    END IF;
  END LOOP;

  -- fn_lightning_config: big_blind, always.
  s := pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure);
  i := position('  -- first_entry_rule: any_seat (the default)' IN s);
  k := position('  -- position_fairness: P3 on or off.' IN s);
  IF i = 0 OR k <= i OR position('''not_any_seat_or_big_blind''' IN substr(s, i, k - i)) = 0 THEN
    RAISE EXCEPTION 'Lightning config first-entry anchors changed';
  END IF;
  n := substr(s, 1, i - 1) || $cfg$  -- first_entry_rule: big_blind, ALWAYS (Dan 2026-10-24: "NEW PLAYERS SHOULD
  -- ALWAYS BE BB FIRST"; 20261024195059). A pool slot that has never been the
  -- big blind is dealt in only as a big blind. It is not a tunable: a ruleset
  -- that names anything else, any_seat included, is listed under invalid and
  -- big_blind is used.
  v_rule := 'big_blind';
  IF v_cfg ? 'first_entry_rule' AND jsonb_typeof(v_cfg -> 'first_entry_rule') <> 'null'
     AND (v_cfg -> 'first_entry_rule') IS DISTINCT FROM to_jsonb('big_blind'::text) THEN
    v_inv := v_inv || jsonb_build_object('key', 'first_entry_rule', 'given', v_cfg -> 'first_entry_rule',
                                         'reason', 'first_entry_is_always_big_blind', 'used', v_rule);
  END IF;

$cfg$ || substr(s, k);
  IF position('first_entry_is_always_big_blind' IN n) = 0 OR position('v_rule := ''any_seat''' IN n) > 0 THEN
    RAISE EXCEPTION 'Lightning config first-entry replacement did not take';
  END IF;
  EXECUTE n;

  -- fn_lightning_match_plan: the newcomer key, and the rule held always.
  s := pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure);
  n := replace(s, '  v_rule   := v_cfg ->> ''first_entry_rule'';',
                  '  v_rule   := ''big_blind'';  -- always (20261024195059); never read as a switch');
  n := replace(n, '           (bl.player_id IS NULL) AS newcomer,',
                  '           (bo.last_bb_at IS NULL) AS newcomer,');
  i := position('  -- THE FIRST-ENTRY RULE, when configured:' IN n);
  k := position('  v_bbs := CASE WHEN v_g > 0 THEN v_seatable[1:v_g] ELSE ARRAY[]::uuid[] END;' IN n);
  IF n = s OR position('(bl.player_id IS NULL) AS newcomer' IN n) > 0
     OR position('v_cfg ->> ''first_entry_rule''' IN n) > 0
     OR i = 0 OR k <= i OR position('IF v_g2 = v_g THEN' IN substr(n, i, k - i)) = 0 THEN
    RAISE EXCEPTION 'Lightning plan first-entry anchors changed';
  END IF;
  n := substr(n, 1, i - 1) || $plan$  -- NEW PLAYERS ARE ALWAYS THE BIG BLIND FIRST (Dan 2026-10-24: "NEW PLAYERS
  -- SHOULD ALWAYS BE BB FIRST"; 20261024195059). A newcomer - a pool slot that
  -- has never been the big blind - who is not one of this pass's big blinds is
  -- held, even when holding costs the pass a hand. Holding shrinks the pass,
  -- so its big blinds are taken again, and a newcomer pushed out of them is
  -- held too, until nothing changes. The one exception: a hold that would
  -- leave the pass no hand at all is not taken, so a pool of only newcomers
  -- still deals and never deadlocks. A held newcomer ranks first in P2
  -- (last_bb_at NULLS FIRST), so they are the next pass's big blind.
  LOOP
    EXIT WHEN v_g = 0;
    v_bbs := v_seatable[1:v_g];
    v_next := ARRAY(SELECT u.pid FROM unnest(v_seatable) WITH ORDINALITY u(pid, ord)
                     WHERE NOT (u.pid = ANY (v_newcomer)) OR u.pid = ANY (v_bbs)
                     ORDER BY u.ord);
    EXIT WHEN cardinality(v_next) = cardinality(v_seatable);
    v_sizes2 := public.fn_lightning_formation_sizes(cardinality(v_next), v_min, v_target, v_max, v_now - interval '3 seconds', v_now);
    v_g2 := LEAST(cardinality(v_sizes2), v_cap);
    EXIT WHEN v_g2 = 0;
    v_seatable := v_next;
    v_sizes := v_sizes2;
    v_g := v_g2;
  END LOOP;
  v_held := ARRAY(SELECT u.pid FROM unnest(v_legal) WITH ORDINALITY u(pid, ord)
                   WHERE NOT (u.pid = ANY (v_seatable)) ORDER BY u.ord);

$plan$ || substr(n, k);
  IF position('NEW PLAYERS ARE ALWAYS THE BIG BLIND FIRST' IN n) = 0
     OR position('IF v_rule = ''big_blind''' IN n) > 0 OR position('IF v_g2 = v_g THEN' IN n) > 0 THEN
    RAISE EXCEPTION 'Lightning plan first-entry replacement did not take';
  END IF;
  EXECUTE n;

  -- fn_lightning_matcher_snapshot: the same newcomer key for the TypeScript port.
  s := pg_get_functiondef('public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)'::regprocedure);
  n := replace(s, '''newcomer'',bl.player_id IS NULL,', '''newcomer'',sl.last_bb_at IS NULL,');
  IF n = s OR position('''newcomer'',sl.last_bb_at IS NULL,' IN n) = 0 THEN
    RAISE EXCEPTION 'Lightning snapshot newcomer anchor changed';
  END IF;
  EXECUTE n;
END $source$;

COMMIT;
