-- 20260919143005_diamond_bonus_replay_and_daily_spin_custody.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Completed, owner-controlled replay receipts and explicit social sharing;
-- future Crash rounds capped at100x with a slower curve. Daily custody is
-- delivered separately in the following qualified migration.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- Only future flights take the new limits. Existing round snapshots, sealed
-- outcomes, payouts and proofs are immutable and are never rewritten.
CREATE OR REPLACE FUNCTION public.fn_crash_config_limits()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
 IF NEW.game='crash' THEN
  NEW.max_multiplier_cents:=least(NEW.max_multiplier_cents,10000);
  NEW.growth_k:=least(NEW.growth_k,0.04);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_crash_config_limits() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER crash_config_limits BEFORE INSERT OR UPDATE ON public.diamond_game_configs
 FOR EACH ROW EXECUTE FUNCTION public.fn_crash_config_limits();
UPDATE public.diamond_game_configs SET max_multiplier_cents=least(max_multiplier_cents,10000),
 growth_k=least(growth_k,0.04),updated_at=now() WHERE game='crash';

-- A replay contains only a completed outcome. Sharing is explicit; a private
-- round identifier cannot be used as a public replay token. No player identity,
-- wallet balances, club identifiers or other private receipts enter the payload.
CREATE TABLE public.diamond_bonus_shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 bonus_id uuid NOT NULL UNIQUE,
 user_id uuid NOT NULL,
 payload jsonb NOT NULL,
 social_post_id uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.diamond_bonus_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.diamond_bonus_shares FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_replay(p_bonus_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE e public.diamond_bonus_entries; c public.crash_rounds; d public.diamond_choice_rounds;
 v_data jsonb; v_payout numeric; v_completed timestamptz; v_road_end integer;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To See Your Replays'); END IF;
 SELECT * INTO e FROM public.diamond_bonus_entries WHERE id=p_bonus_id AND user_id=auth.uid();
 IF e.id IS NULL OR e.result IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Replay Not Found'); END IF;
 IF e.game='plinko' THEN
  v_data:=jsonb_build_object('multipliers_cents',e.result->'multipliers_cents','drops',e.result->'drops',
   'diamonds_per_drop',e.result->'diamonds_per_drop','table_name',e.result->'table_name');
  v_payout:=(e.result->>'payout_chips')::numeric; v_completed:=e.created_at;
 ELSIF e.game='crash' THEN
  SELECT * INTO c FROM public.crash_rounds WHERE commit_id=e.commit_id AND user_id=e.user_id;
  IF c.id IS NULL OR c.status='open' THEN RETURN jsonb_build_object('ok',false,'error','Finish This Bonus Before Replaying It'); END IF;
  v_data:=jsonb_build_object('status',c.status,'growth_k',c.growth_k,'cap_cents',c.cap_cents,
   'elapsed_ms',c.elapsed_ms,'cashout_cents',c.cashout_cents,'crash_cents',c.crash_cents,
   'auto_cashout_cents',c.auto_cashout_cents);
  v_payout:=c.payout_chips; v_completed:=c.settled_at;
 ELSIF e.game IN ('crossing','mines') THEN
  SELECT * INTO d FROM public.diamond_choice_rounds WHERE commit_id=e.commit_id AND user_id=e.user_id;
  IF d.id IS NULL OR d.status='open' THEN RETURN jsonb_build_object('ok',false,'error','Finish This Bonus Before Replaying It'); END IF;
  IF e.game='crossing' THEN
   SELECT count(*) INTO v_road_end FROM unnest(d.prizes) p
    WHERE (d.road_roll::numeric+1)*(p-d.minimum_payout_chips)<=(d.bet_chips*.8-d.minimum_payout_chips)*281474976710656;
  END IF;
  v_data:=jsonb_build_object('status',d.status,'mode',d.mode,'picked',to_jsonb(d.picked),
   'prizes',to_jsonb(d.prizes),'mine_cells',to_jsonb(d.mine_cells),'road_end',v_road_end);
  v_payout:=d.payout_chips; v_completed:=d.settled_at;
 ELSE RETURN jsonb_build_object('ok',false,'error','Replay Not Found'); END IF;
 RETURN jsonb_build_object('ok',true,'replay',jsonb_build_object('version',1,'game',e.game,
  'diamonds',e.total_diamonds,'boost',coalesce((e.result#>>'{bonus,boost_multiplier}')::integer,1),
  'completed_at',v_completed,'payout_chips',v_payout,'data',v_data));
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_replay(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_replay(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_replays(p_club_id uuid,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rows jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To See Your Replays'); END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC,r.id DESC),'[]'::jsonb) INTO v_rows FROM (
  SELECT e.id,e.game,e.created_at,e.total_diamonds AS diamonds,
   coalesce((e.result#>>'{bonus,boost_multiplier}')::integer,1) AS boost,
   CASE WHEN e.game='plinko' THEN (e.result->>'payout_chips')::numeric
        WHEN e.game='crash' THEN c.payout_chips ELSE d.payout_chips END AS payout_chips
  FROM public.diamond_bonus_entries e
  LEFT JOIN public.crash_rounds c ON e.game='crash' AND c.commit_id=e.commit_id AND c.user_id=e.user_id
  LEFT JOIN public.diamond_choice_rounds d ON e.game IN ('mines','crossing') AND d.commit_id=e.commit_id AND d.user_id=e.user_id
  WHERE e.user_id=auth.uid() AND e.club_id=p_club_id AND e.result IS NOT NULL
   AND (e.game='plinko' OR c.status IN ('cashed','crashed') OR d.status IN ('cashed','lost'))
   AND (p_before IS NULL OR (e.created_at,e.id)<(p_before,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  ORDER BY e.created_at DESC,e.id DESC LIMIT 25
 ) r;
 RETURN jsonb_build_object('ok',true,'replays',v_rows);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_replays(uuid,timestamptz,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_replays(uuid,timestamptz,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_share(p_bonus_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_result jsonb; s public.diamond_bonus_shares;
BEGIN
 v_result:=public.fn_diamond_bonus_replay(p_bonus_id);
 IF (v_result->>'ok')::boolean IS DISTINCT FROM true THEN RETURN v_result; END IF;
 INSERT INTO public.diamond_bonus_shares(bonus_id,user_id,payload)
 VALUES(p_bonus_id,auth.uid(),v_result->'replay') ON CONFLICT(bonus_id) DO NOTHING;
 SELECT * INTO s FROM public.diamond_bonus_shares WHERE bonus_id=p_bonus_id AND user_id=auth.uid();
 IF s.id IS NULL THEN RAISE EXCEPTION 'Replay Share Ownership Mismatch'; END IF;
 RETURN jsonb_build_object('ok',true,'share_id',s.id);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_share(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_share(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_shared(p_share_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
 SELECT coalesce((SELECT jsonb_build_object('ok',true,'replay',payload)
  FROM public.diamond_bonus_shares WHERE id=p_share_id),jsonb_build_object('ok',false,'error','Replay Not Found'));
$$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_shared(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_shared(uuid) TO anon,authenticated;

-- Player-triggered social publication is bound to the immutable share receipt.
-- A lost HTTP acknowledgement can be retried without creating another post.
CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_share_to_feed(p_share_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE s public.diamond_bonus_shares; v_post jsonb; v_title text;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Share'); END IF;
 SELECT * INTO s FROM public.diamond_bonus_shares WHERE id=p_share_id AND user_id=auth.uid() FOR UPDATE;
 IF s.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Replay Not Found'); END IF;
 IF s.social_post_id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'post_id',s.social_post_id); END IF;
 v_title:=CASE WHEN (s.payload->>'boost')::integer>1 THEN 'Super ' ELSE 'Diamond ' END ||
  CASE s.payload->>'game' WHEN 'crossing' THEN 'Donkey Cross' ELSE initcap(s.payload->>'game') END;
 v_post:=public.fn_create_social_post(auth.uid(),v_title||': '||(s.payload->>'payout_chips')||' Chips. Watch My Bonus Replay: https://smarter.poker/hub/club-arena/bonus-replay/'||s.id,
  'text',ARRAY[]::text[],'public',jsonb_build_object('type','diamond_bonus_replay','share_id',s.id,
   'url','https://smarter.poker/hub/club-arena/bonus-replay/'||s.id),NULL);
 IF coalesce((v_post->>'success')::boolean,false)=false THEN
  RAISE EXCEPTION 'The Replay Could Not Be Shared: %',v_post->>'error';
 END IF;
 UPDATE public.diamond_bonus_shares SET social_post_id=(v_post->>'id')::uuid WHERE id=s.id;
 RETURN jsonb_build_object('ok',true,'post_id',(v_post->>'id')::uuid);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_share_to_feed(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_share_to_feed(uuid) TO authenticated;

-- The existing social-post trigger awards its normal catalog reward. Admit
-- only this owner-authenticated share door through the profile guard; all
-- direct wallet writes and private helper ACLs remain unchanged.
DO $guard$
DECLARE v_before text; v_after text;
 v_old constant text := $old$     OR v_stack ~ 'function (public[.])?fn_wheel_spin_v2[(]'$old$;
 v_new constant text := $new$     OR v_stack ~ 'function (public[.])?fn_wheel_spin_v2[(]'
     OR v_stack ~ 'function (public[.])?fn_diamond_bonus_share_to_feed[(]'$new$;
BEGIN
 SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_before;
 IF md5(v_before)<>'aba2e58e24c04bc28a94a70e74a0e3f1' OR strpos(v_before,v_old)=0
    OR strpos(v_before,'fn_diamond_bonus_share_to_feed')>0
    OR has_function_privilege('anon','public.fn_diamond_bonus_share_to_feed(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'Replay wallet authority changed; review the exact guard extension';
 END IF;
 EXECUTE replace(v_before,v_old,v_new);
 SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_after;
 IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_before THEN
  RAISE EXCEPTION 'Unrelated profile guard text changed';
 END IF;
 IF 'fn_guard_profile_privileged_columns'=ANY(public.fn_ca_guard_watchlist()) THEN
  PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',
    'migration 20260919143005_diamond_bonus_replay_and_daily_spin_custody');
 END IF;
END $guard$;

COMMIT;
