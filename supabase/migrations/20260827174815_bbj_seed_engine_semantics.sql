-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827174815; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
--  The seeded BBJ hands stop having their own dialect
-- ============================================================================
--
--  The five seeded hands wrote `actions[].amount` as an INCREMENT on every
--  verb. The engine does not:
--  server/src/engine/HandController.ts:600-724 writes the raise-TO level for
--  bet / raise / all_in and the chips actually added for call.
--
--  So the seed rows were the only rows on the platform with their own
--  convention, and every shared reader would have had to branch on
--  `source = 'seed'` forever. src/utils/handReplay.ts is that shared reader;
--  this converts the seed to the engine's form so it does not have to.
--
--  Also fills the two columns the rundown now draws and the seed never set:
--  `showdown` (reveal order + the muck ruling) and `pots` (the main/side
--  split). Both exist on live rows since 2026-08-25.
--
--  Idempotent by construction: the conversion is a no-op once applied, because
--  a to-level equals the increment plus what that seat already had in, and
--  after conversion the stored value already includes it. Guarded anyway by
--  the reconciliation assertion at the end, which fails on a double-apply.
--
--  Equivalent to supabase/migrations/20260827b_bbj_seed_engine_semantics.sql,
--  which regenerates the same end state from scratch via
--  scripts/dev/gen-bbj-seed.mjs.
-- ============================================================================

DO $$
DECLARE
  r record;
  v_act jsonb;
  v_out jsonb;
  v_committed jsonb;
  v_stage text;
  v_seat text;
  v_prior numeric;
  v_inc numeric;
  v_recon numeric;
BEGIN
  FOR r IN
    SELECT h.id, h.hand_number, h.pot_size, h.small_blind, h.big_blind,
           h.actions, b.sb_seat, b.bb_seat
    FROM public.hand_history h
    JOIN (VALUES
      (1506711, 1, 3),
      (1269428, 6, 7),
      (1253455, 1, 2),
      (1127041, 1, 3),
      (1080832, 2, 4)
    ) AS b(hand_number, sb_seat, bb_seat) ON b.hand_number = h.hand_number
    WHERE h.source = 'seed'
  LOOP
    v_out := '[]'::jsonb;
    v_committed := '{}'::jsonb;
    v_stage := NULL;
    v_recon := r.small_blind + r.big_blind;

    FOR v_act IN
      SELECT t.a FROM jsonb_array_elements(r.actions) WITH ORDINALITY t(a, ord) ORDER BY t.ord
    LOOP
      IF v_stage IS DISTINCT FROM lower(v_act->>'stage') THEN
        v_stage := lower(v_act->>'stage');
        v_committed := '{}'::jsonb;
        IF v_stage = 'preflop' THEN
          v_committed := jsonb_build_object(
            r.sb_seat::text, to_jsonb(r.small_blind),
            r.bb_seat::text, to_jsonb(r.big_blind));
        END IF;
      END IF;

      v_seat := v_act->>'seat';
      v_prior := COALESCE((v_committed->>v_seat)::numeric, 0);
      v_inc := COALESCE((v_act->>'amount')::numeric, 0);
      v_recon := v_recon + v_inc;
      v_committed := jsonb_set(v_committed, ARRAY[v_seat], to_jsonb(v_prior + v_inc), true);

      -- Stage names are lowercased to match the engine ('preflop', not 'PreFlop').
      v_out := v_out || jsonb_build_array(
        jsonb_set(
          jsonb_set(v_act, '{stage}', to_jsonb(v_stage)),
          '{amount}',
          to_jsonb(CASE
            WHEN v_act->>'action' IN ('bet', 'raise', 'all_in') THEN v_prior + v_inc
            ELSE v_inc
          END)));
    END LOOP;

    IF abs(v_recon - r.pot_size) >= 0.02 THEN
      RAISE EXCEPTION 'hand %: stored actions rebuild to % but pot_size is % - refusing to convert an already-converted or inconsistent row',
        r.hand_number, v_recon, r.pot_size;
    END IF;

    UPDATE public.hand_history SET actions = v_out WHERE id = r.id;
  END LOOP;
END $$;

-- The muck ruling and the pot split, the way a live hand records them.
UPDATE public.hand_history SET
  showdown = '[{"user_id":"083db75b-95a3-47ae-9989-927134dfa026","seat":5,"mucked":false,"reveal_order":0,"hand_name":"Four of a Kind"},{"user_id":"a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8","seat":7,"mucked":false,"reveal_order":1,"hand_name":"Royal Flush"}]'::jsonb,
  pots = '[{"index":0,"amount":7835,"eligible":["083db75b-95a3-47ae-9989-927134dfa026","a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8"]}]'::jsonb
WHERE source = 'seed' AND hand_number = 1506711;

UPDATE public.hand_history SET
  showdown = '[{"user_id":"f12caf56-c369-4b22-8e04-fdda07820876","seat":2,"mucked":false,"reveal_order":0,"hand_name":"Straight Flush"},{"user_id":"00000000-0000-0000-0000-000000000026","seat":5,"mucked":false,"reveal_order":1,"hand_name":"Royal Flush"}]'::jsonb,
  pots = '[{"index":0,"amount":581,"eligible":["f12caf56-c369-4b22-8e04-fdda07820876","00000000-0000-0000-0000-000000000026"]}]'::jsonb
WHERE source = 'seed' AND hand_number = 1269428;

UPDATE public.hand_history SET
  showdown = '[{"user_id":"25e20c49-15d7-410f-bb88-7161d758c9d5","seat":3,"mucked":false,"reveal_order":0,"hand_name":"Straight Flush"},{"user_id":"de0fe8e7-d317-43b7-bd5f-82dbac01418a","seat":6,"mucked":false,"reveal_order":1,"hand_name":"Straight Flush"}]'::jsonb,
  pots = '[{"index":0,"amount":736.5,"eligible":["25e20c49-15d7-410f-bb88-7161d758c9d5","de0fe8e7-d317-43b7-bd5f-82dbac01418a"]}]'::jsonb
WHERE source = 'seed' AND hand_number = 1253455;

UPDATE public.hand_history SET
  showdown = '[{"user_id":"00000000-0000-0000-0000-000000000008","seat":4,"mucked":false,"reveal_order":0,"hand_name":"Four of a Kind"},{"user_id":"f1042170-33c9-4063-b427-910fe1683c72","seat":9,"mucked":false,"reveal_order":1,"hand_name":"Four of a Kind"}]'::jsonb,
  pots = '[{"index":0,"amount":105.5,"eligible":["00000000-0000-0000-0000-000000000008","f1042170-33c9-4063-b427-910fe1683c72"]}]'::jsonb
WHERE source = 'seed' AND hand_number = 1127041;

UPDATE public.hand_history SET
  showdown = '[{"user_id":"60f7edc9-f93e-43da-833c-1dd10caef345","seat":6,"mucked":false,"reveal_order":0,"hand_name":"Four of a Kind"},{"user_id":"ca905025-0dfc-4353-ac1e-444ce5763c83","seat":8,"mucked":false,"reveal_order":1,"hand_name":"Royal Flush"}]'::jsonb,
  pots = '[{"index":0,"amount":2227,"eligible":["60f7edc9-f93e-43da-833c-1dd10caef345","ca905025-0dfc-4353-ac1e-444ce5763c83"]}]'::jsonb
WHERE source = 'seed' AND hand_number = 1080832;

-- Post-apply: rebuild every seeded hand the way src/utils/handReplay.ts does
-- and refuse to leave the migration applied if any of them misses. A hand that
-- does not reconcile renders with no stack column at all.
DO $$
DECLARE
  r record;
  v_act jsonb;
  v_recon numeric;
  v_committed jsonb;
  v_stage text;
  v_seat text;
  v_prior numeric;
  v_inc numeric;
BEGIN
  FOR r IN
    SELECT h.hand_number, h.pot_size, h.small_blind, h.big_blind, h.actions,
           h.showdown, h.pots, b.sb_seat, b.bb_seat
    FROM public.hand_history h
    JOIN (VALUES
      (1506711, 1, 3), (1269428, 6, 7), (1253455, 1, 2),
      (1127041, 1, 3), (1080832, 2, 4)
    ) AS b(hand_number, sb_seat, bb_seat) ON b.hand_number = h.hand_number
    WHERE h.source = 'seed'
  LOOP
    v_recon := r.small_blind + r.big_blind;
    v_committed := '{}'::jsonb;
    v_stage := NULL;

    FOR v_act IN
      SELECT t.a FROM jsonb_array_elements(r.actions) WITH ORDINALITY t(a, ord) ORDER BY t.ord
    LOOP
      IF v_stage IS DISTINCT FROM (v_act->>'stage') THEN
        v_stage := v_act->>'stage';
        v_committed := '{}'::jsonb;
        IF v_stage = 'preflop' THEN
          v_committed := jsonb_build_object(
            r.sb_seat::text, to_jsonb(r.small_blind),
            r.bb_seat::text, to_jsonb(r.big_blind));
        END IF;
      END IF;

      v_seat := v_act->>'seat';
      v_prior := COALESCE((v_committed->>v_seat)::numeric, 0);
      IF v_act->>'action' IN ('bet', 'raise', 'all_in') THEN
        v_inc := GREATEST(0, (v_act->>'amount')::numeric - v_prior);
      ELSE
        v_inc := COALESCE((v_act->>'amount')::numeric, 0);
      END IF;
      v_recon := v_recon + v_inc;
      v_committed := jsonb_set(v_committed, ARRAY[v_seat], to_jsonb(v_prior + v_inc), true);
    END LOOP;

    IF abs(v_recon - r.pot_size) >= 0.02 THEN
      RAISE EXCEPTION 'hand %: engine-semantics actions rebuild to % but pot_size is %',
        r.hand_number, v_recon, r.pot_size;
    END IF;

    IF r.showdown IS NULL OR jsonb_array_length(r.showdown) <> 2 THEN
      RAISE EXCEPTION 'hand %: expected two showdown reveals', r.hand_number;
    END IF;

    IF r.pots IS NULL OR (r.pots->0->>'amount')::numeric <> r.pot_size THEN
      RAISE EXCEPTION 'hand %: pots[0] does not equal pot_size', r.hand_number;
    END IF;

    IF lower(r.actions->0->>'stage') <> 'preflop' THEN
      RAISE EXCEPTION 'hand %: first action is not preflop', r.hand_number;
    END IF;
  END LOOP;
END $$;
