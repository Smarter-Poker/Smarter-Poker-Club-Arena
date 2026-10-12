-- 20261012041752_one_wheel_for_everyone.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Owner request 2026-10-12 (Dan), verbatim: "THE VIP WHEEL THAT ONLY AWARDS
-- DIAMONDS, CHIPS OR BONUS GAMES SHOULD BE THE SAME WHEEL THAT NON VIP MEMBERS
-- GET. THERE SHOULDN'T BE A DIFFERENCE. CHANGE THAT PLEASE."
--
-- Since 20260922194123 (owner ruling R2) the wheel dealt two tables. A VIP got
-- ords 3, 6 and 9 as 0.2x, 0.25x and 0.3x instant chips; everybody else got a
-- Throwables, a Time Bank and a Rabbit Hunt worth a quarter of the entry each.
-- From this migration EVERY member is dealt the VIP table, and nobody wins a
-- throwable, a time bank or a rabbit hunt from the wheel.
--
-- THE ROOT. The difference lived in one place, fn_wheel_v4_model(p_vip), which
-- now returns that one table whatever it is asked. The parameter stays only so
-- every existing caller (fn_wheel_v4_segments, the spin, the state, the CI
-- contract reader) still resolves; it selects nothing. The weights and the
-- follow-up matrix do not move, so the payback is the same exact 0.8 the VIP
-- table was already proved to return: sum(weight*value_sixths) = 480000, and
-- .2*6667 + .25*6666 + .3*6667 = 5000, the value the three items carried. The
-- mix becomes a game half the time and instant chips the other half.
--
-- THE RECEIPT. `vip` on a receipt and on the state has always meant "this spin
-- was drawn from the item-free table" - it is the flag the browser validator
-- (src/utils/wheelAward.ts) uses to choose which table shape to accept. Every
-- spin is now drawn from that table, so fn_wheel_spin_v2 and fn_wheel_state_v2
-- answer `vip: true` for everybody and no longer ask fn_wheel_is_vip. This is
-- deliberate and is what makes the release order free: the client already
-- installed accepts a `vip: true` receipt carrying exactly this table, and an
-- already sealed `vip: false` receipt keeps the item table it was drawn from
-- and still verifies under its own rules. fn_wheel_is_vip stays installed with
-- no caller (it is a pure read; dropping it would buy nothing).
--
-- THE DEAD GATE. Both functions refused to open, for a non-VIP, unless the
-- throwable / rabbit hunt / time bank prices in feature_pricing were exactly
-- what the quarter-entry item conversion was qualified at. No spin can draw an
-- item now, so that gate is removed rather than left as a condition that can
-- close the wheel for a reason the wheel no longer has. The item-granting
-- branch inside fn_wheel_spin_v2 is left in the body but cannot be reached:
-- the model guard before every draw now refuses ANY table that carries an item
-- kind, for everybody, where it used to refuse it only for a VIP.
--
-- IN FLIGHT. Nothing sealed is rewritten. Unplayed bonus games, unpicked card
-- games, open runs and batch tickets are untouched; receipts already written
-- keep their own `vip` and their own table.
--
-- No engine change. Client and database can be released in either order.
--
-- THE PREIMAGES. fn_wheel_spin_v2 and fn_wheel_state_v2 have been patched in
-- place since 2026-09-22, so they are patched here the same way: their live
-- bodies are read, refused unless their md5 is exactly the body this was
-- written and qualified against, edited at anchors that must each occur
-- exactly once, and re-executed. Read read-only from production 2026-10-12:
--   fn_wheel_spin_v2   3a5c2e4182a60bf90c3f011dac16d99d (the postimage of 20261010084125)
--   fn_wheel_state_v2  b6c4224bcbd24cf0571b9096477d8d64 (the postimage of 20261010064303)
--   fn_wheel_v4_model  f440ca3d4519d16f691cf2c342ec2d05 (the postimage of 20260922194123)
--   fn_wheel_v4_segments 586d1be1986b0701516ac4cab76a34bb (unchanged here, pinned so its p_vip pass-through is what was reasoned about)
-- If production has drifted, this aborts and nothing is changed.
--
-- The postimages below were produced by applying this file to the isolated
-- PostgreSQL 17 Diamond fixture (scripts/dev/test-accounting-delivery.sh), whose
-- preimages are byte-identical to production's.
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_v4_model(boolean)'::regprocedure))='ee7ba6f14477726303e1da553b9a7953'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure))='26b56f5b349b148378bbad2e093d06eb'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_state_v2(uuid,integer)'::regprocedure))='f68734ab6d38159c2d3e2aa25340d66c'
-- @live-proof: NOT EXISTS(SELECT 1 FROM public.fn_wheel_v4_model(false) WHERE kind IN('throwables','time_bank','rabbit_hunt'))
-- @live-proof: (SELECT array_agg(row(ord,label,kind,game,multiplier,value_sixths,weight)::text ORDER BY ord) FROM public.fn_wheel_v4_model(false)) = (SELECT array_agg(row(ord,label,kind,game,multiplier,value_sixths,weight)::text ORDER BY ord) FROM public.fn_wheel_v4_model(true))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='90s';

-- ── 0. the preimages this migration was written against ──────────────────────
DO $preimage$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','3a5c2e4182a60bf90c3f011dac16d99d'),
  ('fn_wheel_state_v2(uuid,integer)','b6c4224bcbd24cf0571b9096477d8d64'),
  ('fn_wheel_v4_model(boolean)','f440ca3d4519d16f691cf2c342ec2d05'),
  ('fn_wheel_v4_segments(integer,integer,boolean,boolean)','586d1be1986b0701516ac4cab76a34bb')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'One wheel for everyone: preimage changed: % (md5 %)',expected.signature,
    md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature)));
  END IF;
 END LOOP;
END $preimage$;

-- ── 1. THE ONE TABLE ─────────────────────────────────────────────────────────
-- Generated by scripts/diamond-spins/wheel-v4-follow-matrix.py --sql. These
-- twelve rows are, value for value, the VIP columns of 20260922194123; only the
-- standard columns are gone. `value_sixths` is one unit of entry's worth on that
-- segment, in sixths, because the three-card game is worth 11/6.
CREATE OR REPLACE FUNCTION public.fn_wheel_v4_model(p_vip boolean DEFAULT false)
RETURNS TABLE(ord smallint,label text,kind text,game text,multiplier numeric,value_sixths numeric,weight integer)
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT o::smallint,l,k,g,m,s,w
   FROM (VALUES
 (1,'Diamond Plinko','bonus','plinko',1,4.8,11950),
 (2,'1x Chips','chips',NULL,1,6,29600),
 (3,'0.2x Chips','chips',NULL,0.2,1.2,6667),
 (4,'Diamond Crash','bonus','crash',1,4.8,11950),
 (5,'Diamonds','diamonds',NULL,1,11,1200),
 (6,'0.25x Chips','chips',NULL,0.25,1.5,6666),
 (7,'Donkey Cross','bonus','crossing',1,4.8,11950),
 (8,'2x Chips','chips',NULL,2,12,240),
 (9,'0.3x Chips','chips',NULL,0.3,1.8,6667),
 (10,'Diamond Mines','bonus','mines',1,4.8,11950),
 (11,'3x Chips','chips',NULL,3,18,160),
 (12,'Upgrade','upgrade',NULL,2,24,1000)
 ) x(o,l,k,g,m,s,w)
$$;
COMMENT ON FUNCTION public.fn_wheel_v4_model(boolean) IS
 'The Diamond Wheel v4 prize table: ONE table for every member, VIP or not (owner request 2026-10-12). p_vip is kept for signature compatibility and selects nothing. Generated by scripts/diamond-spins/wheel-v4-follow-matrix.py.';
COMMENT ON FUNCTION public.fn_wheel_is_vip(uuid) IS
 'An active VIP card holder or a lifetime VIP (owner ruling 2026-09-21, R2). Since 2026-10-12 the Diamond Wheel no longer asks: every member is dealt the same table.';

-- The table must be what this migration says before anything is patched to
-- rely on it: twelve ords, 100000 weight, exactly 0.8, no item, and the same
-- answer whichever way p_vip is set.
DO $model$
BEGIN
 IF (SELECT count(*) FROM public.fn_wheel_v4_model(false))<>12
  OR (SELECT sum(weight) FROM public.fn_wheel_v4_model(false))<>100000
  OR (SELECT sum(weight*value_sixths) FROM public.fn_wheel_v4_model(false))<>480000
  OR EXISTS(SELECT 1 FROM public.fn_wheel_v4_model(false) WHERE kind IN('throwables','time_bank','rabbit_hunt'))
  OR (SELECT count(*) FROM public.fn_wheel_v4_model(false) WHERE kind='chips')<>6
  OR EXISTS(SELECT ord,label,kind,game,multiplier,value_sixths,weight FROM public.fn_wheel_v4_model(false)
            EXCEPT SELECT ord,label,kind,game,multiplier,value_sixths,weight FROM public.fn_wheel_v4_model(true))
  OR EXISTS(SELECT ord,label,kind,game,multiplier,value_sixths,weight FROM public.fn_wheel_v4_model(true)
            EXCEPT SELECT ord,label,kind,game,multiplier,value_sixths,weight FROM public.fn_wheel_v4_model(false)) THEN
  RAISE EXCEPTION 'One wheel for everyone: the installed table is not the one table';
 END IF;
END $model$;

-- ── 2. THE SPIN DEALS IT TO EVERYBODY ────────────────────────────────────────
DO $spin$
DECLARE src text; anchor text; replacement text;
 edits text[][] := ARRAY[
  -- who is spinning no longer decides which table they are dealt
  ARRAY[
   '  -- WHO IS SPINNING DECIDES WHICH TABLE THEY SEE (owner ruling 2026-09-21, R2).'||E'\n'||
   '  -- A VIP already owns unlimited or allowanced throwables, time banks and rabbit'||E'\n'||
   '  -- hunts, so those three cards are instant chip wins of equal value for them.'||E'\n'||
   '  v_vip:=public.fn_wheel_is_vip(v_user);'||E'\n',
   '  -- ONE WHEEL FOR EVERYONE (owner request 2026-10-12). Every member, VIP or not,'||E'\n'||
   '  -- is dealt the same item-free table. `vip` on the receipt means "drawn from'||E'\n'||
   '  -- the item-free table", so it is true on every spin from here on.'||E'\n'||
   '  v_vip:=true;'||E'\n'],
  -- the model guard refuses an item for everybody, not only for a VIP
  ARRAY[
   '   OR (v_vip AND EXISTS(SELECT 1 FROM public.fn_wheel_v4_model(true) WHERE kind IN(''throwables'',''time_bank'',''rabbit_hunt''))) THEN'||E'\n',
   '   OR EXISTS(SELECT 1 FROM public.fn_wheel_v4_model(v_vip) WHERE kind IN(''throwables'',''time_bank'',''rabbit_hunt'')) THEN'||E'\n'],
  -- the item-price gate guarded a draw that can no longer happen
  ARRAY[
   '  IF NOT v_vip AND EXISTS(SELECT 1 FROM (VALUES(''throwable'',1),(''rabbit_hunt'',5),(''time_bank_seconds'',5)) expected(feature,cost)'||E'\n'||
   '    LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature'||E'\n'||
   '    WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>''per_use'') THEN'||E'\n'||
   '   RETURN jsonb_build_object(''ok'',false,''error'',''The Reward Prices Changed. The Wheel Must Be Requalified''); END IF;'||E'\n',
   '  -- No item can be drawn (2026-10-12), so the item prices no longer gate a spin.'||E'\n']
 ];
 i integer;
BEGIN
 src:=pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure);
 IF md5(src) IS DISTINCT FROM '3a5c2e4182a60bf90c3f011dac16d99d' THEN RAISE EXCEPTION 'One wheel for everyone: spin preimage changed'; END IF;
 FOR i IN 1..array_length(edits,1) LOOP
  anchor:=edits[i][1]; replacement:=edits[i][2];
  IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'One wheel for everyone: spin anchor % is not present exactly once',i; END IF;
  src:=replace(src,anchor,replacement);
 END LOOP;
 IF position('fn_wheel_is_vip' in src)>0 OR position('feature_pricing actual' in src)>0 OR position('v_vip:=true;' in src)=0 THEN
  RAISE EXCEPTION 'One wheel for everyone: spin postimage is not the one wheel'; END IF;
 EXECUTE src;
END $spin$;

-- ── 3. THE PAGE IS SHOWN IT BEFORE THE SPIN ──────────────────────────────────
DO $state$
DECLARE src text; anchor text; replacement text;
 edits text[][] := ARRAY[
  ARRAY[
   ' vip:=public.fn_wheel_is_vip(auth.uid());'||E'\n',
   ' -- One wheel for everyone (owner request 2026-10-12): every caller is shown the'||E'\n'||
   ' -- same item-free table, and `vip` names that table, so it is true for all.'||E'\n'||
   ' vip:=true;'||E'\n'],
  ARRAY[
   ' -- A VIP never draws an item, so the item prices are not their wheel''s problem.'||E'\n'||
   ' IF NOT vip AND EXISTS(SELECT 1 FROM (VALUES(''throwable'',1),(''rabbit_hunt'',5),(''time_bank_seconds'',5)) expected(feature,cost)'||E'\n'||
   '  LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature'||E'\n'||
   '  WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>''per_use'') THEN'||E'\n'||
   '  funded:=false;welcome_funded:=false;max_funded:=0;reason:=''The Reward Prices Changed. The Wheel Must Be Requalified''; END IF;'||E'\n',
   ' -- Nobody draws an item (2026-10-12), so the item prices never close the wheel.'||E'\n']
 ];
 i integer;
BEGIN
 src:=pg_get_functiondef('public.fn_wheel_state_v2(uuid,integer)'::regprocedure);
 IF md5(src) IS DISTINCT FROM 'b6c4224bcbd24cf0571b9096477d8d64' THEN RAISE EXCEPTION 'One wheel for everyone: state preimage changed'; END IF;
 FOR i IN 1..array_length(edits,1) LOOP
  anchor:=edits[i][1]; replacement:=edits[i][2];
  IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'One wheel for everyone: state anchor % is not present exactly once',i; END IF;
  src:=replace(src,anchor,replacement);
 END LOOP;
 IF position('fn_wheel_is_vip' in src)>0 OR position('feature_pricing actual' in src)>0 OR position(' vip:=true;' in src)=0 THEN
  RAISE EXCEPTION 'One wheel for everyone: state postimage is not the one wheel'; END IF;
 EXECUTE src;
END $state$;

COMMIT;
