-- Read-only production catalog capture, September 19. No production player data.
SET check_function_bodies=off;
CREATE TABLE public.ca_diamond_snapshots(
 "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "taken_at" timestamp with time zone DEFAULT now() NOT NULL,
 "profile_diamonds" numeric NOT NULL,
 "wallet_diamonds" numeric NOT NULL,
 "cert_diamonds" numeric NOT NULL,
 "total" numeric NOT NULL,
 "journaled_delta" numeric,
 "delta_vs_prev" numeric,
 "unexplained" numeric,
 "register_supply" numeric,
 "house_balance" numeric,
 "fixture_diamonds" numeric,
 "register_fixture" numeric,
 "arena_diamonds" numeric,
 "arena_fixture_diamonds" numeric,
 CONSTRAINT "ca_diamond_snapshots_pkey" PRIMARY KEY (id)
);
ALTER TABLE public.ca_diamond_snapshots ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.poker_diamond_custody(
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "user_id" uuid NOT NULL,
 "arena_id" uuid NOT NULL,
 "purpose" text NOT NULL,
 "target_id" uuid NOT NULL,
 "entry_key" text NOT NULL,
 "balance" bigint DEFAULT 0 NOT NULL,
 "state" text DEFAULT 'reserved'::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "released_at" timestamp with time zone,
 "seat_id" uuid,
 "seat_joined_at" timestamp with time zone,
 "occupancy_id" uuid,
 CONSTRAINT "poker_diamond_custody_arena_id_fkey" FOREIGN KEY (arena_id) REFERENCES clubs(id) ON DELETE RESTRICT,
 CONSTRAINT "poker_diamond_custody_balance_check" CHECK (balance >= 0 AND balance <= 2147483647),
 CONSTRAINT "poker_diamond_custody_check" CHECK ((state = 'released'::text) = (released_at IS NOT NULL)),
 CONSTRAINT "poker_diamond_custody_check1" CHECK (state <> 'released'::text OR balance = 0),
 CONSTRAINT "poker_diamond_custody_entry_key_check" CHECK (length(entry_key) >= 1 AND length(entry_key) <= 160),
 CONSTRAINT "poker_diamond_custody_pkey" PRIMARY KEY (id),
 CONSTRAINT "poker_diamond_custody_purpose_check" CHECK (purpose = ANY (ARRAY['cash_seat'::text, 'tournament_entry'::text])),
 CONSTRAINT "poker_diamond_custody_state_check" CHECK (state = ANY (ARRAY['reserved'::text, 'active'::text, 'released'::text])),
 CONSTRAINT "poker_diamond_custody_user_id_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT,
 CONSTRAINT "poker_diamond_custody_user_id_purpose_target_id_entry_key_key" UNIQUE (user_id, purpose, target_id, entry_key),
 CONSTRAINT "poker_diamond_seat_identity_complete" CHECK (seat_id IS NULL AND seat_joined_at IS NULL AND occupancy_id IS NULL OR purpose = 'cash_seat'::text AND seat_id IS NOT NULL AND seat_joined_at IS NOT NULL AND occupancy_id IS NOT NULL)
);
ALTER TABLE public.poker_diamond_custody ENABLE ROW LEVEL SECURITY;
CREATE INDEX poker_diamond_custody_seat ON public.poker_diamond_custody USING btree (seat_id) WHERE (seat_id IS NOT NULL);
CREATE UNIQUE INDEX poker_diamond_one_open_entry ON public.poker_diamond_custody USING btree (user_id, purpose, target_id) WHERE (state <> 'released'::text);
CREATE INDEX poker_diamond_custody_arena ON public.poker_diamond_custody USING btree (arena_id);
CREATE INDEX poker_diamond_custody_user_state ON public.poker_diamond_custody USING btree (user_id, state);
CREATE UNIQUE INDEX poker_diamond_custody_occupancy ON public.poker_diamond_custody USING btree (occupancy_id) WHERE (occupancy_id IS NOT NULL);
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_moved bigint;
BEGIN
 -- OLD is only touched inside the UPDATE branch; a BEFORE/AFTER INSERT has none.
 IF TG_OP='UPDATE' THEN
   IF OLD.purpose='tournament_entry' OR NEW.purpose='tournament_entry' THEN
     IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.target_id IS DISTINCT FROM OLD.target_id
        OR NEW.arena_id IS DISTINCT FROM OLD.arena_id
        OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
        OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
       RAISE EXCEPTION 'A Diamond Tournament Entry Is Fixed To The Player And Event It Paid For'
         USING ERRCODE='P0815';
     END IF;
   END IF;
 END IF;
 IF NEW.purpose <> 'tournament_entry' THEN RETURN NULL; END IF;

 IF NEW.seat_id IS NOT NULL OR NEW.seat_joined_at IS NOT NULL OR NEW.occupancy_id IS NOT NULL THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Never Binds To A Seat' USING ERRCODE='P0813';
 END IF;

 SELECT COALESCE(sum(CASE WHEN m.action='reserve' THEN m.amount ELSE -m.amount END),0)
   INTO v_moved FROM public.poker_diamond_movements m WHERE m.custody_id=NEW.id;
 IF NEW.balance IS DISTINCT FROM v_moved THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Holds Only What Was Reserved For It'
     USING ERRCODE='P0814';
 END IF;

 RETURN NULL;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry() TO service_role;
CREATE CONSTRAINT TRIGGER zzz_diamond_entry_custody_is_the_entry AFTER INSERT OR UPDATE ON poker_diamond_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_entry_custody_is_the_entry();
