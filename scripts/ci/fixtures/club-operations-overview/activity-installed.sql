CREATE OR REPLACE FUNCTION public.ca_club_activity(p_club_id uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(id text, activity_type text, message text, created_at timestamp with time zone, user_id uuid, display_name text, avatar_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH events AS (
    (SELECT
       'join-' || cm.user_id::text AS id,
       'member_join'::text         AS activity_type,
       'joined the club'::text     AS message,
       cm.created_at               AS created_at,
       cm.user_id                  AS user_id
     FROM club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.created_at > now() - interval '30 days'
     ORDER BY cm.created_at DESC
     LIMIT 50)
    UNION ALL
    (SELECT
       'ann-' || an.id::text,
       'announcement',
       coalesce(nullif(an.title, ''), left(coalesce(an.content, an.message, 'New announcement'), 120)),
       an.created_at,
       coalesce(an.author_id, an.created_by)
     FROM club_announcements an
     WHERE an.club_id = p_club_id
       AND an.created_at > now() - interval '30 days'
       AND coalesce(an.is_active, true)
     ORDER BY an.created_at DESC
     LIMIT 20)
    UNION ALL
    (SELECT
       'hand-' || hh.id::text,
       'big_hand',
       'won a ' || to_char(coalesce(hh.pot_size, 0), 'FM999,999,990.00') || ' pot'
         || CASE WHEN hh.hand_name IS NOT NULL THEN ' with ' || hh.hand_name ELSE '' END,
       hh.created_at,
       CASE
         WHEN (hh.winners->0->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (hh.winners->0->>'userId')::uuid
         ELSE NULL
       END
     FROM hand_history hh
     JOIN tables t ON t.id = hh.table_id
     WHERE t.club_id = p_club_id
       AND hh.created_at > now() - interval '48 hours'
       AND coalesce(hh.pot_size, 0) >= 40 * greatest(coalesce(hh.big_blind, 0.02), 0.02)
     ORDER BY hh.created_at DESC
     LIMIT 30)
    UNION ALL
    (SELECT
       'table-' || t.id::text,
       'table_start',
       'Table "' || coalesce(t.name, 'Unnamed') || '" was created',
       t.created_at,
       t.created_by
     FROM tables t
     WHERE t.club_id = p_club_id
       AND t.created_at > now() - interval '7 days'
       AND coalesce(t.is_deleted, false) = false
     ORDER BY t.created_at DESC
     LIMIT 10)
  )
  SELECT
    e.id, e.activity_type, e.message, e.created_at, e.user_id,
    public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                         pr.first_name, pr.last_name, pr.full_name),
    pr.avatar_url
  FROM events e
  LEFT JOIN profiles pr ON pr.id = e.user_id
  WHERE e.created_at IS NOT NULL
  ORDER BY e.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
END;
$function$

