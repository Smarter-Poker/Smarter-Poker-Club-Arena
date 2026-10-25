-- Production's state before 20261024223153 ran, on top of the October 23
-- fixture: the columns the rake-share readers read, a pg_cron stand-in, the
-- hand-written 520.52 row, and WooWoo's hands either side of the cutoff
-- (2026-10-24 22:21:59.97593 UTC). No credentials; a disposable database only.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE public.rake_attributions
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN rake_amount numeric,
  ADD COLUMN created_at timestamptz,
  ADD COLUMN rake_record_id uuid;
CREATE TABLE public.rake_records(id uuid PRIMARY KEY, created_at timestamptz);
CREATE FUNCTION public.fn_ca_launch_accounting_accepts(uuid, timestamptz)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint
  LANGUAGE sql AS $$ INSERT INTO cron.job(jobname, schedule, command) VALUES (p_name, p_schedule, p_command) RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(p_job bigint) RETURNS boolean
  LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobid = p_job; RETURN FOUND; END $$;
CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean
  LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobname = p_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job %', p_name; END IF; RETURN true; END $$;

-- Written by hand in production, with no migration.
INSERT INTO smarter_private.player_fee_redemptions
  (operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
VALUES ('woowoo-half-earned-rake-20261024', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  '69f2cefa-017d-49f3-ac3e-61505633747c', '2026-10-24', 52052,
  'Owner-directed (Dan, 2026-10-24): remove 50% of WooWoo''s current earned rake (1041.03 net after the Oct 23 redemption -> 520.52 removed) and stop crediting him for half of his fees. Reporting redemption only; no refund and no change to settled financial records.',
  '2026-10-24 22:21:59.97593+00');

-- A: before the cutoff (never shared). B: after it, funded by a KINGS buy-in
-- receipt. C: the next UTC day, funded through its rake attribution.
INSERT INTO public.ca_hand_facts VALUES
 ('69f2cefa-017d-49f3-ac3e-61505633747c','fade0000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a',null,'2026-10-24 20:00:00+00',7.00,0.5),
 ('69f2cefa-017d-49f3-ac3e-61505633747c','fade0000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000b',null,'2026-10-24 23:00:00+00',89.48,0.5),
 ('69f2cefa-017d-49f3-ac3e-61505633747c','fade0000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000000c',null,'2026-10-25 01:00:00+00',10.00,0.5);
INSERT INTO public.cash_participant_funding_receipts VALUES
 (gen_random_uuid(),'00000000-0000-0000-0000-0000000000b1','69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-24 22:59:00+00','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','buyin','2026-10-24 22:59:00+00');
INSERT INTO public.rake_attributions(hand_id, player_id, club_id, rake_amount, created_at) VALUES
 ('00000000-0000-0000-0000-00000000000a','69f2cefa-017d-49f3-ac3e-61505633747c','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',7.00,'2026-10-24 20:00:03+00'),
 ('00000000-0000-0000-0000-00000000000b','69f2cefa-017d-49f3-ac3e-61505633747c','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',89.48,'2026-10-24 23:00:03+00'),
 ('00000000-0000-0000-0000-00000000000c','69f2cefa-017d-49f3-ac3e-61505633747c','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',10.00,'2026-10-25 01:00:03+00');
INSERT INTO public.ca_club_rake_daily_user VALUES
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-24',700+8948),
 ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','69f2cefa-017d-49f3-ac3e-61505633747c','2026-10-25',1000);
