-- Club Arena customization: atomic interface mode + conflict-safe collections.
-- Whole-document client writes lose unrelated settings and concurrent device
-- changes. These functions mutate only the field/slot the player touched.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_set_interface_theme(p_theme text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_theme IS NULL OR NOT (p_theme IN ('light', 'dark')) THEN
    RAISE EXCEPTION 'Invalid interface theme' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
     SET settings = jsonb_set(
       CASE
         WHEN jsonb_typeof(settings) = 'object' THEN settings
         ELSE '{}'::jsonb
       END,
       '{theme}',
       to_jsonb(p_theme),
       true
     )
   WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN p_theme;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_set_interface_theme(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_set_interface_theme(text) TO authenticated;

ALTER TABLE public.user_table_studio_preferences
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.fn_seed_table_studio_preferences(
  p_favorites text[],
  p_loadouts jsonb
)
RETURNS TABLE(favorites text[], loadouts jsonb, revision bigint, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_favorites text[] := COALESCE(p_favorites, '{}'::text[]);
  v_loadouts jsonb := COALESCE(p_loadouts, '[null,null,null]'::jsonb);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF cardinality(v_favorites) > 100 OR EXISTS (
    SELECT 1 FROM unnest(v_favorites) AS item
     WHERE item IS NULL OR btrim(item) = '' OR length(item) > 200
  ) THEN
    RAISE EXCEPTION 'Invalid Table Studio favorites' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_loadouts) <> 'array' OR jsonb_array_length(v_loadouts) <> 3 THEN
    RAISE EXCEPTION 'Invalid Table Studio loadouts' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_table_studio_preferences (user_id, favorites, loadouts)
  VALUES (v_user_id, v_favorites, v_loadouts)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  SELECT p.favorites, p.loadouts, p.revision, p.updated_at
    FROM public.user_table_studio_preferences p
   WHERE p.user_id = v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_mutate_table_studio_preferences(
  p_favorite_key text DEFAULT NULL,
  p_favorite_enabled boolean DEFAULT NULL,
  p_loadout_slot integer DEFAULT NULL,
  p_loadout jsonb DEFAULT NULL
)
RETURNS TABLE(favorites text[], loadouts jsonb, revision bigint, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_is_favorite_mutation boolean := p_favorite_key IS NOT NULL OR p_favorite_enabled IS NOT NULL;
  v_is_loadout_mutation boolean := p_loadout_slot IS NOT NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF v_is_favorite_mutation = v_is_loadout_mutation THEN
    RAISE EXCEPTION 'Exactly one Table Studio mutation is required' USING ERRCODE = '22023';
  END IF;

  IF v_is_favorite_mutation AND (
    p_favorite_key IS NULL OR p_favorite_enabled IS NULL OR
    btrim(p_favorite_key) = '' OR length(p_favorite_key) > 200
  ) THEN
    RAISE EXCEPTION 'Invalid favorite mutation' USING ERRCODE = '22023';
  END IF;

  IF v_is_loadout_mutation THEN
    IF p_loadout_slot < 0 OR p_loadout_slot > 2 THEN
      RAISE EXCEPTION 'Invalid loadout slot' USING ERRCODE = '22023';
    END IF;
    IF p_loadout IS NOT NULL AND (
      jsonb_typeof(p_loadout) <> 'object' OR
      NOT (p_loadout ?& ARRAY['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id']) OR
      jsonb_typeof(p_loadout -> 'theme_id') <> 'string' OR
      jsonb_typeof(p_loadout -> 'table_id') <> 'string' OR
      jsonb_typeof(p_loadout -> 'button_id') <> 'string' OR
      jsonb_typeof(p_loadout -> 'background_id') <> 'string' OR
      jsonb_typeof(p_loadout -> 'cards_id') <> 'string'
    ) THEN
      RAISE EXCEPTION 'Invalid loadout payload' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.user_table_studio_preferences (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY
  UPDATE public.user_table_studio_preferences AS p
     SET favorites = CASE
       WHEN NOT v_is_favorite_mutation THEN p.favorites
       WHEN p_favorite_enabled THEN
         (ARRAY[p_favorite_key] || array_remove(p.favorites, p_favorite_key))[1:100]
       ELSE array_remove(p.favorites, p_favorite_key)
     END,
         loadouts = CASE
       WHEN NOT v_is_loadout_mutation THEN p.loadouts
       ELSE jsonb_set(
         p.loadouts,
         ARRAY[p_loadout_slot::text],
         COALESCE(p_loadout, 'null'::jsonb),
         false
       )
     END,
         revision = p.revision + 1
   WHERE p.user_id = v_user_id
   RETURNING p.favorites, p.loadouts, p.revision, p.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_seed_table_studio_preferences(text[], jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_seed_table_studio_preferences(text[], jsonb)
  TO authenticated;
REVOKE ALL ON FUNCTION public.fn_mutate_table_studio_preferences(text, boolean, integer, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mutate_table_studio_preferences(text, boolean, integer, jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.fn_set_interface_theme(text) IS
  'Atomically patches profiles.settings.theme for the authenticated player.';
COMMENT ON FUNCTION public.fn_mutate_table_studio_preferences(text, boolean, integer, jsonb) IS
  'Atomically applies one favorite or loadout-slot mutation without replacing another device snapshot.';

COMMIT;
