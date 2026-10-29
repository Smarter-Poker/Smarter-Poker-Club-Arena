-- Owner correction, 2026-10-28: PLO bomb pots run every twelve minutes.
-- Existing engine reads configuration at hand boundaries; no restart required.
-- Preserve already armed/owed bombs and the scheduler's hand-count transition.
-- Preserve Classic no-bomb rules, non-PLO cadence, antes, boards and all money.
-- Guard each installed function image; refuse concurrent source drift.
-- @live-proof: (public.fn_cash_template_defaults('madness','plo5')->'bombs'->>'trigger') = 'timed_12m' AND (public.fn_cash_template_defaults('madness','nlh')->'bombs'->>'trigger') = 'timed_10m'
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $patch$
DECLARE p jsonb; e jsonb; s text; n text; anchor text;
BEGIN
 FOR p IN SELECT * FROM jsonb_array_elements($patches$[
  {
    "fn": "public.fn_cash_template_defaults(text,text)",
    "md5": "73d45733045950999a3bbff207096c2f",
    "edits": [
      [
        "CASE WHEN t='classic' THEN NULL ELSE 'timed_10m' END",
        "CASE WHEN t='classic' THEN NULL WHEN v IN ('plo4','plo5','plo6','plo8') THEN 'timed_12m' ELSE 'timed_10m' END"
      ]
    ]
  },
  {
    "fn": "public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)",
    "md5": "0af2ed1c00f1fbaf13ab7f033d849308",
    "edits": [
      [
        "'timed_10m', 'timed_15m', 'timed_20m'",
        "'timed_10m', 'timed_12m', 'timed_15m', 'timed_20m'"
      ]
    ]
  },
  {
    "fn": "public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)",
    "md5": "9958361b856f7892b09491867ace30c0",
    "edits": [
      [
        "'timed_10m', 'timed_15m', 'timed_20m'",
        "'timed_10m', 'timed_12m', 'timed_15m', 'timed_20m'"
      ],
      [
        "WHEN v_bomb_trigger = 'timed_10m' THEN 600",
        "WHEN v_bomb_trigger = 'timed_12m' THEN 720\n                     WHEN v_bomb_trigger = 'timed_10m' THEN 600"
      ]
    ]
  },
  {
    "fn": "public.fn_cash_apply_ruleset(uuid)",
    "md5": "b62f7c8586da9322c66b8de3f274d412",
    "edits": [
      [
        "'timed_10m', 'timed_15m', 'timed_20m'",
        "'timed_10m', 'timed_12m', 'timed_15m', 'timed_20m'"
      ],
      [
        "WHEN v_bomb_trigger = 'timed_10m' THEN 600",
        "WHEN v_bomb_trigger = 'timed_12m' THEN 720\n                     WHEN v_bomb_trigger = 'timed_10m' THEN 600"
      ]
    ]
  }
]$patches$::jsonb) LOOP
  s := pg_get_functiondef((p->>'fn')::regprocedure);
  IF md5(s) IS DISTINCT FROM p->>'md5' THEN
   RAISE EXCEPTION 'PLO_CADENCE_SOURCE_CHANGED: %', p->>'fn';
  END IF;
  n := s;
  FOR e IN SELECT * FROM jsonb_array_elements(p->'edits') LOOP
   anchor := e->>0;
   IF (length(n)-length(replace(n,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'PLO_CADENCE_ANCHOR_CHANGED: %',p->>'fn';
   END IF;
   n := replace(n,anchor,e->>1);
  END LOOP;
  EXECUTE n;
 END LOOP;
END $patch$;

-- The template trigger retains its authority over locked rules. Only open,
-- non-retired PLO games with bombs already enabled receive the new promise.
UPDATE public.cash_games g
 SET ruleset_snapshot=jsonb_set(g.ruleset_snapshot,'{bombs,trigger}','"timed_12m"'::jsonb),
     updated_at=now()
 FROM public.clubs c
 WHERE c.id=g.club_id AND coalesce(c.lifecycle_status,'')<>'retired'
   AND g.closed_at IS NULL AND g.variant IN ('plo4','plo5','plo6','plo8')
   AND (g.ruleset_snapshot->'bombs'->>'enabled')::boolean
   AND g.ruleset_snapshot->'bombs'->>'trigger' IS DISTINCT FROM 'timed_12m';

-- Project only cadence columns; do not rewrite other rules or scheduler state.
-- The original projection/open-table owners above now understand the token,
-- so a subsequent tick or a newly opened table keeps the same interval.
UPDATE public.tables t SET bomb_pot_trigger_mode='timed',
 bomb_pot_interval_seconds=720,updated_at=now()
 FROM public.cash_games g JOIN public.clubs c ON c.id=g.club_id
 WHERE t.cluster_id=g.id AND coalesce(c.lifecycle_status,'')<>'retired'
 AND g.closed_at IS NULL AND g.variant IN ('plo4','plo5','plo6','plo8')
 AND g.ruleset_snapshot->'bombs'->>'trigger'='timed_12m'
 AND (g.ruleset_snapshot->'bombs'->>'enabled')::boolean
 AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
 AND (t.bomb_pot_trigger_mode IS DISTINCT FROM 'timed'
      OR t.bomb_pot_interval_seconds IS DISTINCT FROM 720);

DO $verify$
DECLARE v text;
BEGIN
 FOREACH v IN ARRAY ARRAY['plo4','plo5','plo6','plo8'] LOOP
  IF public.fn_cash_template_defaults('madness',v)->'bombs'->>'trigger' IS DISTINCT FROM 'timed_12m'
     OR public.fn_cash_template_defaults('classic',v)->'bombs'->>'enabled' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'PLO_CADENCE_DEFAULT_FAILED: %',v;
  END IF;
 END LOOP;
 IF public.fn_cash_template_defaults('madness','nlh')->'bombs'->>'trigger' IS DISTINCT FROM 'timed_10m' THEN
  RAISE EXCEPTION 'NON_PLO_CADENCE_CHANGED';
 END IF;
 IF EXISTS (
  SELECT 1 FROM public.cash_games g JOIN public.clubs c ON c.id=g.club_id
  LEFT JOIN public.tables t ON t.cluster_id=g.id AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
  WHERE coalesce(c.lifecycle_status,'')<>'retired' AND g.closed_at IS NULL
  AND g.variant IN ('plo4','plo5','plo6','plo8')
  AND (g.ruleset_snapshot->'bombs'->>'enabled')::boolean
  AND (g.ruleset_snapshot->'bombs'->>'trigger' IS DISTINCT FROM 'timed_12m'
   OR (t.id IS NOT NULL AND (t.bomb_pot_trigger_mode IS DISTINCT FROM 'timed'
     OR t.bomb_pot_interval_seconds IS DISTINCT FROM 720)))
 ) THEN RAISE EXCEPTION 'PLO_CADENCE_PROJECTION_FAILED'; END IF;
END $verify$;
COMMIT;
