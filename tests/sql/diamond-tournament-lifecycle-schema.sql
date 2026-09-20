-- ============================================================================
-- THE DIAMOND TOURNAMENT LIFECYCLE FIXTURE: WHAT THE BASE STILL DOES NOT CARRY
-- ============================================================================
-- `diamond-tournament-fixture-schema.sql` adds the seven objects and three
-- columns the Diamond tournament DOORS read. This file adds the two relations
-- the trigger chain those doors FIRE writes into, and nothing else.
--
-- public.tournaments carries union_pnl_original_inventory in production, an
-- AFTER INSERT OR UPDATE OR DELETE observer that runs on EVERY tournament row
-- and takes no union filter, so a Diamond MTT insert reaches it. It calls
-- fn_union_pnl_original_frame, whose return type IS union_pnl_transaction_frames,
-- and writes one row into union_pnl_inventory_events.
--
-- Both statements are SLICED VERBATIM from the migration that created the
-- object in production. Nothing here is authored.
--
-- Sliced from, in this order:
--   20260917233148_union_pnl_inventory_preserves_original_boundaries.sql
--   20260917234315_union_weekly_pnl_uses_original_qualified_basis.sql
-- ============================================================================

-- Sliced from 20260917234315_union_weekly_pnl_uses_original_qualified_basis.sql.
CREATE TABLE public.union_pnl_transaction_frames (
 transaction_id xid8 PRIMARY KEY,
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
 book_start timestamptz NOT NULL
);

-- Sliced from 20260917233148_union_pnl_inventory_preserves_original_boundaries.sql.
CREATE TABLE public.union_pnl_inventory_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_name text NOT NULL CHECK(source_name IN ('union_clubs','tables','table_seats','tournaments','tournament_players')),
 row_id uuid NOT NULL,
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
 transaction_id xid8 NOT NULL,
 operation text NOT NULL CHECK(operation IN ('baseline','INSERT','UPDATE','DELETE')),
 before_row jsonb,
 after_row jsonb,
 CHECK(before_row IS NOT NULL OR after_row IS NOT NULL),
 CHECK((before_row IS NULL OR (jsonb_typeof(before_row)='object' AND before_row->>'id'=row_id::text)) IS TRUE),
 CHECK((after_row IS NULL OR (jsonb_typeof(after_row)='object' AND after_row->>'id'=row_id::text)) IS TRUE),
 CHECK((operation IN ('baseline','INSERT') AND before_row IS NULL AND after_row IS NOT NULL)
  OR (operation='UPDATE' AND before_row IS NOT NULL AND after_row IS NOT NULL)
  OR (operation='DELETE' AND before_row IS NOT NULL AND after_row IS NULL))
);
CREATE INDEX union_pnl_inventory_identity ON public.union_pnl_inventory_events(source_name,row_id,event_id DESC);
CREATE INDEX union_pnl_inventory_boundary ON public.union_pnl_inventory_events(observed_at,event_id);
ALTER TABLE public.union_pnl_inventory_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_inventory_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.union_pnl_inventory_events_event_id_seq FROM PUBLIC,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- WHAT public.tournaments STILL LACKS
-- ---------------------------------------------------------------------------
-- Four columns and four constraints. Every one was read read-only out of
-- production's own catalogue on 2026-09-20 and, where a migration on `main`
-- carries the statement, is sliced verbatim from it. They are here because the
-- trigger chain captured beside this file names them: a1_tournaments_restart_source
-- fires on restart_source_id, tournament_prize_math_contract fires on
-- payout_math_version and payout_unit_cents, and the capacity constraint is
-- what lets an unlimited MTT hold a NULL max_players at all.
-- ---------------------------------------------------------------------------

-- Sliced from 20260913195404_tournament_blinds_publish_as_one_field.sql.
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS blind_level_state jsonb;

-- payout_math_version and payout_unit_cents: production's installed column
-- definitions, read from pg_attribute and pg_attrdef on 2026-09-20
-- (smallint/integer, NOT NULL, DEFAULT 1 each). No migration on `main` carries
-- their ADD COLUMN; the estate's own
-- tests/fixtures/tournament-fee-sources/tournament-terminal-native-schema.sql
-- declares the same two columns for the same reason.
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS payout_math_version smallint NOT NULL DEFAULT 1;
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS payout_unit_cents integer NOT NULL DEFAULT 1;

-- Sliced from 20260917070000_mtt_dual_satellite_restart_preparation.sql.
ALTER TABLE public.tournaments ADD COLUMN restart_source_id uuid
 REFERENCES public.tournaments(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE UNIQUE INDEX tournaments_one_restart_per_source ON public.tournaments(restart_source_id)
 WHERE restart_source_id IS NOT NULL;

-- Sliced from 20260917060000_mtt_persisted_format_preparation.sql. The base
-- already carries format_contract (the B1 delta adds it); only the constraint
-- that bounds it is missing.
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_format_contract_known
CHECK(format_contract IS NULL OR format_contract IN
 ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1'));

-- Sliced from 20260917065000_mtt_dual_creation_preparation.sql, both statements,
-- in that file's order. max_players is nullable in production; an unlimited MTT
-- records its capacity in format_contract instead, and the constraint is what
-- says so.
ALTER TABLE public.tournaments ALTER COLUMN max_players DROP NOT NULL;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_recorded_entry_capacity CHECK (
 (format_contract IS NOT DISTINCT FROM 'mtt-v2' AND max_players IS NULL AND COALESCE(min_players,0)>=3)
 OR (format_contract IS DISTINCT FROM 'mtt-v2' AND COALESCE(max_players>0,false))
);
ALTER TABLE public.tournaments ADD CONSTRAINT tournament_prize_math_contract_valid CHECK (
 (payout_math_version=1 AND payout_unit_cents=1)
 OR (payout_math_version=2 AND payout_unit_cents IN(1,100)
   AND upper(COALESCE(tournament_type,''))='MTT'
   AND (COALESCE(max_players,0)>2 OR format_contract IS NOT DISTINCT FROM 'mtt-v2')
   AND lower(COALESCE(variant,'')) NOT IN ('spin','sng','satellite')
   AND NOT COALESCE(is_premium_spin,false)
   AND satellite_target_id IS NULL AND satellite_target IS NULL)
);

-- The reserve door counts the Diamonds a lot already has parked in the arena.
-- Sliced from 20260909065458_poker_diamond_custody.sql, with its own comment.
-- A reservation is not consumption. Refunds may reduce outstanding liability
-- below reserved value; the provider reversal then remains traceable as debt.
ALTER TABLE public.diamond_purchase_lots ADD COLUMN arena_reserved bigint NOT NULL DEFAULT 0
  CHECK (arena_reserved >= 0 AND arena_reserved <= issued);

DO $delta$
BEGIN
  IF to_regclass('public.union_pnl_transaction_frames') IS NULL
     OR to_regclass('public.union_pnl_inventory_events') IS NULL THEN
    RAISE EXCEPTION 'the lifecycle fixture delta did not install';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid='public.tournaments'::regclass
         AND attname IN ('blind_level_state','payout_math_version','payout_unit_cents','restart_source_id')) <> 4
     OR (SELECT count(*) FROM pg_constraint
          WHERE conrelid='public.tournaments'::regclass
            AND conname IN ('tournaments_format_contract_known','tournaments_recorded_entry_capacity',
                            'tournament_prize_math_contract_valid')) <> 3
     OR (SELECT attnotnull FROM pg_attribute
          WHERE attrelid='public.tournaments'::regclass AND attname='max_players')
     OR NOT EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid='public.diamond_purchase_lots'::regclass AND attname='arena_reserved') THEN
    RAISE EXCEPTION 'public.tournaments does not carry the columns and constraints production carries';
  END IF;
  RAISE NOTICE 'PASS: the Diamond tournament lifecycle delta is present';
END $delta$;
