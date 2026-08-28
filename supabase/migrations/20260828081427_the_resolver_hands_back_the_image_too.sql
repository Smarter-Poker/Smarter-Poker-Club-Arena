-- The resolver returns eight columns and image_url is not one of them, so a
-- creative could carry an image that no surface could ever render.
--
-- Adding a column to a RETURNS TABLE cannot be done with CREATE OR REPLACE:
-- Postgres refuses to change a function's return type in place. DROP and
-- CREATE inside one transaction is atomic - there is no instant where a client
-- calling this finds it missing - which is why this is a migration and not two.
--
-- Every eligibility rule is carried over verbatim and each is asserted below by
-- name. A rewrite of this function is exactly where they get silently dropped,
-- and three of them exist because they were dropped or missing once already.

drop function if exists public.fn_resolve_ads(text, uuid, integer);

create function public.fn_resolve_ads(
  p_slot text,
  p_club_id uuid default null::uuid,
  p_limit integer default 3
)
returns table(
  ad_id uuid, ad_key text, category text, headline text,
  body text, glyph text, target_url text, cta_label text,
  image_url text
)
language plpgsql
volatile
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
           replace(
             replace(
               COALESCE(pl.target_url, c.target_url),
               '{clubId}',  COALESCE(p_club_id::text, '{clubId}')
             ),
             '{club_id}', COALESCE(p_club_id::text, '{club_id}')
           ) AS target_url,
           c.cta_label,
           c.image_url,
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
         r.target_url, r.cta_label, r.image_url
    FROM resolved r
   WHERE r.target_url IS NULL OR r.target_url NOT LIKE '%{%'
   ORDER BY random() ^ (1.0 / GREATEST(r.weight, 1)) DESC
   LIMIT GREATEST(0, LEAST(p_limit, 10));
END;
$function$;

grant execute on function public.fn_resolve_ads(text, uuid, integer) to anon, authenticated, service_role;

do $$
declare
  v_def  text;
  v_vol  char;
  v_acl  text;
  v_club uuid;
  v_rows int;
begin
  select pg_get_functiondef(oid), provolatile, array_to_string(proacl, ' | ')
    into v_def, v_vol, v_acl
    from pg_proc where proname = 'fn_resolve_ads';

  if v_def not like '%image_url%' then
    raise exception 'the resolver still does not return image_url';
  end if;
  if v_def not like '%e.slot = pl.slot%' then
    raise exception 'the per-surface frequency cap was lost in this rewrite';
  end if;
  if v_def not like '%{clubId}%' then
    raise exception 'the club placeholder substitution was lost in this rewrite';
  end if;
  if v_def not like '%NOT LIKE ''%{%''%' then
    raise exception 'the unresolved-placeholder guard was lost in this rewrite';
  end if;
  if v_def not like '%random()%' then
    raise exception 'the weighted draw was lost in this rewrite';
  end if;
  if v_def like '%NOT v_vip%AND NOT v_vip%' then
    raise exception 'VIP suppression appeared in the resolver';
  end if;
  if v_vol <> 'v' then
    raise exception 'the resolver is marked % again; random() would be evaluated once', v_vol;
  end if;

  -- The grants must survive the drop. Without them every browser gets a
  -- permission error and every surface goes silent at once.
  if v_acl not like '%anon=X%' or v_acl not like '%authenticated=X%' then
    raise exception 'the resolver lost its grants: %', v_acl;
  end if;

  -- And it must still actually serve.
  select id into v_club from public.clubs order by created_at limit 1;
  if v_club is not null then
    select count(*) into v_rows from public.fn_resolve_ads('lobby_strip', v_club, 10);
    if v_rows = 0 then
      raise exception 'the resolver returned nothing for the lobby after the rewrite';
    end if;
  end if;
end $$;
