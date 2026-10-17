-- PRIVATE ISOLATED POSTGRESQL ONLY. Current prerequisite slice read October17.
DO $guard$ BEGIN IF current_database()<>'diamond_concurrency' OR inet_server_addr() IS NOT NULL THEN RAISE EXCEPTION 'isolated current Diamond qualification only'; END IF; END $guard$;
-- Isolated fixture slice, read back October 17. No production execution.
CREATE TABLE public.ca_operator_floor_hold(id boolean PRIMARY KEY DEFAULT true CHECK(id),operation_id uuid NOT NULL,mode text NOT NULL CHECK(mode IN ('pause','park')),reason text NOT NULL,held_since timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '1 hour'));
ALTER TABLE public.ca_operator_floor_hold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_operator_floor_hold FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.ca_operator_floor_hold TO service_role;
CREATE TABLE public.ca_launch_operator_scopes(operation_id uuid PRIMARY KEY,actor_id uuid NOT NULL,club_ids uuid[] NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.ca_launch_operator_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_launch_operator_scopes FROM PUBLIC,anon,authenticated,service_role;

-- Isolated schema slice. Staff read policies are qualified separately, not by this service-only money fixture.
CREATE TABLE public.tournament_ticket_entry_targets (
  ticket_id       uuid PRIMARY KEY,
  tournament_id   uuid NOT NULL,
  club_id         uuid NOT NULL,
  issued_by       uuid NOT NULL,
  holder_id       uuid NOT NULL,
  value           numeric(15,2) NOT NULL CHECK (value > 0),
  entry_prize     numeric(15,2) NOT NULL CHECK (entry_prize >= 0),
  entry_bounty    numeric(15,2) NOT NULL CHECK (entry_bounty >= 0),
  entry_fee       numeric(15,2) NOT NULL CHECK (entry_fee >= 0),
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_ticket_entry_targets_price_is_the_split
    CHECK (value = round(entry_prize + entry_bounty + entry_fee, 2)),
  CONSTRAINT tournament_ticket_entry_targets_holder_is_not_issuer
    CHECK (holder_id <> issued_by)
);
ALTER TABLE public.tournament_ticket_entry_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_ticket_entry_targets FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.tournament_ticket_entry_targets TO authenticated;
GRANT ALL ON public.tournament_ticket_entry_targets TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_ticket_entry_target_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'a cashier ticket''s tournament binding is immutable'
    USING ERRCODE = '55000';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_ticket_entry_target_is_immutable()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER tournament_ticket_entry_targets_are_immutable
  BEFORE UPDATE OR DELETE ON public.tournament_ticket_entry_targets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_ticket_entry_target_is_immutable();
