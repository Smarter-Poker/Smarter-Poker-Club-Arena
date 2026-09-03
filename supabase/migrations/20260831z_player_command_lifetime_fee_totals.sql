-- PLAYER COMMAND: LIFETIME FEE TOTALS ON THE READ PATH (2026-08-31)
--
-- Production evidence before this migration:
--   ca_club_members_page, SHARK CLUB, service-role REST
--     7.216s, 6.312s, then a 14.082s statement-timeout failure.
--
-- The roster rebuilt lifetime fees and hands from every daily/variant row in
-- member_fee_rollup on every page, search, filter and sort. SHARK CLUB has 593
-- members but that join reads 59,322 rollup rows. A transactional production
-- proof replacing that fan-out with one row per player reduced the default
-- page from 7.155s to 0.206s and a searched page to 0.178s.
--
-- member_fee_rollup remains canonical. This table is only its transactionally
-- maintained lifetime projection. Statement-level transition-table triggers
-- aggregate each refresh batch once, so the roster cannot make reporting work
-- proportional to account age.

LOCK TABLE public.member_fee_rollup IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.member_fee_lifetime (
  user_id uuid PRIMARY KEY,
  fees numeric NOT NULL DEFAULT 0,
  hands bigint NOT NULL DEFAULT 0 CHECK (hands >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.member_fee_lifetime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_fee_lifetime FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.member_fee_lifetime TO service_role;

INSERT INTO public.member_fee_lifetime (user_id, fees, hands, updated_at)
SELECT r.user_id,
       sum(r.fees),
       sum(r.hands)::bigint,
       max(r.updated_at)
  FROM public.member_fee_rollup r
 GROUP BY r.user_id
ON CONFLICT (user_id) DO UPDATE
SET fees = EXCLUDED.fees,
    hands = EXCLUDED.hands,
    updated_at = EXCLUDED.updated_at;

DELETE FROM public.member_fee_lifetime lifetime
 WHERE NOT EXISTS (
   SELECT 1 FROM public.member_fee_rollup daily WHERE daily.user_id = lifetime.user_id
 );

CREATE OR REPLACE FUNCTION public.fn_member_fee_lifetime_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.member_fee_lifetime AS lifetime (user_id, fees, hands, updated_at)
  SELECT r.user_id, sum(r.fees), sum(r.hands)::bigint, max(r.updated_at)
    FROM inserted_member_fees r
   GROUP BY r.user_id
  ON CONFLICT (user_id) DO UPDATE
  SET fees = lifetime.fees + EXCLUDED.fees,
      hands = lifetime.hands + EXCLUDED.hands,
      updated_at = greatest(lifetime.updated_at, EXCLUDED.updated_at);
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_member_fee_lifetime_after_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM previous_member_fees previous
     WHERE NOT EXISTS (
       SELECT 1 FROM public.member_fee_lifetime lifetime
        WHERE lifetime.user_id = previous.user_id
     )
  ) THEN
    RAISE EXCEPTION 'member_fee_lifetime is missing an updated source user';
  END IF;

  WITH changes AS (
    SELECT r.user_id, r.fees, r.hands, r.updated_at FROM updated_member_fees r
    UNION ALL
    SELECT r.user_id, -r.fees, -r.hands, r.updated_at FROM previous_member_fees r
  ), delta AS (
    SELECT c.user_id,
           sum(c.fees) AS fees,
           sum(c.hands)::bigint AS hands,
           max(c.updated_at) AS updated_at
      FROM changes c
     GROUP BY c.user_id
    HAVING sum(c.fees) <> 0 OR sum(c.hands) <> 0
  )
  UPDATE public.member_fee_lifetime lifetime
     SET fees = lifetime.fees + delta.fees,
         hands = lifetime.hands + delta.hands,
         updated_at = greatest(lifetime.updated_at, delta.updated_at)
    FROM delta
   WHERE lifetime.user_id = delta.user_id;

  -- A key change can introduce a new user. Existing users were adjusted above;
  -- only genuinely new positive rows reach this insert.
  INSERT INTO public.member_fee_lifetime AS lifetime (user_id, fees, hands, updated_at)
  WITH changes AS (
    SELECT r.user_id, r.fees, r.hands, r.updated_at FROM updated_member_fees r
    UNION ALL
    SELECT r.user_id, -r.fees, -r.hands, r.updated_at FROM previous_member_fees r
  ), delta AS (
    SELECT c.user_id,
           sum(c.fees) AS fees,
           sum(c.hands)::bigint AS hands,
           max(c.updated_at) AS updated_at
      FROM changes c
     GROUP BY c.user_id
    HAVING sum(c.fees) <> 0 OR sum(c.hands) <> 0
  )
  SELECT d.user_id, d.fees, d.hands, d.updated_at
    FROM delta d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.member_fee_lifetime existing WHERE existing.user_id = d.user_id
   )
  ON CONFLICT (user_id) DO UPDATE
  SET fees = lifetime.fees + EXCLUDED.fees,
      hands = lifetime.hands + EXCLUDED.hands,
      updated_at = greatest(lifetime.updated_at, EXCLUDED.updated_at);

  DELETE FROM public.member_fee_lifetime WHERE fees = 0 AND hands = 0;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_member_fee_lifetime_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM deleted_member_fees deleted
     WHERE NOT EXISTS (
       SELECT 1 FROM public.member_fee_lifetime lifetime
        WHERE lifetime.user_id = deleted.user_id
     )
  ) THEN
    RAISE EXCEPTION 'member_fee_lifetime is missing a deleted source user';
  END IF;

  WITH removed AS (
    SELECT r.user_id, sum(r.fees) AS fees, sum(r.hands)::bigint AS hands,
           max(r.updated_at) AS updated_at
    FROM deleted_member_fees r
    GROUP BY r.user_id
  )
  UPDATE public.member_fee_lifetime lifetime
     SET fees = lifetime.fees - removed.fees,
         hands = lifetime.hands - removed.hands,
         updated_at = greatest(lifetime.updated_at, removed.updated_at)
    FROM removed
   WHERE lifetime.user_id = removed.user_id;

  DELETE FROM public.member_fee_lifetime WHERE fees = 0 AND hands = 0;
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_member_fee_lifetime_after_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_member_fee_lifetime_after_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_member_fee_lifetime_after_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_member_fee_lifetime_after_insert ON public.member_fee_rollup;
DROP TRIGGER IF EXISTS trg_member_fee_lifetime_after_update ON public.member_fee_rollup;
DROP TRIGGER IF EXISTS trg_member_fee_lifetime_after_delete ON public.member_fee_rollup;

CREATE TRIGGER trg_member_fee_lifetime_after_insert
AFTER INSERT ON public.member_fee_rollup
REFERENCING NEW TABLE AS inserted_member_fees
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_member_fee_lifetime_after_insert();

CREATE TRIGGER trg_member_fee_lifetime_after_update
AFTER UPDATE ON public.member_fee_rollup
REFERENCING OLD TABLE AS previous_member_fees NEW TABLE AS updated_member_fees
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_member_fee_lifetime_after_update();

CREATE TRIGGER trg_member_fee_lifetime_after_delete
AFTER DELETE ON public.member_fee_rollup
REFERENCING OLD TABLE AS deleted_member_fees
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_member_fee_lifetime_after_delete();

-- Keep the authorization, hierarchy, wallet, presence and redaction body
-- byte-identical. Replace exactly the one daily fee aggregation CTE and fail
-- closed if its source has drifted.
DO $patch_roster$
DECLARE
  v_definition text;
  v_old text :=
E'  fees AS MATERIALIZED (\n'
'    SELECT r.user_id AS uid,\n'
'           sum(r.fees) AS fee_total,\n'
'           sum(r.hands)::bigint AS hand_total\n'
'      FROM public.member_fee_rollup r\n'
'      JOIN base b ON b.m_user_id = r.user_id\n'
'     GROUP BY r.user_id\n'
'  ),';
  v_new text :=
E'  fees AS MATERIALIZED (\n'
'    SELECT r.user_id AS uid,\n'
'           r.fees AS fee_total,\n'
'           r.hands AS hand_total\n'
'      FROM public.member_fee_lifetime r\n'
'      JOIN base b ON b.m_user_id = r.user_id\n'
'  ),';
BEGIN
  SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'ca_club_roster_rows(uuid) not found - refusing to guess';
  END IF;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'roster fee CTE was not found exactly once - refusing to patch blind';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END
$patch_roster$;

ANALYZE public.member_fee_lifetime;

-- The migration rolls back if the projection differs from its canonical rows
-- by one hand, one fraction, one user, or if the roster did not take the fast
-- path. This also proves horses are included: there is no identity-type filter.
DO $verify$
DECLARE
  v_definition text;
BEGIN
  IF EXISTS (
    WITH canonical AS (
      SELECT r.user_id, sum(r.fees) AS fees, sum(r.hands)::bigint AS hands
        FROM public.member_fee_rollup r
       GROUP BY r.user_id
    )
    SELECT 1
      FROM canonical c
      FULL JOIN public.member_fee_lifetime lifetime USING (user_id)
     WHERE c.fees IS DISTINCT FROM lifetime.fees
        OR c.hands IS DISTINCT FROM lifetime.hands
  ) THEN
    RAISE EXCEPTION 'member_fee_lifetime does not equal its canonical daily rollup';
  END IF;

  SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure)
    INTO v_definition;
  IF position('FROM public.member_fee_lifetime r' IN v_definition) = 0
     OR position('FROM public.member_fee_rollup r' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'ca_club_roster_rows did not move exclusively to the lifetime projection';
  END IF;
END
$verify$;

COMMENT ON TABLE public.member_fee_lifetime IS
  'Internal lifetime projection of member_fee_rollup maintained by statement triggers. Player Command reads one row per user; member_fee_rollup remains canonical.';
