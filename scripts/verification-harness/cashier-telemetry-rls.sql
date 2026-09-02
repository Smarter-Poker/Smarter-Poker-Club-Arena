\set ON_ERROR_STOP on

-- Behavioral RLS probe. The row is written as the same authenticated role and
-- JWT shape the browser uses, then rolled back so production keeps no canary
-- debris. A missing grant, missing policy, wrong WITH CHECK, or FK mismatch
-- makes the post-deploy job fail.
SELECT cm.user_id::text AS canary_user_id, cm.club_id::text AS canary_club_id
FROM public.club_members cm
JOIN auth.users u ON u.id = cm.user_id
JOIN public.clubs c ON c.id = cm.club_id
WHERE coalesce(cm.status, 'active') IN ('active', 'approved')
ORDER BY cm.joined_at NULLS LAST, cm.user_id
LIMIT 1
\gset

\if :{?canary_user_id}
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'canary_user_id', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'canary_user_id', 'role', 'authenticated')::text,
  true
);

INSERT INTO public.cashier_operations (
  user_id,
  club_id,
  event,
  operation,
  duration_ms,
  item_count,
  page_number,
  sample_weight
) VALUES (
  :'canary_user_id'::uuid,
  :'canary_club_id'::uuid,
  'roster_page_succeeded',
  'roster',
  1,
  0,
  0,
  10
);

ROLLBACK;
SELECT 'cashier telemetry RLS: authenticated own-row insert verified and rolled back' AS result;
\else
\echo 'cashier telemetry RLS: no active production membership fixture exists'
\quit 1
\endif
