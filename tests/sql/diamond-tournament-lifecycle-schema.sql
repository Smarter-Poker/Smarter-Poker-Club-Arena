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

-- ---------------------------------------------------------------------------
-- WHAT THE BASE LACKS FOR THE PHASE 9 FORMATS AND TODAY'S INSERT CHAIN
-- ---------------------------------------------------------------------------
-- Added 2026-09-29, when the create door began admitting satellites and
-- Spins. Every production tournament insert now records its acceptance
-- (trg_tournaments_record_acceptance, 20260924025555), which reads the
-- capability registry and writes one acceptance row; a Diamond Spin is created
-- against its authorized reserve source and pins its multiplier table in a
-- contract row (20260929163000). Sliced verbatim, statement by statement; the
-- contract table's immutability trigger is attached beside its captured
-- function in the lifecycle capture.
-- ---------------------------------------------------------------------------

-- Sliced from 20260924025555_one_capability_registry_and_accepted_event_continuation.sql.
CREATE TABLE public.platform_capabilities (
  capability_id      text PRIMARY KEY
                     CHECK (capability_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  rule_version       text NOT NULL CHECK (btrim(rule_version) <> ''),
  title              text NOT NULL CHECK (btrim(title) <> '' AND strpos(title, chr(8212)) = 0),
  scope              text NOT NULL
                     CHECK (scope IN ('platform','club','union','cash_table','tournament')),
  supported_variants text[] NOT NULL DEFAULT '{}',
  compatibility      jsonb NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(compatibility) = 'object'),
  readiness          text NOT NULL
                     CHECK (readiness IN ('excluded','planned','implemented','tested','deployed','production_verified')),
  readiness_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(readiness_evidence) = 'object'),
  revision           bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- An available rung is a claim about what is running; it carries its proof.
  CONSTRAINT platform_capabilities_available_carries_evidence
    CHECK (readiness NOT IN ('deployed','production_verified') OR readiness_evidence <> '{}'::jsonb)
);

-- Sliced from 20260924025555_one_capability_registry_and_accepted_event_continuation.sql.
CREATE TABLE public.accepted_event_operations (
  event_kind          text NOT NULL CHECK (event_kind IN ('tournament')),
  event_id            uuid NOT NULL,
  parent_event_id     uuid NULL,
  club_id             uuid NULL,
  union_id            uuid NULL,
  accepted_at         timestamptz NOT NULL,
  accepted_by         uuid NULL,
  authorization_basis jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(authorization_basis) = 'object'),
  capability_versions jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(capability_versions) = 'object'),
  continuation        text NOT NULL DEFAULT 'through_conclusion'
                      CHECK (continuation IN ('through_conclusion')),
  concluded_at        timestamptz NULL,
  conclusion          text NULL CHECK (conclusion IN ('completed','cancelled')),
  PRIMARY KEY (event_kind, event_id),
  CONSTRAINT accepted_event_operations_conclusion_is_whole
    CHECK ((concluded_at IS NULL) = (conclusion IS NULL))
);

CREATE INDEX accepted_event_operations_parent_idx
  ON public.accepted_event_operations (event_kind, parent_event_id)
  WHERE parent_event_id IS NOT NULL;
ALTER TABLE public.platform_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accepted_event_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_capabilities FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.accepted_event_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.platform_capabilities TO service_role;
GRANT SELECT ON TABLE public.accepted_event_operations TO service_role;

-- Sliced from 20260929163000_a_diamond_spin_draws_a_whole_prize.sql.
CREATE TABLE public.poker_diamond_spin_reserve_source (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_account text NOT NULL CHECK (source_account = 'diamond_house'),
  max_underwrite_per_spin bigint NOT NULL
    CHECK (max_underwrite_per_spin >= 1 AND max_underwrite_per_spin <= 2147483647),
  authorized_by text NOT NULL CHECK (length(btrim(authorized_by)) >= 2),
  ruling text NOT NULL CHECK (length(btrim(ruling)) >= 10),
  authorized_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.poker_diamond_spin_reserve_source IS
  'DIAMOND SPIN RESERVE SOURCE (Phase 9). One row or none, written by a values migration that quotes Dan, never by code. '
  'It names the Diamond account that underwrites a Spin prize pool above its three entries and receives the entries above a '
  'smaller pool (the only account the draw can move against today: the house, ca_diamond_house), and the most one Spin may '
  'take from it. No row: every Diamond Spin is refused at creation and at the draw (diamond_spin_reserve_source_not_authorized). '
  'CLAUDE.md 10.9: the source and the number are Dan''s.';
ALTER TABLE public.poker_diamond_spin_reserve_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.poker_diamond_spin_reserve_source FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.poker_diamond_spin_reserve_source TO service_role;

-- Sliced from 20260929163000_a_diamond_spin_draws_a_whole_prize.sql.
CREATE TABLE public.poker_diamond_spin_contracts (
  -- No foreign key: adding one takes a lock that stops every tournament write
  -- for the length of this migration. The creation door writes the contract
  -- in the same transaction as its tournament, and a tournament is never
  -- deleted.
  tournament_id uuid PRIMARY KEY,
  buy_in bigint NOT NULL CHECK (buy_in >= 1 AND buy_in <= 2147483647),
  starting_chips integer NOT NULL CHECK (starting_chips >= 1),
  rake_rate numeric NOT NULL CHECK (rake_rate >= 0 AND rake_rate < 1),
  rule_manifest jsonb NOT NULL CHECK (jsonb_typeof(rule_manifest) = 'object'),
  rule_sha256 text NOT NULL CHECK (rule_sha256 ~ '^[0-9a-f]{64}$'),
  worst_excess bigint NOT NULL CHECK (worst_excess >= 0),
  required_cover bigint NOT NULL CHECK (required_cover >= worst_excess),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
COMMENT ON TABLE public.poker_diamond_spin_contracts IS
  'DIAMOND SPIN CONTRACT (Phase 9). The multiplier table a Diamond Spin was created with, validated by '
  'fn_poker_diamond_spin_contract at its buy-in and pinned by sha256. The draw rolls over this table and nothing else; '
  'the engine''s compiled manifest cannot change it. worst_excess is the most the source can pay into the pool above the '
  'three entries; required_cover is what the source must hold for every tier to be drawable (the pool above the entries, '
  'and a tier''s reserve threshold times its pool - the chip reserve gate, with the event''s own buy-in as its stake).';
ALTER TABLE public.poker_diamond_spin_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.poker_diamond_spin_contracts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.poker_diamond_spin_contracts TO service_role;

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
          WHERE attrelid='public.diamond_purchase_lots'::regclass AND attname='arena_reserved')
     OR to_regclass('public.platform_capabilities') IS NULL
     OR to_regclass('public.accepted_event_operations') IS NULL
     OR to_regclass('public.poker_diamond_spin_reserve_source') IS NULL
     OR to_regclass('public.poker_diamond_spin_contracts') IS NULL THEN
    RAISE EXCEPTION 'public.tournaments does not carry the columns and constraints production carries';
  END IF;
  RAISE NOTICE 'PASS: the Diamond tournament lifecycle delta is present';
END $delta$;
