-- Exact relation/helper from World Hub migration 20261010035338.
-- Pending P3 authority, not a claim of production installation or full migration parity.
CREATE TABLE public.ca_player_session_revocations (
  user_id uuid PRIMARY KEY,
  revoked_before timestamptz NOT NULL,
  op_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_player_session_revocations ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.fn_ca_player_session_live(p_user_id uuid,p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,auth,public AS $f$
 SELECT NOT EXISTS(SELECT 1 FROM public.ca_player_session_revocations WHERE user_id=p_user_id)
   OR EXISTS(SELECT 1 FROM auth.sessions WHERE id=p_session_id AND user_id=p_user_id
   AND (not_after IS NULL OR not_after>statement_timestamp()));
$f$;
ALTER FUNCTION public.fn_ca_player_session_live(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_player_session_live(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_player_session_live(uuid,uuid) TO service_role;
