-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825233619; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The lobby cannot print a rule it is not sent. The NIT GAME chip states the
-- actual thresholds -- "NIT GAME" alone tells a player nothing about whether
-- they would survive it -- so all four columns have to reach the card.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF position('nit_game' in v_def) > 0 THEN
    RAISE NOTICE 'get_club_home already sends the nit game columns';
    RETURN;
  END IF;

  IF position('           is_vip_only, label_as_new, is_featured, hide_club_name' in v_def) = 0 THEN
    RAISE EXCEPTION 'the tables select list is not the shape this patch expects';
  END IF;

  EXECUTE replace(v_def,
    '           is_vip_only, label_as_new, is_featured, hide_club_name',
    E'           is_vip_only, label_as_new, is_featured, hide_club_name,\n'
    || E'           -- NIT GAME: the switch and the three numbers it governs.\n'
    || E'           nit_game, career_percent_min, maintain_percent_min, maintain_hands');
END $$;

DO $$
DECLARE v jsonb; t jsonb;
BEGIN
  v := public.get_club_home('shark-club');
  IF COALESCE((v->>'found')::boolean, false) THEN
    t := v->'tables'->0;
    IF t IS NOT NULL AND NOT (t ? 'nit_game' AND t ? 'career_percent_min'
                              AND t ? 'maintain_percent_min' AND t ? 'maintain_hands') THEN
      RAISE EXCEPTION 'the nit game columns did not reach the table payload';
    END IF;
    -- And nothing applied earlier today was lost.
    IF t IS NOT NULL AND (t ? 'settings' OR NOT (t ? 'club_id' AND t ? 'is_vip_only')) THEN
      RAISE EXCEPTION 'an earlier change to this select list was reverted';
    END IF;
    IF NOT (v ? 'club_names') THEN
      RAISE EXCEPTION 'club_names was lost';
    END IF;
  END IF;
END $$;
