-- Reserved by scripts/new-migration.mjs. The report's owned catchup must not
-- roll up every retained day for a club with no hosted bomb-pot hands.
-- Preserve sealed historical projections, award semantics and authorization.
-- A window of N days includes today and N-1 earlier UTC calendar dates.
-- @live-proof: position('hosted_bomb_days' in pg_get_functiondef('public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $patch$
DECLARE r record;d text; a integer;b integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_ca_bomb_pot_catchup(uuid,integer)','c68ef3419619c358b8b635e6c7ae0369'),
 ('public.fn_club_bomb_pot_report(uuid,integer)','95ce777f24ff95aab6a2f0fc33b5a74a'),
 ('public.fn_club_bomb_pot_report_v2(uuid,integer)','ad1efdf630c856e3828cf94b246937f2')) v(sig,hash)
 LOOP
  d:=pg_get_functiondef(r.sig::regprocedure);
  IF md5(d)<>r.hash THEN RAISE EXCEPTION 'Bomb report source changed: %',r.sig; END IF;
  IF r.sig LIKE '%fn_ca_bomb_pot_catchup%' THEN
   a:=position('  FOR v_day IN' in d);b:=position('  LOOP' in substring(d from a));
   IF a=0 OR b=0 THEN RAISE EXCEPTION 'Bomb catchup query anchor missing'; END IF;
   d:=left(d,a-1)||$source$  -- hosted_bomb_days: source days only; never manufacture a zero archive.
  FOR v_day IN
    SELECT (h.created_at AT TIME ZONE 'UTC')::date AS hosted_bomb_days
      FROM public.hand_history h
     WHERE h.table_id=ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id=p_club_id))
       AND h.bomb_pot IS NOT NULL
       AND h.created_at >= (((now() AT TIME ZONE 'UTC')::date-(LEAST(GREATEST(COALESCE(p_days,30),1),365)-1))::timestamp AT TIME ZONE 'UTC')
       AND h.created_at < ((((now()-interval '15 minutes') AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC')
       AND NOT EXISTS (SELECT 1 FROM public.ca_club_bomb_pot_complete c
         WHERE c.club_id=p_club_id AND c.day=(h.created_at AT TIME ZONE 'UTC')::date)
     GROUP BY (h.created_at AT TIME ZONE 'UTC')::date
     ORDER BY 1 DESC LIMIT 40
$source$||substring(d from a+b-1);
  ELSIF r.sig LIKE '%fn_club_bomb_pot_report_v2%' THEN
   d:=replace(d,'(now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365)))::date',
    '(now() AT TIME ZONE ''UTC'')::date - (LEAST(GREATEST(COALESCE(p_days,30),1),365)-1)');
  ELSE
   d:=replace(d,'v_from := (now() - make_interval(days => v_days))::date;',
    'v_from := (now() AT TIME ZONE ''UTC'')::date - (v_days-1);');
  END IF;
  EXECUTE d;
 END LOOP;
END $patch$;
REVOKE ALL ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid,integer),public.fn_club_bomb_pot_report_v2(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid,integer),public.fn_club_bomb_pot_report_v2(uuid,integer) TO authenticated,service_role;
COMMIT;
