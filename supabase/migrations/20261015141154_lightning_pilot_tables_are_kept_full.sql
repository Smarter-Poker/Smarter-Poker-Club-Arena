-- Lightning Phase 3 needs the private pilot populated past its activation
-- thresholds (6-max 18 live, 9-max 27 live). After the pilot horses were
-- admitted and funded (20261015032740, 20261015093554) the fleet seated them at
-- its ordinary rhythm: a cash table's seat target is 1..max re-rolled per
-- bucket (HorseBehavior occupancyTargetFor), so at 13:15 UTC the pilot held 4
-- at the 9-max and 2 at the 6-max.
--
-- RULING. Dan, 2026-10-15 09:11 Central, in his own words: "set the Lightning
-- pilot club's horse fleet policy to keep its tables full (occupancy_bias 9),
-- pilot club only."
--
-- Change: one club-scoped fleet policy row for the pilot only, through the
-- maintained audited door fn_ca_fleet_set_policy, with occupancy_bias 9.
-- applyBias rounds target x bias and caps at the table size, so every pilot
-- table's target becomes full and the Must-Move cluster opens the next table as
-- mains fill. No other field, no other club's or the global policy changes, no
-- chips move, no Lightning control changes. Horses still meet every bankroll,
-- exposure, stop-loss and rotation rule a human would.
-- @live-proof: (SELECT (public.fn_ca_fleet_policy_effective('e14bc9f7-736d-425f-8f2c-e78305ebac1d')->>'occupancy_bias')::numeric = 9)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $policy$
DECLARE v jsonb; v_eff jsonb; v_global jsonb; v_others jsonb;
BEGIN
  SELECT to_jsonb(p) INTO v_global FROM public.ca_horse_fleet_policy p WHERE scope = 'global';
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.scope_key), '[]'::jsonb) INTO v_others
    FROM public.ca_horse_fleet_policy p
   WHERE p.scope <> 'global' AND p.scope_id IS DISTINCT FROM 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid;

  v := public.fn_ca_fleet_set_policy('club', 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid,
    jsonb_build_object('occupancy_bias', 9,
      'notes', 'Lightning Internal Pilot: tables kept full so Phase 3 calibration crosses 18/27 live (Dan, 2026-10-15).'),
    '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
    'Lightning pilot Phase 3: keep the private pilot tables full (Dan, 2026-10-15)');
  IF coalesce(v->>'ok', '') <> 'true' THEN
    RAISE EXCEPTION 'fleet policy refused: %', v;
  END IF;

  v_eff := public.fn_ca_fleet_policy_effective('e14bc9f7-736d-425f-8f2c-e78305ebac1d');
  IF (v_eff->>'occupancy_bias')::numeric IS DISTINCT FROM 9 OR v_eff->'source'->>'occupancy_bias' <> 'club' THEN
    RAISE EXCEPTION 'pilot effective occupancy_bias is % from %, expected 9 from club',
      v_eff->>'occupancy_bias', v_eff->'source'->>'occupancy_bias';
  END IF;
  IF v_eff->>'enabled' <> 'true' OR v_eff->>'pause_new_seatings' <> 'false' OR v_eff->>'max_horses' IS NOT NULL THEN
    RAISE EXCEPTION 'another pilot policy field changed: %', v_eff;
  END IF;
  IF (SELECT to_jsonb(p) FROM public.ca_horse_fleet_policy p WHERE scope = 'global') IS DISTINCT FROM v_global THEN
    RAISE EXCEPTION 'the global fleet policy changed';
  END IF;
  IF (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.scope_key), '[]'::jsonb)
        FROM public.ca_horse_fleet_policy p
       WHERE p.scope <> 'global' AND p.scope_id IS DISTINCT FROM 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid)
     IS DISTINCT FROM v_others THEN
    RAISE EXCEPTION 'another club or union policy row changed';
  END IF;
END $policy$;

COMMIT;
