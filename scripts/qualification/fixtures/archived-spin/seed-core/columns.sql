BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=public,extensions,pg_temp;
DO $isolation$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user NOT IN('fixture_bootstrap','postgres')
 OR current_database() NOT LIKE 'qual_spin_expiry_%'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_ISOLATION_REQUIRED'; END IF;
END $isolation$;


DO $empty$ BEGIN IF EXISTS(SELECT 1 FROM public.table_seats) THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_EMPTY_REQUIRED: public.table_seats'; END IF; END $empty$;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4() NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();

ALTER TABLE public.table_seats ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "table_id" uuid NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='table_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."table_id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "table_id" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "table_id" SET NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "seat_number" integer NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='seat_number') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."seat_number"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "seat_number" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "seat_number" SET NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "user_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='user_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."user_id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "user_id" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "player_id" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='player_id') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."player_id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "player_id" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "player_id" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "member_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='member_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."member_id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "member_id" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "member_id" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "stack" numeric(15,2) DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='stack') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."stack"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "stack" SET DEFAULT 0;

ALTER TABLE public.table_seats ALTER COLUMN "stack" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "is_sitting_out" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='is_sitting_out') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."is_sitting_out"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "is_sitting_out" SET DEFAULT false;

ALTER TABLE public.table_seats ALTER COLUMN "is_sitting_out" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "is_away" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='is_away') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."is_away"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "is_away" SET DEFAULT false;

ALTER TABLE public.table_seats ALTER COLUMN "is_away" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "joined_at" timestamp with time zone DEFAULT now();

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='joined_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."joined_at"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "joined_at" SET DEFAULT now();

ALTER TABLE public.table_seats ALTER COLUMN "joined_at" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "horse_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='horse_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."horse_id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "horse_id" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "horse_id" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "scheduled_leave_hands" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='scheduled_leave_hands') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."scheduled_leave_hands"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "scheduled_leave_hands" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "scheduled_leave_hands" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "left_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='left_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."left_at"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "left_at" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "left_at" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active'::text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='status') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."status"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "status" SET DEFAULT 'active'::text;

ALTER TABLE public.table_seats ALTER COLUMN "status" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "leave_pending" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='leave_pending') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."leave_pending"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "leave_pending" SET DEFAULT false;

ALTER TABLE public.table_seats ALTER COLUMN "leave_pending" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "auto_rebuy" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='auto_rebuy') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."auto_rebuy"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "auto_rebuy" SET DEFAULT false;

ALTER TABLE public.table_seats ALTER COLUMN "auto_rebuy" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "time_bank_remaining" integer DEFAULT 30;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='time_bank_remaining') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."time_bank_remaining"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "time_bank_remaining" SET DEFAULT 30;

ALTER TABLE public.table_seats ALTER COLUMN "time_bank_remaining" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "time_bank_uses_remaining" integer DEFAULT 4;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='time_bank_uses_remaining') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."time_bank_uses_remaining"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "time_bank_uses_remaining" SET DEFAULT 4;

ALTER TABLE public.table_seats ALTER COLUMN "time_bank_uses_remaining" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "club_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='club_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."club_id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "club_id" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "club_id" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "sit_out_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='sit_out_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."sit_out_at"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "sit_out_at" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "sit_out_at" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "entry_hold" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='entry_hold') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."entry_hold"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "entry_hold" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "entry_hold" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "entry_post_agreed" boolean DEFAULT false NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='entry_post_agreed') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."entry_post_agreed"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "entry_post_agreed" SET DEFAULT false;

ALTER TABLE public.table_seats ALTER COLUMN "entry_post_agreed" SET NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "occupancy_id" uuid DEFAULT gen_random_uuid() NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='occupancy_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."occupancy_id"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "occupancy_id" SET DEFAULT gen_random_uuid();

ALTER TABLE public.table_seats ALTER COLUMN "occupancy_id" SET NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "active_game_scope" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='active_game_scope') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."active_game_scope"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "active_game_scope" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "active_game_scope" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "active_parent_key" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='active_parent_key') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."active_parent_key"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "active_parent_key" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "active_parent_key" DROP NOT NULL;

ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS "terminal_closed_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.table_seats'::regclass AND attname='terminal_closed_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.table_seats."terminal_closed_at"'; END IF; END $type$;

ALTER TABLE public.table_seats ALTER COLUMN "terminal_closed_at" DROP DEFAULT;

ALTER TABLE public.table_seats ALTER COLUMN "terminal_closed_at" DROP NOT NULL;

DO $empty$ BEGIN IF EXISTS(SELECT 1 FROM public.tables) THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_EMPTY_REQUIRED: public.tables'; END IF; END $empty$;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."id"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE public.tables ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "club_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='club_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."club_id"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "club_id" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "club_id" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "name" text NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='name') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."name"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "name" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "game_type" text DEFAULT 'nlhe'::text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='game_type') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."game_type"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "game_type" SET DEFAULT 'nlhe'::text;

ALTER TABLE public.tables ALTER COLUMN "game_type" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "stakes" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='stakes') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."stakes"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "stakes" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "stakes" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "small_blind" numeric(15,2) DEFAULT 1;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='small_blind') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."small_blind"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "small_blind" SET DEFAULT 1;

ALTER TABLE public.tables ALTER COLUMN "small_blind" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "big_blind" numeric(15,2) DEFAULT 2;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='big_blind') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."big_blind"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "big_blind" SET DEFAULT 2;

ALTER TABLE public.tables ALTER COLUMN "big_blind" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "min_buy_in" numeric(15,2) DEFAULT 40;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='min_buy_in') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."min_buy_in"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "min_buy_in" SET DEFAULT 40;

ALTER TABLE public.tables ALTER COLUMN "min_buy_in" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "max_buy_in" numeric(15,2) DEFAULT 200;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='max_buy_in') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."max_buy_in"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "max_buy_in" SET DEFAULT 200;

ALTER TABLE public.tables ALTER COLUMN "max_buy_in" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "max_players" integer DEFAULT 9;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='max_players') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."max_players"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "max_players" SET DEFAULT 9;

ALTER TABLE public.tables ALTER COLUMN "max_players" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "current_players" integer DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='current_players') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."current_players"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "current_players" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "current_players" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'waiting'::text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='status') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."status"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "status" SET DEFAULT 'waiting'::text;

ALTER TABLE public.tables ALTER COLUMN "status" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "is_private" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='is_private') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."is_private"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "is_private" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "is_private" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "settings" jsonb DEFAULT '{}'::jsonb;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='settings') IS DISTINCT FROM 'jsonb' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."settings"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "settings" SET DEFAULT '{}'::jsonb;

ALTER TABLE public.tables ALTER COLUMN "settings" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='created_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."created_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "created_at" SET DEFAULT now();

ALTER TABLE public.tables ALTER COLUMN "created_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='updated_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."updated_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "updated_at" SET DEFAULT now();

ALTER TABLE public.tables ALTER COLUMN "updated_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "game_variant" text DEFAULT 'nlh'::text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='game_variant') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."game_variant"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "game_variant" SET DEFAULT 'nlh'::text;

ALTER TABLE public.tables ALTER COLUMN "game_variant" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "enable_straddle" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='enable_straddle') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."enable_straddle"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "enable_straddle" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "enable_straddle" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "run_it_twice" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='run_it_twice') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."run_it_twice"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "run_it_twice" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "run_it_twice" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "auto_muck" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='auto_muck') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."auto_muck"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "auto_muck" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "auto_muck" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "ante" numeric(15,2) DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='ante') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."ante"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "ante" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "ante" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "allow_rabbit_hunt" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='allow_rabbit_hunt') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."allow_rabbit_hunt"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "allow_rabbit_hunt" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "allow_rabbit_hunt" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "allow_run_it_twice" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='allow_run_it_twice') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."allow_run_it_twice"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "allow_run_it_twice" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "allow_run_it_twice" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "allow_straddle" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='allow_straddle') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."allow_straddle"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "allow_straddle" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "allow_straddle" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "game_mode" character varying(10) DEFAULT 'regular'::character varying;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='game_mode') IS DISTINCT FROM 'character varying(10)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."game_mode"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "game_mode" SET DEFAULT 'regular'::character varying;

ALTER TABLE public.tables ALTER COLUMN "game_mode" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "is_vip_only" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='is_vip_only') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."is_vip_only"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "is_vip_only" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "is_vip_only" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "is_anonymous" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='is_anonymous') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."is_anonymous"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "is_anonymous" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "is_anonymous" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "ban_chat" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='ban_chat') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."ban_chat"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "ban_chat" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "ban_chat" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "label_as_new" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='label_as_new') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."label_as_new"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "label_as_new" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "label_as_new" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "is_featured" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='is_featured') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."is_featured"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "is_featured" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "is_featured" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "hide_club_name" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='hide_club_name') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."hide_club_name"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "hide_club_name" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "hide_club_name" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "is_template" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='is_template') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."is_template"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "is_template" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "is_template" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "double_board" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='double_board') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."double_board"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "double_board" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "double_board" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "triple_board" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='triple_board') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."triple_board"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "triple_board" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "triple_board" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "pineapple_holdem" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='pineapple_holdem') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."pineapple_holdem"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "pineapple_holdem" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "pineapple_holdem" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "seven_deuce_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='seven_deuce_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."seven_deuce_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "seven_deuce_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "seven_deuce_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "nit_game" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='nit_game') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."nit_game"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "nit_game" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "nit_game" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "cap_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='cap_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."cap_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "cap_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "cap_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "no_rathole" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='no_rathole') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."no_rathole"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "no_rathole" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "no_rathole" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "action_time_seconds" integer DEFAULT 15;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='action_time_seconds') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."action_time_seconds"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "action_time_seconds" SET DEFAULT 15;

ALTER TABLE public.tables ALTER COLUMN "action_time_seconds" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "ante_bb" numeric(10,2) DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='ante_bb') IS DISTINCT FROM 'numeric(10,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."ante_bb"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "ante_bb" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "ante_bb" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "career_percent_min" integer DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='career_percent_min') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."career_percent_min"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "career_percent_min" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "career_percent_min" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "maintain_percent_min" integer DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='maintain_percent_min') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."maintain_percent_min"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "maintain_percent_min" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "maintain_percent_min" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "maintain_hands" integer DEFAULT 10;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='maintain_hands') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."maintain_hands"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "maintain_hands" SET DEFAULT 10;

ALTER TABLE public.tables ALTER COLUMN "maintain_hands" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "auto_start_players" integer DEFAULT 2;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='auto_start_players') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."auto_start_players"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "auto_start_players" SET DEFAULT 2;

ALTER TABLE public.tables ALTER COLUMN "auto_start_players" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "game_length_hours" integer DEFAULT 12;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='game_length_hours') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."game_length_hours"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "game_length_hours" SET DEFAULT 12;

ALTER TABLE public.tables ALTER COLUMN "game_length_hours" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "created_by" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='created_by') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."created_by"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "created_by" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "created_by" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "calltime_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='calltime_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."calltime_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "calltime_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "calltime_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "auto_extension" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='auto_extension') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."auto_extension"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "auto_extension" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "auto_extension" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "auto_restart" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='auto_restart') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."auto_restart"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "auto_restart" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "auto_restart" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "auto_create_table" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='auto_create_table') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."auto_create_table"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "auto_create_table" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "auto_create_table" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "auto_utg_straddle" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='auto_utg_straddle') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."auto_utg_straddle"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "auto_utg_straddle" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "auto_utg_straddle" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "voluntary_straddle" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='voluntary_straddle') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."voluntary_straddle"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "voluntary_straddle" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "voluntary_straddle" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "insurance_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='insurance_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."insurance_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "insurance_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "insurance_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "run_it_mode" character varying(20) DEFAULT 'none'::character varying;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='run_it_mode') IS DISTINCT FROM 'character varying(20)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."run_it_mode"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "run_it_mode" SET DEFAULT 'none'::character varying;

ALTER TABLE public.tables ALTER COLUMN "run_it_mode" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "rake_percent" numeric(5,2) DEFAULT '-1'::integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='rake_percent') IS DISTINCT FROM 'numeric(5,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."rake_percent"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "rake_percent" SET DEFAULT '-1'::integer;

ALTER TABLE public.tables ALTER COLUMN "rake_percent" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "rake_cap_bb" numeric(5,2) DEFAULT '-1'::integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='rake_cap_bb') IS DISTINCT FROM 'numeric(5,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."rake_cap_bb"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "rake_cap_bb" SET DEFAULT '-1'::integer;

ALTER TABLE public.tables ALTER COLUMN "rake_cap_bb" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "agent_downline_limit" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='agent_downline_limit') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."agent_downline_limit"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "agent_downline_limit" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "agent_downline_limit" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "buy_in_authorization" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='buy_in_authorization') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."buy_in_authorization"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "buy_in_authorization" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "buy_in_authorization" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "restrict_device" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='restrict_device') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."restrict_device"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "restrict_device" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "restrict_device" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "restrict_observers" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='restrict_observers') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."restrict_observers"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "restrict_observers" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "restrict_observers" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "gps_restriction" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='gps_restriction') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."gps_restriction"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "gps_restriction" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "gps_restriction" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "ip_restriction" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='ip_restriction') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."ip_restriction"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "ip_restriction" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "ip_restriction" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "pc_emulator_restriction" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='pc_emulator_restriction') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."pc_emulator_restriction"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "pc_emulator_restriction" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "pc_emulator_restriction" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "photo_rotation_verification" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='photo_rotation_verification') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."photo_rotation_verification"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "photo_rotation_verification" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "photo_rotation_verification" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "short_description" text DEFAULT ''::text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='short_description') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."short_description"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "short_description" SET DEFAULT ''::text;

ALTER TABLE public.tables ALTER COLUMN "short_description" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "accelerated_mtt" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='accelerated_mtt') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."accelerated_mtt"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "accelerated_mtt" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "accelerated_mtt" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "all_in_or_fold" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='all_in_or_fold') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."all_in_or_fold"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "all_in_or_fold" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "all_in_or_fold" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "custom_rebuy_reentry_cost" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='custom_rebuy_reentry_cost') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."custom_rebuy_reentry_cost"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "custom_rebuy_reentry_cost" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "custom_rebuy_reentry_cost" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "number_of_rebuys_reentries" integer DEFAULT 3;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='number_of_rebuys_reentries') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."number_of_rebuys_reentries"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "number_of_rebuys_reentries" SET DEFAULT 3;

ALTER TABLE public.tables ALTER COLUMN "number_of_rebuys_reentries" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "add_on_multiplier" numeric(3,1) DEFAULT 1.0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='add_on_multiplier') IS DISTINCT FROM 'numeric(3,1)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."add_on_multiplier"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "add_on_multiplier" SET DEFAULT 1.0;

ALTER TABLE public.tables ALTER COLUMN "add_on_multiplier" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "custom_add_on" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='custom_add_on') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."custom_add_on"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "custom_add_on" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "custom_add_on" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "add_on_break_length_minutes" integer DEFAULT 1;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='add_on_break_length_minutes') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."add_on_break_length_minutes"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "add_on_break_length_minutes" SET DEFAULT 1;

ALTER TABLE public.tables ALTER COLUMN "add_on_break_length_minutes" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "ko_bounty" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='ko_bounty') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."ko_bounty"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "ko_bounty" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "ko_bounty" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "gtd_prize_pool" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='gtd_prize_pool') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."gtd_prize_pool"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "gtd_prize_pool" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "gtd_prize_pool" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "final_table_deal" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='final_table_deal') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."final_table_deal"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "final_table_deal" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "final_table_deal" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "big_blind_ante" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='big_blind_ante') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."big_blind_ante"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "big_blind_ante" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "big_blind_ante" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "authorized_to_register" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='authorized_to_register') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."authorized_to_register"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "authorized_to_register" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "authorized_to_register" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "late_registration_level" integer DEFAULT 6;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='late_registration_level') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."late_registration_level"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "late_registration_level" SET DEFAULT 6;

ALTER TABLE public.tables ALTER COLUMN "late_registration_level" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "early_bird_registration" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='early_bird_registration') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."early_bird_registration"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "early_bird_registration" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "early_bird_registration" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bubble_protection" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bubble_protection') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bubble_protection"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bubble_protection" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "bubble_protection" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "featured_tournament" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='featured_tournament') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."featured_tournament"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "featured_tournament" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "featured_tournament" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "min_players_mtt" integer DEFAULT 30;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='min_players_mtt') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."min_players_mtt"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "min_players_mtt" SET DEFAULT 30;

ALTER TABLE public.tables ALTER COLUMN "min_players_mtt" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "max_players_mtt" integer DEFAULT 300;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='max_players_mtt') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."max_players_mtt"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "max_players_mtt" SET DEFAULT 300;

ALTER TABLE public.tables ALTER COLUMN "max_players_mtt" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "multi_day_mtt" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='multi_day_mtt') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."multi_day_mtt"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "multi_day_mtt" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "multi_day_mtt" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "save_start_time" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='save_start_time') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."save_start_time"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "save_start_time" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "save_start_time" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "start_time" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='start_time') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."start_time"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "start_time" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "start_time" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "restart_tournament_every" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='restart_tournament_every') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."restart_tournament_every"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "restart_tournament_every" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "restart_tournament_every" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "tournament_schedule" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='tournament_schedule') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."tournament_schedule"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "tournament_schedule" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "tournament_schedule" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "synchronized_breaks" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='synchronized_breaks') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."synchronized_breaks"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "synchronized_breaks" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "synchronized_breaks" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "sng_buy_in" numeric(10,2) DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='sng_buy_in') IS DISTINCT FROM 'numeric(10,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."sng_buy_in"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "sng_buy_in" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "sng_buy_in" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "blind_structure" character varying(20) DEFAULT 'standard'::character varying;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='blind_structure') IS DISTINCT FROM 'character varying(20)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."blind_structure"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "blind_structure" SET DEFAULT 'standard'::character varying;

ALTER TABLE public.tables ALTER COLUMN "blind_structure" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "payout_structure" character varying(50) DEFAULT 'winner_takes_all'::character varying;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='payout_structure') IS DISTINCT FROM 'character varying(50)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."payout_structure"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "payout_structure" SET DEFAULT 'winner_takes_all'::character varying;

ALTER TABLE public.tables ALTER COLUMN "payout_structure" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "starting_chips" integer DEFAULT 1500;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='starting_chips') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."starting_chips"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "starting_chips" SET DEFAULT 1500;

ALTER TABLE public.tables ALTER COLUMN "starting_chips" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "blinds_up_minutes" integer DEFAULT 10;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='blinds_up_minutes') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."blinds_up_minutes"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "blinds_up_minutes" SET DEFAULT 10;

ALTER TABLE public.tables ALTER COLUMN "blinds_up_minutes" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "next_step_satellite" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='next_step_satellite') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."next_step_satellite"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "next_step_satellite" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "next_step_satellite" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "sng_custom_buy_in" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='sng_custom_buy_in') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."sng_custom_buy_in"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "sng_custom_buy_in" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "sng_custom_buy_in" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "sng_player_count" integer DEFAULT 9;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='sng_player_count') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."sng_player_count"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "sng_player_count" SET DEFAULT 9;

ALTER TABLE public.tables ALTER COLUMN "sng_player_count" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "is_spins" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='is_spins') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."is_spins"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "is_spins" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "is_spins" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "spins_multiplier" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='spins_multiplier') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."spins_multiplier"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "spins_multiplier" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "spins_multiplier" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "is_deleted" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='is_deleted') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."is_deleted"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "is_deleted" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "is_deleted" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='deleted_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."deleted_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "deleted_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "deleted_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "deleted_by" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='deleted_by') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."deleted_by"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "deleted_by" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "deleted_by" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bbj_percent" numeric(5,2) DEFAULT 100;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bbj_percent') IS DISTINCT FROM 'numeric(5,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bbj_percent"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bbj_percent" SET DEFAULT 100;

ALTER TABLE public.tables ALTER COLUMN "bbj_percent" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "tournament_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='tournament_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."tournament_id"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "tournament_id" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "tournament_id" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "live_state" jsonb;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='live_state') IS DISTINCT FROM 'jsonb' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."live_state"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "live_state" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "live_state" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "union_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='union_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."union_id"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "union_id" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "union_id" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "big_blind_ante_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='big_blind_ante_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."big_blind_ante_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "big_blind_ante_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "big_blind_ante_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "straddle_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='straddle_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."straddle_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "straddle_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "straddle_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "straddle_type" text DEFAULT 'utg'::text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='straddle_type') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."straddle_type"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "straddle_type" SET DEFAULT 'utg'::text;

ALTER TABLE public.tables ALTER COLUMN "straddle_type" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "max_straddles" integer DEFAULT 1;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='max_straddles') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."max_straddles"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "max_straddles" SET DEFAULT 1;

ALTER TABLE public.tables ALTER COLUMN "max_straddles" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "run_it_twice_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='run_it_twice_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."run_it_twice_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "run_it_twice_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "run_it_twice_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "auto_muck_enabled" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='auto_muck_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."auto_muck_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "auto_muck_enabled" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "auto_muck_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "show_hand_enabled" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='show_hand_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."show_hand_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "show_hand_enabled" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "show_hand_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "disconnect_timeout_seconds" integer DEFAULT 30;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='disconnect_timeout_seconds') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."disconnect_timeout_seconds"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "disconnect_timeout_seconds" SET DEFAULT 30;

ALTER TABLE public.tables ALTER COLUMN "disconnect_timeout_seconds" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "max_consecutive_timeouts" integer DEFAULT 3;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='max_consecutive_timeouts') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."max_consecutive_timeouts"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "max_consecutive_timeouts" SET DEFAULT 3;

ALTER TABLE public.tables ALTER COLUMN "max_consecutive_timeouts" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "prefer_check_over_fold" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='prefer_check_over_fold') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."prefer_check_over_fold"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "prefer_check_over_fold" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "prefer_check_over_fold" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "time_bank_max_uses" integer DEFAULT 4;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='time_bank_max_uses') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."time_bank_max_uses"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "time_bank_max_uses" SET DEFAULT 4;

ALTER TABLE public.tables ALTER COLUMN "time_bank_max_uses" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "time_bank_enabled" boolean DEFAULT true;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='time_bank_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."time_bank_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "time_bank_enabled" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "time_bank_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "ante_enabled" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='ante_enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."ante_enabled"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "ante_enabled" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "ante_enabled" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_frequency" integer DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_frequency') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_frequency"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_frequency" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_frequency" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_ante_multiplier" integer DEFAULT 2;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_ante_multiplier') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_ante_multiplier"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_ante_multiplier" SET DEFAULT 2;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_ante_multiplier" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "wait_for_big_blind" boolean DEFAULT true NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='wait_for_big_blind') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."wait_for_big_blind"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "wait_for_big_blind" SET DEFAULT true;

ALTER TABLE public.tables ALTER COLUMN "wait_for_big_blind" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "seven_deuce_amount" numeric DEFAULT 2 NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='seven_deuce_amount') IS DISTINCT FROM 'numeric' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."seven_deuce_amount"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "seven_deuce_amount" SET DEFAULT 2;

ALTER TABLE public.tables ALTER COLUMN "seven_deuce_amount" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "hands_dealt" bigint DEFAULT 0 NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='hands_dealt') IS DISTINCT FROM 'bigint' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."hands_dealt"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "hands_dealt" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "hands_dealt" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "avg_pot" numeric(14,2) DEFAULT 0 NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='avg_pot') IS DISTINCT FROM 'numeric(14,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."avg_pot"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "avg_pot" SET DEFAULT 0;

ALTER TABLE public.tables ALTER COLUMN "avg_pot" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_double_board" boolean DEFAULT false NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_double_board') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_double_board"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_double_board" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_double_board" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "cap_bb" numeric(10,2);

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='cap_bb') IS DISTINCT FROM 'numeric(10,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."cap_bb"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "cap_bb" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "cap_bb" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_board_count" smallint DEFAULT 1 NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_board_count') IS DISTINCT FROM 'smallint' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_board_count"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_board_count" SET DEFAULT 1;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_board_count" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_trigger_mode" text DEFAULT 'every_n_hands'::text NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_trigger_mode') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_trigger_mode"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_trigger_mode" SET DEFAULT 'every_n_hands'::text;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_trigger_mode" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_interval_seconds" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_interval_seconds') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_interval_seconds"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_interval_seconds" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_interval_seconds" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_min_players" smallint DEFAULT 3 NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_min_players') IS DISTINCT FROM 'smallint' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_min_players"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_min_players" SET DEFAULT 3;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_min_players" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_ante_fixed" numeric;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_ante_fixed') IS DISTINCT FROM 'numeric' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_ante_fixed"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_ante_fixed" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_ante_fixed" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "first_button_seat" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='first_button_seat') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."first_button_seat"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "first_button_seat" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "first_button_seat" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_variant" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_variant') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_variant"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_variant" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_variant" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_next_due_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_next_due_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_next_due_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_next_due_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_next_due_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_sched_state" jsonb;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_sched_state') IS DISTINCT FROM 'jsonb' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_sched_state"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_sched_state" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_sched_state" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_manual_pending" boolean DEFAULT false NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_manual_pending') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_manual_pending"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_manual_pending" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_manual_pending" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_button_policy" text DEFAULT 'regular'::text NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_button_policy') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_button_policy"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_button_policy" SET DEFAULT 'regular'::text;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_button_policy" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "bomb_pot_announce_seconds" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='bomb_pot_announce_seconds') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."bomb_pot_announce_seconds"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_announce_seconds" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "bomb_pot_announce_seconds" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "min_buy_in_bb" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='min_buy_in_bb') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."min_buy_in_bb"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "min_buy_in_bb" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "max_buy_in_bb" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='max_buy_in_bb') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."max_buy_in_bb"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "max_buy_in_bb" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "min_buyin" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='min_buyin') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."min_buyin"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "min_buyin" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "max_buyin" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='max_buyin') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."max_buyin"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "max_buyin" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "cluster_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='cluster_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."cluster_id"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "cluster_id" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "cluster_id" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "role" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='role') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."role"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "role" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "main_index" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='main_index') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."main_index"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "main_index" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "main_index" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "lifecycle" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='lifecycle') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."lifecycle"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "lifecycle" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "lifecycle" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='opened_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."opened_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "opened_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "opened_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "live_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='live_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."live_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "live_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "live_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "break_started_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='break_started_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."break_started_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "break_started_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "break_started_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "break_eligible_since" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='break_eligible_since') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."break_eligible_since"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "break_eligible_since" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "break_eligible_since" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "promote_pending" boolean DEFAULT false NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='promote_pending') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."promote_pending"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "promote_pending" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "promote_pending" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "observer_show_cards" boolean DEFAULT false NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='observer_show_cards') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."observer_show_cards"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "observer_show_cards" SET DEFAULT false;

ALTER TABLE public.tables ALTER COLUMN "observer_show_cards" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "terminal_closed_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='terminal_closed_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."terminal_closed_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "terminal_closed_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "terminal_closed_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "seat_game_scope" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='seat_game_scope') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."seat_game_scope"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "seat_game_scope" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "seat_game_scope" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "seat_admission_key" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='seat_admission_key') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."seat_admission_key"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "seat_admission_key" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "seat_admission_key" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "f06_lifecycle" bigint DEFAULT smarter_private.f06_new_lifecycle() NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='f06_lifecycle') IS DISTINCT FROM 'bigint' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."f06_lifecycle"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "f06_lifecycle" SET DEFAULT smarter_private.f06_new_lifecycle();

ALTER TABLE public.tables ALTER COLUMN "f06_lifecycle" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "dealing_halted_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='dealing_halted_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."dealing_halted_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "dealing_halted_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "dealing_halted_at" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "dealing_halted_reason" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='dealing_halted_reason') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."dealing_halted_reason"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "dealing_halted_reason" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "dealing_halted_reason" DROP NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "kill_mode" text DEFAULT 'off'::text NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='kill_mode') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."kill_mode"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "kill_mode" SET DEFAULT 'off'::text;

ALTER TABLE public.tables ALTER COLUMN "kill_mode" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "kill_threshold_bb" smallint DEFAULT 10 NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='kill_threshold_bb') IS DISTINCT FROM 'smallint' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."kill_threshold_bb"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "kill_threshold_bb" SET DEFAULT 10;

ALTER TABLE public.tables ALTER COLUMN "kill_threshold_bb" SET NOT NULL;

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS "dealing_halt_observed_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attname='dealing_halt_observed_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tables."dealing_halt_observed_at"'; END IF; END $type$;

ALTER TABLE public.tables ALTER COLUMN "dealing_halt_observed_at" DROP DEFAULT;

ALTER TABLE public.tables ALTER COLUMN "dealing_halt_observed_at" DROP NOT NULL;

DO $empty$ BEGIN IF EXISTS(SELECT 1 FROM public.tournament_players) THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_EMPTY_REQUIRED: public.tournament_players'; END IF; END $empty$;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."id"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE public.tournament_players ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "tournament_id" uuid NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='tournament_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."tournament_id"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "tournament_id" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "tournament_id" SET NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "user_id" uuid NOT NULL;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='user_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."user_id"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "user_id" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "user_id" SET NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "username" text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='username') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."username"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "username" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "username" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "chips" integer DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='chips') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."chips"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "chips" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "chips" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'registered'::text;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='status') IS DISTINCT FROM 'text' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."status"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "status" SET DEFAULT 'registered'::text;

ALTER TABLE public.tournament_players ALTER COLUMN "status" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "position" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='position') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."position"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "position" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "position" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "prize" numeric(15,2) DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='prize') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."prize"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "prize" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "prize" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "rebuys" integer DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='rebuys') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."rebuys"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "rebuys" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "rebuys" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "add_on" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='add_on') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."add_on"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "add_on" SET DEFAULT false;

ALTER TABLE public.tournament_players ALTER COLUMN "add_on" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "registered_at" timestamp with time zone DEFAULT now();

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='registered_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."registered_at"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "registered_at" SET DEFAULT now();

ALTER TABLE public.tournament_players ALTER COLUMN "registered_at" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "eliminated_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='eliminated_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."eliminated_at"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "eliminated_at" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "eliminated_at" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "bounties_collected" integer DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='bounties_collected') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."bounties_collected"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "bounties_collected" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "bounties_collected" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "bounty_winnings" numeric(15,2) DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='bounty_winnings') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."bounty_winnings"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "bounty_winnings" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "bounty_winnings" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "mystery_bounty_value" numeric(15,2) DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='mystery_bounty_value') IS DISTINCT FROM 'numeric(15,2)' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."mystery_bounty_value"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "mystery_bounty_value" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "mystery_bounty_value" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "current_bounty" numeric DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='current_bounty') IS DISTINCT FROM 'numeric' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."current_bounty"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "current_bounty" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "current_bounty" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "table_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='table_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."table_id"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "table_id" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "table_id" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "seat_number" integer;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='seat_number') IS DISTINCT FROM 'integer' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."seat_number"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "seat_number" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "seat_number" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "chip_count" numeric DEFAULT 0;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='chip_count') IS DISTINCT FROM 'numeric' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."chip_count"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "chip_count" SET DEFAULT 0;

ALTER TABLE public.tournament_players ALTER COLUMN "chip_count" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "club_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='club_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."club_id"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "club_id" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "club_id" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "is_satellite_qualifier" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='is_satellite_qualifier') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."is_satellite_qualifier"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "is_satellite_qualifier" SET DEFAULT false;

ALTER TABLE public.tournament_players ALTER COLUMN "is_satellite_qualifier" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "rebuy_prompt_until" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='rebuy_prompt_until') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."rebuy_prompt_until"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "rebuy_prompt_until" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "rebuy_prompt_until" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "push_15m_sent" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='push_15m_sent') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."push_15m_sent"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "push_15m_sent" SET DEFAULT false;

ALTER TABLE public.tournament_players ALTER COLUMN "push_15m_sent" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "push_2m_sent" boolean DEFAULT false;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='push_2m_sent') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."push_2m_sent"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "push_2m_sent" SET DEFAULT false;

ALTER TABLE public.tournament_players ALTER COLUMN "push_2m_sent" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "source_satellite_id" uuid;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='source_satellite_id') IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."source_satellite_id"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "source_satellite_id" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "source_satellite_id" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "elimination_sequence" bigint;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='elimination_sequence') IS DISTINCT FROM 'bigint' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."elimination_sequence"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "elimination_sequence" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "elimination_sequence" DROP NOT NULL;

ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS "terminal_closed_at" timestamp with time zone;

DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.tournament_players'::regclass AND attname='terminal_closed_at') IS DISTINCT FROM 'timestamp with time zone' THEN RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: public.tournament_players."terminal_closed_at"'; END IF; END $type$;

ALTER TABLE public.tournament_players ALTER COLUMN "terminal_closed_at" DROP DEFAULT;

ALTER TABLE public.tournament_players ALTER COLUMN "terminal_closed_at" DROP NOT NULL;
COMMIT;
