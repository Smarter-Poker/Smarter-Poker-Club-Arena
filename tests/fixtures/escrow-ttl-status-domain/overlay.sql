-- Rehearsal overlay: production's exact chip_escrow_holds / ca_ledger_accounts
-- shape, the cron.job row that drives the sweep, and the sweep's INSTALLED
-- PREIMAGE (status = 'active'), so RED can be measured before the candidate.
-- Shapes copied from production kuklfnapbkmacvwxktbh on 2026-09-25.
BEGIN;

CREATE TABLE IF NOT EXISTS public.chip_escrow_holds (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  wallet_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  club_id         uuid,
  hold_type       text NOT NULL,
  related_id      uuid,
  amount          numeric(20,4) NOT NULL,
  currency        text NOT NULL DEFAULT 'CHIPS'::text,
  status          text NOT NULL DEFAULT 'held'::text,
  expires_at      timestamptz NOT NULL,
  released_at     timestamptz,
  released_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chip_escrow_holds_pkey PRIMARY KEY (id),
  CONSTRAINT chip_escrow_holds_amount_check CHECK ((amount > (0)::numeric)),
  CONSTRAINT chk_amount_is_two_decimal_places CHECK (((amount IS NULL) OR (amount = round(amount, 2)))),
  CONSTRAINT chip_escrow_holds_hold_type_check CHECK ((hold_type = ANY (ARRAY['tournament_register'::text, 'cashout_pending'::text, 'inter_club_transfer'::text, 'bomb_pot_ante'::text, 'rebuy_pending'::text, 'other'::text]))),
  CONSTRAINT chip_escrow_holds_status_check CHECK ((status = ANY (ARRAY['held'::text, 'released'::text, 'captured'::text, 'expired'::text]))),
  CONSTRAINT chip_escrow_holds_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE SET NULL,
  CONSTRAINT chip_escrow_holds_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT chip_escrow_holds_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_escrow_user_status ON public.chip_escrow_holds USING btree (user_id, status);
CREATE INDEX IF NOT EXISTS idx_escrow_club_type ON public.chip_escrow_holds USING btree (club_id, hold_type);
CREATE INDEX IF NOT EXISTS idx_chip_escrow_holds_wallet_id ON public.chip_escrow_holds USING btree (wallet_id);

CREATE OR REPLACE FUNCTION public.touch_chip_escrow_holds()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$;
DROP TRIGGER IF EXISTS trg_chip_escrow_holds_updated ON public.chip_escrow_holds;
CREATE TRIGGER trg_chip_escrow_holds_updated BEFORE UPDATE ON public.chip_escrow_holds
  FOR EACH ROW EXECUTE FUNCTION public.touch_chip_escrow_holds();
DROP TRIGGER IF EXISTS trg_guard_retired_club_mutation ON public.chip_escrow_holds;
CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.chip_escrow_holds
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_club_mutation();

CREATE TABLE IF NOT EXISTS public.ca_ledger_accounts (
  account_type text NOT NULL,
  side         text NOT NULL,
  backing      text NOT NULL,
  must_be_zero boolean NOT NULL DEFAULT false,
  notes        text,
  CONSTRAINT ca_ledger_accounts_pkey PRIMARY KEY (account_type),
  CONSTRAINT ca_ledger_accounts_side_check CHECK ((side = ANY (ARRAY['asset'::text, 'liability'::text, 'system'::text])))
);
INSERT INTO public.ca_ledger_accounts (account_type, side, backing, must_be_zero, notes) VALUES
 ('escrow','liability','chip_escrow_holds.amount (active)',false,'held chips'),
 ('settlement_suspense','system','(none — flow account)',true,'must net to zero; never a place to hide drift')
ON CONFLICT (account_type) DO NOTHING;

-- pg_cron is not installed on this native cluster. The sweep's driver is a
-- cron.job ROW, and the candidate asserts on that row, so the row's shape is
-- carried here exactly as production holds it.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (
  jobid    bigint PRIMARY KEY,
  schedule text NOT NULL,
  command  text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT 'postgres',
  username text NOT NULL DEFAULT 'postgres',
  active   boolean NOT NULL DEFAULT true,
  jobname  text
);
INSERT INTO cron.job (jobid, schedule, command, jobname) VALUES
 (171, '*/10 * * * *',
  ' SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-escrow-ttl''))
    THEN (SELECT public.fn_ca_escrow_ttl_sweep()) ELSE -1 END; ',
  'ca-escrow-ttl-sweep-10m'),
 (236, '35 * * * *', ' SELECT 1; ', 'ca-escrow-shadow-hourly')
ON CONFLICT (jobid) DO NOTHING;

-- The two discovery cursors the Sept 28 book reads, at their production values.
-- Fixture scaffolding, not balance movement: the estate's auto-ledger triggers
-- journal real deltas and these rows are shape. Reset before the COMMIT.
SET LOCAL session_replication_role = replica;

INSERT INTO public.clubs (id, name)
VALUES ('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', 'Deep Stack Society')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.unions (id, name, owner_id, slug)
SELECT 'fade0000-0000-0000-0000-000000000001', 'Midway Union', u.id, 'midway-union'
  FROM auth.users u ORDER BY u.id LIMIT 1
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.union_settlement_floor (union_id, earliest_period_start, reason)
VALUES ('fade0000-0000-0000-0000-000000000001', timestamptz '2026-09-21T07:00:00Z',
        'rehearsal: production cursor, carried so the candidate can prove it does not move it')
ON CONFLICT DO NOTHING;
INSERT INTO public.club_settlement_floor (club_id, earliest_period_start, reason)
VALUES ('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', timestamptz '2026-09-21T07:00:00Z',
        'rehearsal: production cursor, carried so the candidate can prove it does not move it')
ON CONFLICT DO NOTHING;

SET LOCAL session_replication_role = origin;

-- THE INSTALLED PREIMAGE, byte-for-byte from production's pg_get_functiondef
-- on 2026-09-25 12:55 UTC. This is the RED state.
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_ttl_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r RECORD; n int := 0;
BEGIN
  FOR r IN
    SELECT * FROM chip_escrow_holds
     WHERE status = 'active' AND expires_at IS NOT NULL
       AND expires_at < now() - interval '10 minutes'
     LIMIT 25
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_escrow_ttl_sweep', 'settlement_error', 'warning',
      'escrow-expired:' || r.id::text,
      r.amount, r.amount, 0, 'settlement', 'chip_escrow_holds', r.user_id,
      r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'escrow hold (' || r.hold_type || ') expired ' ||
        floor(extract(epoch FROM now() - r.expires_at)/60) || ' min ago but was never released',
      NULL, jsonb_build_object('hold_id', r.id, 'hold_type', r.hold_type,
                               'related_id', r.related_id, 'expires_at', r.expires_at));
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

COMMIT;
