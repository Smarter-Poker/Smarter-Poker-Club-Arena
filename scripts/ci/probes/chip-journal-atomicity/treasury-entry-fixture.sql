-- Native journal fixture schema, using captured actual original column types.
-- Actual money, entry/claim/completion, private gift admission/evidence and funding
-- recorder bodies are loaded by the migration-history dependency closure.
-- Auth/session boundaries remain those of fixture.sql. Only original event
-- capture is controlled here, as in the maintained dedicated producer qualifier.
CREATE SCHEMA IF NOT EXISTS smarter_private;
ALTER TABLE public.chip_ledger ADD COLUMN IF NOT EXISTS "status" text;
CREATE TABLE IF NOT EXISTS public.union_pnl_original_flows();
ALTER TABLE public.union_pnl_original_flows ADD COLUMN IF NOT EXISTS "ledger_id" uuid;
ALTER TABLE public.union_pnl_original_flows ADD COLUMN IF NOT EXISTS "transaction_id" xid8;
ALTER TABLE public.union_pnl_original_flows ADD COLUMN IF NOT EXISTS "recognized_at" timestamp with time zone;
ALTER TABLE public.union_pnl_original_flows ADD COLUMN IF NOT EXISTS "game_scope" jsonb;
ALTER TABLE public.union_pnl_original_flows ADD COLUMN IF NOT EXISTS "ledger_snapshot" jsonb;
CREATE TABLE IF NOT EXISTS public.union_pnl_inventory_events();
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "event_id" bigint;
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "source_name" text;
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "row_id" uuid;
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "observed_at" timestamp with time zone;
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "transaction_id" xid8;
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "operation" text;
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "before_row" jsonb;
ALTER TABLE public.union_pnl_inventory_events ADD COLUMN IF NOT EXISTS "after_row" jsonb;
CREATE TABLE IF NOT EXISTS public.union_pnl_transaction_frames();
ALTER TABLE public.union_pnl_transaction_frames ADD COLUMN IF NOT EXISTS "transaction_id" xid8;
ALTER TABLE public.union_pnl_transaction_frames ADD COLUMN IF NOT EXISTS "observed_at" timestamp with time zone;
ALTER TABLE public.union_pnl_transaction_frames ADD COLUMN IF NOT EXISTS "book_start" timestamp with time zone;

-- Draft only. Original financial witnesses, never a replacement funding debit.
CREATE TABLE smarter_private.original_treasury_funding_witnesses(
 ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),
 source jsonb NOT NULL,source_fingerprint text NOT NULL,historical_late boolean NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(source)='object'),CHECK(length(source_fingerprint)=32));
CREATE UNIQUE INDEX original_treasury_gift_occupancy_once ON smarter_private.original_treasury_funding_witnesses((source#>>'{seat_event,after_row,occupancy_id}')) WHERE kind='gift';
CREATE UNIQUE INDEX original_treasury_return_occupancy_once ON smarter_private.original_treasury_funding_witnesses((source#>>'{seat_event,before_row,occupancy_id}')) WHERE kind='return';
CREATE FUNCTION smarter_private.original_treasury_witness_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'original_treasury_witness_is_immutable' USING ERRCODE='55000';END$$;
-- Installation time is current, immutable, and independent of an old gift's
-- transaction timestamp. Future atomic gifts never change closed-book bases.
CREATE TABLE smarter_private.original_treasury_funding_cutover(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),installed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(installed_at)));
INSERT INTO smarter_private.original_treasury_funding_cutover DEFAULT VALUES;
CREATE TRIGGER original_treasury_cutover_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_funding_cutover FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_cutover_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_funding_cutover FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
-- Finite pre-cutover admission journal, separate from future live witnesses.
-- Global closed-book generation reads this bounded table, never all live gifts.
CREATE TABLE smarter_private.original_treasury_historical_admissions(ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),source_fingerprint text NOT NULL CHECK(length(source_fingerprint)=32),admitted_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER original_treasury_historical_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_historical_admissions FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_historical_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_historical_admissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_funding_witnesses FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_funding_witnesses FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();

ALTER TABLE public.chip_ledger ALTER COLUMN status SET DEFAULT 'posted';
CREATE SEQUENCE native_journal_inventory_event;
CREATE FUNCTION public.native_journal_seat_capture()RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $capture$
BEGIN
 IF NEW.club_id IS NULL THEN SELECT club_id INTO NEW.club_id FROM public.tables WHERE id=NEW.table_id;END IF;
 INSERT INTO public.union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 VALUES(nextval('native_journal_inventory_event'),'table_seats',NEW.id,clock_timestamp(),pg_current_xact_id(),'INSERT',NULL,
 jsonb_build_object('id',NEW.id,'occupancy_id',NEW.occupancy_id,'joined_at',NEW.joined_at,'left_at',NEW.left_at,'user_id',NEW.user_id,'table_id',NEW.table_id,'club_id',NEW.club_id,'stack',NEW.stack));
 RETURN NEW;
END$capture$;
CREATE TRIGGER native_journal_seat_capture BEFORE INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION public.native_journal_seat_capture();
CREATE UNIQUE INDEX native_journal_frame_once ON public.union_pnl_transaction_frames(transaction_id);
CREATE FUNCTION public.native_journal_original_ledger_capture()RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $capture$
DECLARE stamp timestamptz;
BEGIN
 INSERT INTO public.union_pnl_transaction_frames(transaction_id,observed_at,book_start)VALUES(pg_current_xact_id(),clock_timestamp(),transaction_timestamp())ON CONFLICT(transaction_id)DO NOTHING;
 SELECT observed_at INTO STRICT stamp FROM public.union_pnl_transaction_frames WHERE transaction_id=pg_current_xact_id();
 INSERT INTO public.union_pnl_original_flows(ledger_id,transaction_id,recognized_at,game_scope,ledger_snapshot)
 VALUES(NEW.id,pg_current_xact_id(),stamp,jsonb_build_object('asset','chips','unit_scale',2,'tournament_id',NULL,'host_club_id',NEW.club_id,'game_union_id',NEW.club_id,'is_private',false),to_jsonb(NEW));
 RETURN NEW;
END$capture$;
CREATE TRIGGER native_journal_original_ledger_capture AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.native_journal_original_ledger_capture();
