-- SOURCE SELECT-only metadata; private output executes ONLY in destination.
-- Exact five native parse-tree restoration recipes, never cast/alias stripping.
SET search_path=pg_catalog;
WITH recipes(table_name,constraint_name,column_name,labels,source_hash,restored_hash) AS (VALUES
 ('referrals','referrals_status_check','status',ARRAY['pending','completed'],'204ebceef853e1cca602532124b1bc49','ecb7ab55a2dcdb103d4040a78598bb13'),
 ('crew_members','crew_members_role_check','role',ARRAY['owner','admin','member'],'0a22183107e42f9ded5a4c577fcadc53','786ed034d0f919820f0eab0cca6017fd'),
 ('insurance_transactions','insurance_transactions_bank_type_check','bank_type',ARRAY['union','club'],'ec32ac972d9cd6ceed034236e4b5e0c0','485e7e61ee7cbab4ae4036f7d79af1de'),
 ('insurance_offer_events','insurance_offer_events_event_check','event',ARRAY['offered','accepted','declined','timeout','cashed_out','settled'],'bffb535b26bae3162098e2eb3bfb987a','4d6f49d45a6e7742a81087eed33ae7b0')
), admission AS MATERIALIZED (
 SELECT 1/CASE WHEN
  (SELECT count(*) FROM recipes r JOIN pg_constraint k ON k.conrelid=to_regclass(format('public.%I',r.table_name)) AND k.conname=r.constraint_name
   JOIN pg_class c ON c.oid=k.conrelid WHERE md5(pg_get_constraintdef(k.oid,true))=r.source_hash
    AND k.contype='c' AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
    AND NOT k.connoinherit AND k.conislocal AND k.coninhcount=0 AND c.relowner='postgres'::regrole)=4
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.v_spin_draw_fairness')
    AND c.relkind='v' AND c.relowner='postgres'::regrole AND c.reloptions=ARRAY['security_invoker=true']::text[]
    AND md5(pg_get_viewdef(c.oid,true))='3c7b8637c106ae00162e4f449445838d')
  THEN 1 ELSE 0 END AS allowed
)
SELECT format('DO %L;',format($body$
DECLARE before_dependencies jsonb; before_relation jsonb; after_dependencies jsonb; observed record; prior_path text:=current_setting('search_path');
BEGIN
 IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
  OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' OR NOT %1$L::boolean THEN
  RAISE EXCEPTION 'Exact isolated definition/source image required'; END IF;
 PERFORM set_config('search_path','pg_catalog',true);
 SELECT k.* INTO STRICT observed FROM pg_constraint k WHERE k.conrelid=%2$L::regclass AND k.conname=%3$L;
 IF observed.contype<>'c' OR NOT observed.convalidated OR observed.condeferrable OR observed.condeferred
  OR observed.connoinherit OR observed.conislocal IS DISTINCT FROM true OR observed.coninhcount<>0
  OR md5(pg_get_constraintdef(observed.oid,true)) NOT IN (%4$L,%5$L)
  OR obj_description(observed.oid,'pg_constraint') IS DISTINCT FROM %6$L
  OR (SELECT relowner FROM pg_class WHERE oid=observed.conrelid)<>'postgres'::regrole
  OR EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_constraint'::regclass AND refobjid=observed.oid) THEN
  RAISE EXCEPTION 'Exact destination constraint image required'; END IF;
 IF md5(pg_get_constraintdef(observed.oid,true))=%5$L THEN
  SELECT to_jsonb(c) INTO before_relation FROM pg_class c WHERE oid=observed.conrelid;
  SELECT jsonb_agg(jsonb_build_array(refclassid,refobjid,refobjsubid,deptype) ORDER BY refclassid,refobjid,refobjsubid,deptype)
    INTO before_dependencies FROM pg_depend WHERE classid='pg_constraint'::regclass AND objid=observed.oid;
  EXECUTE %7$L;
  EXECUTE %8$L;
  EXECUTE %9$L;
  SELECT k.* INTO STRICT observed FROM pg_constraint k WHERE k.conrelid=%2$L::regclass AND k.conname=%3$L;
  SELECT jsonb_agg(jsonb_build_array(refclassid,refobjid,refobjsubid,deptype) ORDER BY refclassid,refobjid,refobjsubid,deptype)
    INTO after_dependencies FROM pg_depend WHERE classid='pg_constraint'::regclass AND objid=observed.oid;
  IF after_dependencies IS DISTINCT FROM before_dependencies
    OR (SELECT to_jsonb(c) FROM pg_class c WHERE oid=observed.conrelid) IS DISTINCT FROM before_relation THEN
   RAISE EXCEPTION 'Constraint recipe changed dependencies or relation security'; END IF;
 END IF;
 IF md5(pg_get_constraintdef(observed.oid,true))<>%4$L OR NOT observed.convalidated
  OR obj_description(observed.oid,'pg_constraint') IS DISTINCT FROM %6$L THEN
  RAISE EXCEPTION 'Exact source constraint post-image required'; END IF;
 PERFORM set_config('search_path',prior_path,true);
END;
$body$,
 coalesce((SELECT md5(pg_get_constraintdef(k.oid,true))=r.source_hash AND k.convalidated AND k.contype='c'
   AND NOT k.condeferrable AND NOT k.condeferred AND NOT k.connoinherit AND k.conislocal AND k.coninhcount=0
   AND c.relowner='postgres'::regrole
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
   WHERE k.conrelid=to_regclass(format('public.%I',r.table_name)) AND k.conname=r.constraint_name),false),
 format('public.%I',r.table_name),r.constraint_name,r.source_hash,r.restored_hash,
 (SELECT obj_description(k.oid,'pg_constraint') FROM pg_constraint k WHERE k.conrelid=to_regclass(format('public.%I',r.table_name)) AND k.conname=r.constraint_name),
 format('ALTER TABLE public.%I DROP CONSTRAINT %I',r.table_name,r.constraint_name),
 format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IN (%s))',r.table_name,r.constraint_name,r.column_name,
   (SELECT string_agg(format('%L::character varying',label),', ' ORDER BY ordinal) FROM unnest(r.labels) WITH ORDINALITY q(label,ordinal))),
 format('COMMENT ON CONSTRAINT %I ON public.%I IS %L',r.constraint_name,r.table_name,
   (SELECT obj_description(k.oid,'pg_constraint') FROM pg_constraint k WHERE k.conrelid=to_regclass(format('public.%I',r.table_name)) AND k.conname=r.constraint_name))))
FROM recipes r CROSS JOIN admission a WHERE a.allowed=1 ORDER BY r.table_name;

SELECT format('DO %L;',format($body$
DECLARE prior_path text:=current_setting('search_path'); before_relation jsonb; before_columns jsonb;
 before_dependencies jsonb; after_dependencies jsonb; before_comment text; view_id oid:='public.v_spin_draw_fairness'::regclass;
BEGIN
 IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
  OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' OR NOT %1$L::boolean THEN
  RAISE EXCEPTION 'Exact isolated view/source image required'; END IF;
 PERFORM set_config('search_path','pg_catalog',true);
 IF md5(pg_get_viewdef(view_id,true)) NOT IN ('3c7b8637c106ae00162e4f449445838d','92630e7e7ff7b3fc84cf14c70d26c3dd')
  OR (SELECT relowner FROM pg_class WHERE oid=view_id)<>'postgres'::regrole
  OR (SELECT reloptions FROM pg_class WHERE oid=view_id) IS DISTINCT FROM ARRAY['security_invoker=true']::text[] THEN
  RAISE EXCEPTION 'Exact destination view image required'; END IF;
 SELECT to_jsonb(c) INTO before_relation FROM pg_class c WHERE oid=view_id;
 SELECT jsonb_agg(to_jsonb(a) ORDER BY attnum) INTO before_columns FROM pg_attribute a WHERE attrelid=view_id;
 SELECT jsonb_agg(to_jsonb(d) ORDER BY to_jsonb(d)::text) INTO before_dependencies FROM pg_depend d
  WHERE (classid='pg_rewrite'::regclass AND objid IN(SELECT oid FROM pg_rewrite WHERE ev_class=view_id))
    OR (refclassid='pg_class'::regclass AND refobjid=view_id);
 before_comment:=obj_description(view_id,'pg_class');
 IF md5(pg_get_viewdef(view_id,true))='92630e7e7ff7b3fc84cf14c70d26c3dd' THEN EXECUTE %2$L; END IF;
 SELECT jsonb_agg(to_jsonb(d) ORDER BY to_jsonb(d)::text) INTO after_dependencies FROM pg_depend d
  WHERE (classid='pg_rewrite'::regclass AND objid IN(SELECT oid FROM pg_rewrite WHERE ev_class=view_id))
    OR (refclassid='pg_class'::regclass AND refobjid=view_id);
 IF md5(pg_get_viewdef(view_id,true))<>'3c7b8637c106ae00162e4f449445838d' THEN
  RAISE EXCEPTION 'View recipe source definition differs'; END IF;
 IF (SELECT to_jsonb(c) FROM pg_class c WHERE oid=view_id) IS DISTINCT FROM before_relation THEN
  RAISE EXCEPTION 'View recipe relation security differs'; END IF;
 IF (SELECT jsonb_agg(to_jsonb(a) ORDER BY attnum) FROM pg_attribute a WHERE attrelid=view_id) IS DISTINCT FROM before_columns THEN
  RAISE EXCEPTION 'View recipe columns differ'; END IF;
 IF after_dependencies IS DISTINCT FROM before_dependencies THEN
  RAISE EXCEPTION 'View recipe dependencies differ'; END IF;
 IF obj_description(view_id,'pg_class') IS DISTINCT FROM before_comment THEN
  RAISE EXCEPTION 'View recipe comment differs'; END IF;
 PERFORM set_config('search_path',prior_path,true);
END;
$body$,
 coalesce((SELECT md5(pg_get_viewdef(c.oid,true))='3c7b8637c106ae00162e4f449445838d' AND c.relowner='postgres'::regrole
   AND c.reloptions=ARRAY['security_invoker=true']::text[]
   FROM pg_class c WHERE c.oid=to_regclass('public.v_spin_draw_fairness')),false),
$recipe$
create or replace view public.v_spin_draw_fairness WITH(security_invoker=true) as
with spec as (
 select sum(freq)::numeric as total_freq, sum(multiplier::numeric * freq) / sum(freq) as spec_e from public.spin_tier_spec
), spec_sd as (
 select s.spec_e, sqrt(sum(t.freq * power(t.multiplier::numeric - s.spec_e, 2)) / s.total_freq) as spec_sd
 from public.spin_tier_spec t cross join spec s group by s.spec_e, s.total_freq
), agg as (
 select count(*) filter (where created_at >= now() - interval '1 hour') as d1,
 avg(spin_multiplier) filter (where created_at >= now() - interval '1 hour') as e1,
 count(*) filter (where created_at >= now() - interval '1 hour' and jsonb_array_length(coalesce(spin_locked_tiers, '[]'::jsonb)) > 0) as c1,
 count(*) filter (where created_at >= now() - interval '24 hours') as d24,
 avg(spin_multiplier) filter (where created_at >= now() - interval '24 hours') as e24,
 count(*) filter (where created_at >= now() - interval '24 hours' and jsonb_array_length(coalesce(spin_locked_tiers, '[]'::jsonb)) > 0) as c24,
 count(*) as d7, avg(spin_multiplier) as e7,
 count(*) filter (where jsonb_array_length(coalesce(spin_locked_tiers, '[]'::jsonb)) > 0) as c7
 from public.tournaments where variant = 'spin' and spin_multiplier is not null and spin_multiplier > 0
 and created_at >= now() - interval '168 hours'
), shaped as (
 select '1h'::text as window_label,1 as window_hours,d1::bigint as draws,e1 as realised_e,c1::bigint as constrained_draws from agg
 union all select '24h',24,d24::bigint,e24,c24::bigint from agg
 union all select '7d',168,d7::bigint,e7,c7::bigint from agg
)
select d.window_label,d.window_hours,d.draws,round(sd.spec_e,6) as spec_e,round(d.realised_e,6) as realised_e,
 round(sd.spec_sd,6) as spec_sd,case when d.draws>=2 then round(sd.spec_sd/sqrt(d.draws::numeric),6) end as sem,
 case when d.draws>=2 and sd.spec_sd>0 then round((d.realised_e-sd.spec_e)/(sd.spec_sd/sqrt(d.draws::numeric)),3) end as z,
 round(100*(1-sd.spec_e/3),4) as spec_edge_pct,
 case when d.draws>0 then round(100*(1-d.realised_e/3),4) end as realised_edge_pct,d.constrained_draws,
 (d.draws>=2000 and sd.spec_sd>0 and abs((d.realised_e-sd.spec_e)/(sd.spec_sd/sqrt(d.draws::numeric)))>=4) as drift
from shaped d cross join spec_sd sd order by d.window_hours;
$recipe$));
