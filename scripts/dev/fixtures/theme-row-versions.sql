-- Isolated timestamp/receipt fixture, not an ownership/RLS substitute.
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END$$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '11111111-1111-4111-8111-111111111111'::uuid $$;
CREATE TABLE public.cosmetic_catalog(category text, asset_id text);
INSERT INTO cosmetic_catalog VALUES ('table_id','carbon_red'),('table_id','jade_city');
CREATE TABLE public.user_theme_settings(user_id uuid,game_type text,theme_id text DEFAULT 'default-dark',table_id text DEFAULT 'classic_green',button_id text DEFAULT 'white-d',background_id text DEFAULT 'default',cards_id text DEFAULT 'default',face_deck_id text DEFAULT 'default',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,game_type));
CREATE TABLE customization_settings_mutation_receipts(user_id uuid,mutation_id uuid,operation text,request jsonb,result jsonb,PRIMARY KEY(user_id,mutation_id));
CREATE FUNCTION public.update_user_theme_settings_timestamp() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.update_user_theme_settings_timestamp() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_user_theme_settings_timestamp() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_user_theme_settings_timestamp() TO service_role;
CREATE TRIGGER trg_user_theme_settings_updated BEFORE UPDATE ON public.user_theme_settings FOR EACH ROW EXECUTE FUNCTION public.update_user_theme_settings_timestamp();
CREATE TABLE theme_events(n bigint GENERATED ALWAYS AS IDENTITY,kind text,row_data jsonb);
CREATE FUNCTION capture_theme_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO theme_events(kind,row_data) VALUES(TG_OP,to_jsonb(NEW)); RETURN NEW; END$$;
CREATE TRIGGER capture_theme AFTER INSERT OR UPDATE ON user_theme_settings FOR EACH ROW EXECUTE FUNCTION capture_theme_event();
CREATE OR REPLACE FUNCTION public.fn_patch_table_appearance(
  p_expected_user_id uuid,
  p_mutation_id uuid,
  p_game_type text,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_request jsonb;
  v_result jsonb;
  v_prior_operation text;
  v_prior_request jsonb;
  v_prior_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_expected_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authenticated account changed before appearance was saved'
      USING ERRCODE = '42501';
  END IF;
  IF p_mutation_id IS NULL
     OR p_mutation_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'Mutation id is required' USING ERRCODE = '22023';
  END IF;
  IF p_game_type IS NULL OR p_game_type NOT IN (
    'ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'
  ) THEN
    RAISE EXCEPTION 'Invalid appearance game type' USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL
     OR jsonb_typeof(p_patch) <> 'object'
     OR p_patch = '{}'::jsonb
     OR octet_length(p_patch::text) > 4096 THEN
    RAISE EXCEPTION 'Appearance patch must be a non-empty object'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_patch) AS field(name)
     WHERE field.name NOT IN (
       'theme_id', 'table_id', 'button_id', 'background_id', 'cards_id', 'face_deck_id'
     )
  ) THEN
    RAISE EXCEPTION 'Appearance patch contains an unsupported field'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each(p_patch) AS field(name, value)
     WHERE jsonb_typeof(field.value) <> 'string'
        OR btrim(field.value #>> '{}') = ''
        OR length(field.value #>> '{}') > 128
  ) THEN
    RAISE EXCEPTION 'Appearance patch contains an invalid asset id'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each_text(p_patch) AS asset(category, asset_id)
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.cosmetic_catalog catalog
        WHERE catalog.category = asset.category
          AND catalog.asset_id = asset.asset_id
     )
  ) THEN
    RAISE EXCEPTION 'Appearance patch references an unknown asset'
      USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_build_object('game_type', p_game_type, 'patch', p_patch);
  INSERT INTO public.customization_settings_mutation_receipts
    (user_id, mutation_id, operation, request, result)
  VALUES (v_user_id, p_mutation_id, 'table_appearance', v_request, NULL)
  ON CONFLICT (user_id, mutation_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT operation, request, result
      INTO v_prior_operation, v_prior_request, v_prior_result
      FROM public.customization_settings_mutation_receipts
     WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
    IF v_prior_operation <> 'table_appearance'
       OR v_prior_request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Mutation id was already used for another request'
        USING ERRCODE = '22023';
    END IF;
    IF v_prior_result IS NULL THEN
      RAISE EXCEPTION 'Mutation is still in progress; retry with the same mutation id'
        USING ERRCODE = '40001';
    END IF;
    RETURN v_prior_result;
  END IF;

  -- Let schema defaults create the untouched fields on a player's first
  -- partial save. The ownership trigger validates those defaults and every
  -- changed field before the row can become visible.
  INSERT INTO public.user_theme_settings (user_id, game_type)
  VALUES (v_user_id, p_game_type)
  ON CONFLICT (user_id, game_type) DO NOTHING;

  -- This update takes the row lock and serializes different devices. Only
  -- keys present in the patch move; unrelated appearance fields survive.
  UPDATE public.user_theme_settings AS settings
     SET theme_id = CASE
           WHEN p_patch ? 'theme_id' THEN p_patch ->> 'theme_id'
           ELSE settings.theme_id
         END,
         table_id = CASE
           WHEN p_patch ? 'table_id' THEN p_patch ->> 'table_id'
           ELSE settings.table_id
         END,
         button_id = CASE
           WHEN p_patch ? 'button_id' THEN p_patch ->> 'button_id'
           ELSE settings.button_id
         END,
         background_id = CASE
           WHEN p_patch ? 'background_id' THEN p_patch ->> 'background_id'
           ELSE settings.background_id
         END,
         cards_id = CASE
           WHEN p_patch ? 'cards_id' THEN p_patch ->> 'cards_id'
           ELSE settings.cards_id
         END,
         face_deck_id = CASE
           WHEN p_patch ? 'face_deck_id' THEN p_patch ->> 'face_deck_id'
           ELSE settings.face_deck_id
         END
   WHERE settings.user_id = v_user_id
     AND settings.game_type = p_game_type
   RETURNING jsonb_build_object(
     'game_type', settings.game_type,
     'theme_id', settings.theme_id,
     'table_id', settings.table_id,
     'button_id', settings.button_id,
     'background_id', settings.background_id,
     'cards_id', settings.cards_id,
     'face_deck_id', settings.face_deck_id,
     'updated_at', settings.updated_at
   ) INTO v_result;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Appearance settings row was not saved' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.customization_settings_mutation_receipts
     SET result = v_result
   WHERE user_id = v_user_id AND mutation_id = p_mutation_id;
  RETURN v_result;
END;
$$;

