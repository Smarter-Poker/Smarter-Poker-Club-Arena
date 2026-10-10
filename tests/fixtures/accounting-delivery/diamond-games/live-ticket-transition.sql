\set ON_ERROR_STOP on
-- Private fixture transition to the installed September22 ticket contract.
-- The old historical migration also pins retired entry functions that this
-- fixture has intentionally advanced. Only this unchanged owning function is
-- advanced here, with both exact old and live postimages retained.
DO $$ BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 IF md5(pg_get_functiondef('public.fn_wheel_commit()'::regprocedure))<>'34c775fe864cc754f30793582aa162ad' THEN RAISE EXCEPTION 'Fixture commit preimage changed'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.fn_wheel_commit()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text;
  v_hash text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  -- Only this player's expired, never-used tickets are swept. A live ticket
  -- another page of theirs is holding stays valid until it is used or expires.
  DELETE FROM public.wheel_seed_commits WHERE user_id = v_user AND consumed_by IS NULL AND expires_at < now();
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.wheel_seed_commits (user_id, server_seed, server_seed_hash)
  VALUES (v_user, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$;

DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_commit()'::regprocedure))<>'2325f279e9b3e5826cfdb9df996680a8' THEN RAISE EXCEPTION 'Installed ticket function postimage changed'; END IF; END $$;
