-- 20260919153039_public_bonus_replay_has_an_explicitly_public_reader.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Shared replays are deliberately public, read-only snapshots created by their
-- authenticated owner. The monetary-function event guard correctly reserves
-- every diamond-named RPC, including the original reader, and strips its anon
-- grant again on any later grant. Use an explicitly public content-reader name
-- with the same qualified token-only body; do not weaken or bypass that guard.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

DO $$ BEGIN
 IF md5(pg_get_functiondef('public.fn_diamond_bonus_shared(uuid)'::regprocedure)) <> 'fe66fec0f8444b2aa7f77107ccfc6544'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_autorevoke_privileged_anon()'::regprocedure)) <> '4508beb8e21b1a964ed2d21cf68c374c'
 OR NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='trg_autorevoke_privileged_anon' AND evtenabled='O' AND evttags @> ARRAY['CREATE FUNCTION','ALTER FUNCTION','GRANT'])
 THEN RAISE EXCEPTION 'Public replay reader or active money guard changed; review exact source'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_shared_bonus_replay(p_share_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
 SELECT coalesce((SELECT jsonb_build_object('ok',true,'replay',payload)
  FROM public.diamond_bonus_shares WHERE id=p_share_id),jsonb_build_object('ok',false,'error','Replay Not Found'));
$$;
REVOKE ALL ON FUNCTION public.fn_shared_bonus_replay(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_shared_bonus_replay(uuid) TO anon,authenticated;

INSERT INTO public.ca_browser_definer_allowlist(proname,reason) VALUES (
 'fn_shared_bonus_replay',
 'Public bonus replay link: a random share UUID, created only by the authenticated owner of a settled game, reads the immutable explicitly shared game and prize snapshot. No identities, wallets, club details, seeds, unshared games, or write capability are returned.'
) ON CONFLICT(proname) DO NOTHING;

-- This reader has never been published in the client. Explicitly close the
-- superseded name before retiring it, including for branch-level ACL checks.
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_shared(uuid) FROM PUBLIC,anon,authenticated,service_role;
DROP FUNCTION public.fn_diamond_bonus_shared(uuid);
DELETE FROM public.privileged_function_lock WHERE function_signature='public.fn_diamond_bonus_shared(uuid)';

DO $$ BEGIN
 IF NOT has_function_privilege('anon','public.fn_shared_bonus_replay(uuid)','EXECUTE')
 OR NOT has_function_privilege('authenticated','public.fn_shared_bonus_replay(uuid)','EXECUTE')
 OR has_table_privilege('anon','public.diamond_bonus_shares','SELECT')
 OR has_function_privilege('anon','public.fn_diamond_bonus_replay(uuid)','EXECUTE')
 OR has_function_privilege('anon','public.fn_diamond_bonus_share(uuid)','EXECUTE')
 OR has_function_privilege('anon','public.fn_diamond_bonus_share_to_feed(uuid)','EXECUTE')
 OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_autorevoke_privileged_anon()'::regprocedure)) <> '4508beb8e21b1a964ed2d21cf68c374c'
 THEN RAISE EXCEPTION 'Public replay grant or private money boundary failed'; END IF;
END $$;

COMMIT;
