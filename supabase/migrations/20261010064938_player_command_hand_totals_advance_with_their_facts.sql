-- Exact retained hand totals, advanced atomically by the authoritative facts writer.
-- No scheduled refresh, financial write or change to fee/retention definitions.
-- Install the triggers in this short transaction BEFORE the separate snapshot seed.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE TABLE public.club_roster_hand_totals (
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  fees numeric NOT NULL DEFAULT 0,
  hands bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (club_id, user_id)
);
ALTER TABLE public.club_roster_hand_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_roster_hand_totals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.club_roster_hand_totals TO service_role;
CREATE TABLE public.club_roster_hand_totals_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initialized boolean NOT NULL DEFAULT false
);
INSERT INTO public.club_roster_hand_totals_state VALUES (true, false);
ALTER TABLE public.club_roster_hand_totals_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_roster_hand_totals_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.club_roster_hand_totals_state TO service_role;

CREATE FUNCTION public.fn_club_roster_hand_totals_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.club_roster_hand_totals AS totals (club_id,user_id,fees,hands)
  SELECT club_id,user_id,sum(fee),sum(n)::bigint
  FROM (SELECT club_id,user_id,rake_paid AS fee,1::bigint AS n FROM new_facts) changes
  WHERE club_id IS NOT NULL
  GROUP BY club_id,user_id
  HAVING sum(fee) <> 0 OR sum(n) <> 0
  ORDER BY club_id,user_id
  ON CONFLICT (club_id,user_id) DO UPDATE
    SET fees = totals.fees + EXCLUDED.fees,
        hands = totals.hands + EXCLUDED.hands;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_roster_hand_totals_insert() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_club_roster_hand_totals_insert
AFTER INSERT ON public.ca_hand_facts
REFERENCING NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_roster_hand_totals_insert();

CREATE FUNCTION public.fn_club_roster_hand_totals_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.club_roster_hand_totals AS totals (club_id,user_id,fees,hands)
  SELECT club_id,user_id,sum(fee),sum(n)::bigint
  FROM (SELECT club_id,user_id,rake_paid AS fee,1::bigint AS n FROM new_facts UNION ALL SELECT club_id,user_id,-rake_paid AS fee,(-1)::bigint AS n FROM old_facts) changes
  WHERE club_id IS NOT NULL
  GROUP BY club_id,user_id
  HAVING sum(fee) <> 0 OR sum(n) <> 0
  ORDER BY club_id,user_id
  ON CONFLICT (club_id,user_id) DO UPDATE
    SET fees = totals.fees + EXCLUDED.fees,
        hands = totals.hands + EXCLUDED.hands;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_roster_hand_totals_update() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_club_roster_hand_totals_update
AFTER UPDATE ON public.ca_hand_facts
REFERENCING OLD TABLE AS old_facts NEW TABLE AS new_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_roster_hand_totals_update();

CREATE FUNCTION public.fn_club_roster_hand_totals_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.club_roster_hand_totals AS totals (club_id,user_id,fees,hands)
  SELECT club_id,user_id,sum(fee),sum(n)::bigint
  FROM (SELECT club_id,user_id,-rake_paid AS fee,(-1)::bigint AS n FROM old_facts) changes
  WHERE club_id IS NOT NULL
  GROUP BY club_id,user_id
  HAVING sum(fee) <> 0 OR sum(n) <> 0
  ORDER BY club_id,user_id
  ON CONFLICT (club_id,user_id) DO UPDATE
    SET fees = totals.fees + EXCLUDED.fees,
        hands = totals.hands + EXCLUDED.hands;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_club_roster_hand_totals_delete() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_club_roster_hand_totals_delete
AFTER DELETE ON public.ca_hand_facts
REFERENCING OLD TABLE AS old_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_club_roster_hand_totals_delete();
COMMIT;
