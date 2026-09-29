-- The Diamond Wheel v4: a different prize every time, a VIP never wins an item,
-- Diamonds deals three cards, and a run accumulates its prizes.
--
-- Owner rulings of 2026-09-21 (Dan): R2, R12, R13, R15 and the server half of
-- R18, as written down in the wheel v4 contract. The owner chose "Hold 80%
-- payback" when told the new 50/30/20 mix could not keep 80% at today's prize
-- values, so the item prizes drop from half an entry to a quarter and the
-- instant-chip ladder is re-solved. Every number below is derived and PROVED by
-- scripts/diamond-spins/wheel-v4-follow-matrix.py; nothing here was retyped.
--
--   R13  a bonus game 50% of the time, an instant chip win 30%, a throwable /
--        time bank / rabbit hunt 20%, and the payback still exactly 0.8:
--        sum(W*value)/100000 = (38240+29600+5000+2200+480+480+4000)/100000.
--   R2   an active or lifetime VIP never wins a throwable, a time bank or a
--        rabbit hunt. Those three cards become instant chip wins of exactly
--        equal value (0.2x, 0.25x, 0.3x), decided server side at spin time, so
--        the owner's economics do not move: .2*6667+.25*6666+.3*6667 = 5000.
--   R12  back-to-back spins can never repeat a prize, or a game across the
--        Upgrade tiers. The spin after ord i draws from ROW i of a SYMMETRIC
--        follow-up matrix whose rows sum to the base weights. Symmetry is what
--        makes the base law stationary, so every spin's unconditional law is
--        still W: the mix stays exactly 50/30/20 and the payback exactly 0.8,
--        and no conditional expectation ever reaches the entry (max 0.8621).
--   R15  "Diamonds" stops paying half an entry and deals three cards worth
--        0.5x, 2x and 3x of what was risked, sealed at spin time, revealed on
--        the pick. Expected value 11/6 of the risk whichever card is chosen.
--   R18  a run of 5, 10 or 25 spins is the server's: bonus games and card picks
--        won INSIDE it pile up unplayed until the end, awards from before it
--        still block, and the spin after the last one is refused.
--
-- MONEY. A card can now pay three times the entry where v3 only ever paid half,
-- so every gate that carried the literal .5 becomes a 3x gate AND every unpicked
-- card holds 3x of its own risk against the owner's custody and the wheel's
-- diamond float until it is picked. That reservation is why wheel_pools'
-- diamond_float >= 0 CHECK still holds untouched: nothing can be drawn that was
-- not reserved before the seed was read. Items cost a quarter of an entry now.
--
-- IN FLIGHT. Old receipts keep their own rules: contract_version 4 and the new
-- HMAC domains ('wheel-v4', 'wheel-v4-upgrade', 'wheel-v4-cards') make no v3
-- vector reusable, fn_wheel_v3_model and fn_wheel_v3_segments stay installed so
-- every stored v3 receipt still verifies, and an award or round already won is
-- played out under the contract it was won under.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';

-- ── 0. the preimages this migration was written against ──────────────────────
-- fn_wheel_spin_v2 and fn_wheel_state_v2 have been PATCHED IN PLACE since
-- 2026-09-17, so their installed bodies are not any one migration's text. The
-- replacements below were written against exactly these bodies; refuse loudly
-- rather than silently drop somebody else's patch.
DO $preimage$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','cb2a22529dd1eeab1451d6e451747c58'),
  ('fn_wheel_state_v2(uuid,integer)','de082e828ec12e437b23a3a1ffbc2ecd'),
  ('fn_wheel_v3_model()','4c0051d37d34e25578a831f4a8c77fbc'),
  ('fn_wheel_v3_segments(integer,integer,boolean)','cb29312e8cbe4815526d70b5cf778470'),
  ('fn_wheel_v3_upgrade_model()','c354f62ec226e8b292d5b3ed56809068'),
  ('fn_wheel_spin_result(wheel_spins)','2d78f1d3913bef3a88f6170aa35569e1'),
  ('fn_wheel_bonus_public_award(wheel_bonus_awards,boolean)','05c398390da8bf8c5d84b7c6549cf83b')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'Diamond Wheel v4 preimage changed: % (md5 %)',expected.signature,
    md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature)));
  END IF;
 END LOOP;
 -- THE PROFILE GUARD HAS TWO KNOWN GOOD STATES, and this migration is correct on
 -- both. 20260919223115 (the transfer door is named) adds one line to the same
 -- list, at a different anchor: before it the body is 43896e9a..., after it
 -- 69f462d0.... The card prize's own extension below is anchored on the
 -- fn_wheel_spin_v2 line, which both states carry exactly once, so the two
 -- patches compose in either order. Anything else is refused.
 IF md5(pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure))
    NOT IN('43896e9aebd9df49151a0e92799f9598','69f462d0546c30d62393b24fa6de58b5') THEN
  RAISE EXCEPTION 'Diamond Wheel v4 preimage changed: fn_guard_profile_privileged_columns (md5 %)',
   md5(pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure));
 END IF;
END $preimage$;

-- ── 1. THE VIP QUESTION, ASKED IN ONE PLACE ──────────────────────────────────
-- The canonical expression was inlined in a dozen migrations. R2 gives it a
-- name, and the wheel is the only caller that may not get it wrong: a VIP who
-- draws a throwable has been handed something they already have for nothing.
CREATE FUNCTION public.fn_wheel_is_vip(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT COALESCE(p.is_vip,false)
    AND (p.vip_tier='lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at>now())
   FROM public.profiles p WHERE p.id=p_user
$$;
COMMENT ON FUNCTION public.fn_wheel_is_vip(uuid) IS
 'An active VIP card holder or a lifetime VIP (owner ruling 2026-09-21, R2). There is no such thing as Platinum VIP.';
REVOKE ALL ON FUNCTION public.fn_wheel_is_vip(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_is_vip(uuid) TO authenticated,service_role;

-- ── 2. THE MODEL (R13, R2) ───────────────────────────────────────────────────
-- Same twelve ords, same order, same labels. `value_sixths` is what one unit of
-- entry is worth on that segment, in sixths, because the three-card game is
-- worth 11/6 and no exact decimal carries a third. sum(weight*value_sixths) is
-- 480000 for the standard table and for the VIP table, which is 0.8 exactly.
CREATE FUNCTION public.fn_wheel_v4_model(p_vip boolean DEFAULT false)
RETURNS TABLE(ord smallint,label text,kind text,game text,multiplier numeric,value_sixths numeric,weight integer)
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT o::smallint,
        CASE WHEN p_vip THEN vl ELSE l END,
        CASE WHEN p_vip THEN vk ELSE k END,
        g,
        CASE WHEN p_vip THEN vm ELSE m END,
        CASE WHEN p_vip THEN vs ELSE s END,
        w
   FROM (VALUES
 (1,'Diamond Plinko','bonus','plinko',1,4.8,'Diamond Plinko','bonus',1,4.8,11950),
 (2,'1x Chips','chips',NULL,1,6,'1x Chips','chips',1,6,29600),
 (3,'Throwables','throwables',NULL,0.25,1.5,'0.2x Chips','chips',0.2,1.2,6667),
 (4,'Diamond Crash','bonus','crash',1,4.8,'Diamond Crash','bonus',1,4.8,11950),
 (5,'Diamonds','diamonds',NULL,1,11,'Diamonds','diamonds',1,11,1200),
 (6,'Time Bank','time_bank',NULL,0.25,1.5,'0.25x Chips','chips',0.25,1.5,6666),
 (7,'Donkey Cross','bonus','crossing',1,4.8,'Donkey Cross','bonus',1,4.8,11950),
 (8,'2x Chips','chips',NULL,2,12,'2x Chips','chips',2,12,240),
 (9,'Rabbit Hunt','rabbit_hunt',NULL,0.25,1.5,'0.3x Chips','chips',0.3,1.8,6667),
 (10,'Diamond Mines','bonus','mines',1,4.8,'Diamond Mines','bonus',1,4.8,11950),
 (11,'3x Chips','chips',NULL,3,18,'3x Chips','chips',3,18,160),
 (12,'Upgrade','upgrade',NULL,2,24,'Upgrade','upgrade',2,24,1000)
 ) x(o,l,k,g,m,s,vl,vk,vm,vs,w)
$$;
COMMENT ON FUNCTION public.fn_wheel_v4_model(boolean) IS
 'The Diamond Wheel v4 prize table, standard or VIP. Generated by scripts/diamond-spins/wheel-v4-follow-matrix.py (owner ruling 2026-09-21, R13 and R2).';
REVOKE ALL ON FUNCTION public.fn_wheel_v4_model(boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_v4_model(boolean) TO authenticated,service_role;

-- ── 3. THE FOLLOW-UP MATRIX (R12) ────────────────────────────────────────────
-- Row i is the law used by the spin AFTER ord i. Symmetric, zero on the
-- diagonal, and every row sums to that ord's own base weight, which is exactly
-- what makes the base law stationary.
CREATE FUNCTION public.fn_wheel_v4_follow_model()
RETURNS TABLE(prev_ord smallint,ord smallint,weight integer)
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT r.p::smallint,c.ord::smallint,(ARRAY[r.w1,r.w2,r.w3,r.w4,r.w5,r.w6,r.w7,r.w8,r.w9,r.w10,r.w11,r.w12])[c.ord]
   FROM (VALUES
 (1,0,5121,754,1429,129,754,1429,26,754,1429,17,108),
 (2,5121,0,2706,5121,464,2704,5121,90,2706,5121,61,385),
 (3,754,2706,0,754,69,398,754,14,398,754,9,57),
 (4,1429,5121,754,0,129,754,1429,26,754,1429,17,108),
 (5,129,464,69,129,0,69,129,2,68,129,2,10),
 (6,754,2704,398,754,69,0,754,14,399,754,9,57),
 (7,1429,5121,754,1429,129,754,0,26,754,1429,17,108),
 (8,26,90,14,26,2,14,26,0,14,26,1,1),
 (9,754,2706,398,754,68,399,754,14,0,754,9,57),
 (10,1429,5121,754,1429,129,754,1429,26,754,0,17,108),
 (11,17,61,9,17,2,9,17,1,9,17,0,1),
 (12,108,385,57,108,10,57,108,1,57,108,1,0)
 ) r(p,w1,w2,w3,w4,w5,w6,w7,w8,w9,w10,w11,w12), generate_series(1,12) c(ord)
$$;
COMMENT ON FUNCTION public.fn_wheel_v4_follow_model() IS
 'The symmetric follow-up matrix: after ord i the wheel draws from row i, so no prize ever repeats (owner ruling 2026-09-21, R12). Generated and proved by scripts/diamond-spins/wheel-v4-follow-matrix.py.';
REVOKE ALL ON FUNCTION public.fn_wheel_v4_follow_model() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_v4_follow_model() TO authenticated,service_role;

-- The main wheel's twelve weights. A first spin ever uses the base law. After
-- an Upgrade that landed Super g the ordinary g is dropped too and its weight
-- is shared by the other three ordinary games, which moves nothing at all in
-- value terms because every ordinary game is worth the same 0.8 of the entry.
CREATE FUNCTION public.fn_wheel_v4_weights(p_prev_ord smallint,p_prev_super_game text DEFAULT NULL)
RETURNS integer[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $weights$
DECLARE w integer[]; hit integer; share integer; rest integer; others integer[]; i integer;
BEGIN
 IF p_prev_ord IS NULL THEN
  SELECT array_agg(weight ORDER BY ord) INTO w FROM public.fn_wheel_v4_model();
  RETURN w;
 END IF;
 IF p_prev_ord NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'The Previous Wheel Outcome Is Invalid'; END IF;
 SELECT array_agg(f.weight ORDER BY f.ord) INTO w FROM public.fn_wheel_v4_follow_model() f WHERE f.prev_ord=p_prev_ord;
 IF p_prev_super_game IS NULL THEN RETURN w; END IF;
 SELECT m.ord INTO hit FROM public.fn_wheel_v4_model() m WHERE m.game=p_prev_super_game;
 IF hit IS NULL THEN RAISE EXCEPTION 'The Previous Super Game Is Invalid'; END IF;
 SELECT array_agg(m.ord ORDER BY m.ord) INTO others FROM public.fn_wheel_v4_model() m WHERE m.kind='bonus' AND m.ord<>hit;
 share:=w[hit]/3; rest:=w[hit]%3; w[hit]:=0;
 FOR i IN 1..array_length(others,1) LOOP
  w[others[i]]:=w[others[i]]+share+CASE WHEN i<=rest THEN 1 ELSE 0 END;
 END LOOP;
 RETURN w;
END $weights$;
REVOKE ALL ON FUNCTION public.fn_wheel_v4_weights(smallint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_v4_weights(smallint,text) TO authenticated,service_role;

-- The Upgrade wheel's eight weights. After an ORDINARY game g, Super g is out
-- and its 20000 is shared by the other three Super games: +6667, +6667, +6666
-- in ord order. Equal value again, so the Upgrade wheel is still worth four
-- entries. Consecutive Upgrades cannot happen at all, because the matrix's
-- twelfth diagonal cell is zero.
CREATE FUNCTION public.fn_wheel_v4_upgrade_weights(p_prev_game text DEFAULT NULL)
RETURNS integer[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $upgrade$
DECLARE w integer[]; hit integer; share integer; rest integer; others integer[]; i integer;
BEGIN
 SELECT array_agg(weight ORDER BY ord) INTO w FROM public.fn_wheel_v3_upgrade_model();
 IF p_prev_game IS NULL THEN RETURN w; END IF;
 SELECT u.ord INTO hit FROM public.fn_wheel_v3_upgrade_model() u WHERE u.game=p_prev_game;
 IF hit IS NULL THEN RAISE EXCEPTION 'The Previous Game Is Invalid'; END IF;
 SELECT array_agg(u.ord ORDER BY u.ord) INTO others FROM public.fn_wheel_v3_upgrade_model() u WHERE u.kind='bonus' AND u.ord<>hit;
 share:=w[hit]/3; rest:=w[hit]%3; w[hit]:=0;
 FOR i IN 1..array_length(others,1) LOOP
  w[others[i]]:=w[others[i]]+share+CASE WHEN i<=rest THEN 1 ELSE 0 END;
 END LOOP;
 RETURN w;
END $upgrade$;
REVOKE ALL ON FUNCTION public.fn_wheel_v4_upgrade_weights(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_v4_upgrade_weights(text) TO authenticated,service_role;

-- The table the player sees. It always carries the BASE law, so the wheel art
-- and the published odds never move; which segments this one spin could
-- actually land on is stated separately, in the receipt's fairness block.
CREATE FUNCTION public.fn_wheel_v4_segments(p_entry integer,p_rate integer,p_secondary boolean DEFAULT false,p_vip boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_agg(jsonb_build_object('ord',ord,'label',label,'kind',kind,'game',game,'multiplier',multiplier,
 'amount',CASE WHEN kind='chips' THEN p_entry::numeric*multiplier/p_rate ELSE p_entry*multiplier END,
 'value_chips',p_entry::numeric*multiplier/p_rate,'weight',weight,'probability',weight/100000::numeric,'locked',false) ORDER BY ord)
 FROM (SELECT ord,label,kind,game,multiplier,weight FROM public.fn_wheel_v4_model(p_vip) WHERE NOT p_secondary
 UNION ALL SELECT ord,label,kind,game,multiplier,weight FROM public.fn_wheel_v3_upgrade_model() WHERE p_secondary) q
$$;
REVOKE ALL ON FUNCTION public.fn_wheel_v4_segments(integer,integer,boolean,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_v4_segments(integer,integer,boolean,boolean) TO authenticated,service_role;

-- ── 4. THE THREE-CARD GAME (R15) ─────────────────────────────────────────────
CREATE TABLE public.wheel_card_awards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 spin_id uuid NOT NULL UNIQUE,
 run_id uuid,
 user_id uuid NOT NULL,club_id uuid NOT NULL,host_id uuid NOT NULL,
 host_kind text NOT NULL CHECK(host_kind IN('club','union')),
 owner_id uuid NOT NULL,
 is_welcome boolean NOT NULL DEFAULT false,
 risk_diamonds integer NOT NULL CHECK(risk_diamonds BETWEEN 25 AND 2500),
 half_diamonds integer NOT NULL CHECK(half_diamonds>=0),
 permutation smallint NOT NULL CHECK(permutation BETWEEN 0 AND 5),
 roll numeric(20,0) NOT NULL CHECK(roll>=0),
 nonce bigint NOT NULL,
 server_seed text NOT NULL,server_seed_hash text NOT NULL,client_seed text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','picked')),
 picked_card smallint CHECK(picked_card BETWEEN 1 AND 3),
 paid_diamonds integer CHECK(paid_diamonds>=0),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 picked_at timestamptz,
 CHECK(half_diamonds IN (risk_diamonds/2,(risk_diamonds+1)/2)),
 CHECK((status='pending' AND picked_card IS NULL AND paid_diamonds IS NULL AND picked_at IS NULL)
    OR (status='picked' AND picked_card IS NOT NULL AND paid_diamonds IS NOT NULL AND picked_at IS NOT NULL))
);
CREATE INDEX wheel_card_awards_player ON public.wheel_card_awards(user_id,club_id,status,created_at);
CREATE INDEX wheel_card_awards_host_open ON public.wheel_card_awards(host_id) WHERE status='pending';
ALTER TABLE public.wheel_card_awards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wheel_card_awards FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.wheel_card_awards TO service_role;
COMMENT ON TABLE public.wheel_card_awards IS
 'One row per Diamonds outcome: three cards worth half, double and triple the diamonds risked, sealed at spin time and paid once on the pick (owner ruling 2026-09-21, R15).';

-- The three cards behind positions 1, 2 and 3. The permutation index runs over
-- the six orderings of (half, double, triple) in lexicographic order, so the
-- expectation is 11/6 of the risk whichever position the player chooses.
CREATE FUNCTION public.fn_wheel_card_values(p_half integer,p_risk integer,p_permutation smallint)
RETURNS integer[] LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE p_permutation
  WHEN 0 THEN ARRAY[p_half,2*p_risk,3*p_risk]
  WHEN 1 THEN ARRAY[p_half,3*p_risk,2*p_risk]
  WHEN 2 THEN ARRAY[2*p_risk,p_half,3*p_risk]
  WHEN 3 THEN ARRAY[2*p_risk,3*p_risk,p_half]
  WHEN 4 THEN ARRAY[3*p_risk,p_half,2*p_risk]
  WHEN 5 THEN ARRAY[3*p_risk,2*p_risk,p_half] END
$$;
REVOKE ALL ON FUNCTION public.fn_wheel_card_values(integer,integer,smallint) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_card_values(integer,integer,smallint) TO authenticated,service_role;

-- What the player may see BEFORE the pick: never the values.
CREATE FUNCTION public.fn_wheel_card_public(a public.wheel_card_awards) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_build_object('id',a.id,'spin_id',a.spin_id,'club_id',a.club_id,
  'risk_diamonds',a.risk_diamonds,'status',a.status,'created_at',a.created_at)
$$;
REVOKE ALL ON FUNCTION public.fn_wheel_card_public(public.wheel_card_awards) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_card_public(public.wheel_card_awards) TO authenticated,service_role;

-- ── 5. THE RUN (R18, server half) ────────────────────────────────────────────
CREATE TABLE public.wheel_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,club_id uuid NOT NULL,host_id uuid NOT NULL,
 spins integer NOT NULL CHECK(spins IN(5,10,25)),
 spins_done integer NOT NULL DEFAULT 0 CHECK(spins_done>=0),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 closed_at timestamptz,
 CHECK(spins_done<=spins),
 CHECK((status='open' AND closed_at IS NULL) OR (status='closed' AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX wheel_runs_one_open_per_player ON public.wheel_runs(user_id) WHERE status='open';
CREATE INDEX wheel_runs_player ON public.wheel_runs(user_id,created_at DESC);
ALTER TABLE public.wheel_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wheel_runs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.wheel_runs TO service_role;
COMMENT ON TABLE public.wheel_runs IS
 'A run of 5, 10 or 25 spins the player declared. Prizes won inside it may stay unplayed until it ends; prizes won before it still block (owner ruling 2026-09-21, R18).';

ALTER TABLE public.wheel_bonus_awards ADD COLUMN run_id uuid;
COMMENT ON COLUMN public.wheel_bonus_awards.run_id IS
 'The open run this award was won inside, or NULL for a single spin. An award from before the run still blocks the next spin.';

CREATE FUNCTION public.fn_wheel_open_run(p_user uuid,p_club_id uuid) RETURNS public.wheel_runs
LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT r.* FROM public.wheel_runs r WHERE r.user_id=p_user AND r.club_id=p_club_id AND r.status='open'
$$;
REVOKE ALL ON FUNCTION public.fn_wheel_open_run(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_open_run(uuid,uuid) TO authenticated,service_role;

CREATE FUNCTION public.fn_wheel_run_begin(p_club_id uuid,p_spins integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $run_begin$
DECLARE v_user uuid:=auth.uid(); v_host uuid; v_run public.wheel_runs;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_spins IS NULL OR p_spins NOT IN(5,10,25) THEN
  RETURN jsonb_build_object('ok',false,'error','Choose 5, 10 Or 25 Spins'); END IF;
 SELECT h.host_id INTO v_host FROM public.fn_wheel_host(p_club_id) h;
 IF v_host IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Club Could Not Be Found'); END IF;
 IF NOT public.fn_wheel_v2_enabled() THEN
  RETURN jsonb_build_object('ok',false,'error','The New Wheel Is Not Open Yet'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text,94615));
 SELECT * INTO v_run FROM public.wheel_runs WHERE user_id=v_user AND status='open' FOR UPDATE;
 IF v_run.id IS NOT NULL THEN
  IF v_run.club_id IS DISTINCT FROM p_club_id OR v_run.spins IS DISTINCT FROM p_spins THEN
   RETURN jsonb_build_object('ok',false,'error','Finish The Run You Already Started'); END IF;
  RETURN jsonb_build_object('ok',true,'run_id',v_run.id,'spins',v_run.spins,'spins_done',v_run.spins_done);
 END IF;
 INSERT INTO public.wheel_runs(user_id,club_id,host_id,spins) VALUES(v_user,p_club_id,v_host,p_spins)
  RETURNING * INTO v_run;
 RETURN jsonb_build_object('ok',true,'run_id',v_run.id,'spins',v_run.spins,'spins_done',v_run.spins_done);
END $run_begin$;
REVOKE ALL ON FUNCTION public.fn_wheel_run_begin(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_run_begin(uuid,integer) TO authenticated,service_role;

CREATE FUNCTION public.fn_wheel_run_end(p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $run_end$
DECLARE v_user uuid:=auth.uid(); v_run public.wheel_runs; v_awards jsonb; v_cards jsonb;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_run_id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Run Could Not Be Found'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text,94615));
 SELECT * INTO v_run FROM public.wheel_runs WHERE id=p_run_id FOR UPDATE;
 IF v_run.id IS NULL OR v_run.user_id IS DISTINCT FROM v_user THEN
  RETURN jsonb_build_object('ok',false,'error','That Run Belongs To Another Player'); END IF;
 IF v_run.status='open' THEN
  UPDATE public.wheel_runs SET status='closed',closed_at=transaction_timestamp() WHERE id=p_run_id
   RETURNING * INTO v_run;
 END IF;
 SELECT COALESCE(jsonb_agg(public.fn_wheel_bonus_public_award(a,false) ORDER BY a.created_at),'[]')
   INTO v_awards FROM public.wheel_bonus_awards a
  WHERE a.user_id=v_user AND a.club_id=v_run.club_id AND public.fn_wheel_bonus_unfinished(a);
 SELECT COALESCE(jsonb_agg(public.fn_wheel_card_public(c) ORDER BY c.created_at),'[]')
   INTO v_cards FROM public.wheel_card_awards c
  WHERE c.user_id=v_user AND c.club_id=v_run.club_id AND c.status='pending';
 RETURN jsonb_build_object('ok',true,'run_id',v_run.id,'spins',v_run.spins,'spins_done',v_run.spins_done,
  'pending_awards',v_awards,'pending_cards',v_cards);
END $run_end$;
REVOKE ALL ON FUNCTION public.fn_wheel_run_end(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_run_end(uuid) TO authenticated,service_role;

-- ── 6. THE PICK (R15) ────────────────────────────────────────────────────────
-- Nothing was paid at the spin. This pays exactly one card, once, out of the
-- owner's daily custody, and reveals all three. Picking again returns the same
-- receipt and moves no money.
CREATE FUNCTION public.fn_wheel_diamond_cards_pick(p_award_id uuid,p_card smallint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $cards$
DECLARE v_user uuid:=auth.uid(); a public.wheel_card_awards; v_values integer[]; v_paid integer;
 v_credit jsonb; v_after numeric; v_rate integer:=public.fn_ca_bridge_rate();
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_award_id IS NULL OR p_card IS NULL OR p_card NOT BETWEEN 1 AND 3 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose Card One, Two Or Three'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_award_id::text,94617));
 SELECT * INTO a FROM public.wheel_card_awards WHERE id=p_award_id FOR UPDATE;
 IF a.id IS NULL OR a.user_id IS DISTINCT FROM v_user THEN
  RETURN jsonb_build_object('ok',false,'error','That Card Game Belongs To Another Player'); END IF;
 v_values:=public.fn_wheel_card_values(a.half_diamonds,a.risk_diamonds,a.permutation);
 IF a.status='picked' THEN
  SELECT COALESCE(p.diamonds,0) INTO v_after FROM public.profiles p WHERE p.id=v_user;
  RETURN jsonb_build_object('ok',true,'replayed',true,'award_id',a.id,'spin_id',a.spin_id,
   'picked',a.picked_card,'cards',to_jsonb(v_values),'paid_diamonds',a.paid_diamonds,
   'risk_diamonds',a.risk_diamonds,'balances',jsonb_build_object('diamonds',v_after),
   'fairness',jsonb_build_object('domain','wheel-v4-cards','roll',a.roll,'permutation',a.permutation,
    'server_seed',a.server_seed,'server_seed_hash',a.server_seed_hash,'client_seed',a.client_seed,'nonce',a.nonce));
 END IF;
 IF public.fn_platform_frozen() THEN
  RETURN jsonb_build_object('ok',false,'error','The Platform Is In Its Maintenance Break. Pick Again In A Few Minutes'); END IF;
 IF EXISTS(SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope='wheel' AND f.cleared_at IS NULL) THEN
  RETURN jsonb_build_object('ok',false,'error','The Diamond Wheel Is Paused'); END IF;
 v_paid:=v_values[p_card];
 -- Same lock order as the spin: both wallets by id, then the pool.
 PERFORM 1 FROM public.profiles WHERE id IN(a.owner_id,v_user) ORDER BY id FOR UPDATE;
 UPDATE public.wheel_card_awards SET status='picked',picked_card=p_card,paid_diamonds=v_paid,
   picked_at=transaction_timestamp() WHERE id=a.id RETURNING * INTO a;
 IF v_paid>0 THEN
  PERFORM public.fn_diamond_spin_book(a.owner_id,a.club_id,a.host_id,a.host_kind,v_user,'diamond_prize',-v_paid,
   'wheel-cards:'||a.id||':custody','Diamond Spins: Diamonds Cards');
  v_credit:=public.add_diamonds_to_balance(v_user,v_paid,'transfer','Diamond Spins: Diamonds',
   'wheel-cards:'||a.id,a.owner_id);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE THEN
   RAISE EXCEPTION 'The Diamond Card Prize Credit Failed: %',v_credit->>'error'; END IF;
  IF NOT a.is_welcome THEN
   UPDATE public.wheel_pools SET diamond_float=diamond_float-v_paid,diamonds_paid=diamonds_paid+v_paid,
     updated_at=now() WHERE host_id=a.host_id;
  END IF;
 END IF;
 SELECT COALESCE(p.diamonds,0) INTO v_after FROM public.profiles p WHERE p.id=v_user;
 RETURN jsonb_build_object('ok',true,'replayed',false,'award_id',a.id,'spin_id',a.spin_id,
  'picked',a.picked_card,'cards',to_jsonb(v_values),'paid_diamonds',v_paid,
  'risk_diamonds',a.risk_diamonds,'value_chips',v_paid::numeric/v_rate,
  'balances',jsonb_build_object('diamonds',v_after),
  'fairness',jsonb_build_object('domain','wheel-v4-cards','roll',a.roll,'permutation',a.permutation,
   'server_seed',a.server_seed,'server_seed_hash',a.server_seed_hash,'client_seed',a.client_seed,'nonce',a.nonce));
END $cards$;
REVOKE ALL ON FUNCTION public.fn_wheel_diamond_cards_pick(uuid,smallint) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_diamond_cards_pick(uuid,smallint) TO authenticated,service_role;

-- The card prize uses the same private ledger writer the spin does, so the
-- profile guard has to name it as well or the credit raises 42501 and rolls the
-- whole pick back. Only the reviewed caller is added; every other word of the
-- guard, and its rejection of direct writes, is preserved and checked.
DO $guard$
DECLARE v_before text;v_after text;
 v_old constant text := $old$     OR v_stack ~ 'function (public[.])?fn_wheel_spin_v2[(]'$old$;
 v_new constant text := $new$     OR v_stack ~ 'function (public[.])?fn_wheel_spin_v2[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_diamond_cards_pick[(]'$new$;
BEGIN
 SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_before;
 IF strpos(v_before,v_old)=0 OR strpos(v_before,'fn_wheel_diamond_cards_pick')>0
    OR has_function_privilege('anon','public.fn_wheel_diamond_cards_pick(uuid,smallint)','EXECUTE')
    OR has_function_privilege('authenticated','public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'Wheel wallet authority changed; review before extending the profile guard'; END IF;
 EXECUTE replace(v_before,v_old,v_new);
 SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_after;
 IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_before THEN
  RAISE EXCEPTION 'Unrelated profile guard text changed'; END IF;
 IF 'fn_guard_profile_privileged_columns'=ANY(public.fn_ca_guard_watchlist()) THEN
  PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',
   'migration 20260922194123_diamond_wheel_v4_draws_a_different_prize_every_time_and_diam');
 END IF;
END $guard$;

-- ── 7. THE RELEASE ROW SPEAKS v4 ─────────────────────────────────────────────
ALTER TABLE public.diamond_wheel_release DROP CONSTRAINT diamond_wheel_release_contract_version_check;
UPDATE public.diamond_wheel_release SET contract_version=4 WHERE singleton;
ALTER TABLE public.diamond_wheel_release ADD CONSTRAINT diamond_wheel_release_contract_version_check CHECK(contract_version=4);

-- ── 8. THE SPIN ITSELF ───────────────────────────────────────────────────────
-- Written against the md5 pinned at the top of this file. What moved: the
-- model, the VIP table, the follow-up law, the three-card game, the run, and
-- every gate that carried the old half-entry diamond prize.
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_v2(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_entry_diamonds integer, p_mode text DEFAULT 'paid'::text, p_bonus_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  p_welcome boolean:=p_mode='welcome';
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_bank numeric; v_bank_after numeric;
  v_promo numeric; v_bank_only numeric; v_pay record;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
  v_ticket public.diamond_bonus_spin_tickets;
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
  v_gcfg public.diamond_game_configs; v_gpool public.diamond_game_pools; v_caps jsonb:='{}';
  v_boost integer; v_budget integer; v_cap integer; v_hold numeric; v_reserved numeric;
  v_game text; v_award public.wheel_bonus_awards; v_secondary jsonb; v_secondary_segments jsonb; v_segments jsonb;
  v_second_hmac bytea; v_second_roll numeric; v_second_ord integer; v_outcome jsonb;
  v_second_point numeric; v_second_acc integer:=0; v_second_outcome jsonb;
  v_prize_multiplier numeric; v_prize_label text;
  v_feature text; v_cost integer:=0; v_unit integer; v_uses integer; v_remainder integer; v_grants jsonb:='[]';
  -- v4 (owner ruling 2026-09-21, R2/R12/R13/R15/R18).
  v_vip boolean := false;
  v_prev_spin uuid; v_prev_ord smallint; v_prev_super_game text; v_prev_game text; v_previous jsonb;
  v_weights integer[]; v_up_weights integer[]; v_second_total integer:=0; v_second_eligible jsonb:='[]';
  v_run public.wheel_runs; v_run_holds boolean:=false; v_cover_refusal text;
  v_card public.wheel_card_awards; v_card_hold numeric:=0; v_card_hold_float numeric:=0;
  v_card_hmac bytea; v_card_roll numeric; v_perm smallint; v_half integer;

BEGIN
  IF p_mode IS NULL OR p_mode NOT IN('paid','welcome','daily') OR p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500
   OR (p_mode<>'paid' AND p_entry_diamonds<>100) OR (p_mode='daily')<>(p_bonus_ticket_id IS NOT NULL)
   OR p_commit_id IS NULL OR p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 OR p_client_seed<>btrim(p_client_seed) THEN
   RETURN jsonb_build_object('ok',false,'error','Choose A Valid Diamond Spins Entry'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613));
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.club_id IS DISTINCT FROM p_club_id OR prior.client_seed IS DISTINCT FROM v_client
       OR prior.is_welcome IS DISTINCT FROM p_welcome OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',false,'error','The New Wheel Is Not Open Yet'); END IF;
  -- Receipt replay above remains possible. Serialize new entries across tabs.
  -- The club lock orders entries at this club; the player lock orders the read
  -- of their previous outcome, which is what the follow-up law is stated on and
  -- which a second club's spin would otherwise be able to read at the same time.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text||':'||p_club_id::text,94614));
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text,94615));
  -- A RUN IS THE ONLY REASON A WON PRIZE MAY WAIT (owner ruling 2026-09-21, R18).
  -- Awards and card games won INSIDE the open run pile up; anything won before
  -- it still has to be played first, exactly as it did before runs existed.
  SELECT * INTO v_run FROM public.wheel_runs WHERE user_id=v_user AND club_id=p_club_id AND status='open' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.wheel_bonus_awards unfinished_award WHERE unfinished_award.user_id=v_user AND unfinished_award.club_id=p_club_id AND public.fn_wheel_bonus_unfinished(unfinished_award)
            AND (v_run.id IS NULL OR unfinished_award.run_id IS DISTINCT FROM v_run.id)) THEN
    RETURN jsonb_build_object('ok',false,'error','Finish Your Bonus Game Before Another Spin');
  END IF;
  IF EXISTS(SELECT 1 FROM public.wheel_card_awards open_card WHERE open_card.user_id=v_user AND open_card.club_id=p_club_id AND open_card.status='pending'
            AND (v_run.id IS NULL OR open_card.run_id IS DISTINCT FROM v_run.id)) THEN
    RETURN jsonb_build_object('ok',false,'error','Pick Your Diamond Card Before Another Spin');
  END IF;
  IF v_run.id IS NOT NULL THEN
    IF v_run.spins_done>=v_run.spins THEN
      RETURN jsonb_build_object('ok',false,'error','This Run Is Finished. Play The Prizes You Won');
    END IF;
    SELECT EXISTS(SELECT 1 FROM public.wheel_bonus_awards ra WHERE ra.run_id=v_run.id AND public.fn_wheel_bonus_unfinished(ra))
        OR EXISTS(SELECT 1 FROM public.wheel_card_awards rc WHERE rc.run_id=v_run.id AND rc.status='pending') INTO v_run_holds;
  END IF;
  v_cover_refusal:=CASE WHEN v_run_holds THEN 'Play Your Bonus Games To Free The Club''s Prize Cover'
                        ELSE 'The Host Must Fund Every Prize Before A Spin' END;

  IF p_bonus_ticket_id IS NOT NULL THEN
    IF p_welcome THEN RETURN jsonb_build_object('ok',false,'error','Choose One Free Spin Reward'); END IF;
    SELECT * INTO v_ticket FROM public.diamond_bonus_spin_tickets WHERE id=p_bonus_ticket_id FOR UPDATE;
    IF v_ticket.id IS NULL OR v_ticket.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok',false,'error','Claim This Bonus Spin In Daily Bonus First');
    END IF;
    IF v_ticket.redeemed_spin_id IS NOT NULL THEN
      SELECT * INTO prior FROM public.wheel_spins WHERE id=v_ticket.redeemed_spin_id;
      IF prior.user_id=v_user AND prior.club_id=p_club_id AND prior.commit_id=p_commit_id
         AND prior.client_seed=v_client AND prior.bonus_ticket_id=p_bonus_ticket_id AND NOT prior.is_welcome THEN
        RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
      END IF;
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
    IF v_ticket.funded_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
  END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    -- Match the canonical Mint's lock order before taking host/owner rows.
    PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id=p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.user_id IS DISTINCT FROM v_user OR prior.club_id IS DISTINCT FROM p_club_id
       OR prior.client_seed IS DISTINCT FROM v_client OR prior.is_welcome IS DISTINCT FROM p_welcome
       OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
  END IF;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  -- WHO IS SPINNING DECIDES WHICH TABLE THEY SEE (owner ruling 2026-09-21, R2).
  -- A VIP already owns unlimited or allowanced throwables, time banks and rabbit
  -- hunts, so those three cards are instant chip wins of equal value for them.
  v_vip:=public.fn_wheel_is_vip(v_user);
  IF (SELECT sum(weight) FROM public.fn_wheel_v4_model(v_vip))<>100000 OR (SELECT count(*) FROM public.fn_wheel_v4_model(v_vip))<>12
   OR (SELECT sum(weight*value_sixths) FROM public.fn_wheel_v4_model(v_vip))<>480000
   OR (v_vip AND EXISTS(SELECT 1 FROM public.fn_wheel_v4_model(true) WHERE kind IN('throwables','time_bank','rabbit_hunt'))) THEN
   RAISE EXCEPTION 'The Wheel Model Is Invalid'; END IF;
  v_mult:=1; v_price:=p_entry_diamonds;
  v_segments:=public.fn_wheel_v4_segments(v_price,v_rate,false,v_vip);
  v_intake := v_price::numeric / v_rate;
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price
  -- is taken in by the host's owner, and the prize is paid out of what the host
  -- holds. The chip side is bounded by the chips this wheel has taken in (this
  -- spin included) plus the host's allowance; the diamond side by the diamonds
  -- it has taken in plus the seed the host put up. Both are "never more than
  -- taken in", stated on the money that actually moved.
  -- A WELCOME SPIN TAKES NOTHING IN (Dan 2026-09-10: the owner "simply receives
  -- no diamonds"). So it adds nothing to the float and nothing to the intake the
  -- paid game's invariant is stated on; its payout is charged to the welcome
  -- budget instead, a few lines below.
  v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;
  v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;

  IF NOT public.fn_diamond_spins_owner_agreed(v_host,v_kind) THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'); END IF;
  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;

  -- ── the welcome spin: once per member, ever, and only out of a real budget ─
  IF p_welcome THEN
    IF NOT cfg.welcome_spin_enabled THEN
      RETURN jsonb_build_object('ok', false, 'error', 'There Is No Welcome Spin Here');
    END IF;
    IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spin Is Not Funded Here Yet');
    END IF;
    IF v_user = v_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Welcome Spin');
    END IF;
    -- The unique index is what actually enforces this; the check is here to
    -- answer the player in words rather than with a constraint violation.
    IF EXISTS (SELECT 1 FROM public.wheel_spins s
                WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You Have Already Taken Your Welcome Spin Here');
    END IF;
    -- A WELCOME SPIN IS THE WHOLE WHEEL OR IT IS NOT OFFERED (2026-09-11).
    -- One helper answers the budget question for the door, the page and the
    -- entry read, so a player is never told "Welcome Spin Ready" and refused.
    v_welcome_spent:=public.fn_wheel_v2_welcome_spent(v_host);
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF NOT p_welcome AND p_bonus_ticket_id IS NULL AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  -- Take game configuration and pools before the shared host wallet, matching game entry.
  PERFORM 1 FROM public.diamond_game_configs WHERE host_id=v_host ORDER BY game FOR UPDATE;
  PERFORM 1 FROM public.diamond_game_pools WHERE host_id=v_host ORDER BY game FOR UPDATE;
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  PERFORM 1 FROM public.profiles WHERE id IN(v_owner,v_user) ORDER BY id FOR UPDATE;
  SELECT public.fn_diamond_spin_available(v_owner) INTO v_owner_dia;

  SELECT COALESCE(sum(reserved_chips),0) INTO v_reserved FROM public.diamond_game_pools WHERE host_id=v_host;
  -- EVERY UNPICKED CARD GAME IS ALREADY SPOKEN FOR (owner ruling 2026-09-21,
  -- R15). Its triple is held against both the owner's custody and this wheel's
  -- diamond float until the player picks, which is why a three-times prize can
  -- never drive the float below zero.
  SELECT COALESCE(sum(3*c.risk_diamonds),0),
         COALESCE(sum(CASE WHEN c.is_welcome THEN 0 ELSE 3*c.risk_diamonds END),0)
    INTO v_card_hold,v_card_hold_float
    FROM public.wheel_card_awards c WHERE c.host_id=v_host AND c.status='pending';
  IF v_bank-v_reserved < ceil(v_price::numeric/v_rate*100*100)/100
   OR v_owner_dia+v_dia_now-v_card_hold<3*v_price
   OR (NOT p_welcome AND pool.diamond_float+v_dia_now-v_card_hold_float<3*v_price) THEN
   RETURN jsonb_build_object('ok',false,'error',v_cover_refusal); END IF;
  IF p_welcome AND cfg.welcome_budget_chips-v_welcome_spent<100*v_price::numeric/v_rate THEN
   RETURN jsonb_build_object('ok',false,'error','The Welcome Spins Here Are Gone For Now'); END IF;
  -- Fixed odds require the entire 100x secondary prize to fit the configured
  -- exposure policy before reading the seed. Never silently remove a prize.
  IF NOT p_welcome AND pool.chips_paid+ceil(100*v_price::numeric/v_rate*100)/100>v_intake_chips+cfg.exposure_allowance_chips THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Prize Before A Spin'); END IF;
  IF (SELECT count(*) FROM public.fn_wheel_v3_upgrade_model())<>8 OR (SELECT sum(weight) FROM public.fn_wheel_v3_upgrade_model())<>100000 THEN
   RAISE EXCEPTION 'The Upgrade Model Is Invalid'; END IF;
  -- Every possible game/upgrade is admitted before looking at the random seed.
  -- All game locks use the same order; one admitted outcome reserves its promise.
  FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
   SELECT * INTO v_gcfg FROM public.diamond_game_configs WHERE host_id=v_host AND game=v_game FOR UPDATE;
   IF NOT FOUND OR NOT v_gcfg.enabled OR (v_is_fixture AND NOT v_gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'error','Every Bonus Game Must Be Open Before A Spin'); END IF;
   INSERT INTO public.diamond_game_pools(host_id,game) VALUES(v_host,v_game) ON CONFLICT DO NOTHING;
   SELECT * INTO v_gpool FROM public.diamond_game_pools WHERE host_id=v_host AND game=v_game FOR UPDATE;
   FOR v_boost IN 1..2 LOOP
    v_budget:=v_price*v_boost;
    v_cap:=public.fn_diamond_game_cap_cents(v_gcfg,v_gpool,v_bank,v_budget::numeric/v_rate,v_gcfg.max_multiplier_cents);
    IF p_welcome THEN v_cap:=LEAST(v_cap,floor((cfg.welcome_budget_chips-v_welcome_spent)/(v_budget::numeric/v_rate)*100)::integer); END IF;
    -- Steady20x covers base plus one original entry:40x ordinary,30x upgraded.
    IF v_cap<2000*(v_boost+1)/v_boost THEN RETURN jsonb_build_object('ok',false,'error',
      CASE WHEN v_run_holds THEN v_cover_refusal ELSE 'The Host Must Fund Every Bonus Before A Spin' END); END IF;
    v_caps:=jsonb_set(v_caps,ARRAY[v_game||':'||v_boost],to_jsonb(v_cap));
   END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
   RETURN jsonb_build_object('ok',false,'error','An Approved Plinko Table Must Be Open Before A Spin'); END IF;
  IF NOT v_vip AND EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
    LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
    WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
   RETURN jsonb_build_object('ok',false,'error','The Reward Prices Changed. The Wheel Must Be Requalified'); END IF;
  SELECT count(*)+1 INTO v_nonce FROM public.wheel_spins WHERE user_id=v_user;
  -- NEVER THE SAME PRIZE TWICE IN A ROW (owner ruling 2026-09-21, R12). The
  -- previous FINAL outcome is this player's last spin on any host, read under
  -- the player lock taken above; the Upgrade wheel's own result is the final
  -- outcome when the main wheel landed Upgrade.
  SELECT s.id,s.outcome_ord,
         CASE WHEN s.outcome_ord=12 AND s.receipt_v2#>>'{secondary,outcome,kind}'='bonus'
              THEN s.receipt_v2#>>'{secondary,outcome,game}' END
    INTO v_prev_spin,v_prev_ord,v_prev_super_game
    FROM public.wheel_spins s WHERE s.user_id=v_user ORDER BY s.nonce DESC LIMIT 1;
  SELECT COALESCE(v_prev_super_game,m.game) INTO v_prev_game FROM public.fn_wheel_v4_model() m WHERE m.ord=v_prev_ord;
  v_prev_game:=COALESCE(v_prev_game,v_prev_super_game);
  v_weights:=public.fn_wheel_v4_weights(v_prev_ord,v_prev_super_game);
  IF (SELECT sum(w) FROM unnest(v_weights) w)<>COALESCE((SELECT weight FROM public.fn_wheel_v4_model() WHERE ord=v_prev_ord),100000) THEN
   RAISE EXCEPTION 'The Wheel Follow Law Is Invalid'; END IF;
  SELECT array_agg(i::smallint ORDER BY i) INTO v_eligible FROM generate_series(1,12) i WHERE v_weights[i]>0;
  SELECT sum(w)::integer INTO v_total FROM unnest(v_weights) w;
  v_previous:=CASE WHEN v_prev_ord IS NULL THEN 'null'::jsonb ELSE jsonb_build_object(
   'spin_id',v_prev_spin,'ord',v_prev_ord,'game',v_prev_game,
   'tier',CASE WHEN v_prev_super_game IS NOT NULL THEN 'super' ELSE 'main' END) END;
  v_hmac:=extensions.hmac(convert_to('wheel-v4:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
  v_roll:=(('x'||encode(substring(v_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
  v_point:=floor(v_roll*v_total/c_two48);
  FOR seg IN SELECT * FROM public.fn_wheel_v4_model(v_vip) ORDER BY ord LOOP
   IF v_weights[seg.ord]>0 THEN
    v_acc:=v_acc+v_weights[seg.ord];
    IF v_point<v_acc THEN v_pick:=seg;v_found:=true;EXIT;END IF;
   END IF;
  END LOOP;
  IF NOT v_found THEN RAISE EXCEPTION 'The Wheel Draw Is Invalid'; END IF;
  SELECT value INTO v_outcome FROM jsonb_array_elements(v_segments) WHERE (value->>'ord')::integer=v_pick.ord;
  IF v_pick.kind='upgrade' THEN
   v_secondary_segments:=public.fn_wheel_v4_segments(v_price,v_rate,true);
   v_up_weights:=public.fn_wheel_v4_upgrade_weights(v_prev_game);
   SELECT sum(w)::integer INTO v_second_total FROM unnest(v_up_weights) w;
   IF v_second_total<>100000 THEN RAISE EXCEPTION 'The Upgrade Follow Law Is Invalid'; END IF;
   SELECT COALESCE(jsonb_agg(i ORDER BY i),'[]') INTO v_second_eligible FROM generate_series(1,8) i WHERE v_up_weights[i]>0;
   v_second_hmac:=extensions.hmac(convert_to('wheel-v4-upgrade:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
   v_second_roll:=(('x'||encode(substring(v_second_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
   v_second_point:=floor(v_second_roll*v_second_total/c_two48);
   FOR seg IN SELECT * FROM public.fn_wheel_v3_upgrade_model() ORDER BY ord LOOP
    IF v_up_weights[seg.ord]>0 THEN
     v_second_acc:=v_second_acc+v_up_weights[seg.ord];
     IF v_second_point<v_second_acc THEN v_second_ord:=seg.ord;EXIT;END IF;
    END IF;
   END LOOP;
   IF v_second_ord IS NULL THEN RAISE EXCEPTION 'The Upgrade Draw Is Invalid'; END IF;
   v_second_outcome:=v_secondary_segments->(v_second_ord-1);
   IF v_second_outcome->>'kind'='bonus' THEN v_game:=v_second_outcome->>'game';
   ELSE v_prize_multiplier:=(v_second_outcome->>'multiplier')::numeric;v_prize_label:=v_second_outcome->>'label'; END IF;
   v_secondary:=jsonb_build_object('segments',v_secondary_segments,'outcome',v_secondary_segments->(v_second_ord-1),
    'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_second_roll,'weight_total',v_second_total,'eligible_ords',v_second_eligible,'locked','[]'::jsonb,'domain','wheel-v4-upgrade','weights',to_jsonb(v_up_weights)));
  ELSIF v_pick.kind='bonus' THEN v_game:=v_pick.game;
  ELSIF v_pick.kind='chips' THEN v_prize_multiplier:=v_pick.multiplier;v_prize_label:=v_pick.label; END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF p_bonus_ticket_id IS NOT NULL THEN
    BEGIN
      UPDATE public.diamond_bonus_spin_tickets SET club_id=p_club_id,host_id=v_host,host_kind=v_kind,
        owner_id=v_owner,commit_id=p_commit_id,client_seed=v_client,
        funded_at=transaction_timestamp(),mint_op_id='daily-bonus-spin:'||p_bonus_ticket_id::text
       WHERE id=p_bonus_ticket_id RETURNING * INTO v_ticket;
    EXCEPTION WHEN SQLSTATE 'PDS01' THEN
      RETURN jsonb_build_object('ok',false,'error',SQLERRM);
    END;
  ELSIF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.fn_diamond_spin_book(v_owner,p_club_id,v_host,v_kind,v_user,'entry',v_price,
                  'wheel:'||v_spin_id||':intake',format('Diamond Wheel Intake (%s Diamonds)',v_price));
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the spin price could not be credited to the host owner: %', v_credit->>'error';
    END IF;
    IF cfg.purchased_only THEN
      v_remaining := v_price;
      FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_user AND l.frozen_at IS NULL
                      AND (l.issued - l.consumed - l.refunded) > 0
                    ORDER BY l.created_at, l.id FOR UPDATE LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
        UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'fn_wheel_spin_core: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
      END IF;
    END IF;
  END IF;

  IF v_prize_multiplier IS NOT NULL THEN
   v_prize_chips:=public.fn_diamond_round_chip_cents(v_price::numeric*v_prize_multiplier/v_rate,cm.server_seed,'wheel-v4-rounding:'||v_client||':'||v_nonce);
   v_value_chips:=v_prize_chips;
   SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips('wheel_prize',v_host,v_kind,p_club_id,v_user,v_prize_chips,
    'wheel-prize:'||v_spin_id,'Diamond Spins: '||v_prize_label,jsonb_build_object('spin_id',v_spin_id,'host_id',v_host,'host_kind',v_kind,'welcome',p_welcome,'bonus_ticket_id',p_bonus_ticket_id,'contract_version',4,'vip',v_vip,'multiplier',v_prize_multiplier,'secondary_ord',v_second_ord));
   v_member_after:=v_pay.member_after;
   IF v_pick.kind='chips' THEN v_outcome:=v_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips);
   ELSE v_secondary:=jsonb_set(v_secondary,'{outcome}',v_second_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips)); END IF;
  ELSIF v_pick.kind='diamonds' THEN
   -- DIAMONDS DEALS THREE CARDS (owner ruling 2026-09-21, R15). Nothing is paid
   -- here: the half / double / triple values and their order behind cards one,
   -- two and three are sealed now and revealed when the player picks. The
   -- entry's own diamonds are what is risked, and the triple is already held
   -- against the owner's custody and the float by the gate above.
   v_card_hmac:=extensions.hmac(convert_to('wheel-v4-cards:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
   v_card_roll:=(('x'||encode(substring(v_card_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
   v_perm:=floor(v_card_roll*6/c_two48)::smallint;
   v_half:=(public.fn_diamond_round_chip_cents(v_price*.5/100,cm.server_seed,'wheel-v4-cards-half:'||v_client||':'||v_nonce)*100)::integer;
   INSERT INTO public.wheel_card_awards(spin_id,run_id,user_id,club_id,host_id,host_kind,owner_id,is_welcome,
     risk_diamonds,half_diamonds,permutation,roll,nonce,server_seed,server_seed_hash,client_seed)
   VALUES(v_spin_id,v_run.id,v_user,p_club_id,v_host,v_kind,v_owner,p_welcome,
     v_price,v_half,v_perm,v_card_roll,v_nonce,cm.server_seed,cm.server_seed_hash,v_client)
   RETURNING * INTO v_card;
   v_value_chips:=3*v_price::numeric/v_rate;
   v_outcome:=v_outcome||jsonb_build_object('amount',v_price,'value_chips',v_price::numeric/v_rate,
    'cards',jsonb_build_object('award_id',v_card.id,'risk_diamonds',v_price,'status','pending'));
  ELSIF v_pick.kind IN('throwables','time_bank','rabbit_hunt') THEN
   v_feature:=CASE v_pick.kind WHEN 'throwables' THEN 'throwable' WHEN 'time_bank' THEN 'time_bank_seconds' ELSE 'rabbit_hunt' END;
   v_cost:=(public.fn_diamond_round_chip_cents(v_price*.25/100,cm.server_seed,'wheel-v4-item:'||v_client||':'||v_nonce)*100)::integer;
   SELECT diamond_cost INTO v_unit FROM public.feature_pricing WHERE feature=v_feature;
   v_uses:=v_cost/v_unit;v_remainder:=v_cost%v_unit;
   v_deduct:=public.fn_diamond_spin_book(v_owner,p_club_id,v_host,v_kind,v_user,CASE v_feature WHEN 'time_bank_seconds' THEN 'time_bank' ELSE v_feature END,-(v_cost-v_remainder),
    'wheel:'||v_spin_id||':inventory','Diamond Spins: '||v_pick.label||' for '||v_user);
   IF v_remainder>0 THEN
    PERFORM public.fn_diamond_spin_book(v_owner,p_club_id,v_host,v_kind,v_user,'throwable',-v_remainder,
      'wheel:'||v_spin_id||':inventory-remainder','Diamond Spins: Throwable Remainder');
   END IF;
   IF COALESCE((v_deduct->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'The Owner Reward Debit Failed'; END IF;
   INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,v_feature,v_uses*v_unit,'per_use',v_uses,'diamond_wheel');
   v_grants:=jsonb_build_array(jsonb_build_object('feature',v_feature,'uses',v_uses));
   IF v_remainder>0 THEN
    INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,'throwable',v_remainder,'per_use',v_remainder,'diamond_wheel');
    v_grants:=v_grants||jsonb_build_object('feature','throwable','uses',v_remainder);
   END IF;
   v_value_chips:=v_cost::numeric/v_rate;
   v_outcome:=v_outcome||jsonb_build_object('amount',v_uses,'value_chips',v_value_chips,'grants',v_grants);
  ELSE
   v_boost:=CASE WHEN v_pick.kind='upgrade' THEN 2 ELSE 1 END;v_budget:=v_price*v_boost;
   v_cap:=(v_caps->>(v_game||':'||v_boost))::integer;v_hold:=ceil(v_budget::numeric/v_rate*v_cap)/100;
   INSERT INTO public.wheel_bonus_awards(spin_id,run_id,user_id,club_id,host_id,host_kind,game,entry_diamonds,boost_multiplier,base_diamonds,cap_cents,reserved_chips)
   VALUES(v_spin_id,v_run.id,v_user,p_club_id,v_host,v_kind,v_game,v_price,v_boost,v_budget,v_cap,v_hold) RETURNING * INTO v_award;
   UPDATE public.diamond_game_pools SET wheel_allocated_diamonds=wheel_allocated_diamonds+v_budget,reserved_chips=reserved_chips+v_hold,updated_at=now() WHERE host_id=v_host AND game=v_game;
   -- The welcome budget reserves the full liability until the awarded round settles.
   v_value_chips:=v_hold;
  END IF;

  -- ── 4. the pool remembers, on the right side of the books ─────────────────
  -- A welcome payout NEVER enters chips_paid. chips_paid is bounded by what the
  -- paid game took in; the welcome is bounded by the budget the host declared.
  -- Two promises, kept apart, both checked below. A card game's diamonds leave
  -- the float when the player picks, never here.
  UPDATE public.wheel_pools
     SET spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,
         welcome_spins = welcome_spins + CASE WHEN p_welcome THEN 1 ELSE 0 END,
         intake_diamonds = intake_diamonds + v_dia_now,
         chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,
         welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,
         diamond_float = diamond_float + v_dia_now
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia+v_cost END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF NOT p_welcome AND pool.chips_paid>pool.intake_diamonds/v_rate+cfg.exposure_allowance_chips THEN RAISE EXCEPTION 'The Wheel Exposure Limit Was Exceeded'; END IF;
  IF v_run.id IS NOT NULL THEN
   UPDATE public.wheel_runs SET spins_done=spins_done+1 WHERE id=v_run.id RETURNING * INTO v_run;
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  v_result:=jsonb_build_object('ok',true,'contract_version',4,'model','wheel-v4','vip',v_vip,'welcome',p_welcome,'daily_bonus',p_mode='daily','bonus_ticket_id',p_bonus_ticket_id,
   'player_cost_diamonds',CASE WHEN p_mode='paid' THEN v_price ELSE 0 END,'entry_value_diamonds',v_price,
   'entry_funded_by',CASE p_mode WHEN 'daily' THEN 'mint' WHEN 'welcome' THEN 'welcome' ELSE 'player' END,
   'spin_id',v_spin_id,'club_id',p_club_id,'host_id',v_host,'segment_version',4,'spin_price_diamonds',CASE WHEN p_welcome THEN 0 ELSE v_price END,
   'diamonds_per_chip',v_rate,'segments',v_segments,'outcome',v_outcome,
   'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_roll,'weight_total',v_total,'eligible_ords',to_jsonb(v_eligible),'locked','[]'::jsonb,'domain','wheel-v4','previous',v_previous,'weights',to_jsonb(v_weights)),
   'balances',jsonb_build_object('diamonds',v_dia_after,'member_chips',v_member_after),'pool',jsonb_build_object('chips_paid',pool.chips_paid,'diamond_float',pool.diamond_float),'created_at',transaction_timestamp());
  IF v_award.id IS NOT NULL THEN v_result:=v_result||jsonb_build_object('bonus',jsonb_build_object('id',v_award.id,'game',v_award.game,'club_id',v_award.club_id,'base_diamonds',v_award.base_diamonds,'entry_diamonds',v_award.entry_diamonds,'boost_multiplier',v_award.boost_multiplier,'cap_cents',v_award.cap_cents)); END IF;
  IF v_secondary IS NOT NULL THEN v_result:=v_result||jsonb_build_object('secondary',v_secondary); END IF;
  IF v_run.id IS NOT NULL THEN v_result:=v_result||jsonb_build_object('auto_run',jsonb_build_object('run_id',v_run.id,'spins',v_run.spins,'spins_done',v_run.spins_done)); END IF;
  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome, bonus_ticket_id,receipt_v2)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, 4,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, (v_outcome->>'amount')::numeric, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome, p_bonus_ticket_id,v_result)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  IF p_bonus_ticket_id IS NOT NULL THEN
    UPDATE public.diamond_bonus_spin_tickets SET redeemed_spin_id=v_spin_id,redeemed_at=transaction_timestamp()
     WHERE id=p_bonus_ticket_id;
  END IF;
  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$;

-- ── 9. WHAT THE PAGE IS TOLD BEFORE THE SPIN ─────────────────────────────────
-- Same md5-pinned body as above, plus: the VIP table for a VIP, the open run,
-- every unplayed bonus game and every unpicked card game, and the model this
-- wheel is drawing under.
CREATE OR REPLACE FUNCTION public.fn_wheel_state_v2(p_club_id uuid, p_entry_diamonds integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s jsonb;h uuid;k text;cfg public.wheel_configs;gcfg public.diamond_game_configs;gp public.diamond_game_pools;
 rate integer;cover numeric;held numeric;owner uuid;owner_diamonds numeric;room numeric;v_game text;boost integer;cap integer;funded boolean:=true;reason text;awards jsonb;welcome boolean;max_funded integer;headroom numeric;minimum_cap integer;welcome_funded boolean:=true;welcome_cap integer;
 vip boolean;cards jsonb;run public.wheel_runs;card_hold numeric;card_hold_float numeric;float_now numeric;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500 THEN RETURN jsonb_build_object('ok',false,'error','Choose 25 To 2,500 Diamonds'); END IF;
 IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',true,'contract_version',4,'model_version','wheel-v4','enabled',false); END IF;
 s:=public.fn_wheel_state(p_club_id);
 IF s->>'ok' IS DISTINCT FROM 'true' THEN RETURN s; END IF;
 vip:=public.fn_wheel_is_vip(auth.uid());
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 SELECT * INTO cfg FROM public.wheel_configs WHERE host_id=h;
 IF NOT FOUND THEN RETURN s||jsonb_build_object('contract_version',4,'model_version','wheel-v4','vip',vip,'enabled',true); END IF;
 rate:=public.fn_ca_bridge_rate();cover:=public.fn_diamond_game_cover(h,k);
 SELECT COALESCE(sum(reserved_chips),0) INTO held FROM public.diamond_game_pools WHERE host_id=h;
 owner:=public.fn_diamond_game_owner(h,k);SELECT public.fn_diamond_spin_available(owner) INTO owner_diamonds;
 -- Every unpicked three-card game is already spoken for, on both the owner's
 -- custody and this wheel's float, at its triple (owner ruling 2026-09-21, R15).
 SELECT COALESCE(sum(3*c.risk_diamonds),0),COALESCE(sum(CASE WHEN c.is_welcome THEN 0 ELSE 3*c.risk_diamonds END),0)
   INTO card_hold,card_hold_float FROM public.wheel_card_awards c WHERE c.host_id=h AND c.status='pending';
 float_now:=COALESCE((s#>>'{pool,diamond_float}')::numeric,0);
 max_funded:=GREATEST(0,LEAST(2500,floor((cover-held)*rate/100),
   floor((COALESCE(owner_diamonds,0)-card_hold)/2),floor((float_now-card_hold_float)/2),
   floor((cfg.exposure_allowance_chips+COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)/rate-COALESCE((s#>>'{pool,chips_paid}')::numeric,0))*rate/99)))::integer;
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 IF NOT public.fn_diamond_spins_owner_agreed(h,k) THEN funded:=false;welcome_funded:=false;reason:='The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'; END IF;
 IF cover-held<ceil(p_entry_diamonds::numeric/rate*100*100)/100 OR COALESCE(owner_diamonds,0)+p_entry_diamonds-card_hold<3*p_entry_diamonds OR float_now+p_entry_diamonds-card_hold_float<3*p_entry_diamonds THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 IF COALESCE((s#>>'{pool,chips_paid}')::numeric,0)+ceil(100*p_entry_diamonds::numeric/rate*100)/100>round((COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)+p_entry_diamonds)/rate,2)+cfg.exposure_allowance_chips THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
  SELECT * INTO gcfg FROM public.diamond_game_configs WHERE host_id=h AND game=v_game;
  SELECT * INTO gp FROM public.diamond_game_pools WHERE host_id=h AND game=v_game;
  IF gcfg.host_id IS NULL OR NOT gcfg.enabled OR ((public.fn_ca_is_fixture_account(auth.uid()) OR public.fn_ca_is_cert_account(auth.uid())) AND NOT gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN funded:=false;welcome_funded:=false;max_funded:=0;reason:='Every Bonus Game Must Be Open Before A Spin';
  ELSE
   headroom:=(COALESCE(gp.intake_diamonds,0)+COALESCE(gp.wheel_allocated_diamonds,0))::numeric/rate+gcfg.exposure_allowance_chips-COALESCE(gp.chips_paid,0)-COALESCE(gp.reserved_chips,0);
   FOR boost IN 1..2 LOOP
    minimum_cap:=2000*(boost+1)/boost;
    welcome_cap:=LEAST(public.fn_diamond_game_cap_cents(gcfg,gp,cover,100*boost::numeric/rate,gcfg.max_multiplier_cents),floor(room/(100*boost::numeric/rate)*100)::integer);
    IF welcome_cap<minimum_cap THEN welcome_funded:=false; END IF;
    IF gcfg.max_multiplier_cents<minimum_cap THEN max_funded:=0;
    ELSE max_funded:=LEAST(max_funded,GREATEST(0,floor(rate*gcfg.cap_fraction*headroom/(minimum_cap::numeric/100-gcfg.cap_fraction)/boost))::integer); END IF;
    cap:=public.fn_diamond_game_cap_cents(gcfg,gp,cover,p_entry_diamonds*boost::numeric/rate,gcfg.max_multiplier_cents);
    IF cap<2000*(boost+1)/boost THEN funded:=false;reason:='The Host Must Fund Every Bonus Before A Spin'; END IF;
   END LOOP;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='An Approved Plinko Table Must Be Open Before A Spin'; END IF;
 -- A VIP never draws an item, so the item prices are not their wheel's problem.
 IF NOT vip AND EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
  LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
  WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='The Reward Prices Changed. The Wheel Must Be Requalified'; END IF;
 SELECT COALESCE(jsonb_agg(public.fn_wheel_bonus_public_award(a,false) ORDER BY a.created_at),'[]') INTO awards FROM public.wheel_bonus_awards a WHERE a.user_id=auth.uid() AND a.club_id=p_club_id AND public.fn_wheel_bonus_unfinished(a);
 SELECT COALESCE(jsonb_agg(public.fn_wheel_card_public(c) ORDER BY c.created_at),'[]') INTO cards FROM public.wheel_card_awards c WHERE c.user_id=auth.uid() AND c.club_id=p_club_id AND c.status='pending';
 SELECT * INTO run FROM public.fn_wheel_open_run(auth.uid(),p_club_id);
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 welcome:=cfg.enabled AND welcome_funded AND cfg.welcome_spin_enabled AND owner IS DISTINCT FROM auth.uid() AND room>=100*100::numeric/rate AND cover-held>=100*100::numeric/rate AND owner_diamonds>=50
  AND NOT EXISTS(SELECT 1 FROM public.wheel_spins WHERE host_id=h AND user_id=auth.uid() AND is_welcome);
 s:=jsonb_set(s,'{config}',(s->'config')-ARRAY['spec_rtp','chip_share','diamond_share','house_share','hit_rate']||jsonb_build_object('spin_price_diamonds',p_entry_diamonds,'spin_price_chips',p_entry_diamonds::numeric/rate,'segment_version',4,'multiplier',1,'min_entry',25,'max_entry',2500));
 RETURN s||jsonb_build_object('contract_version',4,'model_version','wheel-v4','vip',vip,'enabled',true,'available',COALESCE(cfg.enabled,false) AND funded,'reason',reason,
  'min_entry',25,'max_entry',2500,'max_funded_entry',max_funded,'segments',public.fn_wheel_v4_segments(p_entry_diamonds,rate,false,vip),'upgrade_segments',public.fn_wheel_v4_segments(p_entry_diamonds,rate,true),
  'awards',awards,'pending_awards',awards,'pending_cards',cards,
  'auto_run',CASE WHEN run.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('run_id',run.id,'spins',run.spins,'spins_done',run.spins_done) END,
  'welcome',jsonb_build_object('available',welcome,'eligible',welcome,'entry_diamonds',100));
END $function$;

COMMIT;
