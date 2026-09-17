SET search_path=pg_catalog,public,extensions;
SET check_function_bodies=false;
CREATE TABLE IF NOT EXISTS "auth"."users" ();
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "instance_id" uuid;
ALTER TABLE "auth"."users" ALTER COLUMN "instance_id" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "instance_id" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "auth"."users" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "aud" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "aud" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "aud" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "role" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "email" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "email" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "encrypted_password" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "encrypted_password" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "encrypted_password" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "email_confirmed_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "email_confirmed_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "email_confirmed_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "invited_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "invited_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "invited_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "confirmation_token" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "confirmation_token" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "confirmation_token" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "confirmation_sent_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "confirmation_sent_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "confirmation_sent_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "recovery_token" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "recovery_token" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "recovery_token" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "recovery_sent_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "recovery_sent_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "recovery_sent_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "email_change_token_new" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_token_new" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_token_new" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "email_change" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "email_change" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "email_change" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "email_change_sent_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_sent_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_sent_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "last_sign_in_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "last_sign_in_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "last_sign_in_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "raw_app_meta_data" jsonb;
ALTER TABLE "auth"."users" ALTER COLUMN "raw_app_meta_data" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "raw_app_meta_data" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "raw_user_meta_data" jsonb;
ALTER TABLE "auth"."users" ALTER COLUMN "raw_user_meta_data" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "raw_user_meta_data" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "is_super_admin" boolean;
ALTER TABLE "auth"."users" ALTER COLUMN "is_super_admin" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "is_super_admin" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "created_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "auth"."users" ALTER COLUMN "phone" SET DEFAULT NULL::character varying;
ALTER TABLE "auth"."users" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "phone_confirmed_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "phone_confirmed_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "phone_confirmed_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "phone_change" text;
ALTER TABLE "auth"."users" ALTER COLUMN "phone_change" SET DEFAULT ''::character varying;
ALTER TABLE "auth"."users" ALTER COLUMN "phone_change" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "phone_change_token" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "phone_change_token" SET DEFAULT ''::character varying;
ALTER TABLE "auth"."users" ALTER COLUMN "phone_change_token" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "phone_change_sent_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "phone_change_sent_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "phone_change_sent_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "email_change_token_current" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_token_current" SET DEFAULT ''::character varying;
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_token_current" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "email_change_confirm_status" smallint;
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_confirm_status" SET DEFAULT 0;
ALTER TABLE "auth"."users" ALTER COLUMN "email_change_confirm_status" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "banned_until" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "banned_until" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "banned_until" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "reauthentication_token" character varying(255);
ALTER TABLE "auth"."users" ALTER COLUMN "reauthentication_token" SET DEFAULT ''::character varying;
ALTER TABLE "auth"."users" ALTER COLUMN "reauthentication_token" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "reauthentication_sent_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "reauthentication_sent_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "reauthentication_sent_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "is_sso_user" boolean;
ALTER TABLE "auth"."users" ALTER COLUMN "is_sso_user" SET DEFAULT false;
ALTER TABLE "auth"."users" ALTER COLUMN "is_sso_user" SET NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "auth"."users" ALTER COLUMN "deleted_at" DROP DEFAULT;
ALTER TABLE "auth"."users" ALTER COLUMN "deleted_at" DROP NOT NULL;
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "is_anonymous" boolean;
ALTER TABLE "auth"."users" ALTER COLUMN "is_anonymous" SET DEFAULT false;
ALTER TABLE "auth"."users" ALTER COLUMN "is_anonymous" SET NOT NULL;
ALTER TABLE "auth"."users" OWNER TO "supabase_auth_admin";
ALTER TABLE "auth"."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth"."users" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "auth"."users" DROP CONSTRAINT IF EXISTS "users_email_change_confirm_status_check" RESTRICT;
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_email_change_confirm_status_check" CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"auth"."users"'::regclass AND conname='users_phone_key';
 IF actual IS NULL THEN
  ALTER TABLE "auth"."users" ADD CONSTRAINT "users_phone_key" UNIQUE (phone);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (phone)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"auth"."users"', 'users_phone_key';
END IF; END $c$;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"auth"."users"'::regclass AND conname='users_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "auth"."users" ADD CONSTRAINT "users_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"auth"."users"', 'users_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('auth.confirmation_token_idx') IS NULL THEN CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.email_change_token_current_idx') IS NULL THEN CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.email_change_token_new_idx') IS NULL THEN CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.reauthentication_token_idx') IS NULL THEN CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.recovery_token_idx') IS NULL THEN CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.users_email_partial_key') IS NULL THEN CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.users_instance_id_email_idx') IS NULL THEN CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, lower((email)::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.users_instance_id_idx') IS NULL THEN CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.users_is_anonymous_idx') IS NULL THEN CREATE INDEX users_is_anonymous_idx ON auth.users USING btree (is_anonymous); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.users_phone_key') IS NULL THEN CREATE UNIQUE INDEX users_phone_key ON auth.users USING btree (phone); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('auth.users_pkey') IS NULL THEN CREATE UNIQUE INDEX users_pkey ON auth.users USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."agent_commission_settlements" ();
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "union_id" DROP NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "period_start" timestamp with time zone;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "period_start" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "period_start" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "period_end" timestamp with time zone;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "period_end" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "period_end" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "amount" numeric;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "amount" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "rows_count" integer;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "rows_count" SET DEFAULT 0;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "rows_count" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "paid_at" SET DEFAULT now();
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "paid_at" SET NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" ADD COLUMN IF NOT EXISTS "settlement_ref" text;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "settlement_ref" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_settlements" ALTER COLUMN "settlement_ref" DROP NOT NULL;
ALTER TABLE "public"."agent_commission_settlements" OWNER TO "postgres";
ALTER TABLE "public"."agent_commission_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."agent_commission_settlements" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."agent_commission_settlements" DROP CONSTRAINT IF EXISTS "agent_commission_settlements_amount_check" RESTRICT;
ALTER TABLE "public"."agent_commission_settlements" ADD CONSTRAINT "agent_commission_settlements_amount_check" CHECK (((amount >= (0)::numeric) AND (amount = round(amount, 2))));
ALTER TABLE "public"."agent_commission_settlements" DROP CONSTRAINT IF EXISTS "agent_commission_settlements_check" RESTRICT;
ALTER TABLE "public"."agent_commission_settlements" ADD CONSTRAINT "agent_commission_settlements_check" CHECK ((period_end > period_start));
ALTER TABLE "public"."agent_commission_settlements" DROP CONSTRAINT IF EXISTS "agent_commission_settlements_club_id_fkey" RESTRICT;
ALTER TABLE "public"."agent_commission_settlements" ADD CONSTRAINT "agent_commission_settlements_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."agent_commission_settlements"'::regclass AND conname='agent_commission_settlements_club_id_user_id_period_start_p_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."agent_commission_settlements" ADD CONSTRAINT "agent_commission_settlements_club_id_user_id_period_start_p_key" UNIQUE (club_id, user_id, period_start, period_end);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (club_id, user_id, period_start, period_end)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."agent_commission_settlements"', 'agent_commission_settlements_club_id_user_id_period_start_p_key';
END IF; END $c$;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."agent_commission_settlements"'::regclass AND conname='agent_commission_settlements_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."agent_commission_settlements" ADD CONSTRAINT "agent_commission_settlements_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."agent_commission_settlements"', 'agent_commission_settlements_pkey';
END IF; END $c$;
ALTER TABLE "public"."agent_commission_settlements" DROP CONSTRAINT IF EXISTS "chk_amount_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."agent_commission_settlements" ADD CONSTRAINT "chk_amount_is_two_decimal_places" CHECK (((amount IS NULL) OR (amount = round(amount, 2))));
DO $i$ BEGIN IF to_regclass('public.agent_commission_settlements_club_id_user_id_period_start_p_key') IS NULL THEN CREATE UNIQUE INDEX agent_commission_settlements_club_id_user_id_period_start_p_key ON public.agent_commission_settlements USING btree (club_id, user_id, period_start, period_end); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.agent_commission_settlements_pair_idx') IS NULL THEN CREATE INDEX agent_commission_settlements_pair_idx ON public.agent_commission_settlements USING btree (club_id, user_id, period_start, period_end); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.agent_commission_settlements_pkey') IS NULL THEN CREATE UNIQUE INDEX agent_commission_settlements_pkey ON public.agent_commission_settlements USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."agent_commission_unsettled_rollup" ();
ALTER TABLE "public"."agent_commission_unsettled_rollup" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ADD COLUMN IF NOT EXISTS "owed" numeric;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "owed" SET DEFAULT 0;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "owed" SET NOT NULL;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ADD COLUMN IF NOT EXISTS "rows_behind" bigint;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "rows_behind" SET DEFAULT 0;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "rows_behind" SET NOT NULL;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ADD COLUMN IF NOT EXISTS "oldest_unsettled" timestamp with time zone;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "oldest_unsettled" DROP DEFAULT;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "oldest_unsettled" DROP NOT NULL;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."agent_commission_unsettled_rollup" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "public"."agent_commission_unsettled_rollup" OWNER TO "postgres";
ALTER TABLE "public"."agent_commission_unsettled_rollup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."agent_commission_unsettled_rollup" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."agent_commission_unsettled_rollup"'::regclass AND conname='agent_commission_unsettled_rollup_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."agent_commission_unsettled_rollup" ADD CONSTRAINT "agent_commission_unsettled_rollup_pkey" PRIMARY KEY (club_id, user_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (club_id, user_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."agent_commission_unsettled_rollup"', 'agent_commission_unsettled_rollup_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.agent_commission_unsettled_rollup_pkey') IS NULL THEN CREATE UNIQUE INDEX agent_commission_unsettled_rollup_pkey ON public.agent_commission_unsettled_rollup USING btree (club_id, user_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."agent_commissions" ();
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "amount" numeric;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "amount" SET DEFAULT 0;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "amount" DROP NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "commission_rate" numeric;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "commission_rate" SET DEFAULT 0.1;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "commission_rate" DROP NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "source_type" text;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "source_type" SET DEFAULT 'rake'::text;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "source_type" DROP NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "source_id" uuid;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "source_id" DROP DEFAULT;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "source_id" DROP NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "notes" DROP DEFAULT;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "notes" DROP NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."agent_commissions" ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "settled_at" DROP DEFAULT;
ALTER TABLE "public"."agent_commissions" ALTER COLUMN "settled_at" DROP NOT NULL;
ALTER TABLE "public"."agent_commissions" OWNER TO "postgres";
ALTER TABLE "public"."agent_commissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."agent_commissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."agent_commissions" DROP CONSTRAINT IF EXISTS "agent_commissions_club_id_fkey" RESTRICT;
ALTER TABLE "public"."agent_commissions" ADD CONSTRAINT "agent_commissions_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."agent_commissions"'::regclass AND conname='agent_commissions_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."agent_commissions" ADD CONSTRAINT "agent_commissions_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."agent_commissions"', 'agent_commissions_pkey';
END IF; END $c$;
ALTER TABLE "public"."agent_commissions" DROP CONSTRAINT IF EXISTS "agent_commissions_user_id_fkey" RESTRICT;
ALTER TABLE "public"."agent_commissions" ADD CONSTRAINT "agent_commissions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE "public"."agent_commissions" DROP CONSTRAINT IF EXISTS "chk_amount_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."agent_commissions" ADD CONSTRAINT "chk_amount_is_two_decimal_places" CHECK (((amount IS NULL) OR (amount = round(amount, 2))));
ALTER TABLE "public"."agent_commissions" DROP CONSTRAINT IF EXISTS "ck_whole_cents" RESTRICT;
ALTER TABLE "public"."agent_commissions" ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID;
DO $i$ BEGIN IF to_regclass('public.agent_commissions_open_idx') IS NULL THEN CREATE INDEX agent_commissions_open_idx ON public.agent_commissions USING btree (club_id, user_id, created_at) INCLUDE (amount, id) WHERE (settled_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.agent_commissions_pkey') IS NULL THEN CREATE UNIQUE INDEX agent_commissions_pkey ON public.agent_commissions USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.agent_commissions_unsettled_idx') IS NULL THEN CREATE INDEX agent_commissions_unsettled_idx ON public.agent_commissions USING btree (club_id, user_id) INCLUDE (amount, created_at) WHERE (settled_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.agent_commissions_user_recent_idx') IS NULL THEN CREATE INDEX agent_commissions_user_recent_idx ON public.agent_commissions USING btree (user_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_agent_commissions_club_created') IS NULL THEN CREATE INDEX idx_agent_commissions_club_created ON public.agent_commissions USING btree (club_id, created_at) INCLUDE (user_id, amount, settled_at); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_agent_commissions_club_id') IS NULL THEN CREATE INDEX idx_agent_commissions_club_id ON public.agent_commissions USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_agent_commissions_source_lookup') IS NULL THEN CREATE INDEX idx_agent_commissions_source_lookup ON public.agent_commissions USING btree (source_id, source_type, club_id) WHERE (source_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_agent_commissions_user') IS NULL THEN CREATE INDEX idx_agent_commissions_user ON public.agent_commissions USING btree (user_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.uq_agent_commissions_source') IS NULL THEN CREATE UNIQUE INDEX uq_agent_commissions_source ON public.agent_commissions USING btree (user_id, source_id, source_type) WHERE (source_id IS NOT NULL); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."agents" ();
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."agents" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."agents" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."agents" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."agents" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "membership_id" uuid;
ALTER TABLE "public"."agents" ALTER COLUMN "membership_id" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "membership_id" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "public"."agents" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "role" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."agents" ALTER COLUMN "status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."agents" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "parent_agent_id" uuid;
ALTER TABLE "public"."agents" ALTER COLUMN "parent_agent_id" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "parent_agent_id" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "commission_rate" numeric(5,4);
ALTER TABLE "public"."agents" ALTER COLUMN "commission_rate" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "commission_rate" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "player_rakeback_rate" numeric(5,4);
ALTER TABLE "public"."agents" ALTER COLUMN "player_rakeback_rate" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "player_rakeback_rate" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "credit_limit" numeric(15,2);
ALTER TABLE "public"."agents" ALTER COLUMN "credit_limit" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "credit_limit" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "credit_used" numeric(15,2);
ALTER TABLE "public"."agents" ALTER COLUMN "credit_used" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "credit_used" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "is_prepaid" boolean;
ALTER TABLE "public"."agents" ALTER COLUMN "is_prepaid" SET DEFAULT false;
ALTER TABLE "public"."agents" ALTER COLUMN "is_prepaid" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "business_balance" numeric(15,2);
ALTER TABLE "public"."agents" ALTER COLUMN "business_balance" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "business_balance" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "player_balance" numeric(15,2);
ALTER TABLE "public"."agents" ALTER COLUMN "player_balance" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "player_balance" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "promo_balance" numeric(15,2);
ALTER TABLE "public"."agents" ALTER COLUMN "promo_balance" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "promo_balance" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "total_players" integer;
ALTER TABLE "public"."agents" ALTER COLUMN "total_players" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "total_players" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "active_player_count" integer;
ALTER TABLE "public"."agents" ALTER COLUMN "active_player_count" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "active_player_count" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "sub_agent_count" integer;
ALTER TABLE "public"."agents" ALTER COLUMN "sub_agent_count" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "sub_agent_count" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "weekly_rake_generated" numeric(15,2);
ALTER TABLE "public"."agents" ALTER COLUMN "weekly_rake_generated" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "weekly_rake_generated" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "lifetime_earnings" numeric(15,2);
ALTER TABLE "public"."agents" ALTER COLUMN "lifetime_earnings" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "lifetime_earnings" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "joined_at" timestamp with time zone;
ALTER TABLE "public"."agents" ALTER COLUMN "joined_at" SET DEFAULT now();
ALTER TABLE "public"."agents" ALTER COLUMN "joined_at" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "last_active_at" timestamp with time zone;
ALTER TABLE "public"."agents" ALTER COLUMN "last_active_at" DROP DEFAULT;
ALTER TABLE "public"."agents" ALTER COLUMN "last_active_at" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."agents" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."agents" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."agents" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."agents" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "auto_rakeback_enabled" boolean;
ALTER TABLE "public"."agents" ALTER COLUMN "auto_rakeback_enabled" SET DEFAULT true;
ALTER TABLE "public"."agents" ALTER COLUMN "auto_rakeback_enabled" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "rakeback_percentage" numeric(5,4);
ALTER TABLE "public"."agents" ALTER COLUMN "rakeback_percentage" SET DEFAULT 0.0000;
ALTER TABLE "public"."agents" ALTER COLUMN "rakeback_percentage" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "agent_wallet_balance" numeric(18,2);
ALTER TABLE "public"."agents" ALTER COLUMN "agent_wallet_balance" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "agent_wallet_balance" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "player_wallet_balance" numeric(18,4);
ALTER TABLE "public"."agents" ALTER COLUMN "player_wallet_balance" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "player_wallet_balance" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "promo_wallet_balance" numeric(18,2);
ALTER TABLE "public"."agents" ALTER COLUMN "promo_wallet_balance" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "promo_wallet_balance" DROP NOT NULL;
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "lifetime_rake_generated" numeric(18,4);
ALTER TABLE "public"."agents" ALTER COLUMN "lifetime_rake_generated" SET DEFAULT 0;
ALTER TABLE "public"."agents" ALTER COLUMN "lifetime_rake_generated" DROP NOT NULL;
ALTER TABLE "public"."agents" OWNER TO "postgres";
ALTER TABLE "public"."agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."agents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_agent_wallet_balance_nonneg" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_agent_wallet_balance_nonneg" CHECK ((agent_wallet_balance >= (0)::numeric));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_club_id_fkey" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."agents"'::regclass AND conname='agents_club_id_user_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_club_id_user_id_key" UNIQUE (club_id, user_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (club_id, user_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."agents"', 'agents_club_id_user_id_key';
END IF; END $c$;
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_commission_rate_check" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_commission_rate_check" CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= 0.70)));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_credit_used_check" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_credit_used_check" CHECK ((credit_used >= (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."agents"'::regclass AND conname='agents_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."agents"', 'agents_pkey';
END IF; END $c$;
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_player_rakeback_rate_check" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_player_rakeback_rate_check" CHECK (((player_rakeback_rate >= (0)::numeric) AND (player_rakeback_rate <= 0.50)));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_promo_wallet_balance_nonneg" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_promo_wallet_balance_nonneg" CHECK ((promo_wallet_balance >= (0)::numeric));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_role_check" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_role_check" CHECK ((role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text])));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "agents_status_check" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text])));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "check_credit" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "check_credit" CHECK (((credit_used <= credit_limit) OR (is_prepaid = true)));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "chk_player_wallet_balance_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "chk_player_wallet_balance_is_two_decimal_places" CHECK (((player_wallet_balance IS NULL) OR (player_wallet_balance = round(player_wallet_balance, 2))));
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "fk_agents_parent" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "fk_agents_parent" FOREIGN KEY (parent_agent_id) REFERENCES agents(id);
ALTER TABLE "public"."agents" DROP CONSTRAINT IF EXISTS "fk_agents_user_id_profiles" RESTRICT;
ALTER TABLE "public"."agents" ADD CONSTRAINT "fk_agents_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
DO $i$ BEGIN IF to_regclass('public.agents_club_id_user_id_key') IS NULL THEN CREATE UNIQUE INDEX agents_club_id_user_id_key ON public.agents USING btree (club_id, user_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.agents_pkey') IS NULL THEN CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_agents_club') IS NULL THEN CREATE INDEX idx_agents_club ON public.agents USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_agents_parent') IS NULL THEN CREATE INDEX idx_agents_parent ON public.agents USING btree (parent_agent_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_agents_user') IS NULL THEN CREATE INDEX idx_agents_user ON public.agents USING btree (user_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."bbj_pools" ();
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "union_id" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "pool_amount" numeric(14,2);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "pool_amount" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "pool_amount" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "hands_contributed" bigint;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "hands_contributed" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "hands_contributed" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "last_hit_at" timestamp with time zone;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_hit_at" DROP DEFAULT;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_hit_at" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "last_hit_amount" numeric(14,2);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_hit_amount" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_hit_amount" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "last_winner_id" uuid;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_winner_id" DROP DEFAULT;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_winner_id" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "main_balance" numeric(14,2);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "main_balance" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "main_balance" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "backup_balance" numeric(14,2);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "backup_balance" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "backup_balance" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "promo_balance" numeric(14,2);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "promo_balance" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "promo_balance" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "total_contributed" numeric;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "total_contributed" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "total_contributed" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "total_paid_out" numeric(15,2);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "total_paid_out" SET DEFAULT 0.00;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "total_paid_out" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "hit_count" integer;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "hit_count" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "hit_count" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "last_loser_id" uuid;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_loser_id" DROP DEFAULT;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "last_loser_id" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "merged_into_pool_id" uuid;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "merged_into_pool_id" DROP DEFAULT;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "merged_into_pool_id" DROP NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "alloc_cum_amount" numeric(14,4);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "alloc_cum_amount" SET DEFAULT 0;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "alloc_cum_amount" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "mini_reserve_floor" numeric(14,2);
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "mini_reserve_floor" SET DEFAULT fn_bbj_default_mini_floor();
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "mini_reserve_floor" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" ADD COLUMN IF NOT EXISTS "mini_enabled" boolean;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "mini_enabled" SET DEFAULT true;
ALTER TABLE "public"."bbj_pools" ALTER COLUMN "mini_enabled" SET NOT NULL;
ALTER TABLE "public"."bbj_pools" OWNER TO "postgres";
ALTER TABLE "public"."bbj_pools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."bbj_pools" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."bbj_pools" DROP CONSTRAINT IF EXISTS "bbj_pools_backup_balance_nonneg" RESTRICT;
ALTER TABLE "public"."bbj_pools" ADD CONSTRAINT "bbj_pools_backup_balance_nonneg" CHECK ((backup_balance >= (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."bbj_pools"'::regclass AND conname='bbj_pools_club_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."bbj_pools" ADD CONSTRAINT "bbj_pools_club_id_key" UNIQUE (club_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (club_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."bbj_pools"', 'bbj_pools_club_id_key';
END IF; END $c$;
ALTER TABLE "public"."bbj_pools" DROP CONSTRAINT IF EXISTS "bbj_pools_main_balance_nonneg" RESTRICT;
ALTER TABLE "public"."bbj_pools" ADD CONSTRAINT "bbj_pools_main_balance_nonneg" CHECK ((main_balance >= (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."bbj_pools"'::regclass AND conname='bbj_pools_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."bbj_pools" ADD CONSTRAINT "bbj_pools_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."bbj_pools"', 'bbj_pools_pkey';
END IF; END $c$;
ALTER TABLE "public"."bbj_pools" DROP CONSTRAINT IF EXISTS "bbj_pools_promo_balance_nonneg" RESTRICT;
ALTER TABLE "public"."bbj_pools" ADD CONSTRAINT "bbj_pools_promo_balance_nonneg" CHECK ((promo_balance >= (0)::numeric));
ALTER TABLE "public"."bbj_pools" DROP CONSTRAINT IF EXISTS "chk_alloc_cum_amount_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."bbj_pools" ADD CONSTRAINT "chk_alloc_cum_amount_is_two_decimal_places" CHECK (((alloc_cum_amount IS NULL) OR (alloc_cum_amount = round(alloc_cum_amount, 2))));
DO $i$ BEGIN IF to_regclass('public.bbj_pools_club_id_key') IS NULL THEN CREATE UNIQUE INDEX bbj_pools_club_id_key ON public.bbj_pools USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.bbj_pools_pkey') IS NULL THEN CREATE UNIQUE INDEX bbj_pools_pkey ON public.bbj_pools USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_bbj_pools_union') IS NULL THEN CREATE INDEX idx_bbj_pools_union ON public.bbj_pools USING btree (union_id) WHERE (union_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.uq_bbj_pools_club_active') IS NULL THEN CREATE UNIQUE INDEX uq_bbj_pools_club_active ON public.bbj_pools USING btree (club_id) WHERE ((club_id IS NOT NULL) AND (status = 'active'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.uq_bbj_pools_union_active') IS NULL THEN CREATE UNIQUE INDEX uq_bbj_pools_union_active ON public.bbj_pools USING btree (union_id) WHERE ((club_id IS NULL) AND (union_id IS NOT NULL) AND (status = 'active'::text)); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_account_snapshots" ();
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "id" bigint;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "id" SET DEFAULT nextval('ca_account_snapshots_id_seq'::regclass);
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "account_key" text;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "account_key" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "account_key" SET NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "account_type" text;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "account_type" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "account_type" SET NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "entity_id" uuid;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "entity_id" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "entity_id" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "column_name" text;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "column_name" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "column_name" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "balance" numeric;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "balance" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "balance" SET NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "taken_at" timestamp with time zone;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "taken_at" SET DEFAULT now();
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "taken_at" SET NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "is_baseline" boolean;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "is_baseline" SET DEFAULT false;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "is_baseline" SET NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "unexplained" numeric;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "unexplained" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "unexplained" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "note" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "note" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "cum_unexplained" numeric;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "cum_unexplained" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "cum_unexplained" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "basis_version" text;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "basis_version" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "basis_version" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" ADD COLUMN IF NOT EXISTS "read_snapshot" text;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "read_snapshot" DROP DEFAULT;
ALTER TABLE "public"."ca_account_snapshots" ALTER COLUMN "read_snapshot" DROP NOT NULL;
ALTER TABLE "public"."ca_account_snapshots" OWNER TO "postgres";
ALTER TABLE "public"."ca_account_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_account_snapshots" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_account_snapshots"'::regclass AND conname='ca_account_snapshots_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_account_snapshots" ADD CONSTRAINT "ca_account_snapshots_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_account_snapshots"', 'ca_account_snapshots_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_account_snapshots" DROP CONSTRAINT IF EXISTS "chk_balance_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."ca_account_snapshots" ADD CONSTRAINT "chk_balance_is_two_decimal_places" CHECK (((balance IS NULL) OR (balance = round(balance, 2))));
DO $i$ BEGIN IF to_regclass('public.ca_account_snapshots_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_account_snapshots_pkey ON public.ca_account_snapshots USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ix_ca_account_snapshots_key_at') IS NULL THEN CREATE INDEX ix_ca_account_snapshots_key_at ON public.ca_account_snapshots USING btree (account_key, taken_at DESC); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_currency_meter" ();
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "id" bigint;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "id" SET DEFAULT nextval('ca_currency_meter_id_seq'::regclass);
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "at" timestamp with time zone;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "at" SET DEFAULT now();
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "at" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "currency" text;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "outstanding" numeric;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "outstanding" DROP DEFAULT;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "outstanding" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "journal_total" numeric;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "journal_total" DROP DEFAULT;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "journal_total" DROP NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "accounts" integer;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "accounts" SET DEFAULT 0;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "accounts" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "drifted" integer;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "drifted" SET DEFAULT 0;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "drifted" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "worst" numeric;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "worst" SET DEFAULT 0;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "worst" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "enforced" boolean;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "enforced" DROP DEFAULT;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "enforced" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" ADD COLUMN IF NOT EXISTS "detail" jsonb;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "detail" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."ca_currency_meter" ALTER COLUMN "detail" SET NOT NULL;
ALTER TABLE "public"."ca_currency_meter" OWNER TO "postgres";
ALTER TABLE "public"."ca_currency_meter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_currency_meter" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_currency_meter"'::regclass AND conname='ca_currency_meter_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_currency_meter" ADD CONSTRAINT "ca_currency_meter_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_currency_meter"', 'ca_currency_meter_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_currency_meter_currency_at_idx') IS NULL THEN CREATE INDEX ca_currency_meter_currency_at_idx ON public.ca_currency_meter USING btree (currency, at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_currency_meter_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_currency_meter_pkey ON public.ca_currency_meter USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_detector_registry" ();
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "source" SET NOT NULL;
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "owner" text;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "owner" DROP DEFAULT;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "owner" SET NOT NULL;
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "sla_hours" integer;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "sla_hours" SET DEFAULT 24;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "sla_hours" SET NOT NULL;
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "auto_resolve_hours" integer;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "auto_resolve_hours" DROP DEFAULT;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "auto_resolve_hours" DROP NOT NULL;
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "retired_by" text;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "retired_by" DROP DEFAULT;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "retired_by" DROP NOT NULL;
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "note" SET DEFAULT ''::text;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "note" SET NOT NULL;
ALTER TABLE "public"."ca_detector_registry" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."ca_detector_registry" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "public"."ca_detector_registry" OWNER TO "postgres";
ALTER TABLE "public"."ca_detector_registry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_detector_registry" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_detector_registry" DROP CONSTRAINT IF EXISTS "ca_detector_registry_auto_resolve_hours_check" RESTRICT;
ALTER TABLE "public"."ca_detector_registry" ADD CONSTRAINT "ca_detector_registry_auto_resolve_hours_check" CHECK (((auto_resolve_hours IS NULL) OR (auto_resolve_hours > 0)));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_detector_registry"'::regclass AND conname='ca_detector_registry_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_detector_registry" ADD CONSTRAINT "ca_detector_registry_pkey" PRIMARY KEY (source);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (source)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_detector_registry"', 'ca_detector_registry_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_detector_registry" DROP CONSTRAINT IF EXISTS "ca_detector_registry_sla_hours_check" RESTRICT;
ALTER TABLE "public"."ca_detector_registry" ADD CONSTRAINT "ca_detector_registry_sla_hours_check" CHECK ((sla_hours > 0));
ALTER TABLE "public"."ca_detector_registry" DROP CONSTRAINT IF EXISTS "ca_detector_registry_status_check" RESTRICT;
ALTER TABLE "public"."ca_detector_registry" ADD CONSTRAINT "ca_detector_registry_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])));
DO $i$ BEGIN IF to_regclass('public.ca_detector_registry_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_detector_registry_pkey ON public.ca_detector_registry USING btree (source); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_drift_incidents" ();
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "detected_at" timestamp with time zone;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "detected_at" SET DEFAULT now();
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "detected_at" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "deadline_at" timestamp with time zone;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "deadline_at" SET DEFAULT (now() + '00:20:00'::interval);
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "deadline_at" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "classification" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "classification" SET DEFAULT 'unknown'::text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "classification" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "severity" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "severity" SET DEFAULT 'critical'::text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "severity" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "layer" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "layer" SET DEFAULT 'unknown'::text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "layer" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "status" SET DEFAULT 'open'::text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "source" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "dedupe_key" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "dedupe_key" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "union_id" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "entity_type" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "entity_type" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "entity_type" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "entity_id" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "entity_id" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "entity_id" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "table_id" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "table_id" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "tournament_id" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "tournament_id" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "tournament_id" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "hand_id" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "hand_id" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "hand_id" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "settlement_id" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "settlement_id" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "settlement_id" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "wallet_ids" uuid[];
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "wallet_ids" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "wallet_ids" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "transaction_ids" uuid[];
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "transaction_ids" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "transaction_ids" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "currency" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "currency" SET DEFAULT 'club_chips'::text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "expected_amount" numeric;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "expected_amount" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "expected_amount" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "actual_amount" numeric;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "actual_amount" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "actual_amount" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "discrepancy_amount" numeric;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "discrepancy_amount" SET DEFAULT 0;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "discrepancy_amount" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "ledger_balanced" boolean;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "ledger_balanced" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "ledger_balanced" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "suspected_cause" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "suspected_cause" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "suspected_cause" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "auto_repair_status" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "auto_repair_status" SET DEFAULT 'pending'::text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "auto_repair_status" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "escalation_level" integer;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "escalation_level" SET DEFAULT 0;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "escalation_level" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "past_target" boolean;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "past_target" SET DEFAULT false;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "past_target" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "occurrences" integer;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "occurrences" SET DEFAULT 1;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "occurrences" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "last_seen_at" SET DEFAULT now();
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "last_seen_at" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_by" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "acknowledged_by" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "acknowledged_by" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "acknowledged_at" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "acknowledged_at" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "assigned_to" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "assigned_to" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "assigned_to" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "root_cause" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "root_cause" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "root_cause" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "correction_ref" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "correction_ref" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "correction_ref" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "resolution" text;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "resolution" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "resolution" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "resolved_by" uuid;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "resolved_by" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "resolved_by" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "resolved_at" DROP DEFAULT;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "resolved_at" DROP NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "metadata" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."ca_drift_incidents" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."ca_drift_incidents" OWNER TO "postgres";
ALTER TABLE "public"."ca_drift_incidents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_drift_incidents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_drift_incidents" DROP CONSTRAINT IF EXISTS "ca_drift_incidents_auto_repair_status_check" RESTRICT;
ALTER TABLE "public"."ca_drift_incidents" ADD CONSTRAINT "ca_drift_incidents_auto_repair_status_check" CHECK ((auto_repair_status = ANY (ARRAY['pending'::text, 'running'::text, 'repaired'::text, 'manual_needed'::text, 'not_applicable'::text])));
ALTER TABLE "public"."ca_drift_incidents" DROP CONSTRAINT IF EXISTS "ca_drift_incidents_classification_check" RESTRICT;
ALTER TABLE "public"."ca_drift_incidents" ADD CONSTRAINT "ca_drift_incidents_classification_check" CHECK ((classification = ANY (ARRAY['ledger_imbalance'::text, 'settlement_error'::text, 'duplicate_payment'::text, 'missing_payment'::text, 'projection_delay'::text, 'cache_mismatch'::text, 'reporting_mismatch'::text, 'delayed_event'::text, 'duplicate_event'::text, 'rounding_error'::text, 'incorrect_rake'::text, 'incorrect_weighted_rake'::text, 'incorrect_rakeback'::text, 'bbj_error'::text, 'treasury_error'::text, 'credit_line_error'::text, 'cross_club_posting'::text, 'cross_union_posting'::text, 'unauthorized_adjustment'::text, 'historical_migration'::text, 'unknown'::text])));
ALTER TABLE "public"."ca_drift_incidents" DROP CONSTRAINT IF EXISTS "ca_drift_incidents_layer_check" RESTRICT;
ALTER TABLE "public"."ca_drift_incidents" ADD CONSTRAINT "ca_drift_incidents_layer_check" CHECK ((layer = ANY (ARRAY['ledger'::text, 'projection'::text, 'cache'::text, 'reporting'::text, 'settlement'::text, 'unknown'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_drift_incidents"'::regclass AND conname='ca_drift_incidents_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_drift_incidents" ADD CONSTRAINT "ca_drift_incidents_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_drift_incidents"', 'ca_drift_incidents_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_drift_incidents" DROP CONSTRAINT IF EXISTS "ca_drift_incidents_severity_check" RESTRICT;
ALTER TABLE "public"."ca_drift_incidents" ADD CONSTRAINT "ca_drift_incidents_severity_check" CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])));
ALTER TABLE "public"."ca_drift_incidents" DROP CONSTRAINT IF EXISTS "ca_drift_incidents_status_check" RESTRICT;
ALTER TABLE "public"."ca_drift_incidents" ADD CONSTRAINT "ca_drift_incidents_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'reconciling'::text, 'resolved'::text])));
DO $i$ BEGIN IF to_regclass('public.ca_drift_incidents_alert_id_idx') IS NULL THEN CREATE INDEX ca_drift_incidents_alert_id_idx ON public.ca_drift_incidents USING btree (((metadata ->> 'alert_id'::text))) WHERE (metadata ? 'alert_id'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_drift_incidents_alert_uuid_idx') IS NULL THEN CREATE INDEX ca_drift_incidents_alert_uuid_idx ON public.ca_drift_incidents USING btree ((((metadata ->> 'alert_id'::text))::uuid)) WHERE ((metadata ->> 'alert_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_drift_incidents_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_drift_incidents_pkey ON public.ca_drift_incidents USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ix_ca_drift_incidents_club') IS NULL THEN CREATE INDEX ix_ca_drift_incidents_club ON public.ca_drift_incidents USING btree (club_id, detected_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ix_ca_drift_incidents_open') IS NULL THEN CREATE INDEX ix_ca_drift_incidents_open ON public.ca_drift_incidents USING btree (status, detected_at DESC) WHERE (status <> 'resolved'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ux_ca_drift_incidents_open_dedupe') IS NULL THEN CREATE UNIQUE INDEX ux_ca_drift_incidents_open_dedupe ON public.ca_drift_incidents USING btree (dedupe_key) WHERE (status <> 'resolved'::text); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_financial_epochs" ();
ALTER TABLE "public"."ca_financial_epochs" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "name" DROP DEFAULT;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "public"."ca_financial_epochs" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "description" DROP DEFAULT;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "description" DROP NOT NULL;
ALTER TABLE "public"."ca_financial_epochs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "started_at" SET DEFAULT now();
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "started_at" SET NOT NULL;
ALTER TABLE "public"."ca_financial_epochs" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "ended_at" DROP DEFAULT;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "ended_at" DROP NOT NULL;
ALTER TABLE "public"."ca_financial_epochs" ADD COLUMN IF NOT EXISTS "is_current" boolean;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "is_current" SET DEFAULT false;
ALTER TABLE "public"."ca_financial_epochs" ALTER COLUMN "is_current" SET NOT NULL;
ALTER TABLE "public"."ca_financial_epochs" OWNER TO "postgres";
ALTER TABLE "public"."ca_financial_epochs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_financial_epochs" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_financial_epochs"'::regclass AND conname='ca_financial_epochs_name_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_financial_epochs" ADD CONSTRAINT "ca_financial_epochs_name_key" UNIQUE (name);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (name)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_financial_epochs"', 'ca_financial_epochs_name_key';
END IF; END $c$;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_financial_epochs"'::regclass AND conname='ca_financial_epochs_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_financial_epochs" ADD CONSTRAINT "ca_financial_epochs_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_financial_epochs"', 'ca_financial_epochs_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_financial_epochs_name_key') IS NULL THEN CREATE UNIQUE INDEX ca_financial_epochs_name_key ON public.ca_financial_epochs USING btree (name); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_financial_epochs_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_financial_epochs_pkey ON public.ca_financial_epochs USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ux_ca_financial_epochs_current') IS NULL THEN CREATE UNIQUE INDEX ux_ca_financial_epochs_current ON public.ca_financial_epochs USING btree (is_current) WHERE is_current; END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_guard_def_history" ();
ALTER TABLE "public"."ca_guard_def_history" ADD COLUMN IF NOT EXISTS "id" bigint;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "id" SET DEFAULT nextval('ca_guard_def_history_id_seq'::regclass);
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_guard_def_history" ADD COLUMN IF NOT EXISTS "proname" text;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "proname" DROP DEFAULT;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "proname" SET NOT NULL;
ALTER TABLE "public"."ca_guard_def_history" ADD COLUMN IF NOT EXISTS "def_hash" text;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "def_hash" DROP DEFAULT;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "def_hash" SET NOT NULL;
ALTER TABLE "public"."ca_guard_def_history" ADD COLUMN IF NOT EXISTS "def_text" text;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "def_text" DROP DEFAULT;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "def_text" SET NOT NULL;
ALTER TABLE "public"."ca_guard_def_history" ADD COLUMN IF NOT EXISTS "captured_at" timestamp with time zone;
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "captured_at" SET DEFAULT now();
ALTER TABLE "public"."ca_guard_def_history" ALTER COLUMN "captured_at" SET NOT NULL;
ALTER TABLE "public"."ca_guard_def_history" OWNER TO "postgres";
ALTER TABLE "public"."ca_guard_def_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_guard_def_history" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_guard_def_history"'::regclass AND conname='ca_guard_def_history_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_guard_def_history" ADD CONSTRAINT "ca_guard_def_history_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_guard_def_history"', 'ca_guard_def_history_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_guard_def_history_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_guard_def_history_pkey ON public.ca_guard_def_history USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_guard_def_history_proname_hash_idx') IS NULL THEN CREATE UNIQUE INDEX ca_guard_def_history_proname_hash_idx ON public.ca_guard_def_history USING btree (proname, def_hash); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_incident_events" ();
ALTER TABLE "public"."ca_incident_events" ADD COLUMN IF NOT EXISTS "incident_id" uuid;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "incident_id" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "incident_id" SET NOT NULL;
ALTER TABLE "public"."ca_incident_events" ADD COLUMN IF NOT EXISTS "at" timestamp with time zone;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "at" SET DEFAULT now();
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "at" SET NOT NULL;
ALTER TABLE "public"."ca_incident_events" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "public"."ca_incident_events" ADD COLUMN IF NOT EXISTS "actor" uuid;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "actor" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "actor" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_events" ADD COLUMN IF NOT EXISTS "actor_label" text;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "actor_label" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "actor_label" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_events" ADD COLUMN IF NOT EXISTS "detail" jsonb;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "detail" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."ca_incident_events" ALTER COLUMN "detail" SET NOT NULL;
ALTER TABLE "public"."ca_incident_events" OWNER TO "postgres";
ALTER TABLE "public"."ca_incident_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_incident_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_incident_events" DROP CONSTRAINT IF EXISTS "ca_incident_events_incident_id_fkey" RESTRICT;
ALTER TABLE "public"."ca_incident_events" ADD CONSTRAINT "ca_incident_events_incident_id_fkey" FOREIGN KEY (incident_id) REFERENCES ca_drift_incidents(id);
ALTER TABLE "public"."ca_incident_events" DROP CONSTRAINT IF EXISTS "ca_incident_events_kind_check" RESTRICT;
ALTER TABLE "public"."ca_incident_events" ADD CONSTRAINT "ca_incident_events_kind_check" CHECK ((kind = ANY (ARRAY['created'::text, 'recurred'::text, 'notified'::text, 'escalated'::text, 'status_change'::text, 'repair_action'::text, 'comment'::text, 'assigned'::text, 'acknowledged'::text, 'resolved'::text, 'reopened'::text, 'notify_failed'::text, 'notify_withheld'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_incident_events"'::regclass AND conname='ca_incident_events_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_incident_events" ADD CONSTRAINT "ca_incident_events_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_incident_events"', 'ca_incident_events_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_incident_events_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_incident_events_pkey ON public.ca_incident_events USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ix_ca_incident_events_incident') IS NULL THEN CREATE INDEX ix_ca_incident_events_incident ON public.ca_incident_events USING btree (incident_id, at); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_incident_file_failures" ();
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "occurred_at" timestamp with time zone;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "occurred_at" SET DEFAULT now();
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "occurred_at" SET NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "source" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "dedupe_key" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "dedupe_key" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "classification" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "classification" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "classification" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "severity" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "severity" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "severity" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "discrepancy" numeric;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "discrepancy" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "discrepancy" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "sqlstate" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "sqlstate" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "sqlstate" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "message" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "message" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "message" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "db_role" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "db_role" SET DEFAULT CURRENT_USER;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "db_role" SET NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" ADD COLUMN IF NOT EXISTS "app_name" text;
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "app_name" SET DEFAULT COALESCE(current_setting('application_name'::text, true), ''::text);
ALTER TABLE "public"."ca_incident_file_failures" ALTER COLUMN "app_name" SET NOT NULL;
ALTER TABLE "public"."ca_incident_file_failures" OWNER TO "postgres";
ALTER TABLE "public"."ca_incident_file_failures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_incident_file_failures" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_incident_file_failures"'::regclass AND conname='ca_incident_file_failures_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_incident_file_failures" ADD CONSTRAINT "ca_incident_file_failures_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_incident_file_failures"', 'ca_incident_file_failures_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_incident_file_failures_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_incident_file_failures_pkey ON public.ca_incident_file_failures USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_incident_notify_ledger" ();
ALTER TABLE "public"."ca_incident_notify_ledger" ADD COLUMN IF NOT EXISTS "recipient_id" uuid;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "recipient_id" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "recipient_id" SET NOT NULL;
ALTER TABLE "public"."ca_incident_notify_ledger" ADD COLUMN IF NOT EXISTS "finding_key" text;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "finding_key" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "finding_key" SET NOT NULL;
ALTER TABLE "public"."ca_incident_notify_ledger" ADD COLUMN IF NOT EXISTS "state_hash" text;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "state_hash" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "state_hash" SET NOT NULL;
ALTER TABLE "public"."ca_incident_notify_ledger" ADD COLUMN IF NOT EXISTS "last_kind" text;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "last_kind" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "last_kind" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_notify_ledger" ADD COLUMN IF NOT EXISTS "last_incident_id" uuid;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "last_incident_id" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "last_incident_id" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_notify_ledger" ADD COLUMN IF NOT EXISTS "last_sent_at" timestamp with time zone;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "last_sent_at" SET DEFAULT now();
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "last_sent_at" SET NOT NULL;
ALTER TABLE "public"."ca_incident_notify_ledger" ADD COLUMN IF NOT EXISTS "send_count" integer;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "send_count" SET DEFAULT 1;
ALTER TABLE "public"."ca_incident_notify_ledger" ALTER COLUMN "send_count" SET NOT NULL;
ALTER TABLE "public"."ca_incident_notify_ledger" OWNER TO "postgres";
ALTER TABLE "public"."ca_incident_notify_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_incident_notify_ledger" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_incident_notify_ledger"'::regclass AND conname='ca_incident_notify_ledger_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_incident_notify_ledger" ADD CONSTRAINT "ca_incident_notify_ledger_pkey" PRIMARY KEY (recipient_id, finding_key);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (recipient_id, finding_key)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_incident_notify_ledger"', 'ca_incident_notify_ledger_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_incident_notify_ledger_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_incident_notify_ledger_pkey ON public.ca_incident_notify_ledger USING btree (recipient_id, finding_key); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_incident_recipients" ();
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "scope" text;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "scope" SET DEFAULT 'platform'::text;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "scope" SET NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "scope_id" uuid;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "scope_id" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "scope_id" DROP NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "min_severity" text;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "min_severity" SET DEFAULT 'warning'::text;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "min_severity" SET NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "senior" boolean;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "senior" SET DEFAULT false;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "senior" SET NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "active" boolean;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "active" SET DEFAULT true;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "active" SET NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."ca_incident_recipients" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."ca_incident_recipients" OWNER TO "postgres";
ALTER TABLE "public"."ca_incident_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_incident_recipients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_incident_recipients" DROP CONSTRAINT IF EXISTS "ca_incident_recipients_min_severity_check" RESTRICT;
ALTER TABLE "public"."ca_incident_recipients" ADD CONSTRAINT "ca_incident_recipients_min_severity_check" CHECK ((min_severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_incident_recipients"'::regclass AND conname='ca_incident_recipients_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_incident_recipients" ADD CONSTRAINT "ca_incident_recipients_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_incident_recipients"', 'ca_incident_recipients_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_incident_recipients" DROP CONSTRAINT IF EXISTS "ca_incident_recipients_scope_check" RESTRICT;
ALTER TABLE "public"."ca_incident_recipients" ADD CONSTRAINT "ca_incident_recipients_scope_check" CHECK ((scope = ANY (ARRAY['platform'::text, 'financial_ops'::text, 'technical'::text, 'union'::text, 'club'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_incident_recipients"'::regclass AND conname='ca_incident_recipients_scope_scope_id_user_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_incident_recipients" ADD CONSTRAINT "ca_incident_recipients_scope_scope_id_user_id_key" UNIQUE (scope, scope_id, user_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (scope, scope_id, user_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_incident_recipients"', 'ca_incident_recipients_scope_scope_id_user_id_key';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_incident_recipients_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_incident_recipients_pkey ON public.ca_incident_recipients USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_incident_recipients_scope_scope_id_user_id_key') IS NULL THEN CREATE UNIQUE INDEX ca_incident_recipients_scope_scope_id_user_id_key ON public.ca_incident_recipients USING btree (scope, scope_id, user_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_kill_switch_policy" ();
ALTER TABLE "public"."ca_kill_switch_policy" ADD COLUMN IF NOT EXISTS "detector" text;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "detector" DROP DEFAULT;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "detector" SET NOT NULL;
ALTER TABLE "public"."ca_kill_switch_policy" ADD COLUMN IF NOT EXISTS "threshold_chips" numeric;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "threshold_chips" DROP DEFAULT;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "threshold_chips" SET NOT NULL;
ALTER TABLE "public"."ca_kill_switch_policy" ADD COLUMN IF NOT EXISTS "armed" boolean;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "armed" SET DEFAULT true;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "armed" SET NOT NULL;
ALTER TABLE "public"."ca_kill_switch_policy" ADD COLUMN IF NOT EXISTS "scopes" text[];
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "scopes" SET DEFAULT ARRAY[]::text[];
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "scopes" SET NOT NULL;
ALTER TABLE "public"."ca_kill_switch_policy" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "note" SET DEFAULT ''::text;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "note" SET NOT NULL;
ALTER TABLE "public"."ca_kill_switch_policy" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."ca_kill_switch_policy" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "public"."ca_kill_switch_policy" OWNER TO "postgres";
ALTER TABLE "public"."ca_kill_switch_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_kill_switch_policy" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_kill_switch_policy"'::regclass AND conname='ca_kill_switch_policy_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_kill_switch_policy" ADD CONSTRAINT "ca_kill_switch_policy_pkey" PRIMARY KEY (detector);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (detector)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_kill_switch_policy"', 'ca_kill_switch_policy_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_kill_switch_policy" DROP CONSTRAINT IF EXISTS "ca_kill_switch_policy_threshold_chips_check" RESTRICT;
ALTER TABLE "public"."ca_kill_switch_policy" ADD CONSTRAINT "ca_kill_switch_policy_threshold_chips_check" CHECK ((threshold_chips > (0)::numeric));
DO $i$ BEGIN IF to_regclass('public.ca_kill_switch_policy_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_kill_switch_policy_pkey ON public.ca_kill_switch_policy USING btree (detector); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_ledger_mutation_log" ();
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "at" timestamp with time zone;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "at" SET DEFAULT now();
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "at" SET NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "source_table" text;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "source_table" DROP DEFAULT;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "source_table" SET NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "operation" text;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "operation" DROP DEFAULT;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "operation" SET NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "db_role" text;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "db_role" DROP DEFAULT;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "db_role" SET NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "application" text;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "application" DROP DEFAULT;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "application" DROP NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "reason" SET NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "old_row" jsonb;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "old_row" DROP DEFAULT;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "old_row" SET NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" ADD COLUMN IF NOT EXISTS "new_row" jsonb;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "new_row" DROP DEFAULT;
ALTER TABLE "public"."ca_ledger_mutation_log" ALTER COLUMN "new_row" DROP NOT NULL;
ALTER TABLE "public"."ca_ledger_mutation_log" OWNER TO "postgres";
ALTER TABLE "public"."ca_ledger_mutation_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_ledger_mutation_log" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_ledger_mutation_log"'::regclass AND conname='ca_ledger_mutation_log_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_ledger_mutation_log" ADD CONSTRAINT "ca_ledger_mutation_log_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_ledger_mutation_log"', 'ca_ledger_mutation_log_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_ledger_mutation_log_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_ledger_mutation_log_pkey ON public.ca_ledger_mutation_log USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_mint_ledger" ();
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "op_id" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "op_id" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "op_id" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "action" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "action" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "action" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "asset" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "asset" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "asset" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "holder_type" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "holder_type" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "holder_type" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "holder_id" uuid;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "holder_id" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "holder_id" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "holder_label" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "holder_label" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "holder_label" DROP NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "amount" numeric(20,2);
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "amount" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "balance_before" numeric(20,2);
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "balance_before" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "balance_before" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "balance_after" numeric(20,2);
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "balance_after" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "balance_after" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "supply_after" numeric(20,2);
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "supply_after" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "supply_after" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "reason" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "performed_by" uuid;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "performed_by" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "performed_by" DROP NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "performed_by_label" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "performed_by_label" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "performed_by_label" DROP NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "db_role" text;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "db_role" SET DEFAULT CURRENT_USER;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "db_role" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "chip_ledger_id" uuid;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "chip_ledger_id" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "chip_ledger_id" DROP NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" ADD COLUMN IF NOT EXISTS "diamond_tx_id" uuid;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "diamond_tx_id" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_ledger" ALTER COLUMN "diamond_tx_id" DROP NOT NULL;
ALTER TABLE "public"."ca_mint_ledger" OWNER TO "postgres";
ALTER TABLE "public"."ca_mint_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_mint_ledger" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_mint_ledger" DROP CONSTRAINT IF EXISTS "ca_mint_ledger_action_check" RESTRICT;
ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_action_check" CHECK ((action = ANY (ARRAY['mint'::text, 'burn'::text])));
ALTER TABLE "public"."ca_mint_ledger" DROP CONSTRAINT IF EXISTS "ca_mint_ledger_amount_check" RESTRICT;
ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE "public"."ca_mint_ledger" DROP CONSTRAINT IF EXISTS "ca_mint_ledger_asset_check" RESTRICT;
ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_asset_check" CHECK ((asset = ANY (ARRAY['chips'::text, 'diamonds'::text])));
ALTER TABLE "public"."ca_mint_ledger" DROP CONSTRAINT IF EXISTS "ca_mint_ledger_chip_ledger_id_fkey" RESTRICT;
ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_chip_ledger_id_fkey" FOREIGN KEY (chip_ledger_id) REFERENCES chip_ledger(id) ON DELETE RESTRICT;
ALTER TABLE "public"."ca_mint_ledger" DROP CONSTRAINT IF EXISTS "ca_mint_ledger_holder_type_check" RESTRICT;
ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_holder_type_check" CHECK ((holder_type = ANY (ARRAY['club'::text, 'union'::text, 'player'::text, 'house'::text, 'circulation'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_mint_ledger"'::regclass AND conname='ca_mint_ledger_op_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_op_id_key" UNIQUE (op_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (op_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_mint_ledger"', 'ca_mint_ledger_op_id_key';
END IF; END $c$;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_mint_ledger"'::regclass AND conname='ca_mint_ledger_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_mint_ledger"', 'ca_mint_ledger_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_mint_ledger" DROP CONSTRAINT IF EXISTS "ca_mint_ledger_reason_check" RESTRICT;
ALTER TABLE "public"."ca_mint_ledger" ADD CONSTRAINT "ca_mint_ledger_reason_check" CHECK ((length(btrim(reason)) >= 10));
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_asset_idx') IS NULL THEN CREATE INDEX ca_mint_ledger_asset_idx ON public.ca_mint_ledger USING btree (asset, action, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_chip_ledger_id_key') IS NULL THEN CREATE UNIQUE INDEX ca_mint_ledger_chip_ledger_id_key ON public.ca_mint_ledger USING btree (chip_ledger_id) WHERE (chip_ledger_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_created_idx') IS NULL THEN CREATE INDEX ca_mint_ledger_created_idx ON public.ca_mint_ledger USING btree (created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_diamond_tx_id_key') IS NULL THEN CREATE UNIQUE INDEX ca_mint_ledger_diamond_tx_id_key ON public.ca_mint_ledger USING btree (diamond_tx_id) WHERE (diamond_tx_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_holder_idx') IS NULL THEN CREATE INDEX ca_mint_ledger_holder_idx ON public.ca_mint_ledger USING btree (holder_type, holder_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_op_id_key') IS NULL THEN CREATE UNIQUE INDEX ca_mint_ledger_op_id_key ON public.ca_mint_ledger USING btree (op_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_origin_idx') IS NULL THEN CREATE INDEX ca_mint_ledger_origin_idx ON public.ca_mint_ledger USING btree (origin, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_mint_ledger_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_mint_ledger_pkey ON public.ca_mint_ledger USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_mint_policy" ();
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "id" integer;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "per_operation_cap_chips" numeric;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "per_operation_cap_chips" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "per_operation_cap_chips" SET NOT NULL;
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "rolling_24h_cap_chips" numeric;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "rolling_24h_cap_chips" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "rolling_24h_cap_chips" SET NOT NULL;
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "per_operation_cap_diamonds" numeric;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "per_operation_cap_diamonds" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "per_operation_cap_diamonds" SET NOT NULL;
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "rolling_24h_cap_diamonds" numeric;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "rolling_24h_cap_diamonds" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "rolling_24h_cap_diamonds" SET NOT NULL;
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "note" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "note" DROP NOT NULL;
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "public"."ca_mint_policy" ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "updated_by" DROP DEFAULT;
ALTER TABLE "public"."ca_mint_policy" ALTER COLUMN "updated_by" DROP NOT NULL;
ALTER TABLE "public"."ca_mint_policy" OWNER TO "postgres";
ALTER TABLE "public"."ca_mint_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_mint_policy" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_mint_policy" DROP CONSTRAINT IF EXISTS "ca_mint_policy_id_check" RESTRICT;
ALTER TABLE "public"."ca_mint_policy" ADD CONSTRAINT "ca_mint_policy_id_check" CHECK ((id = 1));
ALTER TABLE "public"."ca_mint_policy" DROP CONSTRAINT IF EXISTS "ca_mint_policy_per_operation_cap_chips_check" RESTRICT;
ALTER TABLE "public"."ca_mint_policy" ADD CONSTRAINT "ca_mint_policy_per_operation_cap_chips_check" CHECK ((per_operation_cap_chips > (0)::numeric));
ALTER TABLE "public"."ca_mint_policy" DROP CONSTRAINT IF EXISTS "ca_mint_policy_per_operation_cap_diamonds_check" RESTRICT;
ALTER TABLE "public"."ca_mint_policy" ADD CONSTRAINT "ca_mint_policy_per_operation_cap_diamonds_check" CHECK ((per_operation_cap_diamonds > (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_mint_policy"'::regclass AND conname='ca_mint_policy_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_mint_policy" ADD CONSTRAINT "ca_mint_policy_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_mint_policy"', 'ca_mint_policy_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_mint_policy" DROP CONSTRAINT IF EXISTS "ca_mint_policy_rolling_24h_cap_chips_check" RESTRICT;
ALTER TABLE "public"."ca_mint_policy" ADD CONSTRAINT "ca_mint_policy_rolling_24h_cap_chips_check" CHECK ((rolling_24h_cap_chips > (0)::numeric));
ALTER TABLE "public"."ca_mint_policy" DROP CONSTRAINT IF EXISTS "ca_mint_policy_rolling_24h_cap_diamonds_check" RESTRICT;
ALTER TABLE "public"."ca_mint_policy" ADD CONSTRAINT "ca_mint_policy_rolling_24h_cap_diamonds_check" CHECK ((rolling_24h_cap_diamonds > (0)::numeric));
DO $i$ BEGIN IF to_regclass('public.ca_mint_policy_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_mint_policy_pkey ON public.ca_mint_policy USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_payout_freeze" ();
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "scope" text;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "scope" SET NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "reason" SET NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "opened_by" uuid;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "opened_by" DROP DEFAULT;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "opened_by" DROP NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "opened_by_label" text;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "opened_by_label" DROP DEFAULT;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "opened_by_label" DROP NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "opened_at" SET DEFAULT now();
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "opened_at" SET NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "cleared_by" uuid;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "cleared_by" DROP DEFAULT;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "cleared_by" DROP NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "cleared_by_label" text;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "cleared_by_label" DROP DEFAULT;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "cleared_by_label" DROP NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" ADD COLUMN IF NOT EXISTS "cleared_at" timestamp with time zone;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "cleared_at" DROP DEFAULT;
ALTER TABLE "public"."ca_payout_freeze" ALTER COLUMN "cleared_at" DROP NOT NULL;
ALTER TABLE "public"."ca_payout_freeze" OWNER TO "postgres";
ALTER TABLE "public"."ca_payout_freeze" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_payout_freeze" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_payout_freeze" DROP CONSTRAINT IF EXISTS "ca_payout_freeze_clear_after_open" RESTRICT;
ALTER TABLE "public"."ca_payout_freeze" ADD CONSTRAINT "ca_payout_freeze_clear_after_open" CHECK (((cleared_at IS NULL) OR (cleared_at >= opened_at)));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_payout_freeze"'::regclass AND conname='ca_payout_freeze_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_payout_freeze" ADD CONSTRAINT "ca_payout_freeze_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_payout_freeze"', 'ca_payout_freeze_pkey';
END IF; END $c$;
ALTER TABLE "public"."ca_payout_freeze" DROP CONSTRAINT IF EXISTS "ca_payout_freeze_reason_check" RESTRICT;
ALTER TABLE "public"."ca_payout_freeze" ADD CONSTRAINT "ca_payout_freeze_reason_check" CHECK ((length(btrim(reason)) >= 10));
ALTER TABLE "public"."ca_payout_freeze" DROP CONSTRAINT IF EXISTS "ca_payout_freeze_scope_check" RESTRICT;
ALTER TABLE "public"."ca_payout_freeze" ADD CONSTRAINT "ca_payout_freeze_scope_check" CHECK ((scope = ANY (ARRAY['tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text, 'diamond_tournament_payouts'::text, 'arena_withdrawals'::text, 'wheel'::text, 'plinko'::text, 'crash'::text])));
DO $i$ BEGIN IF to_regclass('public.ca_payout_freeze_one_open_per_scope') IS NULL THEN CREATE UNIQUE INDEX ca_payout_freeze_one_open_per_scope ON public.ca_payout_freeze USING btree (scope) WHERE (cleared_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ca_payout_freeze_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_payout_freeze_pkey ON public.ca_payout_freeze USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."ca_rakeback_baseline" ();
ALTER TABLE "public"."ca_rakeback_baseline" ADD COLUMN IF NOT EXISTS "id" integer;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "id" SET DEFAULT 1;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."ca_rakeback_baseline" ADD COLUMN IF NOT EXISTS "known_orphan_count" integer;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_orphan_count" DROP DEFAULT;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_orphan_count" SET NOT NULL;
ALTER TABLE "public"."ca_rakeback_baseline" ADD COLUMN IF NOT EXISTS "known_orphan_amount" numeric;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_orphan_amount" DROP DEFAULT;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_orphan_amount" SET NOT NULL;
ALTER TABLE "public"."ca_rakeback_baseline" ADD COLUMN IF NOT EXISTS "known_unpayable_amount" numeric;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_unpayable_amount" SET DEFAULT 0;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_unpayable_amount" SET NOT NULL;
ALTER TABLE "public"."ca_rakeback_baseline" ADD COLUMN IF NOT EXISTS "known_through" timestamp with time zone;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_through" DROP DEFAULT;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "known_through" SET NOT NULL;
ALTER TABLE "public"."ca_rakeback_baseline" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "note" DROP DEFAULT;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "note" SET NOT NULL;
ALTER TABLE "public"."ca_rakeback_baseline" ADD COLUMN IF NOT EXISTS "measured_at" timestamp with time zone;
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "measured_at" SET DEFAULT now();
ALTER TABLE "public"."ca_rakeback_baseline" ALTER COLUMN "measured_at" SET NOT NULL;
ALTER TABLE "public"."ca_rakeback_baseline" OWNER TO "postgres";
ALTER TABLE "public"."ca_rakeback_baseline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_rakeback_baseline" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."ca_rakeback_baseline" DROP CONSTRAINT IF EXISTS "ca_rakeback_baseline_id_check" RESTRICT;
ALTER TABLE "public"."ca_rakeback_baseline" ADD CONSTRAINT "ca_rakeback_baseline_id_check" CHECK ((id = 1));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."ca_rakeback_baseline"'::regclass AND conname='ca_rakeback_baseline_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."ca_rakeback_baseline" ADD CONSTRAINT "ca_rakeback_baseline_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."ca_rakeback_baseline"', 'ca_rakeback_baseline_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.ca_rakeback_baseline_pkey') IS NULL THEN CREATE UNIQUE INDEX ca_rakeback_baseline_pkey ON public.ca_rakeback_baseline USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."chip_ledger" ();
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "performed_by" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "performed_by" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "performed_by" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "from_type" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "from_type" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "from_type" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "from_entity_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "from_entity_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "from_entity_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "from_label" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "from_label" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "from_label" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "to_type" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "to_type" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "to_type" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "to_entity_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "to_entity_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "to_entity_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "to_label" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "to_label" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "to_label" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "amount" numeric(15,2);
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "amount" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "category" SET DEFAULT 'transfer'::text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "description" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "description" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "notes" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "notes" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "union_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "table_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "table_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "hand_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "hand_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "hand_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "tournament_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "tournament_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "tournament_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "idempotency_key" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "idempotency_key" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "correlation_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "correlation_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "correlation_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "causation_id" uuid;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "causation_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "causation_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "settlement_id" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "settlement_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "settlement_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "epoch_id" integer;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "epoch_id" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "epoch_id" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "actor_service" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "actor_service" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "actor_service" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "db_role" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "db_role" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "db_role" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "pre_from_balance" numeric;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "pre_from_balance" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "pre_from_balance" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "post_from_balance" numeric;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "post_from_balance" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "post_from_balance" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "pre_to_balance" numeric;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "pre_to_balance" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "pre_to_balance" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "post_to_balance" numeric;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "post_to_balance" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "post_to_balance" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "status" SET DEFAULT 'posted'::text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "metadata" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "metadata" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "chain_seq" bigint;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "chain_seq" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "chain_seq" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "prev_hash" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "prev_hash" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "prev_hash" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" ADD COLUMN IF NOT EXISTS "row_hash" text;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "row_hash" DROP DEFAULT;
ALTER TABLE "public"."chip_ledger" ALTER COLUMN "row_hash" DROP NOT NULL;
ALTER TABLE "public"."chip_ledger" OWNER TO "postgres";
ALTER TABLE "public"."chip_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."chip_ledger" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_amount_check" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_category_check" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_category_check" CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text, 'wheel_prize'::text, 'plinko_prize'::text, 'crash_prize'::text]))) NOT VALID;
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_exact_scale" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_exact_scale" CHECK ((amount = round(amount, 2))) NOT VALID;
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_from_type_check" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_from_type_check" CHECK ((from_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_no_diamond_category_check" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_no_diamond_category_check" CHECK (((category !~* '^diamond'::text) AND (category !~* '_diamond'::text)));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_performed_by_fkey" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_performed_by_fkey" FOREIGN KEY (performed_by) REFERENCES auth.users(id);
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."chip_ledger"'::regclass AND conname='chip_ledger_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."chip_ledger"', 'chip_ledger_pkey';
END IF; END $c$;
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_positive_amount" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_positive_amount" CHECK ((amount > (0)::numeric));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_status_check" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_status_check" CHECK ((status = ANY (ARRAY['posted'::text, 'correction'::text, 'reversal'::text])));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chip_ledger_to_type_check" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chip_ledger_to_type_check" CHECK ((to_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chk_post_from_balance_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chk_post_from_balance_is_two_decimal_places" CHECK (((post_from_balance IS NULL) OR (post_from_balance = round(post_from_balance, 2))));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chk_post_to_balance_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chk_post_to_balance_is_two_decimal_places" CHECK (((post_to_balance IS NULL) OR (post_to_balance = round(post_to_balance, 2))));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chk_pre_from_balance_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chk_pre_from_balance_is_two_decimal_places" CHECK (((pre_from_balance IS NULL) OR (pre_from_balance = round(pre_from_balance, 2))));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "chk_pre_to_balance_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "chk_pre_to_balance_is_two_decimal_places" CHECK (((pre_to_balance IS NULL) OR (pre_to_balance = round(pre_to_balance, 2))));
ALTER TABLE "public"."chip_ledger" DROP CONSTRAINT IF EXISTS "ck_whole_cents" RESTRICT;
ALTER TABLE "public"."chip_ledger" ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID;
DO $i$ BEGIN IF to_regclass('public.chip_ledger_chain_seq_key') IS NULL THEN CREATE UNIQUE INDEX chip_ledger_chain_seq_key ON public.chip_ledger USING btree (chain_seq); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_ledger_pkey') IS NULL THEN CREATE UNIQUE INDEX chip_ledger_pkey ON public.chip_ledger USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_club_created_desc') IS NULL THEN CREATE INDEX idx_chip_ledger_club_created_desc ON public.chip_ledger USING btree (club_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_club_from_created') IS NULL THEN CREATE INDEX idx_chip_ledger_club_from_created ON public.chip_ledger USING btree (club_id, from_entity_id, created_at); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_club_to_created') IS NULL THEN CREATE INDEX idx_chip_ledger_club_to_created ON public.chip_ledger USING btree (club_id, to_entity_id, created_at); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_created_at') IS NULL THEN CREATE INDEX idx_chip_ledger_created_at ON public.chip_ledger USING btree (created_at); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_from_entity_created') IS NULL THEN CREATE INDEX idx_chip_ledger_from_entity_created ON public.chip_ledger USING btree (from_entity_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_overlay_by_tournament') IS NULL THEN CREATE INDEX idx_chip_ledger_overlay_by_tournament ON public.chip_ledger USING btree (tournament_id) INCLUDE (amount) WHERE ((tournament_id IS NOT NULL) AND (category = 'overlay'::text) AND (to_type = 'prize_liability'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_performed_by') IS NULL THEN CREATE INDEX idx_chip_ledger_performed_by ON public.chip_ledger USING btree (performed_by); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_promo_from') IS NULL THEN CREATE INDEX idx_chip_ledger_promo_from ON public.chip_ledger USING btree (from_entity_id, created_at DESC) WHERE (from_type = 'promo_wallet'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_promo_to') IS NULL THEN CREATE INDEX idx_chip_ledger_promo_to ON public.chip_ledger USING btree (to_entity_id, created_at DESC) WHERE (to_type = 'promo_wallet'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_rebuy_probe') IS NULL THEN CREATE INDEX idx_chip_ledger_rebuy_probe ON public.chip_ledger USING btree (from_entity_id, tournament_id, created_at) WHERE ((category = 'rebuy'::text) AND (from_type = 'player_wallet'::text) AND (to_type = 'prize_liability'::text) AND (status = 'posted'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_to_entity') IS NULL THEN CREATE INDEX idx_chip_ledger_to_entity ON public.chip_ledger USING btree (to_entity_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_ledger_to_entity_created') IS NULL THEN CREATE INDEX idx_chip_ledger_to_entity_created ON public.chip_ledger USING btree (to_entity_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ix_chip_ledger_settlement') IS NULL THEN CREATE INDEX ix_chip_ledger_settlement ON public.chip_ledger USING btree (settlement_id) WHERE (settlement_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ux_chip_ledger_idempotency_key') IS NULL THEN CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."chip_transactions" ();
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "from_user_id" uuid;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "from_user_id" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "from_user_id" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "to_user_id" uuid;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "to_user_id" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "to_user_id" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "amount" numeric(14,2);
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "amount" SET NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "transaction_type" text;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "transaction_type" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "transaction_type" SET NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "notes" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "notes" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "related_cashout_id" uuid;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "related_cashout_id" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "related_cashout_id" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "metadata" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "balance_after" numeric(14,2);
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "balance_after" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "balance_after" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "clawed_back" boolean;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "clawed_back" SET DEFAULT false;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "clawed_back" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "reversible_until" timestamp with time zone;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "reversible_until" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "reversible_until" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "is_reversed" boolean;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "is_reversed" SET DEFAULT false;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "is_reversed" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "table_id" DROP DEFAULT;
ALTER TABLE "public"."chip_transactions" ALTER COLUMN "table_id" DROP NOT NULL;
ALTER TABLE "public"."chip_transactions" OWNER TO "postgres";
ALTER TABLE "public"."chip_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."chip_transactions" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."chip_transactions"'::regclass AND conname='chip_transactions_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."chip_transactions" ADD CONSTRAINT "chip_transactions_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."chip_transactions"', 'chip_transactions_pkey';
END IF; END $c$;
ALTER TABLE "public"."chip_transactions" DROP CONSTRAINT IF EXISTS "fk_chip_transactions_club_id_clubs" RESTRICT;
ALTER TABLE "public"."chip_transactions" ADD CONSTRAINT "fk_chip_transactions_club_id_clubs" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE "public"."chip_transactions" DROP CONSTRAINT IF EXISTS "fk_chip_transactions_from_user_id_profiles" RESTRICT;
ALTER TABLE "public"."chip_transactions" ADD CONSTRAINT "fk_chip_transactions_from_user_id_profiles" FOREIGN KEY (from_user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."chip_transactions" DROP CONSTRAINT IF EXISTS "fk_chip_transactions_to_user_id_profiles" RESTRICT;
ALTER TABLE "public"."chip_transactions" ADD CONSTRAINT "fk_chip_transactions_to_user_id_profiles" FOREIGN KEY (to_user_id) REFERENCES profiles(id) ON DELETE CASCADE;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_agent_wallet_op_id_uidx') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_agent_wallet_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['agent_wallet_send'::text, 'agent_wallet_claim_back'::text, 'cashout_request_escrow'::text, 'cashout_approved'::text, 'cashout_denied'::text, 'cashout_cancelled'::text])) AND (metadata ? 'op_id'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_agent_wallet_reversible_idx') IS NULL THEN CREATE INDEX chip_transactions_agent_wallet_reversible_idx ON public.chip_transactions USING btree (from_user_id, reversible_until) WHERE (transaction_type = 'agent_wallet_send'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_club_bank_op_id_uidx') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_club_bank_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['club_bank_send'::text, 'club_bank_reversal'::text])) AND (metadata ? 'op_id'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_club_from_created_idx') IS NULL THEN CREATE INDEX chip_transactions_club_from_created_idx ON public.chip_transactions USING btree (club_id, from_user_id, created_at DESC) INCLUDE (amount, transaction_type, to_user_id, notes); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_club_to_created_idx') IS NULL THEN CREATE INDEX chip_transactions_club_to_created_idx ON public.chip_transactions USING btree (club_id, to_user_id, created_at DESC) INCLUDE (amount, transaction_type, from_user_id, notes); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_commission_claim_op_id_uidx') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_commission_claim_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = 'commission_claim'::text) AND (metadata ? 'op_id'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_pkey') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_pkey ON public.chip_transactions USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_staff_ops_op_id_uidx') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_staff_ops_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['admin_removal'::text, 'mint'::text, 'cashout_expired_refund'::text])) AND (metadata ? 'op_id'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_ticket_cancel_receipt_uidx') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_ticket_cancel_receipt_uidx ON public.chip_transactions USING btree (((metadata ->> 'ticket_id'::text))) WHERE (transaction_type = 'tournament_ticket_cancel'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_ticket_redeem_receipt_uidx') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_ticket_redeem_receipt_uidx ON public.chip_transactions USING btree (((metadata ->> 'ticket_id'::text))) WHERE (transaction_type = 'tournament_ticket_redeem'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.chip_transactions_wallet_ops_op_id_uidx') IS NULL THEN CREATE UNIQUE INDEX chip_transactions_wallet_ops_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['club_bank_claim'::text, 'promo_wallet_send'::text])) AND (metadata ? 'op_id'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_transactions_reversible_open') IS NULL THEN CREATE INDEX idx_chip_transactions_reversible_open ON public.chip_transactions USING btree (reversible_until) WHERE (reversible_until IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_tx_club_created') IS NULL THEN CREATE INDEX idx_chip_tx_club_created ON public.chip_transactions USING btree (club_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_tx_from') IS NULL THEN CREATE INDEX idx_chip_tx_from ON public.chip_transactions USING btree (from_user_id) WHERE (from_user_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_tx_from_user') IS NULL THEN CREATE INDEX idx_chip_tx_from_user ON public.chip_transactions USING btree (from_user_id, created_at DESC) WHERE (from_user_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_tx_table_id') IS NULL THEN CREATE INDEX idx_chip_tx_table_id ON public.chip_transactions USING btree (table_id, created_at) WHERE (table_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_tx_to_user') IS NULL THEN CREATE INDEX idx_chip_tx_to_user ON public.chip_transactions USING btree (to_user_id, created_at DESC) WHERE (to_user_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_chip_tx_type_user_created') IS NULL THEN CREATE INDEX idx_chip_tx_type_user_created ON public.chip_transactions USING btree (transaction_type, to_user_id, created_at); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.ux_chip_transactions_idempotency_key') IS NULL THEN CREATE UNIQUE INDEX ux_chip_transactions_idempotency_key ON public.chip_transactions USING btree (((metadata ->> 'idempotency_key'::text))) WHERE (metadata ? 'idempotency_key'::text); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."club_members" ();
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."club_members" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."club_members" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "role" SET DEFAULT 'player'::text;
ALTER TABLE "public"."club_members" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
ALTER TABLE "public"."club_members" ALTER COLUMN "agent_id" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "agent_id" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "joined_at" timestamp with time zone;
ALTER TABLE "public"."club_members" ALTER COLUMN "joined_at" SET DEFAULT now();
ALTER TABLE "public"."club_members" ALTER COLUMN "joined_at" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "parent_agent_id" uuid;
ALTER TABLE "public"."club_members" ALTER COLUMN "parent_agent_id" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "parent_agent_id" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "invited_by" uuid;
ALTER TABLE "public"."club_members" ALTER COLUMN "invited_by" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "invited_by" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "notes" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "notes" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "last_active_at" timestamp with time zone;
ALTER TABLE "public"."club_members" ALTER COLUMN "last_active_at" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "last_active_at" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."club_members" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."club_members" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."club_members" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."club_members" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "is_bot" boolean;
ALTER TABLE "public"."club_members" ALTER COLUMN "is_bot" SET DEFAULT false;
ALTER TABLE "public"."club_members" ALTER COLUMN "is_bot" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."club_members" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "chip_balance" numeric(20,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "chip_balance" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "chip_balance" SET NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "diamonds" integer;
ALTER TABLE "public"."club_members" ALTER COLUMN "diamonds" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "diamonds" SET NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "is_active" boolean;
ALTER TABLE "public"."club_members" ALTER COLUMN "is_active" SET DEFAULT true;
ALTER TABLE "public"."club_members" ALTER COLUMN "is_active" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "orange_ball_status" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "orange_ball_status" SET DEFAULT 'inactive'::text;
ALTER TABLE "public"."club_members" ALTER COLUMN "orange_ball_status" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "rank_level" integer;
ALTER TABLE "public"."club_members" ALTER COLUMN "rank_level" SET DEFAULT 1;
ALTER TABLE "public"."club_members" ALTER COLUMN "rank_level" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "credit_limit" numeric(15,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "credit_limit" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "credit_limit" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "credit_used" numeric(15,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "credit_used" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "credit_used" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "nickname" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "nickname" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "nickname" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "last_active" timestamp with time zone;
ALTER TABLE "public"."club_members" ALTER COLUMN "last_active" SET DEFAULT now();
ALTER TABLE "public"."club_members" ALTER COLUMN "last_active" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "tier" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "tier" SET DEFAULT 'bronze'::text;
ALTER TABLE "public"."club_members" ALTER COLUMN "tier" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "trust_score" integer;
ALTER TABLE "public"."club_members" ALTER COLUMN "trust_score" SET DEFAULT 50;
ALTER TABLE "public"."club_members" ALTER COLUMN "trust_score" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "sessions_played" integer;
ALTER TABLE "public"."club_members" ALTER COLUMN "sessions_played" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "sessions_played" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "promo_balance" numeric(14,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_balance" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_balance" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "chips_won" bigint;
ALTER TABLE "public"."club_members" ALTER COLUMN "chips_won" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "chips_won" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "chips_lost" bigint;
ALTER TABLE "public"."club_members" ALTER COLUMN "chips_lost" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "chips_lost" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "commission_rate" numeric(5,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "commission_rate" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "commission_rate" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "rakeback_rate" numeric(5,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "rakeback_rate" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "rakeback_rate" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "hands_played" integer;
ALTER TABLE "public"."club_members" ALTER COLUMN "hands_played" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "hands_played" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "total_rake_paid" bigint;
ALTER TABLE "public"."club_members" ALTER COLUMN "total_rake_paid" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "total_rake_paid" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "biggest_pot" bigint;
ALTER TABLE "public"."club_members" ALTER COLUMN "biggest_pot" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "biggest_pot" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "locked_chips" integer;
ALTER TABLE "public"."club_members" ALTER COLUMN "locked_chips" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "locked_chips" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "player_rakeback_pct" numeric(5,4);
ALTER TABLE "public"."club_members" ALTER COLUMN "player_rakeback_pct" SET DEFAULT 0.0000;
ALTER TABLE "public"."club_members" ALTER COLUMN "player_rakeback_pct" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "held_chips" numeric;
ALTER TABLE "public"."club_members" ALTER COLUMN "held_chips" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "held_chips" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "display_name" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "display_name" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "is_prepaid" boolean;
ALTER TABLE "public"."club_members" ALTER COLUMN "is_prepaid" SET DEFAULT true;
ALTER TABLE "public"."club_members" ALTER COLUMN "is_prepaid" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "promo_received_total" numeric(14,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_received_total" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_received_total" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "promo_wagered" numeric(14,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_wagered" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_wagered" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "promo_playthrough_required" numeric(14,2);
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_playthrough_required" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "promo_playthrough_required" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "missions_completed" integer;
ALTER TABLE "public"."club_members" ALTER COLUMN "missions_completed" SET DEFAULT 0;
ALTER TABLE "public"."club_members" ALTER COLUMN "missions_completed" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "membership_lifecycle_status" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "membership_lifecycle_status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."club_members" ALTER COLUMN "membership_lifecycle_status" SET NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "departed_at" timestamp with time zone;
ALTER TABLE "public"."club_members" ALTER COLUMN "departed_at" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "departed_at" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "departed_by" uuid;
ALTER TABLE "public"."club_members" ALTER COLUMN "departed_by" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "departed_by" DROP NOT NULL;
ALTER TABLE "public"."club_members" ADD COLUMN IF NOT EXISTS "departure_reason" text;
ALTER TABLE "public"."club_members" ALTER COLUMN "departure_reason" DROP DEFAULT;
ALTER TABLE "public"."club_members" ALTER COLUMN "departure_reason" DROP NOT NULL;
ALTER TABLE "public"."club_members" OWNER TO "postgres";
ALTER TABLE "public"."club_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."club_members" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "chk_held_chips_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "chk_held_chips_is_two_decimal_places" CHECK (((held_chips IS NULL) OR (held_chips = round(held_chips, 2))));
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_agent_id_fkey" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_bot_house_only" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_bot_house_only" CHECK (((NOT COALESCE(is_bot, false)) OR fn_ca_house_board_allows_automation(club_id)));
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_chip_balance_nonneg" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_chip_balance_nonneg" CHECK ((chip_balance >= (0)::numeric));
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_club_id_fkey" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_membership_lifecycle_check" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_membership_lifecycle_check" CHECK ((membership_lifecycle_status = ANY (ARRAY['active'::text, 'departed'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."club_members"'::regclass AND conname='club_members_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_pkey" PRIMARY KEY (club_id, user_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (club_id, user_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."club_members"', 'club_members_pkey';
END IF; END $c$;
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_profiles_fkey" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_profiles_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_promo_balance_nonneg" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_promo_balance_nonneg" CHECK ((promo_balance >= (0)::numeric));
ALTER TABLE "public"."club_members" DROP CONSTRAINT IF EXISTS "club_members_role_check" RESTRICT;
ALTER TABLE "public"."club_members" ADD CONSTRAINT "club_members_role_check" CHECK ((role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'super_agent'::text, 'agent'::text, 'sub_agent'::text, 'player'::text])));
DO $i$ BEGIN IF to_regclass('public.club_members_cashier_tree_idx') IS NULL THEN CREATE INDEX club_members_cashier_tree_idx ON public.club_members USING btree (club_id, agent_id, user_id) INCLUDE (role, status, chip_balance) WHERE (COALESCE(status, 'active'::text) = ANY (ARRAY['active'::text, 'approved'::text])); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.club_members_pkey') IS NULL THEN CREATE UNIQUE INDEX club_members_pkey ON public.club_members USING btree (club_id, user_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_club_members_active_lifecycle') IS NULL THEN CREATE INDEX idx_club_members_active_lifecycle ON public.club_members USING btree (club_id, user_id) WHERE (membership_lifecycle_status = 'active'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_club_members_agent_id') IS NULL THEN CREATE INDEX idx_club_members_agent_id ON public.club_members USING btree (agent_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_club_members_club_status') IS NULL THEN CREATE INDEX idx_club_members_club_status ON public.club_members USING btree (club_id, status); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_club_members_search_scope') IS NULL THEN CREATE INDEX idx_club_members_search_scope ON public.club_members USING btree (club_id, user_id) WHERE (status = ANY (ARRAY['active'::text, 'approved'::text])); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_club_members_user') IS NULL THEN CREATE INDEX idx_club_members_user ON public.club_members USING btree (user_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_club_members_user_active') IS NULL THEN CREATE INDEX idx_club_members_user_active ON public.club_members USING btree (user_id, club_id) WHERE (status = ANY (ARRAY['active'::text, 'approved'::text])); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_cm_club_role_status') IS NULL THEN CREATE INDEX idx_cm_club_role_status ON public.club_members USING btree (club_id, role, status); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."clubs" ();
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."clubs" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();
ALTER TABLE "public"."clubs" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "name" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "description" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "description" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "owner_id" uuid;
ALTER TABLE "public"."clubs" ALTER COLUMN "owner_id" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "owner_id" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."clubs" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."clubs" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "is_union" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_union" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_union" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "club_id" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "club_id" SET DEFAULT (((10000)::double precision + floor((random() * (90000)::double precision))))::integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "avatar_url" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "avatar_url" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "avatar_url" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "is_public" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_public" SET DEFAULT true;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_public" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "requires_approval" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "requires_approval" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "requires_approval" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "gps_restricted" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "gps_restricted" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "gps_restricted" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "settings" jsonb;
ALTER TABLE "public"."clubs" ALTER COLUMN "settings" SET DEFAULT '{"rake_cap": 15, "max_buy_in_bb": 200, "min_buy_in_bb": 40, "allow_straddle": true, "time_bank_seconds": 30, "allow_run_it_twice": true, "default_rake_percent": 5}'::jsonb;
ALTER TABLE "public"."clubs" ALTER COLUMN "settings" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."clubs" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."clubs" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."clubs" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "union_id" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "color_theme" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "color_theme" SET DEFAULT 'royal-blue'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "color_theme" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "slug" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "slug" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "chip_treasury" numeric(18,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "chip_treasury" SET DEFAULT 100000;
ALTER TABLE "public"."clubs" ALTER COLUMN "chip_treasury" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "total_rake" numeric(18,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "total_rake" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "total_rake" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "online_count" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "online_count" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "online_count" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "game_types" text[];
ALTER TABLE "public"."clubs" ALTER COLUMN "game_types" SET DEFAULT ARRAY['NLH'::text];
ALTER TABLE "public"."clubs" ALTER COLUMN "game_types" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "member_count" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "member_count" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "member_count" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "table_count" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "table_count" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "table_count" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "promo_balance" numeric(14,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "promo_balance" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "promo_balance" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "code" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "code" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "code" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "rake_percent" numeric(5,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "rake_percent" SET DEFAULT 5.0;
ALTER TABLE "public"."clubs" ALTER COLUMN "rake_percent" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "rake_cap_bb" numeric(8,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "rake_cap_bb" SET DEFAULT 3.0;
ALTER TABLE "public"."clubs" ALTER COLUMN "rake_cap_bb" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "max_tables" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "max_tables" SET DEFAULT 20;
ALTER TABLE "public"."clubs" ALTER COLUMN "max_tables" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "max_members" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "max_members" SET DEFAULT 500;
ALTER TABLE "public"."clubs" ALTER COLUMN "max_members" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "hands_played" bigint;
ALTER TABLE "public"."clubs" ALTER COLUMN "hands_played" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "hands_played" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "logo_url" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "logo_url" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "logo_url" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "banner_url" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "banner_url" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "banner_url" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "game_variants" text[];
ALTER TABLE "public"."clubs" ALTER COLUMN "game_variants" SET DEFAULT ARRAY['nlh'::text];
ALTER TABLE "public"."clubs" ALTER COLUMN "game_variants" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "settlement_locked" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "settlement_locked" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "settlement_locked" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "settlement_locked_until" timestamp with time zone;
ALTER TABLE "public"."clubs" ALTER COLUMN "settlement_locked_until" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "settlement_locked_until" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "auto_settlement_enabled" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement_enabled" SET DEFAULT true;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement_enabled" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "auto_settlement_day" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement_day" SET DEFAULT 'monday'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement_day" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "auto_settlement_hour" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement_hour" SET DEFAULT 10;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement_hour" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "club_commission_rate" numeric(5,4);
ALTER TABLE "public"."clubs" ALTER COLUMN "club_commission_rate" SET DEFAULT 0.9000;
ALTER TABLE "public"."clubs" ALTER COLUMN "club_commission_rate" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "insurance_balance" numeric(14,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "insurance_balance" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "insurance_balance" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "bbj_enabled" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "bbj_enabled" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "bbj_enabled" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "player_level" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "player_level" SET DEFAULT 1;
ALTER TABLE "public"."clubs" ALTER COLUMN "player_level" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "hierarchy_level" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_level" SET DEFAULT 1;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_level" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "level" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "level" SET DEFAULT 1;
ALTER TABLE "public"."clubs" ALTER COLUMN "level" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "player_threshold_current" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "player_threshold_current" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "player_threshold_current" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "player_threshold_next" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "player_threshold_next" SET DEFAULT 30;
ALTER TABLE "public"."clubs" ALTER COLUMN "player_threshold_next" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "hierarchy_units" numeric(10,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_units" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_units" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "hierarchy_units_rounded_up" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_units_rounded_up" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_units_rounded_up" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "hierarchy_threshold_current" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_threshold_current" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_threshold_current" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "hierarchy_threshold_next" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_threshold_next" SET DEFAULT 2;
ALTER TABLE "public"."clubs" ALTER COLUMN "hierarchy_threshold_next" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "tags" text[];
ALTER TABLE "public"."clubs" ALTER COLUMN "tags" SET DEFAULT '{}'::text[];
ALTER TABLE "public"."clubs" ALTER COLUMN "tags" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "average_rating" numeric(3,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "average_rating" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "average_rating" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "game_type" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "game_type" SET DEFAULT 'Texas Holdem'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "game_type" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "settlement_lock_until" timestamp with time zone;
ALTER TABLE "public"."clubs" ALTER COLUMN "settlement_lock_until" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "settlement_lock_until" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "card_image_url" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "card_image_url" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "card_image_url" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "active_players" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "active_players" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "active_players" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "default_rake_percent" numeric(5,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "default_rake_percent" SET DEFAULT '-1'::integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "default_rake_percent" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "rake_cap" numeric(18,4);
ALTER TABLE "public"."clubs" ALTER COLUMN "rake_cap" SET DEFAULT '-1'::integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "rake_cap" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "min_buyin_bb" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "min_buyin_bb" SET DEFAULT 20;
ALTER TABLE "public"."clubs" ALTER COLUMN "min_buyin_bb" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "max_buyin_bb" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "max_buyin_bb" SET DEFAULT 200;
ALTER TABLE "public"."clubs" ALTER COLUMN "max_buyin_bb" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "allow_straddle" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_straddle" SET DEFAULT true;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_straddle" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "allow_run_it_twice" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_run_it_twice" SET DEFAULT true;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_run_it_twice" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "allow_rabbit_hunt" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_rabbit_hunt" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_rabbit_hunt" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "logo" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "logo" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "logo" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "is_private" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_private" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_private" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "min_buy_in" numeric(18,4);
ALTER TABLE "public"."clubs" ALTER COLUMN "min_buy_in" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "min_buy_in" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "max_buy_in" numeric(18,4);
ALTER TABLE "public"."clubs" ALTER COLUMN "max_buy_in" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "max_buy_in" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "default_game_type" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "default_game_type" SET DEFAULT 'NLHE'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "default_game_type" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "allow_insurance" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_insurance" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "allow_insurance" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "auto_approve_agents" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_approve_agents" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_approve_agents" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "auto_settlement" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "auto_settlement" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "active_tables" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "active_tables" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "active_tables" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "admin_count" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "admin_count" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "admin_count" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "super_agent_count" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "super_agent_count" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "super_agent_count" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "agent_count" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "agent_count" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "agent_count" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "chip_pool" numeric(18,2);
ALTER TABLE "public"."clubs" ALTER COLUMN "chip_pool" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "chip_pool" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "bbj_rake_enabled" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "bbj_rake_enabled" SET DEFAULT true;
ALTER TABLE "public"."clubs" ALTER COLUMN "bbj_rake_enabled" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "spins_enabled" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "spins_enabled" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "spins_enabled" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "spins_preseed_amount" integer;
ALTER TABLE "public"."clubs" ALTER COLUMN "spins_preseed_amount" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "spins_preseed_amount" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "spins_wallet_funding" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "spins_wallet_funding" SET DEFAULT 'PROMO'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "spins_wallet_funding" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "ticker_enabled" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "ticker_enabled" SET DEFAULT true;
ALTER TABLE "public"."clubs" ALTER COLUMN "ticker_enabled" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "guarantee_treasury_floor" numeric;
ALTER TABLE "public"."clubs" ALTER COLUMN "guarantee_treasury_floor" SET DEFAULT 0;
ALTER TABLE "public"."clubs" ALTER COLUMN "guarantee_treasury_floor" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "guarantee_enforcement_enabled" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "guarantee_enforcement_enabled" SET DEFAULT true;
ALTER TABLE "public"."clubs" ALTER COLUMN "guarantee_enforcement_enabled" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "tagline" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "tagline" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "tagline" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "opening_checklist_started_at" timestamp with time zone;
ALTER TABLE "public"."clubs" ALTER COLUMN "opening_checklist_started_at" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "opening_checklist_started_at" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "lobby_message" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "lobby_message" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "lobby_message" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "lobby_message_updated_at" timestamp with time zone;
ALTER TABLE "public"."clubs" ALTER COLUMN "lobby_message_updated_at" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "lobby_message_updated_at" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "message_revision" bigint;
ALTER TABLE "public"."clubs" ALTER COLUMN "message_revision" SET DEFAULT 1;
ALTER TABLE "public"."clubs" ALTER COLUMN "message_revision" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "lifecycle_status" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "lifecycle_status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "lifecycle_status" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "public"."clubs" ALTER COLUMN "retired_at" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "retired_at" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "retired_by" uuid;
ALTER TABLE "public"."clubs" ALTER COLUMN "retired_by" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "retired_by" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "retirement_reason" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "retirement_reason" DROP DEFAULT;
ALTER TABLE "public"."clubs" ALTER COLUMN "retirement_reason" DROP NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "asset" text;
ALTER TABLE "public"."clubs" ALTER COLUMN "asset" SET DEFAULT 'chips'::text;
ALTER TABLE "public"."clubs" ALTER COLUMN "asset" SET NOT NULL;
ALTER TABLE "public"."clubs" ADD COLUMN IF NOT EXISTS "is_platform" boolean;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_platform" SET DEFAULT false;
ALTER TABLE "public"."clubs" ALTER COLUMN "is_platform" SET NOT NULL;
ALTER TABLE "public"."clubs" OWNER TO "postgres";
ALTER TABLE "public"."clubs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."clubs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_asset_known" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_asset_known" CHECK ((asset = ANY (ARRAY['chips'::text, 'diamonds'::text])));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_chip_pool_nonneg" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_chip_pool_nonneg" CHECK ((chip_pool >= (0)::numeric));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_chip_treasury_nonneg" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_chip_treasury_nonneg" CHECK ((chip_treasury >= (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."clubs"'::regclass AND conname='clubs_club_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_club_id_key" UNIQUE (club_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (club_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."clubs"', 'clubs_club_id_key';
END IF; END $c$;
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_default_rake_percent_range" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_default_rake_percent_range" CHECK (((default_rake_percent IS NULL) OR (default_rake_percent = ('-1'::integer)::numeric) OR ((default_rake_percent >= (0)::numeric) AND (default_rake_percent <= (10)::numeric)))) NOT VALID;
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_description_character_limit" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_description_character_limit" CHECK ((char_length(COALESCE(description, ''::text)) <= 500));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_insurance_balance_nonneg" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_insurance_balance_nonneg" CHECK ((insurance_balance >= (0)::numeric));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_lifecycle_status_check" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_lifecycle_status_check" CHECK ((lifecycle_status = ANY (ARRAY['active'::text, 'retired'::text])));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_lobby_message_character_limit" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_lobby_message_character_limit" CHECK ((char_length(COALESCE(lobby_message, ''::text)) <= 240));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_message_revision_positive" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_message_revision_positive" CHECK ((message_revision > 0));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_name_not_blank" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_name_not_blank" CHECK ((btrim(name) <> ''::text));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_owner_id_fkey" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES profiles(id);
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."clubs"'::regclass AND conname='clubs_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."clubs"', 'clubs_pkey';
END IF; END $c$;
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_promo_balance_nonneg" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_promo_balance_nonneg" CHECK ((promo_balance >= (0)::numeric));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_rake_cap_range" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_rake_cap_range" CHECK (((rake_cap IS NULL) OR (rake_cap = ('-1'::integer)::numeric) OR ((rake_cap >= (0)::numeric) AND (rake_cap <= (10)::numeric)))) NOT VALID;
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_retired_by_fkey" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_retired_by_fkey" FOREIGN KEY (retired_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_tagline_character_limit" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_tagline_character_limit" CHECK ((char_length(COALESCE(tagline, ''::text)) <= 72));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_tagline_length" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_tagline_length" CHECK (((tagline IS NULL) OR (char_length(tagline) <= 72)));
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "clubs_union_id_fkey" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "clubs_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id);
ALTER TABLE "public"."clubs" DROP CONSTRAINT IF EXISTS "poker_arena_diamond_identity" RESTRICT;
ALTER TABLE "public"."clubs" ADD CONSTRAINT "poker_arena_diamond_identity" CHECK ((((asset = 'chips'::text) AND (NOT is_platform)) OR ((asset = 'diamonds'::text) AND is_platform AND (union_id IS NULL) AND (NOT COALESCE(is_union, false)) AND (COALESCE(chip_treasury, (0)::numeric) = (0)::numeric) AND (COALESCE(chip_pool, (0)::numeric) = (0)::numeric) AND (COALESCE(promo_balance, (0)::numeric) = (0)::numeric) AND (COALESCE(insurance_balance, (0)::numeric) = (0)::numeric))));
DO $i$ BEGIN IF to_regclass('public.ca_clubs_one_platform_club') IS NULL THEN CREATE UNIQUE INDEX ca_clubs_one_platform_club ON public.clubs USING btree (is_platform) WHERE is_platform; END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.clubs_club_id_key') IS NULL THEN CREATE UNIQUE INDEX clubs_club_id_key ON public.clubs USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.clubs_pkey') IS NULL THEN CREATE UNIQUE INDEX clubs_pkey ON public.clubs USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_clubs_active_lifecycle') IS NULL THEN CREATE INDEX idx_clubs_active_lifecycle ON public.clubs USING btree (id) WHERE (lifecycle_status = 'active'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_clubs_code') IS NULL THEN CREATE UNIQUE INDEX idx_clubs_code ON public.clubs USING btree (code); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_clubs_name_lower') IS NULL THEN CREATE UNIQUE INDEX idx_clubs_name_lower ON public.clubs USING btree (lower(name)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_clubs_one_platform') IS NULL THEN CREATE UNIQUE INDEX idx_clubs_one_platform ON public.clubs USING btree (is_platform) WHERE is_platform; END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_clubs_owner') IS NULL THEN CREATE INDEX idx_clubs_owner ON public.clubs USING btree (owner_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_clubs_slug') IS NULL THEN CREATE UNIQUE INDEX idx_clubs_slug ON public.clubs USING btree (slug) WHERE (slug IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_clubs_union_id') IS NULL THEN CREATE INDEX idx_clubs_union_id ON public.clubs USING btree (union_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.poker_arena_one_diamond_identity') IS NULL THEN CREATE UNIQUE INDEX poker_arena_one_diamond_identity ON public.clubs USING btree (asset) WHERE (asset = 'diamonds'::text); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."financial_alerts" ();
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "severity" text;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "severity" DROP DEFAULT;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "severity" SET NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "source" SET NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "message" text;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "message" DROP DEFAULT;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "message" SET NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "context" jsonb;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "context" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "context" DROP NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "resolved" boolean;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolved" SET DEFAULT false;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolved" SET NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolved_at" DROP DEFAULT;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolved_at" DROP NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "resolved_by" uuid;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolved_by" DROP DEFAULT;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolved_by" DROP NOT NULL;
ALTER TABLE "public"."financial_alerts" ADD COLUMN IF NOT EXISTS "resolution" text;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolution" DROP DEFAULT;
ALTER TABLE "public"."financial_alerts" ALTER COLUMN "resolution" DROP NOT NULL;
ALTER TABLE "public"."financial_alerts" OWNER TO "postgres";
ALTER TABLE "public"."financial_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."financial_alerts" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."financial_alerts"'::regclass AND conname='financial_alerts_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."financial_alerts" ADD CONSTRAINT "financial_alerts_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."financial_alerts"', 'financial_alerts_pkey';
END IF; END $c$;
ALTER TABLE "public"."financial_alerts" DROP CONSTRAINT IF EXISTS "financial_alerts_resolved_by_fkey" RESTRICT;
ALTER TABLE "public"."financial_alerts" ADD CONSTRAINT "financial_alerts_resolved_by_fkey" FOREIGN KEY (resolved_by) REFERENCES auth.users(id);
ALTER TABLE "public"."financial_alerts" DROP CONSTRAINT IF EXISTS "financial_alerts_severity_check" RESTRICT;
ALTER TABLE "public"."financial_alerts" ADD CONSTRAINT "financial_alerts_severity_check" CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])));
DO $i$ BEGIN IF to_regclass('public.financial_alerts_incident_id_idx') IS NULL THEN CREATE INDEX financial_alerts_incident_id_idx ON public.financial_alerts USING btree (((context ->> 'incident_id'::text))) WHERE (context ? 'incident_id'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.financial_alerts_incident_uuid_idx') IS NULL THEN CREATE INDEX financial_alerts_incident_uuid_idx ON public.financial_alerts USING btree ((((context ->> 'incident_id'::text))::uuid)) WHERE ((context ->> 'incident_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.financial_alerts_pkey') IS NULL THEN CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.financial_alerts_unresolved_source_idx') IS NULL THEN CREATE INDEX financial_alerts_unresolved_source_idx ON public.financial_alerts USING btree (source) WHERE (NOT resolved); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_financial_alerts_reported_by_created') IS NULL THEN CREATE INDEX idx_financial_alerts_reported_by_created ON public.financial_alerts USING btree (((context ->> 'reported_by'::text)), created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_financial_alerts_resolved') IS NULL THEN CREATE INDEX idx_financial_alerts_resolved ON public.financial_alerts USING btree (resolved) WHERE (resolved = false); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_financial_alerts_resolved_by') IS NULL THEN CREATE INDEX idx_financial_alerts_resolved_by ON public.financial_alerts USING btree (resolved_by); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_financial_alerts_severity') IS NULL THEN CREATE INDEX idx_financial_alerts_severity ON public.financial_alerts USING btree (severity); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_financial_alerts_source_created') IS NULL THEN CREATE INDEX idx_financial_alerts_source_created ON public.financial_alerts USING btree (source, created_at DESC); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."notifications" ();
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."notifications" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."notifications" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."notifications" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "type" text;
ALTER TABLE "public"."notifications" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "type" SET NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "public"."notifications" ALTER COLUMN "title" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "title" SET NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "message" text;
ALTER TABLE "public"."notifications" ALTER COLUMN "message" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "message" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "data" jsonb;
ALTER TABLE "public"."notifications" ALTER COLUMN "data" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."notifications" ALTER COLUMN "data" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "read" boolean;
ALTER TABLE "public"."notifications" ALTER COLUMN "read" SET DEFAULT false;
ALTER TABLE "public"."notifications" ALTER COLUMN "read" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."notifications" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."notifications" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."notifications" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."notifications" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "is_read" boolean;
ALTER TABLE "public"."notifications" ALTER COLUMN "is_read" SET DEFAULT false;
ALTER TABLE "public"."notifications" ALTER COLUMN "is_read" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "action_url" text;
ALTER TABLE "public"."notifications" ALTER COLUMN "action_url" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "action_url" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "public"."notifications" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."notifications" ALTER COLUMN "metadata" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "actor_id" uuid;
ALTER TABLE "public"."notifications" ALTER COLUMN "actor_id" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "actor_id" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "link" text;
ALTER TABLE "public"."notifications" ALTER COLUMN "link" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "link" DROP NOT NULL;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;
ALTER TABLE "public"."notifications" ALTER COLUMN "read_at" DROP DEFAULT;
ALTER TABLE "public"."notifications" ALTER COLUMN "read_at" DROP NOT NULL;
ALTER TABLE "public"."notifications" OWNER TO "postgres";
ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."notifications" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."notifications" DROP CONSTRAINT IF EXISTS "fk_notifications_user_id_profiles" RESTRICT;
ALTER TABLE "public"."notifications" ADD CONSTRAINT "fk_notifications_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."notifications" DROP CONSTRAINT IF EXISTS "notifications_actor_id_fkey" RESTRICT;
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES profiles(id);
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."notifications"'::regclass AND conname='notifications_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."notifications"', 'notifications_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.idx_notif_dedup_friend_request') IS NULL THEN CREATE UNIQUE INDEX idx_notif_dedup_friend_request ON public.notifications USING btree (user_id, type, ((data ->> 'sender_id'::text))) WHERE (type = 'friend_request'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_notif_dedup_group_friend') IS NULL THEN CREATE UNIQUE INDEX idx_notif_dedup_group_friend ON public.notifications USING btree (user_id, type, ((data ->> 'group_id'::text)), ((data ->> 'friend_id'::text))) WHERE (type = 'home_group_friend_joined'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_notifications_actor_id') IS NULL THEN CREATE INDEX idx_notifications_actor_id ON public.notifications USING btree (actor_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_notifications_user_all') IS NULL THEN CREATE INDEX idx_notifications_user_all ON public.notifications USING btree (user_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_notifications_user_id') IS NULL THEN CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_notifications_user_id_id') IS NULL THEN CREATE INDEX idx_notifications_user_id_id ON public.notifications USING btree (user_id, id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_notifications_user_type_read') IS NULL THEN CREATE INDEX idx_notifications_user_type_read ON public.notifications USING btree (user_id, type, read, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_notifications_user_unread') IS NULL THEN CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, read, created_at DESC) WHERE (read = false); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.notifications_daily_mission_cycle_unique') IS NULL THEN CREATE UNIQUE INDEX notifications_daily_mission_cycle_unique ON public.notifications USING btree (user_id, ((data ->> 'cycle_date'::text))) WHERE ((type = 'daily_challenge'::text) AND ((data ->> 'source'::text) = 'club_arena_daily_missions'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.notifications_pa_leak_audit_job_unique') IS NULL THEN CREATE UNIQUE INDEX notifications_pa_leak_audit_job_unique ON public.notifications USING btree (((data ->> 'paAuditJobId'::text))) WHERE ((type = 'personal_assistant_audit_complete'::text) AND (data ? 'paAuditJobId'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.notifications_pkey') IS NULL THEN CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."profiles" ();
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."profiles" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "full_name" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "full_name" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "full_name" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "display_name" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "display_name" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "first_name" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "first_name" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "first_name" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "last_name" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_name" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_name" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "username" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "username" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "username" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "email" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "email" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "phone" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "bio" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "bio" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "bio" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "city" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "city" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "city" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "state" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "state" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "alias" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "alias" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "alias" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "avatar_url" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "avatar_url" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "avatar_url" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "role" SET DEFAULT 'user'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "is_vip" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_vip" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_vip" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "is_horse" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_horse" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_horse" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "is_admin" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_admin" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_admin" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "is_online" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_online" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_online" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "player_number" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "player_number" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "player_number" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "diamonds" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "diamonds" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "diamonds" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "diamond_balance" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "diamond_balance" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "diamond_balance" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "diamond_multiplier" numeric(3,2);
ALTER TABLE "public"."profiles" ALTER COLUMN "diamond_multiplier" SET DEFAULT 1.00;
ALTER TABLE "public"."profiles" ALTER COLUMN "diamond_multiplier" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "level" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "level" SET DEFAULT 1;
ALTER TABLE "public"."profiles" ALTER COLUMN "level" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "tier" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "tier" SET DEFAULT 'Newcomer'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "tier" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "skill_tier" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "skill_tier" SET DEFAULT 'Newcomer'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "skill_tier" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "login_streak" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "login_streak" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "login_streak" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "streak_days" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "streak_days" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "streak_days" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "settings" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "settings" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "settings" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "preferences" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "preferences" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "social_page_id" uuid;
ALTER TABLE "public"."profiles" ALTER COLUMN "social_page_id" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "social_page_id" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "favorite_venue" uuid;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_venue" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_venue" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "home_poker_club" uuid;
ALTER TABLE "public"."profiles" ALTER COLUMN "home_poker_club" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "home_poker_club" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "referred_by" uuid;
ALTER TABLE "public"."profiles" ALTER COLUMN "referred_by" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "referred_by" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "friends_count" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "friends_count" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "friends_count" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "hendon_total_cashes" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_total_cashes" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_total_cashes" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "hendon_total_earnings" numeric;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_total_earnings" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_total_earnings" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "email_verified" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "email_verified" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "email_verified" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "phone_verified" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "phone_verified" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "phone_verified" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "onboarding_complete" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "onboarding_complete" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "onboarding_complete" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "last_login" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_login" SET DEFAULT now();
ALTER TABLE "public"."profiles" ALTER COLUMN "last_login" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "last_login_date" date;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_login_date" SET DEFAULT CURRENT_DATE;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_login_date" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "last_seen" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_seen" SET DEFAULT now();
ALTER TABLE "public"."profiles" ALTER COLUMN "last_seen" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."profiles" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."profiles" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "training_view_mode" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "training_view_mode" SET DEFAULT 'grid'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "training_view_mode" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "last_trivia_date" date;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_trivia_date" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_trivia_date" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "trivia_streak" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "trivia_streak" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "trivia_streak" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "trivia_high_score" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "trivia_high_score" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "trivia_high_score" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "total_hands_played" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "total_hands_played" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "total_hands_played" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "notification_token" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "notification_token" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "notification_token" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "referral_code" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "referral_code" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "referral_code" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "horse_status" character varying;
ALTER TABLE "public"."profiles" ALTER COLUMN "horse_status" SET DEFAULT 'available'::character varying;
ALTER TABLE "public"."profiles" ALTER COLUMN "horse_status" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "horse_profile" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "horse_profile" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "horse_profile" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "sounds_enabled" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "sounds_enabled" SET DEFAULT true;
ALTER TABLE "public"."profiles" ALTER COLUMN "sounds_enabled" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "vibrations_enabled" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "vibrations_enabled" SET DEFAULT true;
ALTER TABLE "public"."profiles" ALTER COLUMN "vibrations_enabled" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "show_stack_bb" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "show_stack_bb" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "show_stack_bb" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "birth_year" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "birth_year" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "birth_year" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "favorite_hand_type" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_hand_type" SET DEFAULT 'holdem'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_hand_type" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "card_back_preference" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "card_back_preference" SET DEFAULT 'white'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "card_back_preference" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "country" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "country" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "country" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "website" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "website" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "website" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "twitter" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "twitter" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "twitter" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "instagram" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "instagram" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "instagram" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "hendon_url" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_url" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_url" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "favorite_game" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_game" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_game" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "favorite_hand" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_hand" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_hand" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "home_casino" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "home_casino" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "home_casino" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "cover_photo_url" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "cover_photo_url" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "cover_photo_url" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "favorite_hand_plo" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_hand_plo" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "favorite_hand_plo" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "app_settings" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "app_settings" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "app_settings" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "display_name_preference" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "display_name_preference" SET DEFAULT 'full_name'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "display_name_preference" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "cover_photo_position" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "cover_photo_position" SET DEFAULT '50% 50%'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "cover_photo_position" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "tiktok" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "tiktok" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "tiktok" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "telegram" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "telegram" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "telegram" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "birthday" date;
ALTER TABLE "public"."profiles" ALTER COLUMN "birthday" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "birthday" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "hendon_biggest_cash" numeric;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_biggest_cash" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "hendon_biggest_cash" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "use_real_name" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "use_real_name" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "use_real_name" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "streak_count" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "streak_count" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "streak_count" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "access_tier" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "access_tier" SET DEFAULT 'Full_Access'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "access_tier" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "vip_tier" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "vip_tier" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "vip_tier" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "vip_expires_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "vip_expires_at" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "vip_expires_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "last_active" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "last_active" SET DEFAULT now();
ALTER TABLE "public"."profiles" ALTER COLUMN "last_active" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "poker_near_me_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "poker_near_me_preferences" SET DEFAULT '{"geofenceAlerts": true, "locationEnabled": true, "showNewcomerFriendly": true}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "poker_near_me_preferences" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "can_review" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "can_review" SET DEFAULT true;
ALTER TABLE "public"."profiles" ALTER COLUMN "can_review" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "deleted_reviews_count" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "deleted_reviews_count" SET DEFAULT 0;
ALTER TABLE "public"."profiles" ALTER COLUMN "deleted_reviews_count" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "kyc_status" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_status" SET DEFAULT 'NONE'::text;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_status" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "kyc_provider" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_provider" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_provider" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "kyc_inquiry_id" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_inquiry_id" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_inquiry_id" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "kyc_completed_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_completed_at" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_completed_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "kyc_rejection_reason" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_rejection_reason" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "kyc_rejection_reason" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "age_verified" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "age_verified" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "age_verified" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "age_verified_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "age_verified_at" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "age_verified_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "jurisdiction_country" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "jurisdiction_country" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "jurisdiction_country" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "mfa_required" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "mfa_required" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "mfa_required" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "hub_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "hub_preferences" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "hub_preferences" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "friend_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "friend_preferences" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "friend_preferences" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "store_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "store_preferences" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "store_preferences" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "messenger_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "messenger_preferences" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "messenger_preferences" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "reels_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "reels_preferences" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "reels_preferences" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "over_18_attested_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "over_18_attested_at" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "over_18_attested_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "jurisdiction_region" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "jurisdiction_region" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "jurisdiction_region" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "jurisdiction_acknowledged_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "jurisdiction_acknowledged_at" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "jurisdiction_acknowledged_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "home_games_onboarded_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "home_games_onboarded_at" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "home_games_onboarded_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "social_profile_completed" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "social_profile_completed" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "social_profile_completed" SET NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "is_farming_flagged" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_farming_flagged" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "is_farming_flagged" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "stripe_customer_id" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "stripe_customer_id" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "club_arena_tos_accepted_at" timestamp with time zone;
ALTER TABLE "public"."profiles" ALTER COLUMN "club_arena_tos_accepted_at" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "club_arena_tos_accepted_at" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "bankroll_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "bankroll_preferences" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "bankroll_preferences" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "diamond_arena_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "diamond_arena_preferences" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "diamond_arena_preferences" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "memory_games_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "memory_games_preferences" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "memory_games_preferences" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "news_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "news_preferences" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "news_preferences" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "video_library_preferences" jsonb;
ALTER TABLE "public"."profiles" ALTER COLUMN "video_library_preferences" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "video_library_preferences" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "memory_elo" integer;
ALTER TABLE "public"."profiles" ALTER COLUMN "memory_elo" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "memory_elo" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "arena_avatar_url" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "arena_avatar_url" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "arena_avatar_url" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "equipped_frame" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "equipped_frame" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "equipped_frame" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "equipped_aura" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "equipped_aura" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "equipped_aura" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "use_avatar_as_profile_pic" boolean;
ALTER TABLE "public"."profiles" ALTER COLUMN "use_avatar_as_profile_pic" SET DEFAULT false;
ALTER TABLE "public"."profiles" ALTER COLUMN "use_avatar_as_profile_pic" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "status_text" text;
ALTER TABLE "public"."profiles" ALTER COLUMN "status_text" DROP DEFAULT;
ALTER TABLE "public"."profiles" ALTER COLUMN "status_text" DROP NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN IF NOT EXISTS "player_tags" text[];
ALTER TABLE "public"."profiles" ALTER COLUMN "player_tags" SET DEFAULT '{}'::text[];
ALTER TABLE "public"."profiles" ALTER COLUMN "player_tags" DROP NOT NULL;
ALTER TABLE "public"."profiles" OWNER TO "postgres";
ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."profiles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."profiles" DROP CONSTRAINT IF EXISTS "profiles_diamonds_nonnegative" RESTRICT;
ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_diamonds_nonnegative" CHECK ((diamonds >= 0));
ALTER TABLE "public"."profiles" DROP CONSTRAINT IF EXISTS "profiles_id_fkey" RESTRICT;
ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE "public"."profiles" DROP CONSTRAINT IF EXISTS "profiles_kyc_provider_check" RESTRICT;
ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_kyc_provider_check" CHECK (((kyc_provider IS NULL) OR (kyc_provider = ANY (ARRAY['persona'::text, 'veriff'::text, 'jumio'::text, 'onfido'::text, 'stub'::text]))));
ALTER TABLE "public"."profiles" DROP CONSTRAINT IF EXISTS "profiles_kyc_status_check" RESTRICT;
ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_kyc_status_check" CHECK ((kyc_status = ANY (ARRAY['NONE'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'EXPIRED'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."profiles"'::regclass AND conname='profiles_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."profiles"', 'profiles_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.idx_profiles_alias_trgm') IS NULL THEN CREATE INDEX idx_profiles_alias_trgm ON public.profiles USING gin (lower(alias) gin_trgm_ops); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_profiles_display_name_trgm') IS NULL THEN CREATE INDEX idx_profiles_display_name_trgm ON public.profiles USING gin (lower(display_name) gin_trgm_ops); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_profiles_farming_flagged') IS NULL THEN CREATE INDEX idx_profiles_farming_flagged ON public.profiles USING btree (is_farming_flagged); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_profiles_kyc_status') IS NULL THEN CREATE INDEX idx_profiles_kyc_status ON public.profiles USING btree (kyc_status) WHERE (kyc_status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_profiles_referral_code') IS NULL THEN CREATE INDEX idx_profiles_referral_code ON public.profiles USING btree (referral_code) WHERE (referral_code IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_profiles_username_lower') IS NULL THEN CREATE UNIQUE INDEX idx_profiles_username_lower ON public.profiles USING btree (lower(username)) WHERE (username IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_profiles_username_trgm') IS NULL THEN CREATE INDEX idx_profiles_username_trgm ON public.profiles USING gin (lower(username) gin_trgm_ops); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.one_god_account_only') IS NULL THEN CREATE UNIQUE INDEX one_god_account_only ON public.profiles USING btree (role) WHERE (role = 'god'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.profiles_pkey') IS NULL THEN CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.profiles_username_lower_key') IS NULL THEN CREATE UNIQUE INDEX profiles_username_lower_key ON public.profiles USING btree (lower(username)) WHERE ((username IS NOT NULL) AND (username <> ''::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.uniq_profiles_verified_phone') IS NULL THEN CREATE UNIQUE INDEX uniq_profiles_verified_phone ON public.profiles USING btree (phone) WHERE ((phone_verified = true) AND (phone IS NOT NULL) AND (phone <> ''::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.uq_profiles_player_number') IS NULL THEN CREATE UNIQUE INDEX uq_profiles_player_number ON public.profiles USING btree (player_number) WHERE (player_number IS NOT NULL); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."rakeback_period_payouts" ();
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "rakeback_period_id" uuid;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "rakeback_period_id" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "rakeback_period_id" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "user_rake_contribution" numeric(20,4);
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "user_rake_contribution" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "user_rake_contribution" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "rakeback_pct" numeric(5,2);
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "rakeback_pct" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "rakeback_pct" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "payout_amount" numeric(20,4);
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "payout_amount" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "payout_amount" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "currency" text;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "currency" SET DEFAULT 'CHIPS'::text;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "wallet_transaction_id" uuid;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "wallet_transaction_id" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "wallet_transaction_id" DROP NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "status" SET DEFAULT 'paid'::text;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "paid_at" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "paid_at" DROP NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "failure_reason" text;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "failure_reason" DROP DEFAULT;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "failure_reason" DROP NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."rakeback_period_payouts" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."rakeback_period_payouts" OWNER TO "postgres";
ALTER TABLE "public"."rakeback_period_payouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."rakeback_period_payouts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "chk_payout_amount_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "chk_payout_amount_is_two_decimal_places" CHECK (((payout_amount IS NULL) OR (payout_amount = round(payout_amount, 2))));
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "ck_whole_cents" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (payout_amount = round(payout_amount, 2)))) NOT VALID;
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "rakeback_period_payouts_club_id_fkey" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "rakeback_period_payouts_payout_amount_check" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_payout_amount_check" CHECK ((payout_amount >= (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."rakeback_period_payouts"'::regclass AND conname='rakeback_period_payouts_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."rakeback_period_payouts"', 'rakeback_period_payouts_pkey';
END IF; END $c$;
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "rakeback_period_payouts_rakeback_pct_check" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_rakeback_pct_check" CHECK (((rakeback_pct >= (0)::numeric) AND (rakeback_pct <= (100)::numeric)));
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "rakeback_period_payouts_rakeback_period_id_fkey" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_rakeback_period_id_fkey" FOREIGN KEY (rakeback_period_id) REFERENCES rakeback_periods(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."rakeback_period_payouts"'::regclass AND conname='rakeback_period_payouts_rakeback_period_id_user_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_rakeback_period_id_user_id_key" UNIQUE (rakeback_period_id, user_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (rakeback_period_id, user_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."rakeback_period_payouts"', 'rakeback_period_payouts_rakeback_period_id_user_id_key';
END IF; END $c$;
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "rakeback_period_payouts_status_check" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'clawed_back'::text, 'failed'::text])));
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "rakeback_period_payouts_user_id_fkey" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE "public"."rakeback_period_payouts" DROP CONSTRAINT IF EXISTS "rakeback_period_payouts_user_rake_contribution_check" RESTRICT;
ALTER TABLE "public"."rakeback_period_payouts" ADD CONSTRAINT "rakeback_period_payouts_user_rake_contribution_check" CHECK ((user_rake_contribution >= (0)::numeric));
DO $i$ BEGIN IF to_regclass('public.idx_rakeback_payouts_club_status') IS NULL THEN CREATE INDEX idx_rakeback_payouts_club_status ON public.rakeback_period_payouts USING btree (club_id, status); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_rakeback_payouts_user') IS NULL THEN CREATE INDEX idx_rakeback_payouts_user ON public.rakeback_period_payouts USING btree (user_id, created_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.rakeback_period_payouts_pkey') IS NULL THEN CREATE UNIQUE INDEX rakeback_period_payouts_pkey ON public.rakeback_period_payouts USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.rakeback_period_payouts_rakeback_period_id_user_id_key') IS NULL THEN CREATE UNIQUE INDEX rakeback_period_payouts_rakeback_period_id_user_id_key ON public.rakeback_period_payouts USING btree (rakeback_period_id, user_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."rakeback_periods" ();
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "period_start" date;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "period_start" DROP DEFAULT;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "period_start" SET NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "period_end" date;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "period_end" DROP DEFAULT;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "period_end" SET NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "rake_generated" numeric(15,2);
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rake_generated" SET DEFAULT 0;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rake_generated" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "rakeback_rate" numeric(5,4);
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rakeback_rate" SET DEFAULT 0.10;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rakeback_rate" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "rakeback_amount" numeric(15,2);
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rakeback_amount" SET DEFAULT 0;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rakeback_amount" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "status" SET DEFAULT 'pending'::text;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "paid_at" DROP DEFAULT;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "paid_at" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "rakeback_earned" numeric(15,2);
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rakeback_earned" SET DEFAULT 0;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "rakeback_earned" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "total_rake_paid" numeric(15,2);
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "total_rake_paid" SET DEFAULT 0;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "total_rake_paid" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "deferred_reason" text;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "deferred_reason" DROP DEFAULT;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "deferred_reason" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "deferred_at" timestamp with time zone;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "deferred_at" DROP DEFAULT;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "deferred_at" DROP NOT NULL;
ALTER TABLE "public"."rakeback_periods" ADD COLUMN IF NOT EXISTS "defer_count" integer;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "defer_count" SET DEFAULT 0;
ALTER TABLE "public"."rakeback_periods" ALTER COLUMN "defer_count" SET NOT NULL;
ALTER TABLE "public"."rakeback_periods" OWNER TO "postgres";
ALTER TABLE "public"."rakeback_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."rakeback_periods" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."rakeback_periods" DROP CONSTRAINT IF EXISTS "ck_whole_cents" RESTRICT;
ALTER TABLE "public"."rakeback_periods" ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR ((rakeback_amount = round(rakeback_amount, 2)) AND (rake_generated = round(rake_generated, 2))))) NOT VALID;
ALTER TABLE "public"."rakeback_periods" DROP CONSTRAINT IF EXISTS "fk_rakeback_periods_user_id_profiles" RESTRICT;
ALTER TABLE "public"."rakeback_periods" ADD CONSTRAINT "fk_rakeback_periods_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."rakeback_periods" DROP CONSTRAINT IF EXISTS "rakeback_periods_club_id_fkey" RESTRICT;
ALTER TABLE "public"."rakeback_periods" ADD CONSTRAINT "rakeback_periods_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."rakeback_periods"'::regclass AND conname='rakeback_periods_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."rakeback_periods" ADD CONSTRAINT "rakeback_periods_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."rakeback_periods"', 'rakeback_periods_pkey';
END IF; END $c$;
ALTER TABLE "public"."rakeback_periods" DROP CONSTRAINT IF EXISTS "rakeback_periods_status_check" RESTRICT;
ALTER TABLE "public"."rakeback_periods" ADD CONSTRAINT "rakeback_periods_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'open'::text, 'closed'::text, 'claiming'::text, 'claimed'::text, 'paid'::text, 'expired'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."rakeback_periods"'::regclass AND conname='rakeback_periods_user_id_club_id_period_start_period_end_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."rakeback_periods" ADD CONSTRAINT "rakeback_periods_user_id_club_id_period_start_period_end_key" UNIQUE (user_id, club_id, period_start, period_end);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (user_id, club_id, period_start, period_end)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."rakeback_periods"', 'rakeback_periods_user_id_club_id_period_start_period_end_key';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.idx_rakeback_periods_club') IS NULL THEN CREATE INDEX idx_rakeback_periods_club ON public.rakeback_periods USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_rakeback_periods_status') IS NULL THEN CREATE INDEX idx_rakeback_periods_status ON public.rakeback_periods USING btree (status); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_rakeback_periods_user') IS NULL THEN CREATE INDEX idx_rakeback_periods_user ON public.rakeback_periods USING btree (user_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.rakeback_periods_drain_order_idx') IS NULL THEN CREATE INDEX rakeback_periods_drain_order_idx ON public.rakeback_periods USING btree (club_id, defer_count, period_end, id) WHERE (status = 'pending'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.rakeback_periods_due_idx') IS NULL THEN CREATE INDEX rakeback_periods_due_idx ON public.rakeback_periods USING btree (club_id, period_end) WHERE (status = 'pending'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.rakeback_periods_pkey') IS NULL THEN CREATE UNIQUE INDEX rakeback_periods_pkey ON public.rakeback_periods USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.rakeback_periods_user_id_club_id_period_start_period_end_key') IS NULL THEN CREATE UNIQUE INDEX rakeback_periods_user_id_club_id_period_start_period_end_key ON public.rakeback_periods USING btree (user_id, club_id, period_start, period_end); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."spin_bonus_pools" ();
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "balance" numeric(12,2);
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "balance" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "balance" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "total_deposited" numeric(12,2);
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "total_deposited" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "total_deposited" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "total_drawn" numeric(12,2);
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "total_drawn" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "total_drawn" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "spin_count" integer;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "spin_count" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "spin_count" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "bonus_count" integer;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "bonus_count" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "bonus_count" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "seeded_amount" numeric;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seeded_amount" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seeded_amount" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "ceiling_amount" numeric;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "ceiling_amount" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "ceiling_amount" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "highest_stake" numeric;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "highest_stake" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "highest_stake" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "surplus_returned" numeric;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "surplus_returned" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "surplus_returned" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "is_active" boolean;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "is_active" SET DEFAULT true;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "is_active" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "owner_kind" text;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "owner_kind" SET DEFAULT 'club'::text;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "owner_kind" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "offered_max_stake" numeric;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "offered_max_stake" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "offered_max_stake" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "activated_at" DROP DEFAULT;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "activated_at" DROP NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "activated_by" uuid;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "activated_by" DROP DEFAULT;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "activated_by" DROP NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp with time zone;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "deactivated_at" DROP DEFAULT;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "deactivated_at" DROP NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "seed_source_wallet" text;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seed_source_wallet" DROP DEFAULT;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seed_source_wallet" DROP NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "seed_returned_at" timestamp with time zone;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seed_returned_at" DROP DEFAULT;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seed_returned_at" DROP NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "seed_returned_amount" numeric;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seed_returned_amount" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "seed_returned_amount" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" ADD COLUMN IF NOT EXISTS "required_seed_at_activation" numeric;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "required_seed_at_activation" SET DEFAULT 0;
ALTER TABLE "public"."spin_bonus_pools" ALTER COLUMN "required_seed_at_activation" SET NOT NULL;
ALTER TABLE "public"."spin_bonus_pools" OWNER TO "postgres";
ALTER TABLE "public"."spin_bonus_pools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."spin_bonus_pools" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."spin_bonus_pools" DROP CONSTRAINT IF EXISTS "spin_bonus_pools_balance_check" RESTRICT;
ALTER TABLE "public"."spin_bonus_pools" ADD CONSTRAINT "spin_bonus_pools_balance_check" CHECK ((balance >= ('-500'::integer)::numeric));
ALTER TABLE "public"."spin_bonus_pools" DROP CONSTRAINT IF EXISTS "spin_bonus_pools_balance_non_negative" RESTRICT;
ALTER TABLE "public"."spin_bonus_pools" ADD CONSTRAINT "spin_bonus_pools_balance_non_negative" CHECK ((balance >= (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."spin_bonus_pools"'::regclass AND conname='spin_bonus_pools_club_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."spin_bonus_pools" ADD CONSTRAINT "spin_bonus_pools_club_id_key" UNIQUE (club_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (club_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."spin_bonus_pools"', 'spin_bonus_pools_club_id_key';
END IF; END $c$;
ALTER TABLE "public"."spin_bonus_pools" DROP CONSTRAINT IF EXISTS "spin_bonus_pools_owner_kind_check" RESTRICT;
ALTER TABLE "public"."spin_bonus_pools" ADD CONSTRAINT "spin_bonus_pools_owner_kind_check" CHECK ((owner_kind = ANY (ARRAY['union'::text, 'club'::text])));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."spin_bonus_pools"'::regclass AND conname='spin_bonus_pools_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."spin_bonus_pools" ADD CONSTRAINT "spin_bonus_pools_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."spin_bonus_pools"', 'spin_bonus_pools_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.spin_bonus_pools_club_id_key') IS NULL THEN CREATE UNIQUE INDEX spin_bonus_pools_club_id_key ON public.spin_bonus_pools USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.spin_bonus_pools_pkey') IS NULL THEN CREATE UNIQUE INDEX spin_bonus_pools_pkey ON public.spin_bonus_pools USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."table_seats" ();
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."table_seats" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();
ALTER TABLE "public"."table_seats" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE "public"."table_seats" ALTER COLUMN "table_id" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "table_id" SET NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "seat_number" integer;
ALTER TABLE "public"."table_seats" ALTER COLUMN "seat_number" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "seat_number" SET NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."table_seats" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "player_id" integer;
ALTER TABLE "public"."table_seats" ALTER COLUMN "player_id" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "player_id" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "member_id" uuid;
ALTER TABLE "public"."table_seats" ALTER COLUMN "member_id" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "member_id" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "stack" numeric(15,2);
ALTER TABLE "public"."table_seats" ALTER COLUMN "stack" SET DEFAULT 0;
ALTER TABLE "public"."table_seats" ALTER COLUMN "stack" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "is_sitting_out" boolean;
ALTER TABLE "public"."table_seats" ALTER COLUMN "is_sitting_out" SET DEFAULT false;
ALTER TABLE "public"."table_seats" ALTER COLUMN "is_sitting_out" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "is_away" boolean;
ALTER TABLE "public"."table_seats" ALTER COLUMN "is_away" SET DEFAULT false;
ALTER TABLE "public"."table_seats" ALTER COLUMN "is_away" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "joined_at" timestamp with time zone;
ALTER TABLE "public"."table_seats" ALTER COLUMN "joined_at" SET DEFAULT now();
ALTER TABLE "public"."table_seats" ALTER COLUMN "joined_at" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "horse_id" uuid;
ALTER TABLE "public"."table_seats" ALTER COLUMN "horse_id" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "horse_id" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "scheduled_leave_hands" integer;
ALTER TABLE "public"."table_seats" ALTER COLUMN "scheduled_leave_hands" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "scheduled_leave_hands" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "left_at" timestamp with time zone;
ALTER TABLE "public"."table_seats" ALTER COLUMN "left_at" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "left_at" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."table_seats" ALTER COLUMN "status" SET DEFAULT 'active'::text;
ALTER TABLE "public"."table_seats" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "leave_pending" boolean;
ALTER TABLE "public"."table_seats" ALTER COLUMN "leave_pending" SET DEFAULT false;
ALTER TABLE "public"."table_seats" ALTER COLUMN "leave_pending" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "auto_rebuy" boolean;
ALTER TABLE "public"."table_seats" ALTER COLUMN "auto_rebuy" SET DEFAULT false;
ALTER TABLE "public"."table_seats" ALTER COLUMN "auto_rebuy" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "time_bank_remaining" integer;
ALTER TABLE "public"."table_seats" ALTER COLUMN "time_bank_remaining" SET DEFAULT 30;
ALTER TABLE "public"."table_seats" ALTER COLUMN "time_bank_remaining" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "time_bank_uses_remaining" integer;
ALTER TABLE "public"."table_seats" ALTER COLUMN "time_bank_uses_remaining" SET DEFAULT 4;
ALTER TABLE "public"."table_seats" ALTER COLUMN "time_bank_uses_remaining" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."table_seats" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "sit_out_at" timestamp with time zone;
ALTER TABLE "public"."table_seats" ALTER COLUMN "sit_out_at" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "sit_out_at" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "entry_hold" text;
ALTER TABLE "public"."table_seats" ALTER COLUMN "entry_hold" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "entry_hold" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "entry_post_agreed" boolean;
ALTER TABLE "public"."table_seats" ALTER COLUMN "entry_post_agreed" SET DEFAULT false;
ALTER TABLE "public"."table_seats" ALTER COLUMN "entry_post_agreed" SET NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "occupancy_id" uuid;
ALTER TABLE "public"."table_seats" ALTER COLUMN "occupancy_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."table_seats" ALTER COLUMN "occupancy_id" SET NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "active_game_scope" text;
ALTER TABLE "public"."table_seats" ALTER COLUMN "active_game_scope" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "active_game_scope" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "active_parent_key" text;
ALTER TABLE "public"."table_seats" ALTER COLUMN "active_parent_key" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "active_parent_key" DROP NOT NULL;
ALTER TABLE "public"."table_seats" ADD COLUMN IF NOT EXISTS "terminal_closed_at" timestamp with time zone;
ALTER TABLE "public"."table_seats" ALTER COLUMN "terminal_closed_at" DROP DEFAULT;
ALTER TABLE "public"."table_seats" ALTER COLUMN "terminal_closed_at" DROP NOT NULL;
ALTER TABLE "public"."table_seats" OWNER TO "postgres";
ALTER TABLE "public"."table_seats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."table_seats" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "active_seat_requires_game_scope" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "active_seat_requires_game_scope" CHECK ((((left_at IS NULL) AND (active_game_scope IS NOT NULL) AND (user_id IS NOT NULL) AND (table_id IS NOT NULL)) OR ((left_at IS NOT NULL) AND (active_game_scope IS NULL))));
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "active_seat_requires_open_parent" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "active_seat_requires_open_parent" CHECK ((((left_at IS NULL) AND (active_parent_key IS NOT NULL) AND (active_parent_key <> 'closed'::text)) OR ((left_at IS NOT NULL) AND (active_parent_key IS NULL))));
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "fk_table_seats_user_id_profiles" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "fk_table_seats_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."table_seats"'::regclass AND conname='one_committed_seat_per_game_player';
 IF actual IS NULL THEN
  ALTER TABLE "public"."table_seats" ADD CONSTRAINT "one_committed_seat_per_game_player" UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED;
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."table_seats"', 'one_committed_seat_per_game_player';
END IF; END $c$;
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "table_seats_club_id_fkey" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "table_seats_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id);
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "table_seats_entry_hold_check" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "table_seats_entry_hold_check" CHECK (((entry_hold IS NULL) OR (entry_hold = ANY (ARRAY['waiting'::text, 'posting'::text, 'moved'::text]))));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."table_seats"'::regclass AND conname='table_seats_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."table_seats" ADD CONSTRAINT "table_seats_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."table_seats"', 'table_seats_pkey';
END IF; END $c$;
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "table_seats_seat_number_check" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "table_seats_seat_number_check" CHECK (((seat_number >= 1) AND (seat_number <= 10)));
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "table_seats_stack_nonneg" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "table_seats_stack_nonneg" CHECK ((stack >= (0)::numeric));
ALTER TABLE "public"."table_seats" DROP CONSTRAINT IF EXISTS "table_seats_table_id_fkey" RESTRICT;
ALTER TABLE "public"."table_seats" ADD CONSTRAINT "table_seats_table_id_fkey" FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."table_seats"'::regclass AND conname='table_seats_table_id_seat_number_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."table_seats" ADD CONSTRAINT "table_seats_table_id_seat_number_key" UNIQUE (table_id, seat_number);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (table_id, seat_number)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."table_seats"', 'table_seats_table_id_seat_number_key';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_club_active') IS NULL THEN CREATE INDEX idx_table_seats_club_active ON public.table_seats USING btree (club_id, table_id) WHERE (left_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_club_id_fk') IS NULL THEN CREATE INDEX idx_table_seats_club_id_fk ON public.table_seats USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_horse_id') IS NULL THEN CREATE INDEX idx_table_seats_horse_id ON public.table_seats USING btree (horse_id) WHERE (horse_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_live_user') IS NULL THEN CREATE INDEX idx_table_seats_live_user ON public.table_seats USING btree (user_id, table_id) WHERE (left_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_status') IS NULL THEN CREATE INDEX idx_table_seats_status ON public.table_seats USING btree (status) WHERE (left_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_table') IS NULL THEN CREATE INDEX idx_table_seats_table ON public.table_seats USING btree (table_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_unstamped_active') IS NULL THEN CREATE INDEX idx_table_seats_unstamped_active ON public.table_seats USING btree (table_id) WHERE ((left_at IS NULL) AND (club_id IS NULL)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_user') IS NULL THEN CREATE INDEX idx_table_seats_user ON public.table_seats USING btree (user_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_table_seats_user_live') IS NULL THEN CREATE INDEX idx_table_seats_user_live ON public.table_seats USING btree (user_id) WHERE (left_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_unique_active_user_per_table') IS NULL THEN CREATE UNIQUE INDEX idx_unique_active_user_per_table ON public.table_seats USING btree (table_id, user_id) WHERE (left_at IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.one_committed_seat_per_game_player') IS NULL THEN CREATE UNIQUE INDEX one_committed_seat_per_game_player ON public.table_seats USING btree (user_id, active_game_scope); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.table_seats_occupancy_id_unique') IS NULL THEN CREATE UNIQUE INDEX table_seats_occupancy_id_unique ON public.table_seats USING btree (occupancy_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.table_seats_pkey') IS NULL THEN CREATE UNIQUE INDEX table_seats_pkey ON public.table_seats USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.table_seats_table_id_seat_number_key') IS NULL THEN CREATE UNIQUE INDEX table_seats_table_id_seat_number_key ON public.table_seats USING btree (table_id, seat_number); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."tables" ();
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."tables" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."tables" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."tables" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "public"."tables" ALTER COLUMN "name" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "game_type" text;
ALTER TABLE "public"."tables" ALTER COLUMN "game_type" SET DEFAULT 'nlhe'::text;
ALTER TABLE "public"."tables" ALTER COLUMN "game_type" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "stakes" text;
ALTER TABLE "public"."tables" ALTER COLUMN "stakes" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "stakes" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "small_blind" numeric(15,2);
ALTER TABLE "public"."tables" ALTER COLUMN "small_blind" SET DEFAULT 1;
ALTER TABLE "public"."tables" ALTER COLUMN "small_blind" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "big_blind" numeric(15,2);
ALTER TABLE "public"."tables" ALTER COLUMN "big_blind" SET DEFAULT 2;
ALTER TABLE "public"."tables" ALTER COLUMN "big_blind" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "min_buy_in" numeric(15,2);
ALTER TABLE "public"."tables" ALTER COLUMN "min_buy_in" SET DEFAULT 40;
ALTER TABLE "public"."tables" ALTER COLUMN "min_buy_in" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "max_buy_in" numeric(15,2);
ALTER TABLE "public"."tables" ALTER COLUMN "max_buy_in" SET DEFAULT 200;
ALTER TABLE "public"."tables" ALTER COLUMN "max_buy_in" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "max_players" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "max_players" SET DEFAULT 9;
ALTER TABLE "public"."tables" ALTER COLUMN "max_players" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "current_players" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "current_players" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "current_players" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."tables" ALTER COLUMN "status" SET DEFAULT 'waiting'::text;
ALTER TABLE "public"."tables" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "is_private" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "is_private" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "is_private" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "settings" jsonb;
ALTER TABLE "public"."tables" ALTER COLUMN "settings" SET DEFAULT '{}'::jsonb;
ALTER TABLE "public"."tables" ALTER COLUMN "settings" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."tables" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."tables" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "game_variant" text;
ALTER TABLE "public"."tables" ALTER COLUMN "game_variant" SET DEFAULT 'nlh'::text;
ALTER TABLE "public"."tables" ALTER COLUMN "game_variant" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "enable_straddle" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "enable_straddle" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "enable_straddle" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "run_it_twice" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "run_it_twice" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "run_it_twice" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "auto_muck" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_muck" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_muck" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "ante" numeric(15,2);
ALTER TABLE "public"."tables" ALTER COLUMN "ante" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "ante" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "allow_rabbit_hunt" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "allow_rabbit_hunt" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "allow_rabbit_hunt" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "allow_run_it_twice" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "allow_run_it_twice" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "allow_run_it_twice" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "allow_straddle" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "allow_straddle" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "allow_straddle" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "game_mode" character varying(10);
ALTER TABLE "public"."tables" ALTER COLUMN "game_mode" SET DEFAULT 'regular'::character varying;
ALTER TABLE "public"."tables" ALTER COLUMN "game_mode" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "is_vip_only" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "is_vip_only" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "is_vip_only" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "is_anonymous" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "is_anonymous" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "is_anonymous" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "ban_chat" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "ban_chat" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "ban_chat" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "label_as_new" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "label_as_new" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "label_as_new" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "is_featured" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "is_featured" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "is_featured" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "hide_club_name" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "hide_club_name" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "hide_club_name" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "is_template" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "is_template" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "is_template" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "double_board" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "double_board" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "double_board" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "triple_board" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "triple_board" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "triple_board" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "pineapple_holdem" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "pineapple_holdem" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "pineapple_holdem" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "seven_deuce_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "seven_deuce_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "seven_deuce_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "nit_game" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "nit_game" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "nit_game" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "cap_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "cap_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "cap_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "no_rathole" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "no_rathole" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "no_rathole" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "action_time_seconds" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "action_time_seconds" SET DEFAULT 15;
ALTER TABLE "public"."tables" ALTER COLUMN "action_time_seconds" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "ante_bb" numeric(10,2);
ALTER TABLE "public"."tables" ALTER COLUMN "ante_bb" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "ante_bb" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "career_percent_min" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "career_percent_min" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "career_percent_min" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "maintain_percent_min" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "maintain_percent_min" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "maintain_percent_min" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "maintain_hands" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "maintain_hands" SET DEFAULT 10;
ALTER TABLE "public"."tables" ALTER COLUMN "maintain_hands" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "auto_start_players" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_start_players" SET DEFAULT 2;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_start_players" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "game_length_hours" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "game_length_hours" SET DEFAULT 12;
ALTER TABLE "public"."tables" ALTER COLUMN "game_length_hours" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "created_by" uuid;
ALTER TABLE "public"."tables" ALTER COLUMN "created_by" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "calltime_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "calltime_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "calltime_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "auto_extension" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_extension" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_extension" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "auto_restart" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_restart" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_restart" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "auto_create_table" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_create_table" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_create_table" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "auto_utg_straddle" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_utg_straddle" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_utg_straddle" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "voluntary_straddle" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "voluntary_straddle" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "voluntary_straddle" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "insurance_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "insurance_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "insurance_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "run_it_mode" character varying(20);
ALTER TABLE "public"."tables" ALTER COLUMN "run_it_mode" SET DEFAULT 'none'::character varying;
ALTER TABLE "public"."tables" ALTER COLUMN "run_it_mode" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "rake_percent" numeric(5,2);
ALTER TABLE "public"."tables" ALTER COLUMN "rake_percent" SET DEFAULT '-1'::integer;
ALTER TABLE "public"."tables" ALTER COLUMN "rake_percent" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "rake_cap_bb" numeric(5,2);
ALTER TABLE "public"."tables" ALTER COLUMN "rake_cap_bb" SET DEFAULT '-1'::integer;
ALTER TABLE "public"."tables" ALTER COLUMN "rake_cap_bb" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "agent_downline_limit" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "agent_downline_limit" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "agent_downline_limit" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "buy_in_authorization" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "buy_in_authorization" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "buy_in_authorization" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "restrict_device" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "restrict_device" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "restrict_device" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "restrict_observers" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "restrict_observers" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "restrict_observers" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "gps_restriction" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "gps_restriction" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "gps_restriction" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "ip_restriction" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "ip_restriction" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "ip_restriction" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "pc_emulator_restriction" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "pc_emulator_restriction" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "pc_emulator_restriction" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "photo_rotation_verification" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "photo_rotation_verification" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "photo_rotation_verification" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "short_description" text;
ALTER TABLE "public"."tables" ALTER COLUMN "short_description" SET DEFAULT ''::text;
ALTER TABLE "public"."tables" ALTER COLUMN "short_description" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "accelerated_mtt" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "accelerated_mtt" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "accelerated_mtt" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "all_in_or_fold" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "all_in_or_fold" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "all_in_or_fold" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "custom_rebuy_reentry_cost" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "custom_rebuy_reentry_cost" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "custom_rebuy_reentry_cost" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "number_of_rebuys_reentries" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "number_of_rebuys_reentries" SET DEFAULT 3;
ALTER TABLE "public"."tables" ALTER COLUMN "number_of_rebuys_reentries" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "add_on_multiplier" numeric(3,1);
ALTER TABLE "public"."tables" ALTER COLUMN "add_on_multiplier" SET DEFAULT 1.0;
ALTER TABLE "public"."tables" ALTER COLUMN "add_on_multiplier" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "custom_add_on" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "custom_add_on" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "custom_add_on" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "add_on_break_length_minutes" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "add_on_break_length_minutes" SET DEFAULT 1;
ALTER TABLE "public"."tables" ALTER COLUMN "add_on_break_length_minutes" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "ko_bounty" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "ko_bounty" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "ko_bounty" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "gtd_prize_pool" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "gtd_prize_pool" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "gtd_prize_pool" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "final_table_deal" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "final_table_deal" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "final_table_deal" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "big_blind_ante" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "big_blind_ante" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "big_blind_ante" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "authorized_to_register" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "authorized_to_register" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "authorized_to_register" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "late_registration_level" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "late_registration_level" SET DEFAULT 6;
ALTER TABLE "public"."tables" ALTER COLUMN "late_registration_level" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "early_bird_registration" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "early_bird_registration" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "early_bird_registration" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bubble_protection" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "bubble_protection" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "bubble_protection" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "featured_tournament" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "featured_tournament" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "featured_tournament" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "min_players_mtt" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "min_players_mtt" SET DEFAULT 30;
ALTER TABLE "public"."tables" ALTER COLUMN "min_players_mtt" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "max_players_mtt" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "max_players_mtt" SET DEFAULT 300;
ALTER TABLE "public"."tables" ALTER COLUMN "max_players_mtt" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "multi_day_mtt" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "multi_day_mtt" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "multi_day_mtt" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "save_start_time" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "save_start_time" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "save_start_time" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "start_time" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "start_time" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "start_time" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "restart_tournament_every" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "restart_tournament_every" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "restart_tournament_every" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "tournament_schedule" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "tournament_schedule" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "tournament_schedule" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "synchronized_breaks" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "synchronized_breaks" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "synchronized_breaks" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "sng_buy_in" numeric(10,2);
ALTER TABLE "public"."tables" ALTER COLUMN "sng_buy_in" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "sng_buy_in" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "blind_structure" character varying(20);
ALTER TABLE "public"."tables" ALTER COLUMN "blind_structure" SET DEFAULT 'standard'::character varying;
ALTER TABLE "public"."tables" ALTER COLUMN "blind_structure" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "payout_structure" character varying(50);
ALTER TABLE "public"."tables" ALTER COLUMN "payout_structure" SET DEFAULT 'winner_takes_all'::character varying;
ALTER TABLE "public"."tables" ALTER COLUMN "payout_structure" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "starting_chips" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "starting_chips" SET DEFAULT 1500;
ALTER TABLE "public"."tables" ALTER COLUMN "starting_chips" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "blinds_up_minutes" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "blinds_up_minutes" SET DEFAULT 10;
ALTER TABLE "public"."tables" ALTER COLUMN "blinds_up_minutes" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "next_step_satellite" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "next_step_satellite" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "next_step_satellite" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "sng_custom_buy_in" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "sng_custom_buy_in" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "sng_custom_buy_in" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "sng_player_count" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "sng_player_count" SET DEFAULT 9;
ALTER TABLE "public"."tables" ALTER COLUMN "sng_player_count" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "is_spins" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "is_spins" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "is_spins" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "spins_multiplier" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "spins_multiplier" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "spins_multiplier" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "is_deleted" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "is_deleted" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "is_deleted" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "deleted_at" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "deleted_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "deleted_by" uuid;
ALTER TABLE "public"."tables" ALTER COLUMN "deleted_by" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "deleted_by" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bbj_percent" numeric(5,2);
ALTER TABLE "public"."tables" ALTER COLUMN "bbj_percent" SET DEFAULT 100;
ALTER TABLE "public"."tables" ALTER COLUMN "bbj_percent" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "tournament_id" uuid;
ALTER TABLE "public"."tables" ALTER COLUMN "tournament_id" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "tournament_id" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "live_state" jsonb;
ALTER TABLE "public"."tables" ALTER COLUMN "live_state" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "live_state" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."tables" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "union_id" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "big_blind_ante_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "big_blind_ante_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "big_blind_ante_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "straddle_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "straddle_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "straddle_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "straddle_type" text;
ALTER TABLE "public"."tables" ALTER COLUMN "straddle_type" SET DEFAULT 'utg'::text;
ALTER TABLE "public"."tables" ALTER COLUMN "straddle_type" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "max_straddles" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "max_straddles" SET DEFAULT 1;
ALTER TABLE "public"."tables" ALTER COLUMN "max_straddles" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "run_it_twice_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "run_it_twice_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "run_it_twice_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "auto_muck_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_muck_enabled" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "auto_muck_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "show_hand_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "show_hand_enabled" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "show_hand_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "disconnect_timeout_seconds" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "disconnect_timeout_seconds" SET DEFAULT 30;
ALTER TABLE "public"."tables" ALTER COLUMN "disconnect_timeout_seconds" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "max_consecutive_timeouts" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "max_consecutive_timeouts" SET DEFAULT 3;
ALTER TABLE "public"."tables" ALTER COLUMN "max_consecutive_timeouts" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "prefer_check_over_fold" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "prefer_check_over_fold" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "prefer_check_over_fold" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "time_bank_max_uses" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "time_bank_max_uses" SET DEFAULT 4;
ALTER TABLE "public"."tables" ALTER COLUMN "time_bank_max_uses" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "time_bank_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "time_bank_enabled" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "time_bank_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "ante_enabled" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "ante_enabled" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "ante_enabled" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_frequency" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_frequency" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_frequency" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_ante_multiplier" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_ante_multiplier" SET DEFAULT 2;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_ante_multiplier" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "wait_for_big_blind" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "wait_for_big_blind" SET DEFAULT true;
ALTER TABLE "public"."tables" ALTER COLUMN "wait_for_big_blind" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "seven_deuce_amount" numeric;
ALTER TABLE "public"."tables" ALTER COLUMN "seven_deuce_amount" SET DEFAULT 2;
ALTER TABLE "public"."tables" ALTER COLUMN "seven_deuce_amount" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "hands_dealt" bigint;
ALTER TABLE "public"."tables" ALTER COLUMN "hands_dealt" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "hands_dealt" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "avg_pot" numeric(14,2);
ALTER TABLE "public"."tables" ALTER COLUMN "avg_pot" SET DEFAULT 0;
ALTER TABLE "public"."tables" ALTER COLUMN "avg_pot" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_double_board" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_double_board" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_double_board" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "cap_bb" numeric(10,2);
ALTER TABLE "public"."tables" ALTER COLUMN "cap_bb" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "cap_bb" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_board_count" smallint;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_board_count" SET DEFAULT 1;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_board_count" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_trigger_mode" text;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_trigger_mode" SET DEFAULT 'every_n_hands'::text;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_trigger_mode" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_interval_seconds" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_interval_seconds" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_interval_seconds" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_min_players" smallint;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_min_players" SET DEFAULT 3;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_min_players" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_ante_fixed" numeric;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_ante_fixed" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_ante_fixed" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "first_button_seat" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "first_button_seat" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "first_button_seat" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_variant" text;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_variant" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_variant" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_next_due_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_next_due_at" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_next_due_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_sched_state" jsonb;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_sched_state" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_sched_state" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_manual_pending" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_manual_pending" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_manual_pending" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_button_policy" text;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_button_policy" SET DEFAULT 'regular'::text;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_button_policy" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "bomb_pot_announce_seconds" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_announce_seconds" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "bomb_pot_announce_seconds" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "cluster_id" uuid;
ALTER TABLE "public"."tables" ALTER COLUMN "cluster_id" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "cluster_id" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE "public"."tables" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "main_index" integer;
ALTER TABLE "public"."tables" ALTER COLUMN "main_index" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "main_index" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "lifecycle" text;
ALTER TABLE "public"."tables" ALTER COLUMN "lifecycle" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "lifecycle" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "opened_at" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "opened_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "live_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "live_at" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "live_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "break_started_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "break_started_at" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "break_started_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "break_eligible_since" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "break_eligible_since" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "break_eligible_since" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "promote_pending" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "promote_pending" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "promote_pending" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "observer_show_cards" boolean;
ALTER TABLE "public"."tables" ALTER COLUMN "observer_show_cards" SET DEFAULT false;
ALTER TABLE "public"."tables" ALTER COLUMN "observer_show_cards" SET NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "terminal_closed_at" timestamp with time zone;
ALTER TABLE "public"."tables" ALTER COLUMN "terminal_closed_at" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "terminal_closed_at" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "seat_game_scope" text;
ALTER TABLE "public"."tables" ALTER COLUMN "seat_game_scope" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "seat_game_scope" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "seat_admission_key" text;
ALTER TABLE "public"."tables" ALTER COLUMN "seat_admission_key" DROP DEFAULT;
ALTER TABLE "public"."tables" ALTER COLUMN "seat_admission_key" DROP NOT NULL;
ALTER TABLE "public"."tables" ADD COLUMN IF NOT EXISTS "f06_lifecycle" bigint;
ALTER TABLE "public"."tables" ALTER COLUMN "f06_lifecycle" SET DEFAULT smarter_private.f06_new_lifecycle();
ALTER TABLE "public"."tables" ALTER COLUMN "f06_lifecycle" SET NOT NULL;
ALTER TABLE "public"."tables" OWNER TO "postgres";
ALTER TABLE "public"."tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tables" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "fk_tables_club_id" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "fk_tables_club_id" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "table_game_scope_is_derived" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "table_game_scope_is_derived" CHECK (((seat_game_scope IS NULL) OR (seat_game_scope =
CASE
    WHEN (cluster_id IS NULL) THEN ('table:'::text || (id)::text)
    ELSE ('cluster:'::text || (cluster_id)::text)
END)));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."tables"'::regclass AND conname='table_game_scope_parent_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."tables" ADD CONSTRAINT "table_game_scope_parent_key" UNIQUE (id, seat_game_scope);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (id, seat_game_scope)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."tables"', 'table_game_scope_parent_key';
END IF; END $c$;
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "table_seat_admission_is_derived" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "table_seat_admission_is_derived" CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])) OR (lifecycle = 'closed'::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN 'closed'::text
    WHEN (tournament_id IS NOT NULL) THEN ('tournament:'::text || (tournament_id)::text)
    ELSE 'cash'::text
END)));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."tables"'::regclass AND conname='table_seat_admission_parent_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."tables" ADD CONSTRAINT "table_seat_admission_parent_key" UNIQUE (id, seat_admission_key);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (id, seat_admission_key)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."tables"', 'table_seat_admission_parent_key';
END IF; END $c$;
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_bomb_pot_board_count_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_bomb_pot_board_count_check" CHECK (((bomb_pot_board_count >= 1) AND (bomb_pot_board_count <= 3)));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_bomb_pot_button_policy_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_bomb_pot_button_policy_check" CHECK ((bomb_pot_button_policy = ANY (ARRAY['regular'::text, 'separate'::text])));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_bomb_pot_trigger_mode_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_bomb_pot_trigger_mode_check" CHECK ((bomb_pot_trigger_mode = ANY (ARRAY['every_n_hands'::text, 'once_per_orbit'::text, 'timed'::text, 'bomb_pot_only'::text])));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_bomb_pot_variant_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_bomb_pot_variant_check" CHECK (((bomb_pot_variant IS NULL) OR ((bomb_pot_variant = ANY (ARRAY['nlh'::text, 'plo4'::text, 'plo5'::text, 'plo6'::text, 'flh'::text, 'flo8'::text])) AND ((lower(COALESCE(game_variant, 'nlh'::text)) = ANY (ARRAY['flh'::text, 'flo8'::text])) = (bomb_pot_variant = ANY (ARRAY['flh'::text, 'flo8'::text]))))));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_cash_needs_a_game" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_cash_needs_a_game" CHECK (((tournament_id IS NOT NULL) OR (cluster_id IS NOT NULL) OR (status = ANY (ARRAY['closed'::text, 'deleted'::text])) OR COALESCE(is_deleted, false) OR (club_id IS NULL) OR (game_variant IS NULL) OR (COALESCE(small_blind, (0)::numeric) <= (0)::numeric) OR (COALESCE(big_blind, (0)::numeric) <= COALESCE(small_blind, (0)::numeric)) OR (club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_cluster_id_fkey" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_cluster_id_fkey" FOREIGN KEY (cluster_id) REFERENCES cash_games(id);
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_created_by_fkey" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_game_type_is_format" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_game_type_is_format" CHECK ((game_type = ANY (ARRAY['cash'::text, 'tournament'::text])));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_lifecycle_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_lifecycle_check" CHECK ((lifecycle = ANY (ARRAY['opening'::text, 'live'::text, 'breaking'::text, 'closed'::text])));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_main_index_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_main_index_check" CHECK ((main_index >= 1));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."tables"'::regclass AND conname='tables_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."tables"', 'tables_pkey';
END IF; END $c$;
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_rake_cap_bb_range" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_rake_cap_bb_range" CHECK (((rake_cap_bb IS NULL) OR (rake_cap_bb = ('-1'::integer)::numeric) OR ((rake_cap_bb >= (0)::numeric) AND (rake_cap_bb <= (10)::numeric)))) NOT VALID;
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_rake_percent_range" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_rake_percent_range" CHECK (((rake_percent IS NULL) OR (rake_percent = ('-1'::integer)::numeric) OR ((rake_percent >= (0)::numeric) AND (rake_percent <= (10)::numeric)))) NOT VALID;
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_role_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_role_check" CHECK ((role = ANY (ARRAY['main'::text, 'feeder'::text])));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_status_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_status_check" CHECK ((status = ANY (ARRAY['waiting'::text, 'active'::text, 'running'::text, 'paused'::text, 'closed'::text])));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_straddle_type_check" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_straddle_type_check" CHECK ((straddle_type = 'utg'::text));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_terminal_closed_shape" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_terminal_closed_shape" CHECK (((terminal_closed_at IS NULL) OR ((lower(COALESCE(status, ''::text)) = 'closed'::text) AND (lower(COALESCE(lifecycle, ''::text)) = 'closed'::text) AND (NOT (current_players IS DISTINCT FROM 0)))));
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_tournament_id_fkey" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_tournament_id_fkey" FOREIGN KEY (tournament_id) REFERENCES tournaments(id);
ALTER TABLE "public"."tables" DROP CONSTRAINT IF EXISTS "tables_union_id_fkey" RESTRICT;
ALTER TABLE "public"."tables" ADD CONSTRAINT "tables_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE;
DO $i$ BEGIN IF to_regclass('public.idx_tables_bomb_pot_due') IS NULL THEN CREATE INDEX idx_tables_bomb_pot_due ON public.tables USING btree (bomb_pot_next_due_at) WHERE (bomb_pot_next_due_at IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_club_id') IS NULL THEN CREATE INDEX idx_tables_club_id ON public.tables USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_club_open') IS NULL THEN CREATE INDEX idx_tables_club_open ON public.tables USING btree (club_id, created_at DESC) WHERE ((is_deleted = false) AND (status <> 'closed'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_cluster_closed_status_drift') IS NULL THEN CREATE INDEX idx_tables_cluster_closed_status_drift ON public.tables USING btree (cluster_id) WHERE ((lifecycle = 'closed'::text) AND (status <> 'closed'::text)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_cluster_open') IS NULL THEN CREATE INDEX idx_tables_cluster_open ON public.tables USING btree (cluster_id, role, main_index, created_at) WHERE (lifecycle <> 'closed'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_created_by') IS NULL THEN CREATE INDEX idx_tables_created_by ON public.tables USING btree (created_by); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_live_by_club') IS NULL THEN CREATE INDEX idx_tables_live_by_club ON public.tables USING btree (club_id) WHERE ((tournament_id IS NULL) AND (is_deleted IS NOT TRUE) AND (status <> ALL (ARRAY['closed'::text, 'deleted'::text]))); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_live_by_union') IS NULL THEN CREATE INDEX idx_tables_live_by_union ON public.tables USING btree (union_id) WHERE ((tournament_id IS NULL) AND (is_deleted IS NOT TRUE) AND (status <> ALL (ARRAY['closed'::text, 'deleted'::text]))); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_management_club_page') IS NULL THEN CREATE INDEX idx_tables_management_club_page ON public.tables USING btree (club_id, created_at, id) WHERE ((tournament_id IS NULL) AND (NOT COALESCE(is_deleted, false)) AND (union_id IS NULL)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_management_scope_club_page') IS NULL THEN CREATE INDEX idx_tables_management_scope_club_page ON public.tables USING btree (club_id, created_at, id) WHERE ((tournament_id IS NULL) AND (NOT COALESCE(is_deleted, false))); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_open_by_club') IS NULL THEN CREATE INDEX idx_tables_open_by_club ON public.tables USING btree (club_id, tournament_id) WHERE ((status <> 'closed'::text) AND (is_deleted IS NOT TRUE)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_platform_open') IS NULL THEN CREATE INDEX idx_tables_platform_open ON public.tables USING btree (current_players DESC) WHERE ((is_deleted = false) AND (status <> 'closed'::text) AND (tournament_id IS NULL)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_status') IS NULL THEN CREATE INDEX idx_tables_status ON public.tables USING btree (status); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_tournament_id') IS NULL THEN CREATE INDEX idx_tables_tournament_id ON public.tables USING btree (tournament_id) WHERE (tournament_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tables_union_id') IS NULL THEN CREATE INDEX idx_tables_union_id ON public.tables USING btree (union_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.table_game_scope_parent_key') IS NULL THEN CREATE UNIQUE INDEX table_game_scope_parent_key ON public.tables USING btree (id, seat_game_scope); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.table_seat_admission_parent_key') IS NULL THEN CREATE UNIQUE INDEX table_seat_admission_parent_key ON public.tables USING btree (id, seat_admission_key); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.tables_cluster_id_idx') IS NULL THEN CREATE INDEX tables_cluster_id_idx ON public.tables USING btree (cluster_id) WHERE (cluster_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.tables_pkey') IS NULL THEN CREATE UNIQUE INDEX tables_pkey ON public.tables USING btree (id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."tournaments" ();
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."tournaments" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "name" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "description" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "description" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "game_type" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "game_type" SET DEFAULT 'NLH'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "game_type" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "variant" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "variant" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "variant" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "buy_in_amount" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "buy_in_amount" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "buy_in_amount" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "buy_in_fee" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "buy_in_fee" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "buy_in_fee" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "guaranteed_prize" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "guaranteed_prize" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "guaranteed_prize" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "start_time" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "start_time" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "start_time" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "status" SET DEFAULT 'ANNOUNCED'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "current_players" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "current_players" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "current_players" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "max_players" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "max_players" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "max_players" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "late_reg_mins" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "late_reg_mins" SET DEFAULT 60;
ALTER TABLE "public"."tournaments" ALTER COLUMN "late_reg_mins" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "starting_chips" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "starting_chips" SET DEFAULT 10000;
ALTER TABLE "public"."tournaments" ALTER COLUMN "starting_chips" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "blind_structure" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "blind_structure" SET DEFAULT 'Standard'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "blind_structure" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "payout_structure" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "payout_structure" SET DEFAULT 'Standard'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "payout_structure" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."tournaments" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."tournaments" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "club_id" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "started_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "started_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "ended_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "ended_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "current_level" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "current_level" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "current_level" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "prize_pool" numeric(18,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "prize_pool" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "prize_pool" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_rebuy" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_rebuy" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_rebuy" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "add_on_available" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "add_on_available" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "add_on_available" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "rebuy_cost" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "rebuy_cost" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "rebuy_cost" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "rebuy_chips" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "rebuy_chips" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "rebuy_chips" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "rebuy_levels" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "rebuy_levels" SET DEFAULT 4;
ALTER TABLE "public"."tournaments" ALTER COLUMN "rebuy_levels" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_cost" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_cost" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_cost" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_chips" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_chips" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_chips" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "min_players" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "min_players" SET DEFAULT 3;
ALTER TABLE "public"."tournaments" ALTER COLUMN "min_players" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "tournament_type" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "tournament_type" SET DEFAULT 'MTT'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "tournament_type" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_bounty" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_bounty" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_bounty" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "bounty_amount" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "bounty_amount" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "bounty_amount" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_pko" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_pko" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_pko" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_mystery_bounty" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_mystery_bounty" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_mystery_bounty" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_min" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_min" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_min" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_max" numeric(15,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_max" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_max" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_xmtt" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_xmtt" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_xmtt" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "union_id" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_multi_day" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_multi_day" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_multi_day" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "parent_tournament_id" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "parent_tournament_id" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "parent_tournament_id" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "flight_number" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "flight_number" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "flight_number" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "day_number" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "day_number" SET DEFAULT 1;
ALTER TABLE "public"."tournaments" ALTER COLUMN "day_number" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "total_days" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "total_days" SET DEFAULT 1;
ALTER TABLE "public"."tournaments" ALTER COLUMN "total_days" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "flight_end_chips_snapshot" jsonb;
ALTER TABLE "public"."tournaments" ALTER COLUMN "flight_end_chips_snapshot" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "flight_end_chips_snapshot" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "survivors_advance_to" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "survivors_advance_to" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "survivors_advance_to" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_pinned" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_pinned" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_pinned" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "spin_multiplier" numeric;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_multiplier" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_multiplier" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_premium_spin" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_premium_spin" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_premium_spin" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "prize_pool_finalized" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "prize_pool_finalized" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "prize_pool_finalized" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_turbo" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_turbo" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_turbo" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "blind_speed" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "blind_speed" SET DEFAULT 'standard'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "blind_speed" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "spin_type" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_type" SET DEFAULT 'standard'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_type" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "total_rake" numeric(18,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "total_rake" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "total_rake" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "late_reg_levels" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "late_reg_levels" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "late_reg_levels" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_levels" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_levels" SET DEFAULT 1;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_levels" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_reentry" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_reentry" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_reentry" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "satellite_target" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "satellite_target" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "satellite_target" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "max_rebuys" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "max_rebuys" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "max_rebuys" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "max_reentries" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "max_reentries" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "max_reentries" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "level_started_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "level_started_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "level_started_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_period_triggered" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_period_triggered" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_period_triggered" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "satellite_target_id" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "satellite_target_id" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "satellite_target_id" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "final_table_triggered" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "final_table_triggered" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "final_table_triggered" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "bounty_pool" numeric(18,2);
ALTER TABLE "public"."tournaments" ALTER COLUMN "bounty_pool" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "bounty_pool" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "bounty_pool_paid" numeric;
ALTER TABLE "public"."tournaments" ALTER COLUMN "bounty_pool_paid" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "bounty_pool_paid" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "on_break" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "on_break" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "on_break" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "break_started_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "break_started_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "break_started_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "break_ends_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "break_ends_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "break_ends_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_private" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_private" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_private" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "spin_locked_tiers" jsonb;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_locked_tiers" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_locked_tiers" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "short_description" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "short_description" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "short_description" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "is_vip_only" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_vip_only" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "is_vip_only" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "ban_chat" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "ban_chat" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "ban_chat" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "all_in_or_fold" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "all_in_or_fold" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "all_in_or_fold" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "label_as_new" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "label_as_new" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "label_as_new" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "hide_club_name" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "hide_club_name" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "hide_club_name" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "action_time_seconds" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "action_time_seconds" SET DEFAULT 15;
ALTER TABLE "public"."tournaments" ALTER COLUMN "action_time_seconds" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "table_size" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "table_size" SET DEFAULT 9;
ALTER TABLE "public"."tournaments" ALTER COLUMN "table_size" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "accelerated_mtt" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "accelerated_mtt" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "accelerated_mtt" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_break_minutes" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_break_minutes" SET DEFAULT 1;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_break_minutes" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "big_blind_ante" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "big_blind_ante" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "big_blind_ante" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "authorized_to_register" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "authorized_to_register" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "authorized_to_register" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "early_bird_enabled" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "early_bird_enabled" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "early_bird_enabled" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "early_bird_chips" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "early_bird_chips" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "early_bird_chips" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "bubble_protection" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "bubble_protection" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "bubble_protection" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "final_table_deal_enabled" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "final_table_deal_enabled" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "final_table_deal_enabled" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "restart_every_minutes" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "restart_every_minutes" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "restart_every_minutes" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "synchronized_breaks" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "synchronized_breaks" SET DEFAULT true;
ALTER TABLE "public"."tournaments" ALTER COLUMN "synchronized_breaks" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "satellite_seats" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "satellite_seats" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "satellite_seats" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "schedule_id" uuid;
ALTER TABLE "public"."tournaments" ALTER COLUMN "schedule_id" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "schedule_id" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_activation" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activation" SET DEFAULT 'at_the_money'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activation" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_activation_value" numeric;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activation_value" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activation_value" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_profile" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_profile" SET DEFAULT 'classic'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_profile" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_top_percent" numeric;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_top_percent" SET DEFAULT 20;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_top_percent" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_regular_pool_percent" numeric;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_regular_pool_percent" SET DEFAULT 50;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_regular_pool_percent" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_pool_percent" numeric;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_pool_percent" SET DEFAULT 50;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_pool_percent" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_stage" text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_stage" SET DEFAULT 'pending'::text;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_stage" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_activated_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activated_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activated_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_activated_players" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activated_players" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activated_players" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_pool_cents" bigint;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_pool_cents" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_pool_cents" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "allow_rabbit_hunt" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "allow_rabbit_hunt" SET DEFAULT true;
ALTER TABLE "public"."tournaments" ALTER COLUMN "allow_rabbit_hunt" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "spin_reveal_lag_ms" integer;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_reveal_lag_ms" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_reveal_lag_ms" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_period_started_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_period_started_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_period_started_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_period_ends_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_period_ends_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_period_ends_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "payout_percent" smallint;
ALTER TABLE "public"."tournaments" ALTER COLUMN "payout_percent" SET DEFAULT 10;
ALTER TABLE "public"."tournaments" ALTER COLUMN "payout_percent" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "free_buy" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "free_buy" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "free_buy" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "addon_from_start" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_from_start" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "addon_from_start" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "spin_reveal_at" timestamp with time zone;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_reveal_at" DROP DEFAULT;
ALTER TABLE "public"."tournaments" ALTER COLUMN "spin_reveal_at" DROP NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "mystery_bounty_activation_generation" bigint;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activation_generation" SET DEFAULT 0;
ALTER TABLE "public"."tournaments" ALTER COLUMN "mystery_bounty_activation_generation" SET NOT NULL;
ALTER TABLE "public"."tournaments" ADD COLUMN IF NOT EXISTS "entry_contract_locked" boolean;
ALTER TABLE "public"."tournaments" ALTER COLUMN "entry_contract_locked" SET DEFAULT false;
ALTER TABLE "public"."tournaments" ALTER COLUMN "entry_contract_locked" SET NOT NULL;
ALTER TABLE "public"."tournaments" OWNER TO "postgres";
ALTER TABLE "public"."tournaments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tournaments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_club_id_fkey" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_free_buy_entry_is_free" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_free_buy_entry_is_free" CHECK (((NOT free_buy) OR ((COALESCE(buy_in_amount, (0)::numeric) = (0)::numeric) AND (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))));
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_heads_up_rake_within_5_pct" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_heads_up_rake_within_5_pct" CHECK (((max_players IS NULL) OR (max_players > 2) OR (COALESCE(buy_in_fee, (0)::numeric) <= (round(((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.05), 2) + 0.005)))) NOT VALID;
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_mystery_activation_chk" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_mystery_activation_chk" CHECK ((mystery_bounty_activation = ANY (ARRAY['at_the_money'::text, 'percent_field'::text, 'player_count'::text])));
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_mystery_activation_generation_nonnegative" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_mystery_activation_generation_nonnegative" CHECK ((mystery_bounty_activation_generation >= 0));
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_mystery_profile_chk" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_mystery_profile_chk" CHECK ((mystery_bounty_profile = ANY (ARRAY['balanced'::text, 'classic'::text, 'jackpot'::text])));
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_mystery_stage_chk" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_mystery_stage_chk" CHECK ((mystery_bounty_stage = ANY (ARRAY['pending'::text, 'active'::text, 'complete'::text])));
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_never_pko_and_mystery" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_never_pko_and_mystery" CHECK ((NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false))));
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_no_pko_mystery_hybrid" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_no_pko_mystery_hybrid" CHECK ((NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false))));
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_payout_percent_check" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_payout_percent_check" CHECK ((payout_percent = ANY (ARRAY[10, 15, 20]))) NOT VALID;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."tournaments"'::regclass AND conname='tournaments_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."tournaments"', 'tournaments_pkey';
END IF; END $c$;
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_rake_within_10_pct" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_rake_within_10_pct" CHECK ((COALESCE(buy_in_fee, (0)::numeric) <= (((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.1) + 0.000000001))) NOT VALID;
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_satellite_target_id_fkey" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_satellite_target_id_fkey" FOREIGN KEY (satellite_target_id) REFERENCES tournaments(id);
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_spin_has_no_fee" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_spin_has_no_fee" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR (((lower(COALESCE(variant, ''::text)) <> 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric)))) NOT VALID;
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_spin_no_extra_rake" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_spin_no_extra_rake" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR ((variant IS DISTINCT FROM 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))) NOT VALID;
ALTER TABLE "public"."tournaments" DROP CONSTRAINT IF EXISTS "tournaments_status_check" RESTRICT;
ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_status_check" CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text])));
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_addon_period_open') IS NULL THEN CREATE INDEX idx_tournaments_addon_period_open ON public.tournaments USING btree (addon_period_ends_at) WHERE (addon_period_ends_at IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_club_id') IS NULL THEN CREATE INDEX idx_tournaments_club_id ON public.tournaments USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_completed_ended_at') IS NULL THEN CREATE INDEX idx_tournaments_completed_ended_at ON public.tournaments USING btree (ended_at DESC) WHERE (status = 'COMPLETED'::text); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_live_unfinalized_guarantee') IS NULL THEN CREATE INDEX idx_tournaments_live_unfinalized_guarantee ON public.tournaments USING btree (club_id) INCLUDE (guaranteed_prize, prize_pool) WHERE ((NOT COALESCE(prize_pool_finalized, false)) AND (upper(status) = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'RUNNING'::text]))); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_management_club_page') IS NULL THEN CREATE INDEX idx_tournaments_management_club_page ON public.tournaments USING btree (club_id, start_time, id) WHERE (union_id IS NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_management_scope_club_page') IS NULL THEN CREATE INDEX idx_tournaments_management_scope_club_page ON public.tournaments USING btree (club_id, start_time, id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_management_union_page') IS NULL THEN CREATE INDEX idx_tournaments_management_union_page ON public.tournaments USING btree (union_id, start_time, id) WHERE (union_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_pinned') IS NULL THEN CREATE INDEX idx_tournaments_pinned ON public.tournaments USING btree (is_pinned) WHERE (is_pinned = true); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_satellite_target_id') IS NULL THEN CREATE INDEX idx_tournaments_satellite_target_id ON public.tournaments USING btree (satellite_target_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_spin_draws') IS NULL THEN CREATE INDEX idx_tournaments_spin_draws ON public.tournaments USING btree (created_at DESC) INCLUDE (spin_multiplier, spin_locked_tiers) WHERE ((variant = 'spin'::text) AND (spin_multiplier IS NOT NULL)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_spin_ended') IS NULL THEN CREATE INDEX idx_tournaments_spin_ended ON public.tournaments USING btree (ended_at DESC) WHERE ((variant = 'spin'::text) AND (spin_multiplier IS NOT NULL) AND (ended_at IS NOT NULL)); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_spin_reveal_lag') IS NULL THEN CREATE INDEX idx_tournaments_spin_reveal_lag ON public.tournaments USING btree (started_at DESC) INCLUDE (spin_reveal_lag_ms) WHERE (spin_reveal_lag_ms IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_spin_unbooked_scan') IS NULL THEN CREATE INDEX idx_tournaments_spin_unbooked_scan ON public.tournaments USING btree (started_at) WHERE ((variant = 'spin'::text) AND (status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text]))); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_start_time') IS NULL THEN CREATE INDEX idx_tournaments_start_time ON public.tournaments USING btree (start_time); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_status_start_time') IS NULL THEN CREATE INDEX idx_tournaments_status_start_time ON public.tournaments USING btree (status, start_time); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_tournament_type') IS NULL THEN CREATE INDEX idx_tournaments_tournament_type ON public.tournaments USING btree (tournament_type); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_union_id') IS NULL THEN CREATE INDEX idx_tournaments_union_id ON public.tournaments USING btree (union_id) WHERE (union_id IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_updated_at') IS NULL THEN CREATE INDEX idx_tournaments_updated_at ON public.tournaments USING btree (updated_at DESC); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_tournaments_variant') IS NULL THEN CREATE INDEX idx_tournaments_variant ON public.tournaments USING btree (variant); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.tournaments_pkey') IS NULL THEN CREATE UNIQUE INDEX tournaments_pkey ON public.tournaments USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.uq_scheduled_tournament_one_live_per_occurrence') IS NULL THEN CREATE UNIQUE INDEX uq_scheduled_tournament_one_live_per_occurrence ON public.tournaments USING btree (club_id, tournament_type, name, start_time) WHERE ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text])) AND (tournament_type = ANY (ARRAY['MTT'::text, 'XMTT'::text]))); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."union_clubs" ();
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."union_clubs" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "union_id" SET NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "club_id" uuid;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "club_id" DROP DEFAULT;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "club_id" SET NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "joined_at" timestamp with time zone;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "joined_at" SET DEFAULT now();
ALTER TABLE "public"."union_clubs" ALTER COLUMN "joined_at" DROP NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "club_commission_rate" numeric(5,4);
ALTER TABLE "public"."union_clubs" ALTER COLUMN "club_commission_rate" SET DEFAULT 0.9000;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "club_commission_rate" DROP NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "rate_cash" numeric;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_cash" DROP DEFAULT;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_cash" DROP NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "rate_mtt" numeric;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_mtt" DROP DEFAULT;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_mtt" DROP NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "rate_sng" numeric;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_sng" DROP DEFAULT;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_sng" DROP NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "rate_spin" numeric;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_spin" DROP DEFAULT;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_spin" DROP NOT NULL;
ALTER TABLE "public"."union_clubs" ADD COLUMN IF NOT EXISTS "rate_satellite" numeric;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_satellite" DROP DEFAULT;
ALTER TABLE "public"."union_clubs" ALTER COLUMN "rate_satellite" DROP NOT NULL;
ALTER TABLE "public"."union_clubs" OWNER TO "postgres";
ALTER TABLE "public"."union_clubs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."union_clubs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."union_clubs" DROP CONSTRAINT IF EXISTS "union_clubs_club_id_fkey" RESTRICT;
ALTER TABLE "public"."union_clubs" ADD CONSTRAINT "union_clubs_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE "public"."union_clubs" DROP CONSTRAINT IF EXISTS "union_clubs_game_rates_are_fractions" RESTRICT;
ALTER TABLE "public"."union_clubs" ADD CONSTRAINT "union_clubs_game_rates_are_fractions" CHECK ((((rate_cash IS NULL) OR ((rate_cash >= (0)::numeric) AND (rate_cash <= (1)::numeric))) AND ((rate_mtt IS NULL) OR ((rate_mtt >= (0)::numeric) AND (rate_mtt <= (1)::numeric))) AND ((rate_sng IS NULL) OR ((rate_sng >= (0)::numeric) AND (rate_sng <= (1)::numeric))) AND ((rate_spin IS NULL) OR ((rate_spin >= (0)::numeric) AND (rate_spin <= (1)::numeric))) AND ((rate_satellite IS NULL) OR ((rate_satellite >= (0)::numeric) AND (rate_satellite <= (1)::numeric)))));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."union_clubs"'::regclass AND conname='union_clubs_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."union_clubs" ADD CONSTRAINT "union_clubs_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."union_clubs"', 'union_clubs_pkey';
END IF; END $c$;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."union_clubs"'::regclass AND conname='union_clubs_union_id_club_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."union_clubs" ADD CONSTRAINT "union_clubs_union_id_club_id_key" UNIQUE (union_id, club_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (union_id, club_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."union_clubs"', 'union_clubs_union_id_club_id_key';
END IF; END $c$;
ALTER TABLE "public"."union_clubs" DROP CONSTRAINT IF EXISTS "union_clubs_union_id_fkey" RESTRICT;
ALTER TABLE "public"."union_clubs" ADD CONSTRAINT "union_clubs_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE;
DO $i$ BEGIN IF to_regclass('public.idx_union_clubs_club_id') IS NULL THEN CREATE INDEX idx_union_clubs_club_id ON public.union_clubs USING btree (club_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.union_clubs_pkey') IS NULL THEN CREATE UNIQUE INDEX union_clubs_pkey ON public.union_clubs USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.union_clubs_union_id_club_id_key') IS NULL THEN CREATE UNIQUE INDEX union_clubs_union_id_club_id_key ON public.union_clubs USING btree (union_id, club_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."union_wallets" ();
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."union_wallets" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "union_id" uuid;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "union_id" DROP DEFAULT;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "union_id" SET NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "chip_balance" numeric(20,2);
ALTER TABLE "public"."union_wallets" ALTER COLUMN "chip_balance" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "chip_balance" SET NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "rake_wallet" numeric(20,2);
ALTER TABLE "public"."union_wallets" ALTER COLUMN "rake_wallet" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "rake_wallet" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "bbj_wallet" numeric(20,2);
ALTER TABLE "public"."union_wallets" ALTER COLUMN "bbj_wallet" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "bbj_wallet" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "promo_wallet" numeric(20,2);
ALTER TABLE "public"."union_wallets" ALTER COLUMN "promo_wallet" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "promo_wallet" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "insurance_wallet" numeric(20,2);
ALTER TABLE "public"."union_wallets" ALTER COLUMN "insurance_wallet" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "insurance_wallet" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "total_rake_collected" numeric(20,2);
ALTER TABLE "public"."union_wallets" ALTER COLUMN "total_rake_collected" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "total_rake_collected" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "total_settlements" numeric;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "total_settlements" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "total_settlements" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."union_wallets" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."union_wallets" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."union_wallets" ADD COLUMN IF NOT EXISTS "spin_reserve_wallet" numeric(20,2);
ALTER TABLE "public"."union_wallets" ALTER COLUMN "spin_reserve_wallet" SET DEFAULT 0;
ALTER TABLE "public"."union_wallets" ALTER COLUMN "spin_reserve_wallet" SET NOT NULL;
ALTER TABLE "public"."union_wallets" OWNER TO "postgres";
ALTER TABLE "public"."union_wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."union_wallets" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."union_wallets" DROP CONSTRAINT IF EXISTS "union_wallets_bbj_wallet_nonneg" RESTRICT;
ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_bbj_wallet_nonneg" CHECK ((bbj_wallet >= (0)::numeric));
ALTER TABLE "public"."union_wallets" DROP CONSTRAINT IF EXISTS "union_wallets_chip_balance_nonneg" RESTRICT;
ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_chip_balance_nonneg" CHECK ((chip_balance >= (0)::numeric));
ALTER TABLE "public"."union_wallets" DROP CONSTRAINT IF EXISTS "union_wallets_insurance_wallet_nonneg" RESTRICT;
ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_insurance_wallet_nonneg" CHECK ((insurance_wallet >= (0)::numeric));
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."union_wallets"'::regclass AND conname='union_wallets_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."union_wallets"', 'union_wallets_pkey';
END IF; END $c$;
ALTER TABLE "public"."union_wallets" DROP CONSTRAINT IF EXISTS "union_wallets_promo_wallet_nonneg" RESTRICT;
ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_promo_wallet_nonneg" CHECK ((promo_wallet >= (0)::numeric));
ALTER TABLE "public"."union_wallets" DROP CONSTRAINT IF EXISTS "union_wallets_rake_wallet_nonneg" RESTRICT;
ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_rake_wallet_nonneg" CHECK ((rake_wallet >= (0)::numeric));
ALTER TABLE "public"."union_wallets" DROP CONSTRAINT IF EXISTS "union_wallets_spin_reserve_wallet_nonneg" RESTRICT;
ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_spin_reserve_wallet_nonneg" CHECK ((spin_reserve_wallet >= (0)::numeric));
ALTER TABLE "public"."union_wallets" DROP CONSTRAINT IF EXISTS "union_wallets_union_id_fkey" RESTRICT;
ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."union_wallets"'::regclass AND conname='union_wallets_union_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."union_wallets" ADD CONSTRAINT "union_wallets_union_id_key" UNIQUE (union_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (union_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."union_wallets"', 'union_wallets_union_id_key';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.union_wallets_pkey') IS NULL THEN CREATE UNIQUE INDEX union_wallets_pkey ON public.union_wallets USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.union_wallets_union_id_key') IS NULL THEN CREATE UNIQUE INDEX union_wallets_union_id_key ON public.union_wallets USING btree (union_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."unions" ();
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."unions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."unions" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "public"."unions" ALTER COLUMN "name" DROP DEFAULT;
ALTER TABLE "public"."unions" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "public"."unions" ALTER COLUMN "description" DROP DEFAULT;
ALTER TABLE "public"."unions" ALTER COLUMN "description" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "owner_id" uuid;
ALTER TABLE "public"."unions" ALTER COLUMN "owner_id" DROP DEFAULT;
ALTER TABLE "public"."unions" ALTER COLUMN "owner_id" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "avatar_url" text;
ALTER TABLE "public"."unions" ALTER COLUMN "avatar_url" DROP DEFAULT;
ALTER TABLE "public"."unions" ALTER COLUMN "avatar_url" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "is_public" boolean;
ALTER TABLE "public"."unions" ALTER COLUMN "is_public" SET DEFAULT true;
ALTER TABLE "public"."unions" ALTER COLUMN "is_public" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "member_count" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "member_count" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "member_count" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "club_count" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "club_count" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "club_count" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "total_rake" numeric(15,2);
ALTER TABLE "public"."unions" ALTER COLUMN "total_rake" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "total_rake" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "settings" jsonb;
ALTER TABLE "public"."unions" ALTER COLUMN "settings" SET DEFAULT '{"shared_player_pool": true, "revenue_share_percent": 10, "cross_club_tournaments": true}'::jsonb;
ALTER TABLE "public"."unions" ALTER COLUMN "settings" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."unions" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."unions" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."unions" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."unions" ALTER COLUMN "updated_at" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "union_code" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "union_code" DROP DEFAULT;
ALTER TABLE "public"."unions" ALTER COLUMN "union_code" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "main_bbj_balance" numeric(14,2);
ALTER TABLE "public"."unions" ALTER COLUMN "main_bbj_balance" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "main_bbj_balance" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "backup_bbj_balance" numeric(14,2);
ALTER TABLE "public"."unions" ALTER COLUMN "backup_bbj_balance" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "backup_bbj_balance" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "promo_fund_balance" numeric(14,2);
ALTER TABLE "public"."unions" ALTER COLUMN "promo_fund_balance" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "promo_fund_balance" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "code" text;
ALTER TABLE "public"."unions" ALTER COLUMN "code" DROP DEFAULT;
ALTER TABLE "public"."unions" ALTER COLUMN "code" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "insurance_balance" numeric(14,2);
ALTER TABLE "public"."unions" ALTER COLUMN "insurance_balance" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "insurance_balance" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "chip_balance" numeric(20,4);
ALTER TABLE "public"."unions" ALTER COLUMN "chip_balance" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "chip_balance" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "rake_wallet" numeric(20,4);
ALTER TABLE "public"."unions" ALTER COLUMN "rake_wallet" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "rake_wallet" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "bbj_wallet" numeric(20,4);
ALTER TABLE "public"."unions" ALTER COLUMN "bbj_wallet" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "bbj_wallet" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "promo_wallet" numeric(20,4);
ALTER TABLE "public"."unions" ALTER COLUMN "promo_wallet" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "promo_wallet" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "auto_settlement" boolean;
ALTER TABLE "public"."unions" ALTER COLUMN "auto_settlement" SET DEFAULT false;
ALTER TABLE "public"."unions" ALTER COLUMN "auto_settlement" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "level" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "level" SET DEFAULT 1;
ALTER TABLE "public"."unions" ALTER COLUMN "level" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "player_level" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "player_level" SET DEFAULT 1;
ALTER TABLE "public"."unions" ALTER COLUMN "player_level" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "hierarchy_level" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_level" SET DEFAULT 1;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_level" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "total_players" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "total_players" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "total_players" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "total_admins" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "total_admins" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "total_admins" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "total_super_agents" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "total_super_agents" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "total_super_agents" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "total_agents" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "total_agents" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "total_agents" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "hierarchy_units" numeric(10,2);
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_units" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_units" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "hierarchy_units_rounded_up" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_units_rounded_up" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_units_rounded_up" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "player_threshold_current" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "player_threshold_current" SET DEFAULT 30;
ALTER TABLE "public"."unions" ALTER COLUMN "player_threshold_current" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "player_threshold_next" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "player_threshold_next" SET DEFAULT 34;
ALTER TABLE "public"."unions" ALTER COLUMN "player_threshold_next" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "hierarchy_threshold_current" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_threshold_current" SET DEFAULT 2;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_threshold_current" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "hierarchy_threshold_next" integer;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_threshold_next" SET DEFAULT 2;
ALTER TABLE "public"."unions" ALTER COLUMN "hierarchy_threshold_next" DROP NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "promo_funded_from_bbj" numeric;
ALTER TABLE "public"."unions" ALTER COLUMN "promo_funded_from_bbj" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "promo_funded_from_bbj" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "promo_funded_from_bank" numeric;
ALTER TABLE "public"."unions" ALTER COLUMN "promo_funded_from_bank" SET DEFAULT 0;
ALTER TABLE "public"."unions" ALTER COLUMN "promo_funded_from_bank" SET NOT NULL;
ALTER TABLE "public"."unions" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "public"."unions" ALTER COLUMN "slug" DROP DEFAULT;
ALTER TABLE "public"."unions" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "public"."unions" OWNER TO "postgres";
ALTER TABLE "public"."unions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."unions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."unions" DROP CONSTRAINT IF EXISTS "chk_chip_balance_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."unions" ADD CONSTRAINT "chk_chip_balance_is_two_decimal_places" CHECK (((chip_balance IS NULL) OR (chip_balance = round(chip_balance, 2))));
ALTER TABLE "public"."unions" DROP CONSTRAINT IF EXISTS "chk_rake_wallet_is_two_decimal_places" RESTRICT;
ALTER TABLE "public"."unions" ADD CONSTRAINT "chk_rake_wallet_is_two_decimal_places" CHECK (((rake_wallet IS NULL) OR (rake_wallet = round(rake_wallet, 2))));
ALTER TABLE "public"."unions" DROP CONSTRAINT IF EXISTS "fk_unions_owner_id_profiles" RESTRICT;
ALTER TABLE "public"."unions" ADD CONSTRAINT "fk_unions_owner_id_profiles" FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE CASCADE;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."unions"'::regclass AND conname='unions_code_unique';
 IF actual IS NULL THEN
  ALTER TABLE "public"."unions" ADD CONSTRAINT "unions_code_unique" UNIQUE (code);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (code)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."unions"', 'unions_code_unique';
END IF; END $c$;
ALTER TABLE "public"."unions" DROP CONSTRAINT IF EXISTS "unions_owner_id_fkey" RESTRICT;
ALTER TABLE "public"."unions" ADD CONSTRAINT "unions_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id);
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."unions"'::regclass AND conname='unions_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."unions" ADD CONSTRAINT "unions_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."unions"', 'unions_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.idx_unions_owner_id') IS NULL THEN CREATE INDEX idx_unions_owner_id ON public.unions USING btree (owner_id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.idx_unions_union_code') IS NULL THEN CREATE UNIQUE INDEX idx_unions_union_code ON public.unions USING btree (union_code) WHERE (union_code IS NOT NULL); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.unions_code_unique') IS NULL THEN CREATE UNIQUE INDEX unions_code_unique ON public.unions USING btree (code); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.unions_pkey') IS NULL THEN CREATE UNIQUE INDEX unions_pkey ON public.unions USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.unions_slug_key') IS NULL THEN CREATE UNIQUE INDEX unions_slug_key ON public.unions USING btree (slug); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."vip_points" ();
ALTER TABLE "public"."vip_points" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."vip_points" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."vip_points" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."vip_points" ADD COLUMN IF NOT EXISTS "current_points" bigint;
ALTER TABLE "public"."vip_points" ALTER COLUMN "current_points" SET DEFAULT 0;
ALTER TABLE "public"."vip_points" ALTER COLUMN "current_points" SET NOT NULL;
ALTER TABLE "public"."vip_points" ADD COLUMN IF NOT EXISTS "lifetime_points" bigint;
ALTER TABLE "public"."vip_points" ALTER COLUMN "lifetime_points" SET DEFAULT 0;
ALTER TABLE "public"."vip_points" ALTER COLUMN "lifetime_points" SET NOT NULL;
ALTER TABLE "public"."vip_points" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "public"."vip_points" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "public"."vip_points" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "public"."vip_points" OWNER TO "postgres";
ALTER TABLE "public"."vip_points" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."vip_points" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."vip_points"'::regclass AND conname='vip_points_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."vip_points" ADD CONSTRAINT "vip_points_pkey" PRIMARY KEY (user_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (user_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."vip_points"', 'vip_points_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.vip_points_pkey') IS NULL THEN CREATE UNIQUE INDEX vip_points_pkey ON public.vip_points USING btree (user_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "public"."vip_points_ledger" ();
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "points" bigint;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "points" DROP DEFAULT;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "points" SET NOT NULL;
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "reason" DROP NOT NULL;
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "source_type" text;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "source_type" SET DEFAULT 'rake'::text;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "source_type" SET NOT NULL;
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "source_id" uuid;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "source_id" DROP DEFAULT;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "source_id" DROP NOT NULL;
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "public"."vip_points_ledger" ADD COLUMN IF NOT EXISTS "credit" numeric(14,4);
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "credit" DROP DEFAULT;
ALTER TABLE "public"."vip_points_ledger" ALTER COLUMN "credit" DROP NOT NULL;
ALTER TABLE "public"."vip_points_ledger" OWNER TO "postgres";
ALTER TABLE "public"."vip_points_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."vip_points_ledger" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."vip_points_ledger"'::regclass AND conname='vip_points_ledger_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "public"."vip_points_ledger" ADD CONSTRAINT "vip_points_ledger_pkey" PRIMARY KEY (id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."vip_points_ledger"', 'vip_points_ledger_pkey';
END IF; END $c$;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"public"."vip_points_ledger"'::regclass AND conname='vip_points_ledger_user_id_source_type_source_id_key';
 IF actual IS NULL THEN
  ALTER TABLE "public"."vip_points_ledger" ADD CONSTRAINT "vip_points_ledger_user_id_source_type_source_id_key" UNIQUE (user_id, source_type, source_id);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (user_id, source_type, source_id)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"public"."vip_points_ledger"', 'vip_points_ledger_user_id_source_type_source_id_key';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('public.vip_points_ledger_pkey') IS NULL THEN CREATE UNIQUE INDEX vip_points_ledger_pkey ON public.vip_points_ledger USING btree (id); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('public.vip_points_ledger_user_id_source_type_source_id_key') IS NULL THEN CREATE UNIQUE INDEX vip_points_ledger_user_id_source_type_source_id_key ON public.vip_points_ledger USING btree (user_id, source_type, source_id); END IF; END $i$;
CREATE TABLE IF NOT EXISTS "supabase_migrations"."schema_migrations" ();
ALTER TABLE "supabase_migrations"."schema_migrations" ADD COLUMN IF NOT EXISTS "version" text;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "version" DROP DEFAULT;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "version" SET NOT NULL;
ALTER TABLE "supabase_migrations"."schema_migrations" ADD COLUMN IF NOT EXISTS "statements" text[];
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "statements" DROP DEFAULT;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "statements" DROP NOT NULL;
ALTER TABLE "supabase_migrations"."schema_migrations" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "name" DROP DEFAULT;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "supabase_migrations"."schema_migrations" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "created_by" DROP DEFAULT;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "supabase_migrations"."schema_migrations" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "idempotency_key" DROP DEFAULT;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "idempotency_key" DROP NOT NULL;
ALTER TABLE "supabase_migrations"."schema_migrations" ADD COLUMN IF NOT EXISTS "rollback" text[];
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "rollback" DROP DEFAULT;
ALTER TABLE "supabase_migrations"."schema_migrations" ALTER COLUMN "rollback" DROP NOT NULL;
ALTER TABLE "supabase_migrations"."schema_migrations" OWNER TO "postgres";
ALTER TABLE "supabase_migrations"."schema_migrations" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "supabase_migrations"."schema_migrations" NO FORCE ROW LEVEL SECURITY;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"supabase_migrations"."schema_migrations"'::regclass AND conname='schema_migrations_idempotency_key_key';
 IF actual IS NULL THEN
  ALTER TABLE "supabase_migrations"."schema_migrations" ADD CONSTRAINT "schema_migrations_idempotency_key_key" UNIQUE (idempotency_key);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('UNIQUE (idempotency_key)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"supabase_migrations"."schema_migrations"', 'schema_migrations_idempotency_key_key';
END IF; END $c$;
DO $c$ DECLARE actual text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
 WHERE conrelid='"supabase_migrations"."schema_migrations"'::regclass AND conname='schema_migrations_pkey';
 IF actual IS NULL THEN
  ALTER TABLE "supabase_migrations"."schema_migrations" ADD CONSTRAINT "schema_migrations_pkey" PRIMARY KEY (version);
 ELSIF btrim(actual) IS DISTINCT FROM btrim('PRIMARY KEY (version)') THEN
  RAISE EXCEPTION 'Fixture constraint differs: %.% (needs an exact source overlay)', '"supabase_migrations"."schema_migrations"', 'schema_migrations_pkey';
END IF; END $c$;
DO $i$ BEGIN IF to_regclass('supabase_migrations.schema_migrations_idempotency_key_key') IS NULL THEN CREATE UNIQUE INDEX schema_migrations_idempotency_key_key ON supabase_migrations.schema_migrations USING btree (idempotency_key); END IF; END $i$;
DO $i$ BEGIN IF to_regclass('supabase_migrations.schema_migrations_pkey') IS NULL THEN CREATE UNIQUE INDEX schema_migrations_pkey ON supabase_migrations.schema_migrations USING btree (version); END IF; END $i$;
CREATE OR REPLACE VIEW "public"."agent_commissions_unsettled" WITH (security_invoker=true) AS  SELECT id,
    club_id,
    user_id,
    amount,
    commission_rate,
    source_type,
    source_id,
    notes,
    created_at,
    settled_at
   FROM agent_commissions ac
  WHERE ((settled_at IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM agent_commission_settlements s
          WHERE ((s.club_id = ac.club_id) AND (s.user_id = ac.user_id) AND (ac.created_at >= s.period_start) AND (ac.created_at < s.period_end))))));
ALTER VIEW "public"."agent_commissions_unsettled" OWNER TO "postgres";
-- Exact relation options: "auth"."users"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"auth"."users"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"auth"."users"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"auth"."users"';
   END IF;
   EXECUTE 'ALTER TABLE "auth"."users" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"auth"."users"';
   END IF;
   EXECUTE 'ALTER TABLE "auth"."users" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"auth"."users"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"auth"."users"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."agent_commission_settlements"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."agent_commission_settlements"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."agent_commission_settlements"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."agent_commission_settlements"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agent_commission_settlements" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."agent_commission_settlements"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agent_commission_settlements" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."agent_commission_settlements"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."agent_commission_settlements"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."agent_commission_unsettled_rollup"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."agent_commission_unsettled_rollup"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."agent_commission_unsettled_rollup"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."agent_commission_unsettled_rollup"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agent_commission_unsettled_rollup" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."agent_commission_unsettled_rollup"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agent_commission_unsettled_rollup" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."agent_commission_unsettled_rollup"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."agent_commission_unsettled_rollup"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."agent_commissions"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_enabled=true', 'autovacuum_analyze_scale_factor=0.0', 'autovacuum_analyze_threshold=1000', 'autovacuum_vacuum_scale_factor=0.0', 'autovacuum_vacuum_threshold=1000', 'autovacuum_vacuum_cost_delay=2', 'autovacuum_vacuum_cost_limit=2000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."agent_commissions"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."agent_commissions"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."agent_commissions"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agent_commissions" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."agent_commissions"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agent_commissions" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."agent_commissions"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."agent_commissions"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."agent_commissions_unsettled"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['security_invoker=true']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."agent_commissions_unsettled"'::regclass;
 IF NOT FOUND OR actual_kind <> 'v' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."agent_commissions_unsettled"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."agent_commissions_unsettled"';
   END IF;
   EXECUTE 'ALTER VIEW "public"."agent_commissions_unsettled" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."agent_commissions_unsettled"';
   END IF;
   EXECUTE 'ALTER VIEW "public"."agent_commissions_unsettled" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."agent_commissions_unsettled"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."agent_commissions_unsettled"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."agents"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."agents"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."agents"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."agents"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agents" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."agents"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."agents" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."agents"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."agents"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."bbj_pools"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."bbj_pools"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."bbj_pools"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."bbj_pools"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."bbj_pools" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."bbj_pools"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."bbj_pools" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."bbj_pools"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."bbj_pools"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_account_snapshots"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_account_snapshots"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_account_snapshots"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_account_snapshots"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_account_snapshots" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_account_snapshots"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_account_snapshots" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_account_snapshots"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_account_snapshots"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_currency_meter"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_currency_meter"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_currency_meter"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_currency_meter"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_currency_meter" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_currency_meter"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_currency_meter" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_currency_meter"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_currency_meter"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_detector_registry"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_detector_registry"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_detector_registry"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_detector_registry"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_detector_registry" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_detector_registry"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_detector_registry" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_detector_registry"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_detector_registry"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_drift_incidents"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_drift_incidents"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_drift_incidents"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_drift_incidents"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_drift_incidents" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_drift_incidents"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_drift_incidents" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_drift_incidents"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_drift_incidents"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_financial_epochs"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_financial_epochs"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_financial_epochs"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_financial_epochs"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_financial_epochs" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_financial_epochs"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_financial_epochs" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_financial_epochs"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_financial_epochs"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_guard_def_history"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_guard_def_history"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_guard_def_history"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_guard_def_history"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_guard_def_history" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_guard_def_history"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_guard_def_history" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_guard_def_history"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_guard_def_history"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_incident_events"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_incident_events"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_incident_events"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_incident_events"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_events" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_incident_events"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_events" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_incident_events"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_incident_events"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_incident_file_failures"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_incident_file_failures"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_incident_file_failures"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_incident_file_failures"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_file_failures" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_incident_file_failures"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_file_failures" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_incident_file_failures"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_incident_file_failures"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_incident_notify_ledger"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_incident_notify_ledger"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_incident_notify_ledger"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_incident_notify_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_notify_ledger" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_incident_notify_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_notify_ledger" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_incident_notify_ledger"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_incident_notify_ledger"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_incident_recipients"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_incident_recipients"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_incident_recipients"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_incident_recipients"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_recipients" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_incident_recipients"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_incident_recipients" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_incident_recipients"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_incident_recipients"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_kill_switch_policy"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_kill_switch_policy"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_kill_switch_policy"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_kill_switch_policy"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_kill_switch_policy" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_kill_switch_policy"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_kill_switch_policy" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_kill_switch_policy"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_kill_switch_policy"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_ledger_mutation_log"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_ledger_mutation_log"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_ledger_mutation_log"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_ledger_mutation_log"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_ledger_mutation_log" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_ledger_mutation_log"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_ledger_mutation_log" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_ledger_mutation_log"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_ledger_mutation_log"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_mint_ledger"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_mint_ledger"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_mint_ledger"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_mint_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_mint_ledger" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_mint_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_mint_ledger" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_mint_ledger"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_mint_ledger"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_mint_policy"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_mint_policy"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_mint_policy"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_mint_policy"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_mint_policy" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_mint_policy"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_mint_policy" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_mint_policy"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_mint_policy"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_payout_freeze"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_payout_freeze"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_payout_freeze"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_payout_freeze"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_payout_freeze" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_payout_freeze"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_payout_freeze" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_payout_freeze"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_payout_freeze"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."ca_rakeback_baseline"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."ca_rakeback_baseline"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."ca_rakeback_baseline"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."ca_rakeback_baseline"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_rakeback_baseline" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."ca_rakeback_baseline"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."ca_rakeback_baseline" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."ca_rakeback_baseline"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."ca_rakeback_baseline"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."chip_ledger"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_enabled=true', 'autovacuum_analyze_scale_factor=0.0', 'autovacuum_analyze_threshold=1000', 'autovacuum_vacuum_scale_factor=0.0', 'autovacuum_vacuum_threshold=1000', 'autovacuum_vacuum_cost_delay=2', 'autovacuum_vacuum_cost_limit=2000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."chip_ledger"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."chip_ledger"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."chip_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."chip_ledger" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."chip_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."chip_ledger" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."chip_ledger"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."chip_ledger"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."chip_transactions"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_freeze_max_age=150000000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."chip_transactions"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."chip_transactions"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."chip_transactions"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."chip_transactions" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."chip_transactions"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."chip_transactions" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."chip_transactions"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."chip_transactions"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."club_members"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."club_members"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."club_members"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."club_members"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."club_members" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."club_members"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."club_members" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."club_members"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."club_members"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."clubs"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."clubs"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."clubs"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."clubs"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."clubs" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."clubs"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."clubs" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."clubs"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."clubs"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."financial_alerts"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."financial_alerts"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."financial_alerts"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."financial_alerts"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."financial_alerts" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."financial_alerts"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."financial_alerts" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."financial_alerts"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."financial_alerts"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."notifications"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."notifications"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."notifications"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."notifications"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."notifications" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."notifications"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."notifications" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."notifications"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."notifications"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."profiles"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_analyze_scale_factor=0.01', 'autovacuum_vacuum_cost_delay=2', 'autovacuum_vacuum_cost_limit=1000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."profiles"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."profiles"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."profiles"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."profiles" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."profiles"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."profiles" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."profiles"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."profiles"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."rakeback_period_payouts"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."rakeback_period_payouts"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."rakeback_period_payouts"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."rakeback_period_payouts"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."rakeback_period_payouts" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."rakeback_period_payouts"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."rakeback_period_payouts" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."rakeback_period_payouts"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."rakeback_period_payouts"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."rakeback_periods"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."rakeback_periods"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."rakeback_periods"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."rakeback_periods"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."rakeback_periods" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."rakeback_periods"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."rakeback_periods" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."rakeback_periods"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."rakeback_periods"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."spin_bonus_pools"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."spin_bonus_pools"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."spin_bonus_pools"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."spin_bonus_pools"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."spin_bonus_pools" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."spin_bonus_pools"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."spin_bonus_pools" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."spin_bonus_pools"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."spin_bonus_pools"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."table_seats"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_analyze_scale_factor=0.02', 'autovacuum_vacuum_cost_delay=2', 'autovacuum_vacuum_cost_limit=1000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."table_seats"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."table_seats"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."table_seats"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."table_seats" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."table_seats"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."table_seats" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."table_seats"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."table_seats"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."tables"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_analyze_scale_factor=0.02', 'autovacuum_vacuum_cost_delay=2', 'autovacuum_vacuum_cost_limit=1000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."tables"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."tables"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."tables"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."tables" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."tables"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."tables" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."tables"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."tables"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."tournaments"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_enabled=true', 'autovacuum_analyze_scale_factor=0.0', 'autovacuum_analyze_threshold=500', 'autovacuum_vacuum_scale_factor=0.0', 'autovacuum_vacuum_threshold=500', 'autovacuum_vacuum_cost_delay=2', 'autovacuum_vacuum_cost_limit=2000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."tournaments"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."tournaments"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."tournaments"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."tournaments" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."tournaments"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."tournaments" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."tournaments"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."tournaments"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."union_clubs"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."union_clubs"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."union_clubs"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."union_clubs"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."union_clubs" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."union_clubs"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."union_clubs" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."union_clubs"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."union_clubs"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."union_wallets"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."union_wallets"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."union_wallets"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."union_wallets"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."union_wallets" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."union_wallets"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."union_wallets" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."union_wallets"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."union_wallets"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."unions"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."unions"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."unions"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."unions"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."unions" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."unions"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."unions" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."unions"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."unions"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."vip_points"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."vip_points"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."vip_points"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."vip_points"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."vip_points" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."vip_points"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."vip_points" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."vip_points"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."vip_points"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "public"."vip_points_ledger"
DO $options$
DECLARE old_options text[]; desired_options text[] := ARRAY['autovacuum_enabled=true', 'autovacuum_analyze_scale_factor=0.0', 'autovacuum_analyze_threshold=2000', 'autovacuum_vacuum_scale_factor=0.0', 'autovacuum_vacuum_threshold=2000', 'autovacuum_vacuum_cost_delay=2', 'autovacuum_vacuum_cost_limit=2000']::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"public"."vip_points_ledger"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"public"."vip_points_ledger"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"public"."vip_points_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."vip_points_ledger" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"public"."vip_points_ledger"';
   END IF;
   EXECUTE 'ALTER TABLE "public"."vip_points_ledger" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"public"."vip_points_ledger"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"public"."vip_points_ledger"', desired_options, actual_options;
 END IF;
END $options$;
-- Exact relation options: "supabase_migrations"."schema_migrations"
DO $options$
DECLARE old_options text[]; desired_options text[] := NULL::text[]; actual_options text[];
        option_text text; option_name text; option_value text; equals_at int; actual_kind "char";
BEGIN
 SELECT relkind, reloptions INTO actual_kind, old_options FROM pg_catalog.pg_class
  WHERE oid='"supabase_migrations"."schema_migrations"'::regclass;
 IF NOT FOUND OR actual_kind <> 'r' THEN
  RAISE EXCEPTION 'Unexpected relation option target/kind: %', '"supabase_migrations"."schema_migrations"';
 END IF;
 IF old_options IS NOT DISTINCT FROM desired_options THEN RETURN; END IF;
 -- Reset the entire previous explicit set; never assume one named mismatch is
 -- the only possible old override. Empty/NULL arrays require no iteration.
 IF COALESCE(pg_catalog.cardinality(old_options),0)>0 THEN
  FOREACH option_text IN ARRAY old_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed archived relation option: % on %', option_text, '"supabase_migrations"."schema_migrations"';
   END IF;
   EXECUTE 'ALTER TABLE "supabase_migrations"."schema_migrations" RESET ('||pg_catalog.quote_ident(option_name)||')';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(desired_options),0)>0 THEN
  FOREACH option_text IN ARRAY desired_options LOOP
   equals_at:=pg_catalog.strpos(option_text,'=');
   option_name:=pg_catalog.substr(option_text,1,equals_at-1);
   option_value:=pg_catalog.substr(option_text,equals_at+1);
   IF equals_at<2 OR option_name !~ '^[a-z_][a-z_0-9]*$' THEN
    RAISE EXCEPTION 'Unreviewed captured relation option: % on %', option_text, '"supabase_migrations"."schema_migrations"';
   END IF;
   EXECUTE 'ALTER TABLE "supabase_migrations"."schema_migrations" SET ('||pg_catalog.quote_ident(option_name)||'='||pg_catalog.quote_literal(option_value)||')';
  END LOOP;
 END IF;
 SELECT reloptions INTO actual_options FROM pg_catalog.pg_class WHERE oid='"supabase_migrations"."schema_migrations"'::regclass;
 IF actual_options IS DISTINCT FROM desired_options THEN
  RAISE EXCEPTION 'Exact relation options differ: % expected %, actual %',
    '"supabase_migrations"."schema_migrations"', desired_options, actual_options;
 END IF;
END $options$;
