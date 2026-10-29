 SELECT r.tournament_id,
    r.club_id,
    r.amount,
    r.source,
    r.settled_at,
    r.attributed_at,
    r.attributed_users,
    r.attribution_error,
    t.tournament_type,
    t.variant,
    t.name,
    t.buy_in_amount,
        CASE
            WHEN (r.attributed_users IS NULL) THEN 'never_measured'::text
            WHEN (r.attributed_users = '-1'::integer) THEN 'attribution_threw'::text
            WHEN (r.attributed_users = 0) THEN 'credited_nobody'::text
            ELSE 'ok'::text
        END AS verdict
   FROM (tournament_rake_settlements r
     LEFT JOIN tournaments t ON ((t.id = r.tournament_id)))
  WHERE ((r.settled_at IS NOT NULL) AND (r.amount > (0)::numeric) AND ((r.attributed_users IS NULL) OR (r.attributed_users <= 0)));