-- The one production definition the installed ticket migration 20260921185541
-- replaces and this fixture never captured: fn_diamond_game_commit as it stood
-- before that migration, copied byte for byte from 20260914102113. Its
-- pg_get_functiondef md5 must be 6f1cfed80ae7f203205c2d6c8a2d5c02, the preimage
-- 20260921185541 itself asserts, so the installed migration then loads
-- unchanged and installs the expired-only ticket sweep production runs. That
-- sweep is the one DELETE the crash lock (20260922173914) admits on
-- diamond_game_commits.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_commit(p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text; v_hash text; v_id uuid; v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('plinko', 'crash', 'crossing', 'mines') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND game = p_game AND consumed_by IS NULL;
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.diamond_game_commits (user_id, game, server_seed, server_seed_hash)
  VALUES (v_user, p_game, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$
;
DO $witness$ BEGIN
  IF md5(pg_get_functiondef('public.fn_diamond_game_commit(text)'::regprocedure))
     IS DISTINCT FROM '6f1cfed80ae7f203205c2d6c8a2d5c02' THEN
    RAISE EXCEPTION 'The captured ticket dealer is not the production preimage';
  END IF;
END $witness$;
