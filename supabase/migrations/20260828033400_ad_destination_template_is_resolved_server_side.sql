-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828033400; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_resolve_ads(
  p_slot text,
  p_club_id uuid default null::uuid,
  p_limit integer default 3
)
returns table(
  ad_id uuid, ad_key text, category text, headline text,
  body text, glyph text, target_url text, cta_label text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_user uuid := auth.uid();
  v_vip  boolean := false;
BEGIN
  IF v_user IS NOT NULL THEN
    SELECT COALESCE(p.is_vip, false) INTO v_vip FROM public.profiles p WHERE p.id = v_user;
  END IF;

  RETURN QUERY
  WITH resolved AS (
    SELECT c.id, c.ad_key, c.category, c.headline, c.body, c.glyph,
           -- The placement decides where its own surface should land; the
           -- campaign default applies when it has no opinion. Then the club
           -- placeholder is expanded with the club we were already given.
           replace(
             replace(
               COALESCE(pl.target_url, c.target_url),
               '{clubId}',  COALESCE(p_club_id::text, '{clubId}')
             ),
             '{club_id}', COALESCE(p_club_id::text, '{club_id}')
           ) AS target_url,
           c.cta_label,
           c.weight,
           c.created_at
      FROM public.ad_catalog c
      JOIN public.ad_placement pl ON pl.ad_id = c.id
     WHERE c.is_active
       AND pl.is_active
       AND pl.slot = p_slot
       AND (c.starts_at IS NULL OR c.starts_at <= now())
       AND (c.ends_at   IS NULL OR c.ends_at   >  now())
       AND (pl.club_id IS NULL OR pl.club_id = p_club_id)
       AND (
             pl.audience IS NULL
          OR pl.audience = 'all'
          OR (pl.audience = 'vip'      AND v_vip)
          OR (pl.audience = 'non_vip'  AND v_user IS NOT NULL AND NOT v_vip)
          OR (pl.audience = 'new_player' AND v_user IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.profiles p
                 WHERE p.id = v_user AND p.created_at > now() - interval '7 days'))
          OR (pl.audience = 'returning'  AND v_user IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.profiles p
                 WHERE p.id = v_user AND p.created_at <= now() - interval '7 days'))
       )
       AND (
             pl.daily_cap IS NULL
          OR v_user IS NULL
          OR (SELECT count(*) FROM public.ad_event e
               WHERE e.user_id = v_user AND e.ad_id = c.id
                 AND e.slot = pl.slot
                 AND e.event_type = 'impression'
                 AND e.created_at > now() - interval '24 hours') < pl.daily_cap
       )
  )
  SELECT r.id, r.ad_key, r.category, r.headline, r.body, r.glyph,
         r.target_url, r.cta_label
    FROM resolved r
   WHERE r.target_url IS NULL OR r.target_url NOT LIKE '%{%'
   ORDER BY r.weight DESC, r.created_at DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

do $$
declare
  v_def       text;
  v_club      uuid;
  v_templated int;
  v_broken    int;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'fn_resolve_ads';

  if v_def not like '%{clubId}%' then
    raise exception 'fn_resolve_ads did not take the club placeholder substitution';
  end if;

  if v_def not like '%e.slot = pl.slot%' then
    raise exception 'the per-surface frequency cap was lost in this rewrite';
  end if;

  select count(*) into v_templated
    from public.ad_catalog c
    join public.ad_placement pl on pl.ad_id = c.id
   where c.is_active and pl.is_active
     and coalesce(pl.target_url, c.target_url) like '%{%';
  if v_templated = 0 then
    raise notice 'no templated destinations remain; substitution is now a no-op guard';
  end if;

  select id into v_club from public.clubs order by created_at limit 1;
  if v_club is not null then
    select count(*) into v_broken
      from public.fn_resolve_ads('lobby_strip', v_club, 10) f
     where f.target_url like '%{%';
    if v_broken > 0 then
      raise exception '% lobby destination(s) still carry an unresolved placeholder', v_broken;
    end if;
  end if;
end $$;
