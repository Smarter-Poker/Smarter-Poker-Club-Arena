-- Old private-column reads still arriving: every statement by authenticated or anon that names public.profiles
-- and one of the seventeen private columns, excluding writes and the two doors. Run read-only, twice; the
-- difference in calls per queryid is what arrived in between (docs/evidence/profile-privacy-2026-10-01.md, step 2).
select now()::text at_, s.queryid::text qid, s.calls, left(regexp_replace(s.query,'\s+',' ','g'), 140) q
from extensions.pg_stat_statements s join pg_roles r on r.oid=s.userid
where r.rolname in ('authenticated','anon') and s.query ~* '"profiles"'
  and s.query !~* '^\s*WITH pgrst_source AS \(UPDATE'
  and s.query !~* '"(get_my_full_profile|get_full_profiles_for_staff)"\('
  and s.query ~* '"(diamonds|diamond_balance|diamond_multiplier|first_name|last_name|full_name|birth_year|city|state|country|last_seen|last_login|last_login_date|last_active|updated_at|referred_by|poker_near_me_preferences)"'
order by s.calls desc
