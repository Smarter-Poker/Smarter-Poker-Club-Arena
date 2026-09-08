-- 20260908153239_tournament_cancellation_commits_one_stored_receipt
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 03:44:40 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- The engine's legacy cancellation helper made one RPC per refund, inserted
-- each fee reversal separately, then issued independent player and table
-- updates. A timeout between any two statements left a terminal tournament
-- carrying only some refunds or still-open rows. Its retry candidate set was
-- itself changed by those partial commits, so replay could not reconstruct the
-- original decision.
--
-- atomic_cancel_tournament already owns the correct evidence rules (entry,
-- rebuy and add-on debits; satellite seat funding; the two aggregate Spin fee
-- writers) and all of its work is one PostgreSQL transaction. This migration
-- makes that existing door replayable: the tournament row is locked first, a
-- complete per-player disposition receipt is persisted only after direct
-- charges return as exact source-wallet chips, while satellite-funded seats
-- and already-spent entry tickets return as tournament-entry-only tickets,
-- fees reverse and all three closeouts
-- succeed. A retry returns those exact immutable bytes. Every chip refund must
-- report fully_settled and every seat ticket must equal its funded entitlement;
-- otherwise an exception rolls the entire call back. The function signature
-- and service-role ACL remain in place for rolling deploy compatibility.
--
-- The managed-game command door had a second terminal writer: when no player
-- had registered, fn_close_managed_game wrote CANCELLED and closed tables
-- directly. That write has no exact cancellation receipt, and its supported
-- caller locked the tournament row before reaching the global terminal lock.
-- This migration therefore republishes both layers. Tournament close commands
-- acquire the terminal lock before their first tournament row lock, retain the
-- registered-player refusal, and call atomic_cancel_tournament in the same
-- transaction. The cash-table branch is copied unchanged. The atomic owner now
-- uses fn_can_create_games so a union-authorized operator is accepted while an
-- affiliated club operator remains fail-closed; its RPC stays service-role-only.
--
-- No tournament is cancelled or backfilled by this migration.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- Drain every preexisting status writer before replacing the old AFTER
-- trigger. Cancellation owns its money movement explicitly below; no reactive
-- status hook may race it or return a reserve draw a second time.
LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE;

DO $prerequisites$
DECLARE
  v_cancel_source text;
  v_settle_source text;
  v_ticket_source text;
BEGIN
  IF to_regclass('public.ca_settle_sources') IS NULL THEN
    RAISE EXCEPTION 'platform settlement-source registry is missing';
  END IF;

  IF to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'atomic cancellation authority is missing';
  END IF;
  IF to_regprocedure('public.fn_can_create_games(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_close_managed_game(text,uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)')
          IS NULL THEN
    RAISE EXCEPTION 'governed managed-game cancellation door is missing';
  END IF;
  SELECT pg_get_functiondef(
           to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)'))
    INTO v_cancel_source;
  IF v_cancel_source NOT LIKE '%fn_spin_book_entry%'
     OR v_cancel_source NOT LIKE '%fn_spin_settle_game%'
     OR v_cancel_source NOT LIKE '%source_satellite_id%' THEN
    RAISE EXCEPTION
      'atomic cancellation does not contain the current satellite and aggregate Spin safeguards';
  END IF;

  IF to_regprocedure(
       'public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)')
       IS NULL
     OR to_regclass('public.tournament_refund_entitlements') IS NULL
     OR to_regclass('public.tournament_refund_tranches') IS NULL
     OR to_regprocedure(
          'public.fn_ca_return_satellite_entitlement_as_ticket(uuid,text,text)')
          IS NULL
     OR to_regclass('public.spin_reserve_ledger') IS NULL
     OR to_regclass('public.spin_bonus_pools') IS NULL THEN
    RAISE EXCEPTION 'exact refund or Spin reserve authority is missing';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(
           'public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)'))
    INTO v_settle_source;
  IF v_settle_source NOT LIKE '%tournament_refund_tranches%'
     OR v_settle_source NOT LIKE '%tournament_refund_entitlements%'
     OR v_settle_source NOT LIKE '%entitlement_id%'
     OR v_settle_source NOT LIKE '%refund_prize%'
     OR v_settle_source NOT LIKE '%refund_bounty%'
     OR v_settle_source NOT LIKE '%refund_fee%' THEN
    RAISE EXCEPTION
      'exact refund authority cannot prove component rails';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(
    'public.fn_ca_return_satellite_entitlement_as_ticket(uuid,text,text)'))
    INTO v_ticket_source;
  IF v_ticket_source NOT LIKE '%tournament_entry_only%'
     OR v_ticket_source NOT LIKE '%source_refund_entitlement_id%'
     OR v_ticket_source NOT LIKE '%fn_ca_escrow_apply_exact_refund%'
     OR v_ticket_source LIKE '%player_wallet%' THEN
    RAISE EXCEPTION 'satellite cancellation return is not a ticket-only authority';
  END IF;
END;
$prerequisites$;

DROP TRIGGER IF EXISTS zz_ca_spin_cancel_returns_draw ON public.tournaments;
DROP FUNCTION IF EXISTS public.fn_ca_spin_cancel_returns_draw() RESTRICT;

ALTER TABLE public.spin_reserve_ledger
  DROP CONSTRAINT IF EXISTS spin_reserve_ledger_kind_check;
ALTER TABLE public.spin_reserve_ledger
  ADD CONSTRAINT spin_reserve_ledger_kind_check
  CHECK (kind = ANY (ARRAY[
    'seed','contribution','jackpot_draw','surplus_return',
    'adjustment','merge','wallet_return','seed_return','activation',
    'deactivation','draw_reversal','contribution_reversal'
  ]));

-- A refund is paid through the obligation authority, whose fail-closed source
-- registry must recognize the caller before it can move chips. Claim the
-- existing legacy registration only when it has the known predecessor note;
-- any unrelated row using this authority name aborts the cutover.
DO $own_settle_source$
DECLARE
  c_source constant text := 'atomic_cancel_tournament';
  c_note constant text :=
    '20260908153239: atomic cancellation receipt authority';
  v_note text;
BEGIN
  SELECT s.note INTO v_note
    FROM public.ca_settle_sources s
   WHERE s.source = c_source
   FOR UPDATE;
  IF FOUND AND v_note NOT IN ('DB caller', c_note) THEN
    RAISE EXCEPTION
      'settlement source % is already owned by unexpected note %',
      c_source, v_note USING ERRCODE = 'P0404';
  END IF;

  IF FOUND THEN
    UPDATE public.ca_settle_sources
       SET note = c_note
     WHERE source = c_source AND note = v_note;
  ELSE
    -- DO NOTHING keeps a concurrently claimed name intact; the exact proof
    -- below then refuses the migration instead of overwriting its owner.
    INSERT INTO public.ca_settle_sources(source,note)
    VALUES(c_source,c_note)
    ON CONFLICT(source) DO NOTHING;
  END IF;

  IF (SELECT count(*)
        FROM public.ca_settle_sources s
       WHERE s.source = c_source AND s.note = c_note) <> 1 THEN
    RAISE EXCEPTION 'atomic cancellation settlement source was not registered exactly'
      USING ERRCODE = 'P0404';
  END IF;
END;
$own_settle_source$;

CREATE UNIQUE INDEX uq_spin_one_draw_reversal_per_game
  ON public.spin_reserve_ledger(tournament_id)
  WHERE kind = 'draw_reversal';
CREATE UNIQUE INDEX uq_spin_one_contribution_reversal_per_game
  ON public.spin_reserve_ledger(tournament_id)
  WHERE kind = 'contribution_reversal';

-- All four reserve movements require the journal leg that changed the bank.
-- Reversal rows point back to the original immutable contract through their
-- copied economic fields and deterministic keys.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_row_requires_exact_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $reserve_evidence$
DECLARE
  v_pool_id uuid;
  v_count integer;
  v_key text;
  v_category text;
  v_from_type text;
  v_from_id uuid;
  v_to_type text;
  v_to_id uuid;
  v_original public.spin_reserve_ledger%ROWTYPE;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.kind NOT IN (
       'contribution','jackpot_draw','draw_reversal',
       'contribution_reversal') THEN
    RETURN NEW;
  END IF;
  IF NEW.amount IS NULL
     OR NEW.amount::text IN ('NaN','Infinity','-Infinity')
     OR NEW.amount IS DISTINCT FROM round(NEW.amount,2)
     OR NEW.balance_after IS NULL
     OR NEW.balance_after::text IN ('NaN','Infinity','-Infinity')
     OR NEW.balance_after IS DISTINCT FROM round(NEW.balance_after,2) THEN
    RAISE EXCEPTION 'Spin reserve evidence has invalid money'
      USING ERRCODE = '23514';
  END IF;
  SELECT p.id INTO v_pool_id FROM public.spin_bonus_pools p
   WHERE p.club_id = NEW.club_id;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'Spin reserve row has no pool for owner %',NEW.club_id
      USING ERRCODE = 'P0404';
  END IF;

  IF NEW.kind IN ('contribution','jackpot_draw') THEN
    IF NEW.buy_in IS NULL OR NEW.buy_in <= 0
       OR NEW.seats IS DISTINCT FROM 3
       OR (NEW.kind = 'contribution' AND (
            NEW.amount <= 0 OR NEW.house_rake IS NULL OR NEW.house_rake < 0
            OR NEW.amount IS DISTINCT FROM
                 round(NEW.buy_in*3-NEW.house_rake,2)))
       OR (NEW.kind = 'jackpot_draw' AND (
            NEW.amount >= 0 OR NEW.multiplier IS NULL OR NEW.multiplier <= 0
            OR round(-NEW.amount,2) IS DISTINCT FROM
                 round(NEW.buy_in*NEW.multiplier,2))) THEN
      RAISE EXCEPTION 'Spin % violates its exact funded contract',NEW.kind
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO v_original FROM public.spin_reserve_ledger r
     WHERE r.tournament_id = NEW.tournament_id
       AND r.kind = CASE WHEN NEW.kind = 'draw_reversal'
                         THEN 'jackpot_draw' ELSE 'contribution' END
     FOR SHARE;
    IF v_original.id IS NULL
       OR v_original.club_id IS DISTINCT FROM NEW.club_id
       OR NEW.buy_in IS DISTINCT FROM v_original.buy_in
       OR NEW.seats IS DISTINCT FROM v_original.seats
       OR NEW.house_rake IS DISTINCT FROM v_original.house_rake
       OR NEW.multiplier IS DISTINCT FROM v_original.multiplier
       OR NEW.amount IS DISTINCT FROM -v_original.amount
       OR (NEW.kind = 'draw_reversal' AND NEW.amount <= 0)
       OR (NEW.kind = 'contribution_reversal' AND NEW.amount >= 0) THEN
      RAISE EXCEPTION 'Spin % does not reverse one exact original row',NEW.kind
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_key := 'spin:' || NEW.tournament_id::text || CASE NEW.kind
    WHEN 'contribution' THEN ':entry'
    WHEN 'jackpot_draw' THEN ':draw'
    WHEN 'draw_reversal' THEN ':cancel:draw'
    ELSE ':cancel:entry' END;
  v_category := CASE NEW.kind
    WHEN 'contribution' THEN 'spin_entry'
    WHEN 'jackpot_draw' THEN 'spin_prize'
    ELSE 'reversal' END;
  v_from_type := CASE NEW.kind
    WHEN 'contribution' THEN 'prize_liability'
    WHEN 'draw_reversal' THEN 'prize_liability'
    ELSE 'spin_reserve' END;
  v_from_id := CASE WHEN v_from_type = 'prize_liability'
                    THEN NEW.tournament_id ELSE v_pool_id END;
  v_to_type := CASE WHEN v_from_type = 'prize_liability'
                    THEN 'spin_reserve' ELSE 'prize_liability' END;
  v_to_id := CASE WHEN v_to_type = 'prize_liability'
                  THEN NEW.tournament_id ELSE v_pool_id END;

  SELECT count(*) INTO v_count FROM public.chip_ledger l
   WHERE l.category = v_category
     AND l.from_type = v_from_type AND l.from_entity_id = v_from_id
     AND l.to_type = v_to_type AND l.to_entity_id = v_to_id
     AND l.tournament_id = NEW.tournament_id
     AND (l.idempotency_key = v_key
          OR (NEW.kind = 'jackpot_draw' AND l.idempotency_key IS NULL))
     AND l.amount = abs(NEW.amount)
     AND CASE WHEN NEW.amount > 0
              THEN l.post_to_balance IS NOT DISTINCT FROM NEW.balance_after
              ELSE l.post_from_balance IS NOT DISTINCT FROM NEW.balance_after END;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Spin % requires one exact journal leg; found %',
      NEW.kind,v_count USING ERRCODE = 'P0404';
  END IF;
  RETURN NEW;
END;
$reserve_evidence$;

CREATE OR REPLACE FUNCTION public.fn_spin_reserve_receipt_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $immutable_reserve$
BEGIN
  IF OLD.kind IN (
       'contribution','jackpot_draw','draw_reversal',
       'contribution_reversal') THEN
    RAISE EXCEPTION 'Spin reserve receipt % (%) is immutable',OLD.id,OLD.kind
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$immutable_reserve$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_row_requires_exact_journal(),
  public.fn_spin_reserve_receipt_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.tournament_spin_cancellation_unwinds (
  tournament_id uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  pool_id uuid NOT NULL
    REFERENCES public.spin_bonus_pools(id) ON DELETE RESTRICT,
  reserve_owner_id uuid NOT NULL,
  original_contribution_id uuid NOT NULL UNIQUE
    REFERENCES public.spin_reserve_ledger(id) ON DELETE RESTRICT,
  original_draw_id uuid UNIQUE
    REFERENCES public.spin_reserve_ledger(id) ON DELETE RESTRICT,
  original_entry_journal_id uuid NOT NULL UNIQUE
    REFERENCES public.chip_ledger(id) ON DELETE RESTRICT,
  original_draw_journal_id uuid UNIQUE
    REFERENCES public.chip_ledger(id) ON DELETE RESTRICT,
  draw_reversal_id uuid UNIQUE
    REFERENCES public.spin_reserve_ledger(id) ON DELETE RESTRICT,
  draw_reversal_journal_id uuid UNIQUE
    REFERENCES public.chip_ledger(id) ON DELETE RESTRICT,
  contribution_reversal_id uuid NOT NULL UNIQUE
    REFERENCES public.spin_reserve_ledger(id) ON DELETE RESTRICT,
  contribution_reversal_journal_id uuid NOT NULL UNIQUE
    REFERENCES public.chip_ledger(id) ON DELETE RESTRICT,
  contribution_amount numeric(15,2) NOT NULL,
  draw_amount numeric(15,2) NOT NULL,
  pool_balance_before numeric(15,2) NOT NULL,
  pool_balance_after numeric(15,2) NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (contribution_amount::text NOT IN ('NaN','Infinity','-Infinity')
     AND contribution_amount > 0
     AND contribution_amount = round(contribution_amount,2)),
  CHECK (draw_amount::text NOT IN ('NaN','Infinity','-Infinity')
     AND draw_amount >= 0 AND draw_amount = round(draw_amount,2)),
  CHECK (pool_balance_before::text NOT IN ('NaN','Infinity','-Infinity')
     AND pool_balance_after::text NOT IN ('NaN','Infinity','-Infinity')
     AND pool_balance_before >= 0 AND pool_balance_after >= 0),
  CHECK (pool_balance_after =
         round(pool_balance_before + draw_amount - contribution_amount,2)),
  CHECK ((draw_amount = 0 AND original_draw_id IS NULL
          AND original_draw_journal_id IS NULL
          AND draw_reversal_id IS NULL
          AND draw_reversal_journal_id IS NULL)
      OR (draw_amount > 0 AND original_draw_id IS NOT NULL
          AND original_draw_journal_id IS NOT NULL
          AND draw_reversal_id IS NOT NULL
          AND draw_reversal_journal_id IS NOT NULL))
);
ALTER TABLE public.tournament_spin_cancellation_unwinds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_spin_cancellation_unwinds
  FROM PUBLIC, anon, authenticated, service_role;

-- The published draw stays immutable while a Spin is live. The sole terminal
-- exception is an exact zeroing performed after the reserve unwind receipt is
-- already durable in the same transaction.
CREATE OR REPLACE FUNCTION public.fn_spin_tournament_contract_is_draw()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $spin_contract$
DECLARE
  v_count integer;
  v_multiplier numeric;
  v_prize numeric;
  v_old_sealed boolean;
BEGIN
  IF NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.prize_pool IS NOT DISTINCT FROM OLD.prize_pool
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant,'')) <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.status::text,'')) IN ('CANCELLED','CANCELED')
     AND upper(COALESCE(OLD.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     AND NEW.prize_pool IS NOT DISTINCT FROM 0::numeric
     AND NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers
     AND (
       (NOT EXISTS (
          SELECT 1 FROM public.spin_reserve_ledger r
           WHERE r.tournament_id = NEW.id
             AND r.kind IN ('contribution','jackpot_draw')))
       OR EXISTS (
          SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
           WHERE u.tournament_id = NEW.id)) THEN
    RETURN NEW;
  END IF;

  SELECT count(*),min(r.multiplier),min(round(-r.amount,2))
    INTO v_count,v_multiplier,v_prize
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = NEW.id AND r.kind = 'jackpot_draw';
  IF v_count <> 1
     OR NEW.spin_multiplier IS DISTINCT FROM v_multiplier
     OR NEW.prize_pool IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION 'Spin % tournament contract must equal its reserve draw',NEW.id
      USING ERRCODE = 'P0404';
  END IF;
  v_old_sealed := OLD.spin_multiplier IS NOT DISTINCT FROM v_multiplier
                  AND OLD.prize_pool IS NOT DISTINCT FROM v_prize
                  AND OLD.spin_locked_tiers IS NOT NULL;
  IF v_old_sealed THEN
    RAISE EXCEPTION 'Spin % published draw contract is immutable',NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$spin_contract$;

REVOKE ALL ON FUNCTION public.fn_spin_tournament_contract_is_draw()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.tournament_cancellation_receipts (
  tournament_id   uuid PRIMARY KEY
                       REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  actor_id        uuid NOT NULL,
  receipt_version integer NOT NULL DEFAULT 2 CHECK (receipt_version = 2),
  source_player_count integer NOT NULL CHECK (source_player_count >= 0),
  source_player_ids uuid[] NOT NULL,
  refunded_count integer NOT NULL CHECK (refunded_count >= 0),
  refunded_registration_ids uuid[] NOT NULL,
  refund_line_count integer NOT NULL CHECK (refund_line_count >= 0),
  ticket_return_count integer NOT NULL CHECK (ticket_return_count >= 0),
  ticket_return_ids uuid[] NOT NULL,
  total_ticket_returned numeric(15,2) NOT NULL
    CHECK (total_ticket_returned::text NOT IN ('NaN','Infinity','-Infinity')
       AND total_ticket_returned >= 0
       AND total_ticket_returned = round(total_ticket_returned,2)),
  zero_refund_count integer NOT NULL CHECK (zero_refund_count >= 0),
  zero_refund_registration_ids uuid[] NOT NULL,
  total_refunded numeric(15,2) NOT NULL
                       CHECK (total_refunded::text NOT IN ('NaN','Infinity','-Infinity')
                          AND total_refunded >= 0
                          AND total_refunded = round(total_refunded, 2)),
  fees_reversed  numeric(15,2) NOT NULL
                       CHECK (fees_reversed::text NOT IN ('NaN','Infinity','-Infinity')
                          AND fees_reversed >= 0 AND fees_reversed = round(fees_reversed, 2)
                              AND fees_reversed <=
                                  total_refunded+total_ticket_returned),
  total_rake_before numeric(15,2) NOT NULL,
  total_rake_after numeric(15,2) NOT NULL,
  closed_table_count integer NOT NULL CHECK (closed_table_count >= 0),
  closed_table_ids uuid[] NOT NULL,
  source_seat_count integer NOT NULL CHECK (source_seat_count >= 0),
  source_seat_ids uuid[] NOT NULL,
  released_seat_count integer NOT NULL CHECK (released_seat_count >= 0),
  released_seat_ids uuid[] NOT NULL,
  fee_reversal_ids uuid[] NOT NULL,
  escrow_closed_at timestamptz NOT NULL,
  escrow_close_note text NOT NULL CHECK (length(btrim(escrow_close_note)) > 0),
  spin_unwind_tournament_id uuid UNIQUE
    REFERENCES public.tournament_spin_cancellation_unwinds(tournament_id)
    ON DELETE RESTRICT,
  receipt        jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  settled_at     timestamptz NOT NULL,
  CHECK (source_player_count = cardinality(source_player_ids)),
  CHECK (refunded_count = cardinality(refunded_registration_ids)),
  CHECK (ticket_return_count = cardinality(ticket_return_ids)),
  CHECK (zero_refund_count = cardinality(zero_refund_registration_ids)),
  CHECK (source_player_count = refunded_count + zero_refund_count),
  CHECK (refunded_registration_ids && zero_refund_registration_ids IS FALSE),
  CHECK (refunded_registration_ids || zero_refund_registration_ids <@ source_player_ids),
  CHECK (closed_table_count = cardinality(closed_table_ids)),
  CHECK (source_seat_count = cardinality(source_seat_ids)),
  CHECK (released_seat_count = cardinality(released_seat_ids)),
  CHECK (released_seat_ids <@ source_seat_ids),
  CHECK (array_position(source_player_ids,NULL) IS NULL),
  CHECK (array_position(refunded_registration_ids,NULL) IS NULL),
  CHECK (array_position(ticket_return_ids,NULL) IS NULL),
  CHECK (array_position(zero_refund_registration_ids,NULL) IS NULL),
  CHECK (array_position(closed_table_ids,NULL) IS NULL),
  CHECK (array_position(source_seat_ids,NULL) IS NULL),
  CHECK (array_position(released_seat_ids,NULL) IS NULL),
  CHECK (array_position(fee_reversal_ids,NULL) IS NULL),
  CHECK (total_rake_before::text NOT IN ('NaN','Infinity','-Infinity')
     AND total_rake_after::text NOT IN ('NaN','Infinity','-Infinity')
     AND total_rake_before >= 0 AND total_rake_after = 0
     AND total_rake_before = fees_reversed),
  CHECK (escrow_closed_at = settled_at),
  CHECK ((spin_unwind_tournament_id IS NULL)
      OR spin_unwind_tournament_id = tournament_id),
  CHECK ((receipt->>'tournament_id')::uuid IS NOT DISTINCT FROM tournament_id),
  CHECK ((receipt->>'actor_id')::uuid IS NOT DISTINCT FROM actor_id),
  CHECK ((receipt->>'receipt_version')::integer IS NOT DISTINCT FROM receipt_version),
  CHECK ((receipt->>'source_player_count')::integer IS NOT DISTINCT FROM source_player_count),
  CHECK ((receipt->>'refunded_count')::integer IS NOT DISTINCT FROM refunded_count),
  CHECK ((receipt->>'refund_line_count')::integer IS NOT DISTINCT FROM refund_line_count),
  CHECK ((receipt->>'ticket_return_count')::integer IS NOT DISTINCT FROM ticket_return_count),
  CHECK ((receipt->>'total_ticket_returned')::numeric IS NOT DISTINCT FROM total_ticket_returned),
  CHECK ((receipt->>'total_refunded')::numeric IS NOT DISTINCT FROM total_refunded),
  CHECK ((receipt->>'fees_reversed')::numeric IS NOT DISTINCT FROM fees_reversed),
  CHECK ((receipt->>'closed_table_count')::integer IS NOT DISTINCT FROM closed_table_count),
  CHECK ((receipt->>'source_seat_count')::integer IS NOT DISTINCT FROM source_seat_count),
  CHECK ((receipt->>'released_seat_count')::integer IS NOT DISTINCT FROM released_seat_count),
  CHECK ((receipt->>'settled_at')::timestamptz IS NOT DISTINCT FROM settled_at),
  CHECK (receipt->>'status' IS NOT DISTINCT FROM 'CANCELLED'),
  CHECK ((receipt->>'ok')::boolean IS TRUE),
  CHECK ((receipt->>'success')::boolean IS TRUE),
  CHECK ((receipt->>'fully_settled')::boolean IS TRUE),
  CHECK (jsonb_typeof(receipt->'refunds') IS NOT DISTINCT FROM 'array'),
  CHECK (jsonb_array_length(receipt->'refunds') = refund_line_count),
  CHECK (jsonb_typeof(receipt->'ticket_returns') IS NOT DISTINCT FROM 'array'),
  CHECK (jsonb_array_length(receipt->'ticket_returns') = ticket_return_count)
);

ALTER TABLE public.tournament_cancellation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_cancellation_receipts
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.tournament_cancellation_receipts IS
  'Immutable terminal proof that evidence-derived refunds, fee reversals and tournament/player/table closeout committed in one atomic_cancel_tournament call.';

CREATE OR REPLACE FUNCTION public.fn_tournament_cancellation_receipts_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $append_only$
BEGIN
  RAISE EXCEPTION
    'tournament cancellation receipt is immutable; % refused for tournament %',
    TG_OP, OLD.tournament_id USING ERRCODE = '55000';
END;
$append_only$;

REVOKE ALL ON FUNCTION public.fn_tournament_cancellation_receipts_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_cancellation_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_cancellation_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_cancellation_receipts_append_only();
CREATE TRIGGER tournament_spin_cancellation_unwinds_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_spin_cancellation_unwinds
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_cancellation_receipts_append_only();

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(
  p_tournament_id uuid,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','pg_temp'
SET statement_timeout TO '120s'
AS $cancel$
DECLARE
  v_uid uuid := auth.uid();
  v_actor uuid := COALESCE(
    auth.uid(),p_admin_id,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_t public.tournaments%ROWTYPE;
  v_stored public.tournament_cancellation_receipts%ROWTYPE;
  v_e public.tournament_escrow%ROWTYPE;
  v_player record;
  v_entitlement public.tournament_refund_entitlements%ROWTYPE;
  v_fee record;
  v_contribution public.spin_reserve_ledger%ROWTYPE;
  v_draw public.spin_reserve_ledger%ROWTYPE;
  v_pool public.spin_bonus_pools%ROWTYPE;
  v_settle jsonb;
  v_ticket jsonb;
  v_receipt jsonb;
  v_refunds jsonb := '[]'::jsonb;
  v_ticket_returns jsonb := '[]'::jsonb;
  v_source_player_ids uuid[] := ARRAY[]::uuid[];
  v_refunded_registration_ids uuid[] := ARRAY[]::uuid[];
  v_ticket_return_ids uuid[] := ARRAY[]::uuid[];
  v_zero_refund_registration_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_fee_reversal_ids uuid[] := ARRAY[]::uuid[];
  v_registration_id uuid;
  v_fee_reversal_id uuid;
  v_original_entry_journal_id uuid;
  v_original_draw_journal_id uuid;
  v_draw_reversal_id uuid;
  v_draw_reversal_journal_id uuid;
  v_contribution_reversal_id uuid;
  v_contribution_reversal_journal_id uuid;
  v_spin_unwind_id uuid;
  v_source_player_count integer := 0;
  v_refunded_count integer := 0;
  v_refund_line_count integer := 0;
  v_ticket_return_count integer := 0;
  v_zero_refund_count integer := 0;
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_total_refunded numeric := 0;
  v_total_ticket_returned numeric := 0;
  v_fees_reversed numeric := 0;
  v_total_rake_before numeric := 0;
  v_total_rake_after numeric := 0;
  v_total_owed numeric;
  v_draw_amount numeric := 0;
  v_pool_balance_before numeric;
  v_pool_balance_after numeric;
  v_rows integer;
  v_journal_count integer;
  v_cancelled_at timestamptz := transaction_timestamp();
  v_close_note constant text := 'atomic cancellation receipt: exact zero';
BEGIN
  -- Every terminal authority takes this lock before any row lock. Cancellation,
  -- satellite finish and cash finish can touch the same wallets and event rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Tournament id is required' USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NOT NULL
     AND NOT public.fn_can_create_games(v_t.club_id,v_uid) THEN
    RAISE EXCEPTION 'Only the governed game operator may cancel a tournament'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stored FROM public.tournament_cancellation_receipts h
   WHERE h.tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,NULL);
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
    RAISE EXCEPTION 'Tournament is already %',v_t.status USING ERRCODE='55000';
  END IF;

  -- Freeze every identity before any payer runs. Any concurrent registration,
  -- seat move or hand settlement either committed before these locks and is in
  -- the receipt, or waits behind this transaction and sees a terminal parent.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats s
   JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
   ORDER BY s.table_id,s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[])
    INTO v_source_player_ids FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  v_source_player_count := cardinality(v_source_player_ids);
  v_closed_table_count := cardinality(v_closed_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'atomic cancellation escrow prelock');
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_t.prize_pool IS DISTINCT FROM v_e.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_e.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_e.fee_balance THEN
    RAISE EXCEPTION 'tournament % caches do not equal exact escrow before cancellation',
      p_tournament_id USING ERRCODE='P0404';
  END IF;

  -- A booked Spin first gives back its draw, then withdraws this event's own
  -- contribution. Each pool movement creates its strict journal before the
  -- matching immutable reversal row and all four ids are stored together.
  PERFORM 1 FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id ORDER BY r.created_at,r.id FOR UPDATE;
  SELECT * INTO v_contribution FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id AND r.kind='contribution';
  IF FOUND THEN
    IF (SELECT count(*) FROM public.spin_reserve_ledger r
         WHERE r.tournament_id=p_tournament_id AND r.kind='contribution') <> 1
       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind IN ('draw_reversal','contribution_reversal'))
       OR EXISTS (SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
                   WHERE u.tournament_id=p_tournament_id) THEN
      RAISE EXCEPTION 'Spin % has an ambiguous or partially unwound reserve contract',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_draw FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw';
    IF FOUND AND (SELECT count(*) FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind='jackpot_draw') <> 1 THEN
      RAISE EXCEPTION 'Spin % has more than one immutable draw',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_pool FROM public.spin_bonus_pools p
     WHERE p.club_id=v_contribution.club_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % original reserve owner is missing',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    v_pool_balance_before := v_pool.balance;
    IF v_pool_balance_before IS NULL
       OR v_pool_balance_before::text IN ('NaN','Infinity','-Infinity')
       OR v_pool_balance_before<0 THEN
      RAISE EXCEPTION 'Spin % reserve balance is invalid',p_tournament_id
        USING ERRCODE='22003';
    END IF;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_original_entry_journal_id
      FROM public.chip_ledger l
     WHERE l.tournament_id=p_tournament_id
       AND l.category='spin_entry'
       AND l.from_type='prize_liability'
       AND l.from_entity_id=p_tournament_id
       AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 OR v_contribution.amount<=0 THEN
      RAISE EXCEPTION 'Spin % contribution has no single exact journal',p_tournament_id
        USING ERRCODE='P0404';
    END IF;

    IF v_draw.id IS NOT NULL THEN
      IF v_draw.club_id IS DISTINCT FROM v_contribution.club_id
         OR v_draw.amount>=0 THEN
        RAISE EXCEPTION 'Spin % draw disagrees with its contribution owner',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      v_draw_amount := round(-v_draw.amount,2);
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_original_draw_journal_id
        FROM public.chip_ledger l
       WHERE l.tournament_id=p_tournament_id
         AND l.category='spin_prize'
         AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
         AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      PERFORM public.fn_ca_declare_ledger(
        'reversal','prize_liability',p_tournament_id,NULL,
        'spin:'||p_tournament_id::text||':cancel:draw',NULL);
      UPDATE public.spin_bonus_pools
         SET balance=balance+v_draw_amount,updated_at=now()
       WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Spin % reserve vanished during draw reversal',p_tournament_id
          USING ERRCODE='40001';
      END IF;
      INSERT INTO public.spin_reserve_ledger
        (club_id,tournament_id,kind,amount,balance_after,multiplier,
         buy_in,seats,house_rake,note)
      VALUES
        (v_draw.club_id,p_tournament_id,'draw_reversal',v_draw_amount,
         v_pool_balance_after,v_draw.multiplier,v_draw.buy_in,v_draw.seats,
         v_draw.house_rake,'atomic cancellation reversed the exact reserve draw')
      RETURNING id INTO v_draw_reversal_id;
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_draw_reversal_journal_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:draw'
         AND l.tournament_id=p_tournament_id AND l.category='reversal'
         AND l.from_type='prize_liability' AND l.from_entity_id=p_tournament_id
         AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw reversal has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
    ELSE
      v_pool_balance_after := v_pool_balance_before;
    END IF;

    IF v_pool_balance_after<v_contribution.amount THEN
      RAISE EXCEPTION 'Spin % reserve cannot return its own contribution',p_tournament_id
        USING ERRCODE='P0403';
    END IF;
    PERFORM public.fn_ca_declare_ledger(
      'reversal','prize_liability',p_tournament_id,NULL,
      'spin:'||p_tournament_id::text||':cancel:entry',NULL);
    UPDATE public.spin_bonus_pools
       SET balance=balance-v_contribution.amount,updated_at=now()
     WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % reserve vanished during contribution reversal',p_tournament_id
        USING ERRCODE='40001';
    END IF;
    INSERT INTO public.spin_reserve_ledger
      (club_id,tournament_id,kind,amount,balance_after,multiplier,
       buy_in,seats,house_rake,note)
    VALUES
      (v_contribution.club_id,p_tournament_id,'contribution_reversal',
       -v_contribution.amount,v_pool_balance_after,v_contribution.multiplier,
       v_contribution.buy_in,v_contribution.seats,v_contribution.house_rake,
       'atomic cancellation returned the exact entry contribution')
    RETURNING id INTO v_contribution_reversal_id;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_contribution_reversal_journal_id
      FROM public.chip_ledger l
     WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:entry'
       AND l.tournament_id=p_tournament_id AND l.category='reversal'
       AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
       AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 THEN
      RAISE EXCEPTION 'Spin % contribution reversal has no single exact journal',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    INSERT INTO public.tournament_spin_cancellation_unwinds(
      tournament_id,pool_id,reserve_owner_id,
      original_contribution_id,original_draw_id,
      original_entry_journal_id,original_draw_journal_id,
      draw_reversal_id,draw_reversal_journal_id,
      contribution_reversal_id,contribution_reversal_journal_id,
      contribution_amount,draw_amount,pool_balance_before,pool_balance_after,
      settled_at)
    VALUES(
      p_tournament_id,v_pool.id,v_contribution.club_id,
      v_contribution.id,v_draw.id,
      v_original_entry_journal_id,v_original_draw_journal_id,
      v_draw_reversal_id,v_draw_reversal_journal_id,
      v_contribution_reversal_id,v_contribution_reversal_journal_id,
      v_contribution.amount,v_draw_amount,v_pool_balance_before,
      v_pool_balance_after,v_cancelled_at)
    RETURNING tournament_id INTO v_spin_unwind_id;
  ELSIF EXISTS (
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('jackpot_draw','draw_reversal','contribution_reversal')) THEN
    RAISE EXCEPTION 'Spin % has reserve evidence without its contribution',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  -- Consume one immutable entitlement at a time. Wallet charges go back as
  -- chips to their exact source club. A satellite-funded seat or spent entry
  -- ticket is not chips: it becomes a tournament-entry-only ticket carrying
  -- the same immutable rails and original satellite identity.
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
    JOIN public.tournament_tickets tk
      ON tk.source_refund_entitlement_id=e.id
   WHERE e.tournament_id=p_tournament_id
     AND tp.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'active qualifier roster already has an unreceipted return ticket'
      USING ERRCODE='P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id
   WHERE e.tournament_id=p_tournament_id
     AND (tp.id IS NULL OR (e.entitlement_kind IN (
            'satellite_seat','tournament_ticket')
          AND e.registration_id IS DISTINCT FROM tp.id))) THEN
    RAISE EXCEPTION 'refund entitlement is detached from the frozen roster'
      USING ERRCODE='P0404';
  END IF;
  FOR v_player IN
    SELECT DISTINCT ON (tp.user_id) tp.id,tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
     ORDER BY tp.user_id,tp.id
  LOOP
    -- The owner-only plan validates every source ledger, wallet debit and
    -- escrow rail. Identity comes from the locked entitlement table below.
    PERFORM 1 FROM public.fn_ca_tournament_refund_plan(
      p_tournament_id,v_player.user_id);
    LOOP
      SELECT e.* INTO v_entitlement
        FROM public.tournament_refund_entitlements e
       WHERE e.tournament_id=p_tournament_id
         AND e.user_id=v_player.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_tranches tr
            WHERE tr.entitlement_id=e.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_tickets tk
            WHERE tk.source_refund_entitlement_id=e.id)
       ORDER BY e.entitlement_kind,e.id
       LIMIT 1 FOR UPDATE OF e;
      EXIT WHEN NOT FOUND;
      v_registration_id:=COALESCE(v_entitlement.registration_id,v_player.id);
      IF v_entitlement.entitlement_kind='wallet_charge' THEN
        SELECT COALESCE(o.amount_paid,0)+v_entitlement.gross
          INTO v_total_owed FROM public.tournament_obligations o
         WHERE o.tournament_id=p_tournament_id AND o.kind='refund'
           AND o.place IS NULL AND o.user_id=v_player.user_id FOR UPDATE;
        IF NOT FOUND THEN v_total_owed:=v_entitlement.gross; END IF;
        v_settle:=public.fn_settle_tournament_refund_exact(
          p_tournament_id,v_player.user_id,
          v_entitlement.refund_wallet_club_id,v_total_owed,
          v_entitlement.refund_prize,v_entitlement.refund_bounty,
          v_entitlement.refund_fee,'atomic_cancel_tournament',
          'Tournament cancellation refund: '||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'fully_settled')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'remaining')::numeric,-1)<>0
           OR (v_settle->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR v_settle->>'entitlement_kind' IS DISTINCT FROM 'wallet_charge'
           OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_settle->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_settle->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_settle->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee THEN
          RAISE EXCEPTION 'exact cancellation refund refused entitlement %: %',
            v_entitlement.id,v_settle USING ERRCODE='55000';
        END IF;
        v_refunds:=v_refunds||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind','wallet_charge',
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'gross_paid',v_entitlement.gross,
          'amount_paid_before',(v_settle->>'already_paid')::numeric,
          'amount_paid_now',(v_settle->>'paid')::numeric,
          'refund_prize',(v_settle->>'refund_prize')::numeric,
          'refund_bounty',(v_settle->>'refund_bounty')::numeric,
          'refund_fee',(v_settle->>'refund_fee')::numeric,
          'obligation_id',(v_settle->>'obligation_id')::uuid,
          'idempotency_key',v_settle->>'idempotency_key',
          'credit_ledger_id',(v_settle->>'credit_ledger_id')::uuid,
          'wallet_transaction_id',(v_settle->>'wallet_transaction_id')::uuid));
        v_refund_line_count:=v_refund_line_count+1;
        v_total_refunded:=round(
          v_total_refunded+(v_settle->>'paid')::numeric,2);
      ELSIF v_entitlement.entitlement_kind IN (
          'satellite_seat','tournament_ticket') THEN
        v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
          v_entitlement.id,'atomic_cancel_tournament',
          'Cancelled tournament seat returned as entry ticket: '
            ||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_ticket->>'replayed')::boolean,true) IS NOT FALSE
           OR (v_ticket->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_ticket->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_ticket->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_ticket->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee
           OR (v_ticket->>'refund_wallet_club_id')::uuid
                IS DISTINCT FROM v_entitlement.refund_wallet_club_id
           OR NULLIF(v_ticket->>'ticket_id','') IS NULL
           OR NULLIF(v_ticket->>'ledger_id','') IS NULL
           OR NULLIF(v_ticket->>'transaction_id','') IS NULL THEN
          RAISE EXCEPTION 'satellite ticket return refused entitlement %: %',
            v_entitlement.id,v_ticket USING ERRCODE='55000';
        END IF;
        v_ticket_return_ids:=array_append(
          v_ticket_return_ids,(v_ticket->>'ticket_id')::uuid);
        v_ticket_returns:=v_ticket_returns||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind',v_entitlement.entitlement_kind,
          'ticket_id',(v_ticket->>'ticket_id')::uuid,
          'value',(v_ticket->>'value')::numeric,
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'source_satellite_id',v_entitlement.source_satellite_id,
          'refund_prize',(v_ticket->>'refund_prize')::numeric,
          'refund_bounty',(v_ticket->>'refund_bounty')::numeric,
          'refund_fee',(v_ticket->>'refund_fee')::numeric,
          'ledger_id',(v_ticket->>'ledger_id')::uuid,
          'transaction_id',(v_ticket->>'transaction_id')::uuid));
        v_ticket_return_count:=v_ticket_return_count+1;
        v_total_ticket_returned:=round(
          v_total_ticket_returned+(v_ticket->>'value')::numeric,2);
      ELSE
        RAISE EXCEPTION 'unknown cancellation entitlement kind %',
          v_entitlement.entitlement_kind USING ERRCODE='P0404';
      END IF;
      IF NOT v_registration_id=ANY(v_refunded_registration_ids) THEN
        v_refunded_registration_ids:=array_append(
          v_refunded_registration_ids,v_registration_id);
      END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_refunded_registration_ids
    FROM unnest(v_refunded_registration_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_zero_refund_registration_ids
    FROM unnest(v_source_player_ids) ids(id)
   WHERE NOT id=ANY(v_refunded_registration_ids);
  v_refunded_count:=cardinality(v_refunded_registration_ids);
  v_zero_refund_count:=cardinality(v_zero_refund_registration_ids);

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.fn_ca_tournament_refund_plan(
                    p_tournament_id,tp.user_id))) THEN
    RAISE EXCEPTION 'cancellation left a refundable entitlement unpaid'
      USING ERRCODE='55000';
  END IF;

  -- Rake reversal is attribution only: the exact refund payer already returned
  -- the fee component from escrow. Reverse each current player's net fee and
  -- each aggregate Spin source exactly once, retaining immutable source ids.
  IF EXISTS (SELECT 1 FROM public.rake_records r
              WHERE r.tournament_id=p_tournament_id
                AND r.source='atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'unreceipted cancellation rake evidence already exists'
      USING ERRCODE='P0404';
  END IF;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_before FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_before<0
     OR v_total_rake_before::text IN ('NaN','Infinity','-Infinity')
     OR round(COALESCE(v_t.total_rake,0),2) IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % rake cache and evidence disagree',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  FOR v_fee IN
    SELECT tp.user_id,r.club_id,
           round(sum(r.rake_amount),2) AS amount,
           jsonb_agg(r.id ORDER BY r.id) AS source_ids
      FROM (SELECT DISTINCT p.user_id FROM public.tournament_players p
             WHERE p.tournament_id=p_tournament_id AND p.user_id IS NOT NULL) tp
      JOIN public.rake_records r
        ON r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.metadata->>'user_id'=tp.user_id::text
     GROUP BY tp.user_id,r.club_id HAVING round(sum(r.rake_amount),2)>0
     ORDER BY tp.user_id,r.club_id
  LOOP
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.amount,1,0,true,
      p_tournament_id,'atomic_cancel_tournament',jsonb_build_object(
        'kind','tournament_fee_refund','user_id',v_fee.user_id,
        'original_rake_record_ids',v_fee.source_ids))
    RETURNING id INTO v_fee_reversal_id;
    v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
    v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
  END LOOP;
  FOR v_fee IN
    SELECT r.*,round(r.rake_amount+COALESCE((SELECT sum(rr.rake_amount)
      FROM public.rake_records rr WHERE rr.tournament_id=p_tournament_id
       AND rr.source='atomic_cancel_tournament'
       AND rr.metadata->>'original_rake_record_id'=r.id::text),0),2) AS amount
      FROM public.rake_records r
     WHERE r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.source IN ('fn_spin_book_entry','fn_spin_settle_game')
       AND r.rake_amount>0 AND NULLIF(r.metadata->>'user_id','') IS NULL
     ORDER BY r.id FOR UPDATE
  LOOP
    IF v_fee.amount>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,
        player_contributions,metadata)
      VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.pot_size,
        v_fee.num_players,0,true,p_tournament_id,'atomic_cancel_tournament',
        v_fee.player_contributions,jsonb_build_object(
          'kind','spin_rake_refund','original_source',v_fee.source,
          'original_rake_record_id',v_fee.id))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
    END IF;
  END LOOP;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_after FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_after IS DISTINCT FROM 0::numeric
     OR v_fees_reversed IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % fee reversal did not close exactly',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % cancellation did not close all escrow banks',
      p_tournament_id USING ERRCODE='P0404';
  END IF;
  UPDATE public.tournament_escrow
     SET closed_at=v_cancelled_at,close_note=v_close_note,updated_at=now()
   WHERE tournament_id=p_tournament_id AND closed_at IS NULL
     AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its exact-zero escrow close',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,
         chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at=v_cancelled_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.left_at IS NULL RETURNING s.id)
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_released_seat_ids FROM released;
  v_released_seat_count:=cardinality(v_released_seat_ids);
  UPDATE public.table_seats s
     SET status='left',leave_pending=false,is_sitting_out=false,is_away=false,
         sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.id=ANY(v_source_seat_ids) AND s.left_at IS NOT NULL;

  UPDATE public.tournaments
     SET status='CANCELLED',ended_at=v_cancelled_at,updated_at=now(),
         prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,
         on_break=false,break_started_at=NULL,break_ends_at=NULL
   WHERE id=p_tournament_id
     AND upper(COALESCE(status::text,'')) NOT IN
         ('COMPLETED','CANCELLED','CANCELED','COMPLETING');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim',
      p_tournament_id USING ERRCODE='40001';
  END IF;
  UPDATE public.tables
     SET status='closed',lifecycle='closed',current_players=0,
         terminal_closed_at=v_cancelled_at,updated_at=now()
   WHERE tournament_id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>v_closed_table_count THEN
    RAISE EXCEPTION 'tournament % did not close every table',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids FROM unnest(v_fee_reversal_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_ticket_return_ids FROM unnest(v_ticket_return_ids) ids(id);
  v_receipt:=jsonb_build_object(
    'ok',true,'success',true,'fully_settled',true,'receipt_version',2,
    'tournament_id',p_tournament_id,'actor_id',v_actor,'status','CANCELLED',
    'source_player_count',v_source_player_count,
    'refunded_count',v_refunded_count,'refund_line_count',v_refund_line_count,
    'ticket_return_count',v_ticket_return_count,
    'total_ticket_returned',v_total_ticket_returned,
    'total_refunded',v_total_refunded,'fees_reversed',v_fees_reversed,
    'closed_table_count',v_closed_table_count,
    'source_seat_count',v_source_seat_count,
    'released_seat_count',v_released_seat_count,
    'refunds',v_refunds,'ticket_returns',v_ticket_returns,
    'settled_at',v_cancelled_at);
  INSERT INTO public.tournament_cancellation_receipts(
    tournament_id,actor_id,receipt_version,
    source_player_count,source_player_ids,
    refunded_count,refunded_registration_ids,refund_line_count,
    ticket_return_count,ticket_return_ids,total_ticket_returned,
    zero_refund_count,zero_refund_registration_ids,
    total_refunded,fees_reversed,total_rake_before,total_rake_after,
    closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
    released_seat_count,released_seat_ids,fee_reversal_ids,
    escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,
    receipt,settled_at)
  VALUES(
    p_tournament_id,v_actor,2,
    v_source_player_count,v_source_player_ids,
    v_refunded_count,v_refunded_registration_ids,v_refund_line_count,
    v_ticket_return_count,v_ticket_return_ids,v_total_ticket_returned,
    v_zero_refund_count,v_zero_refund_registration_ids,
    v_total_refunded,v_fees_reversed,v_total_rake_before,v_total_rake_after,
    v_closed_table_count,v_closed_table_ids,v_source_seat_count,v_source_seat_ids,
    v_released_seat_count,v_released_seat_ids,v_fee_reversal_ids,
    v_cancelled_at,v_close_note,v_spin_unwind_id,v_receipt,v_cancelled_at);

  RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,v_actor);
END;
$cancel$;

-- Replay is deliberately read-only. Every mutable child it checks is frozen by
-- the guards below once the receipt exists, so a retry either returns the exact
-- stored JSONB value or refuses contradictory durable state.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_cancellation_receipt(
  p_tournament_id uuid,
  p_observed_actor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $cancellation_receipt_v2$
DECLARE
  v_h public.tournament_cancellation_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_e public.tournament_escrow%ROWTYPE;
  v_ids uuid[];
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'cancellation receipt requires a tournament id'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_h FROM public.tournament_cancellation_receipts h
   WHERE h.tournament_id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable cancellation receipt',
      p_tournament_id USING ERRCODE='P0404';
  END IF;
  IF p_observed_actor_id IS NOT NULL
     AND v_h.actor_id IS DISTINCT FROM p_observed_actor_id THEN
    RAISE EXCEPTION 'cancellation actor disagrees with stored receipt'
      USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  IF v_t.id IS NULL
     OR upper(COALESCE(v_t.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     OR v_t.ended_at IS DISTINCT FROM v_h.settled_at
     OR v_t.current_players IS DISTINCT FROM 0
     OR v_t.prize_pool IS DISTINCT FROM 0::numeric
     OR v_t.bounty_pool IS DISTINCT FROM 0::numeric
     OR v_t.total_rake IS DISTINCT FROM v_h.total_rake_after
     OR v_t.on_break IS DISTINCT FROM false
     OR v_t.break_started_at IS NOT NULL OR v_t.break_ends_at IS NOT NULL
     OR v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'cancellation receipt lost its terminal parent or escrow state'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_player_ids OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND (tp.status::text IS DISTINCT FROM 'eliminated'
         OR tp.eliminated_at IS DISTINCT FROM v_h.settled_at
         OR COALESCE(tp.chips,0)<>0 OR COALESCE(tp.current_bounty,0)<>0)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen roster'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.closed_table_ids OR EXISTS (
    SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id
      AND (lower(COALESCE(tb.status::text,''))<>'closed'
        OR lower(COALESCE(tb.lifecycle,''))<>'closed'
        OR tb.current_players IS DISTINCT FROM 0
        OR tb.terminal_closed_at IS DISTINCT FROM v_h.settled_at)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen tables'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_seat_ids OR EXISTS (
    SELECT 1 FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'
         OR s.leave_pending IS DISTINCT FROM false
         OR s.is_sitting_out IS DISTINCT FROM false
         OR s.is_away IS DISTINCT FROM false OR s.sit_out_at IS NOT NULL
         OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen seats'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NOT DISTINCT FROM v_h.settled_at;
  IF v_ids IS DISTINCT FROM v_h.released_seat_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its released-seat identity'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(x.registration_id ORDER BY x.registration_id),
                  ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT DISTINCT (line->>'registration_id')::uuid AS registration_id
        FROM jsonb_array_elements(v_h.receipt->'refunds') line
      UNION
      SELECT DISTINCT (line->>'registration_id')::uuid AS registration_id
        FROM jsonb_array_elements(v_h.receipt->'ticket_returns') line
    ) x;
  IF v_ids IS DISTINCT FROM v_h.refunded_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its disposition roster'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(x.id ORDER BY x.id),ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT unnest(v_h.source_player_ids) AS id
      EXCEPT SELECT unnest(v_h.refunded_registration_ids)
    ) x;
  IF v_ids IS DISTINCT FROM v_h.zero_refund_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its zero-disposition roster'
      USING ERRCODE='P0404';
  END IF;

  IF (SELECT count(*) FROM public.tournament_refund_tranches tr
       WHERE tr.tournament_id=p_tournament_id
         AND tr.source='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.refund_line_count
     OR (SELECT round(COALESCE(sum(tr.amount_paid_now),0),2)
           FROM public.tournament_refund_tranches tr
          WHERE tr.tournament_id=p_tournament_id
            AND tr.source='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.total_refunded
     OR EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(
           registration_id uuid,user_id uuid,entitlement_id uuid,
           entitlement_kind text,source_wallet_club_id uuid,
           gross_paid numeric,amount_paid_before numeric,amount_paid_now numeric,
           refund_prize numeric,refund_bounty numeric,refund_fee numeric,
           obligation_id uuid,idempotency_key text,credit_ledger_id uuid,
           wallet_transaction_id uuid)
         LEFT JOIN public.tournament_players tp ON tp.id=line.registration_id
         LEFT JOIN public.tournament_refund_entitlements e
           ON e.id=line.entitlement_id
         LEFT JOIN public.tournament_refund_tranches tr
           ON tr.wallet_transaction_id=line.wallet_transaction_id
         LEFT JOIN public.tournament_obligations o ON o.id=line.obligation_id
         LEFT JOIN public.wallet_transactions w ON w.id=line.wallet_transaction_id
         LEFT JOIN public.wallet_credit_idempotency k ON k.key=line.idempotency_key
         LEFT JOIN public.chip_ledger l ON l.id=line.credit_ledger_id
        WHERE tp.id IS NULL OR tp.tournament_id IS DISTINCT FROM p_tournament_id
           OR tp.user_id IS DISTINCT FROM line.user_id
           OR e.id IS NULL OR e.tournament_id IS DISTINCT FROM p_tournament_id
           OR e.user_id IS DISTINCT FROM line.user_id
           OR e.entitlement_kind IS DISTINCT FROM 'wallet_charge'
           OR e.entitlement_kind IS DISTINCT FROM line.entitlement_kind
           OR e.refund_wallet_club_id IS DISTINCT FROM line.source_wallet_club_id
           OR e.gross IS DISTINCT FROM line.amount_paid_now
           OR e.refund_prize IS DISTINCT FROM line.refund_prize
           OR e.refund_bounty IS DISTINCT FROM line.refund_bounty
           OR e.refund_fee IS DISTINCT FROM line.refund_fee
           OR (e.entitlement_kind IN ('satellite_seat','tournament_ticket')
               AND e.registration_id IS DISTINCT FROM line.registration_id)
           OR line.gross_paid IS DISTINCT FROM line.amount_paid_now
           OR line.amount_paid_now IS DISTINCT FROM
                round(line.refund_prize+line.refund_bounty+line.refund_fee,2)
           OR tr.wallet_transaction_id IS NULL
           OR tr.idempotency_key IS DISTINCT FROM line.idempotency_key
           OR tr.tournament_id IS DISTINCT FROM p_tournament_id
           OR tr.obligation_id IS DISTINCT FROM line.obligation_id
           OR tr.user_id IS DISTINCT FROM line.user_id
           OR tr.source_wallet_club_id IS DISTINCT FROM line.source_wallet_club_id
           OR tr.entitlement_id IS DISTINCT FROM line.entitlement_id
           OR tr.credit_ledger_id IS DISTINCT FROM line.credit_ledger_id
           OR tr.amount_paid_before IS DISTINCT FROM line.amount_paid_before
           OR tr.amount_paid_now IS DISTINCT FROM line.amount_paid_now
           OR tr.refund_prize IS DISTINCT FROM line.refund_prize
           OR tr.refund_bounty IS DISTINCT FROM line.refund_bounty
           OR tr.refund_fee IS DISTINCT FROM line.refund_fee
           OR tr.source IS DISTINCT FROM 'atomic_cancel_tournament'
           OR o.id IS NULL OR o.tournament_id IS DISTINCT FROM p_tournament_id
           OR o.kind IS DISTINCT FROM 'refund' OR o.place IS NOT NULL
           OR o.user_id IS DISTINCT FROM line.user_id OR o.settled_at IS NULL
           OR o.amount_paid IS DISTINCT FROM o.amount_owed
           OR o.amount_paid IS DISTINCT FROM (
             SELECT round(COALESCE(sum(all_tr.amount_paid_now),0),2)
               FROM public.tournament_refund_tranches all_tr
              WHERE all_tr.obligation_id=o.id)
           OR w.id IS NULL OR w.user_id IS DISTINCT FROM line.user_id
           OR w.related_entity_id IS DISTINCT FROM p_tournament_id
           OR w.type IS DISTINCT FROM 'credit' OR lower(w.category)<>'refund'
           OR w.amount IS DISTINCT FROM line.amount_paid_now
           OR k.key IS NULL OR k.user_id IS DISTINCT FROM line.user_id
           OR k.amount IS DISTINCT FROM line.amount_paid_now
           OR l.id IS NULL OR l.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR l.from_type IS DISTINCT FROM 'prize_liability'
           OR l.from_entity_id IS DISTINCT FROM p_tournament_id
           OR l.to_type IS DISTINCT FROM 'player_wallet'
           OR l.to_entity_id IS DISTINCT FROM line.user_id
           OR l.amount IS DISTINCT FROM line.amount_paid_now)
     OR EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.tournament_id=p_tournament_id
          AND tr.source='atomic_cancel_tournament'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(
              wallet_transaction_id uuid)
             WHERE line.wallet_transaction_id=tr.wallet_transaction_id)) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact refund evidence'
      USING ERRCODE='P0404';
  END IF;

  IF (SELECT count(*) FROM public.tournament_tickets tk
       WHERE tk.id=ANY(v_h.ticket_return_ids))
       IS DISTINCT FROM v_h.ticket_return_count
     OR (SELECT round(COALESCE(sum(tk.value),0),2)
           FROM public.tournament_tickets tk
          WHERE tk.id=ANY(v_h.ticket_return_ids))
       IS DISTINCT FROM v_h.total_ticket_returned
     OR EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_h.receipt->'ticket_returns') AS line(
           registration_id uuid,user_id uuid,entitlement_id uuid,
           entitlement_kind text,ticket_id uuid,
           value numeric,source_wallet_club_id uuid,source_satellite_id uuid,
           refund_prize numeric,refund_bounty numeric,refund_fee numeric,
           ledger_id uuid,transaction_id uuid)
         LEFT JOIN public.tournament_players tp ON tp.id=line.registration_id
         LEFT JOIN public.tournament_refund_entitlements e
           ON e.id=line.entitlement_id
         LEFT JOIN public.tournament_tickets tk ON tk.id=line.ticket_id
         LEFT JOIN public.chip_ledger l ON l.id=line.ledger_id
         LEFT JOIN public.chip_transactions ct ON ct.id=line.transaction_id
        WHERE tp.id IS NULL OR tp.tournament_id IS DISTINCT FROM p_tournament_id
           OR tp.user_id IS DISTINCT FROM line.user_id
           OR e.id IS NULL OR e.tournament_id IS DISTINCT FROM p_tournament_id
           OR e.user_id IS DISTINCT FROM line.user_id
           OR e.entitlement_kind NOT IN ('satellite_seat','tournament_ticket')
           OR e.entitlement_kind IS DISTINCT FROM line.entitlement_kind
           OR e.registration_id IS DISTINCT FROM line.registration_id
           OR e.source_satellite_id IS DISTINCT FROM line.source_satellite_id
           OR e.refund_wallet_club_id IS DISTINCT FROM line.source_wallet_club_id
           OR e.gross IS DISTINCT FROM line.value
           OR e.refund_prize IS DISTINCT FROM line.refund_prize
           OR e.refund_bounty IS DISTINCT FROM line.refund_bounty
           OR e.refund_fee IS DISTINCT FROM line.refund_fee
           OR EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr
                       WHERE tr.entitlement_id=line.entitlement_id)
           OR tk.id IS NULL OR tk.id<>ALL(v_h.ticket_return_ids)
           OR tk.source_refund_entitlement_id IS DISTINCT FROM line.entitlement_id
           OR tk.source_tournament_id IS DISTINCT FROM p_tournament_id
           OR tk.source_satellite_id IS DISTINCT FROM line.source_satellite_id
           OR tk.holder_id IS DISTINCT FROM line.user_id
           OR tk.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR tk.value IS DISTINCT FROM line.value
           OR tk.status NOT IN ('issued','redeemed')
           OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
           OR tk.entry_prize IS DISTINCT FROM line.refund_prize
           OR tk.entry_bounty IS DISTINCT FROM line.refund_bounty
           OR tk.entry_fee IS DISTINCT FROM line.refund_fee
           OR l.id IS NULL
           OR l.idempotency_key IS DISTINCT FROM
                'tourney:'||p_tournament_id::text
                  ||':satellite-ticket-return:'||line.entitlement_id::text
           OR l.tournament_id IS DISTINCT FROM p_tournament_id
           OR l.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR l.from_type IS DISTINCT FROM 'prize_liability'
           OR l.from_entity_id IS DISTINCT FROM p_tournament_id
           OR l.to_type IS DISTINCT FROM 'escrow'
           OR l.to_entity_id IS DISTINCT FROM line.ticket_id
           OR l.category IS DISTINCT FROM 'ticket_issue'
           OR l.amount IS DISTINCT FROM line.value
           OR l.metadata->>'entitlement_kind'
                IS DISTINCT FROM line.entitlement_kind
           OR ct.id IS NULL OR ct.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR ct.to_user_id IS DISTINCT FROM line.user_id
           OR ct.amount IS DISTINCT FROM line.value
           OR ct.transaction_type IS DISTINCT FROM 'tournament_ticket_issue'
           OR ct.metadata->>'ticket_id' IS DISTINCT FROM line.ticket_id::text
           OR ct.metadata->>'entitlement_id' IS DISTINCT FROM line.entitlement_id::text
           OR ct.metadata->>'entitlement_kind'
                IS DISTINCT FROM line.entitlement_kind
           OR ct.metadata->>'ledger_id' IS DISTINCT FROM line.ledger_id::text)
     OR EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.id=ANY(v_h.ticket_return_ids)
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(
              v_h.receipt->'ticket_returns') AS line(ticket_id uuid)
             WHERE line.ticket_id=tk.id)) THEN
    RAISE EXCEPTION 'cancellation receipt lost satellite entry-ticket evidence'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(r.id ORDER BY r.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id
     AND r.source='atomic_cancel_tournament';
  IF v_ids IS DISTINCT FROM v_h.fee_reversal_ids
     OR (SELECT round(COALESCE(sum(r.rake_amount),0),2)
           FROM public.rake_records r
          WHERE r.tournament_id=p_tournament_id AND r.is_tournament)
        IS DISTINCT FROM v_h.total_rake_after
     OR (SELECT round(COALESCE(-sum(r.rake_amount),0),2)
           FROM public.rake_records r WHERE r.id=ANY(v_h.fee_reversal_ids))
        IS DISTINCT FROM v_h.fees_reversed
     OR EXISTS (
       SELECT 1 FROM public.rake_records reversal
        WHERE reversal.id=ANY(v_h.fee_reversal_ids)
          AND (reversal.rake_amount>=0
            OR reversal.club_id IS NULL
            OR reversal.source IS DISTINCT FROM 'atomic_cancel_tournament'
            OR reversal.metadata->>'kind' NOT IN (
                 'tournament_fee_refund','spin_rake_refund')
            OR (reversal.metadata->>'kind'='tournament_fee_refund' AND (
              jsonb_typeof(reversal.metadata->'original_rake_record_ids')
                IS DISTINCT FROM 'array'
              OR jsonb_array_length(
                   reversal.metadata->'original_rake_record_ids')
                 IS DISTINCT FROM (
                   SELECT count(*)::integer
                     FROM jsonb_array_elements_text(
                       reversal.metadata->'original_rake_record_ids') source(id)
                     JOIN public.rake_records original
                       ON original.id=source.id::uuid
                    WHERE original.tournament_id=p_tournament_id
                      AND original.club_id=reversal.club_id
                      AND original.metadata->>'user_id'=
                          reversal.metadata->>'user_id')
              OR (SELECT round(COALESCE(sum(original.rake_amount),0),2)
                    FROM jsonb_array_elements_text(
                      reversal.metadata->'original_rake_record_ids') source(id)
                    JOIN public.rake_records original ON original.id=source.id::uuid
                   WHERE original.tournament_id=p_tournament_id
                     AND original.club_id=reversal.club_id
                     AND original.metadata->>'user_id'=
                         reversal.metadata->>'user_id')
                 IS DISTINCT FROM -reversal.rake_amount))
            OR (reversal.metadata->>'kind'='spin_rake_refund' AND NOT EXISTS (
              SELECT 1 FROM public.rake_records original
               WHERE original.id::text=
                       reversal.metadata->>'original_rake_record_id'
                 AND original.tournament_id=p_tournament_id
                 AND original.club_id=reversal.club_id
                 AND original.source IN (
                       'fn_spin_book_entry','fn_spin_settle_game')
                 AND original.rake_amount=-reversal.rake_amount)))) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact fee evidence'
      USING ERRCODE='P0404';
  END IF;

  IF v_h.spin_unwind_tournament_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
    JOIN public.spin_reserve_ledger c ON c.id=u.original_contribution_id
    JOIN public.spin_reserve_ledger cr ON cr.id=u.contribution_reversal_id
    JOIN public.chip_ledger cj ON cj.id=u.original_entry_journal_id
    JOIN public.chip_ledger crj ON crj.id=u.contribution_reversal_journal_id
     WHERE u.tournament_id=p_tournament_id AND c.kind='contribution'
       AND cr.kind='contribution_reversal' AND cr.amount=-c.amount
       AND cj.category='spin_entry' AND cj.amount=c.amount
       AND crj.category='reversal' AND crj.amount=c.amount
       AND crj.idempotency_key='spin:'||p_tournament_id::text||':cancel:entry'
       AND ((u.draw_amount=0 AND u.original_draw_id IS NULL
             AND u.draw_reversal_id IS NULL)
         OR (u.draw_amount>0 AND EXISTS (
           SELECT 1 FROM public.spin_reserve_ledger d
           JOIN public.spin_reserve_ledger dr ON dr.id=u.draw_reversal_id
           JOIN public.chip_ledger dj ON dj.id=u.original_draw_journal_id
           JOIN public.chip_ledger drj ON drj.id=u.draw_reversal_journal_id
            WHERE d.id=u.original_draw_id AND d.kind='jackpot_draw'
              AND dr.kind='draw_reversal' AND dr.amount=-d.amount
              AND dj.category='spin_prize' AND dj.amount=-d.amount
              AND drj.category='reversal' AND drj.amount=-d.amount
              AND drj.idempotency_key=
                  'spin:'||p_tournament_id::text||':cancel:draw')))) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact Spin unwind evidence'
      USING ERRCODE='P0404';
  END IF;
  IF v_h.spin_unwind_tournament_id IS NULL AND EXISTS (
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id AND r.kind='contribution') THEN
    RAISE EXCEPTION 'cancellation receipt omitted the Spin contribution unwind'
      USING ERRCODE='P0404';
  END IF;
  RETURN v_h.receipt;
END;
$cancellation_receipt_v2$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_cancellation_receipt(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid, uuid)
  TO service_role;

-- The managed-game close command used to bypass the atomic cancellation
-- authority for an empty tournament. Its direct CANCELLED write cannot satisfy
-- the exact deferred receipt invariant above, and it also takes the tournament
-- row before the terminal settlement lock. Preserve the cash-table branch byte
-- for byte while routing only the tournament branch through the one atomic
-- cancellation authority.
CREATE OR REPLACE FUNCTION public.fn_close_managed_game(
  p_kind text,
  p_game_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $managed_close$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_status text;
  v_cluster uuid;
  v_role text;
  v_cancel jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id, status, cluster_id, role
      INTO v_club, v_status, v_cluster, v_role
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF lower(COALESCE(v_status, '')) IN ('closed', 'completed', 'cancelled', 'finished') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.table_seats ts
     WHERE ts.table_id = p_game_id
       AND ts.left_at IS NULL
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_seated');
    END IF;

    UPDATE public.tables
       SET status = 'closed', current_players = 0, updated_at = now()
     WHERE id = p_game_id;

    IF v_cluster IS NOT NULL AND v_role = 'main' THEN
      UPDATE public.cash_games
         SET enabled = false,
             state = 'dormant',
             closed_at = now(),
             closed_by = v_uid,
             updated_at = now()
       WHERE id = v_cluster
         AND enabled;
    END IF;
    RETURN jsonb_build_object('ok', true);
  ELSIF p_kind = 'tournament' THEN
    -- This must precede the first tournament row lock. Every terminal owner
    -- takes the same lock, so managed cancellation cannot deadlock or race a
    -- finish, satellite closeout, unregister, or another cancellation.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1',0));

    SELECT club_id, status
      INTO v_club, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF upper(COALESCE(v_status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED', 'COMPLETING') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;

    PERFORM set_config('app.managed_game_lifecycle', 'on', true);
    v_cancel := public.atomic_cancel_tournament(p_game_id, v_uid);
    PERFORM set_config('app.managed_game_lifecycle', '', true);
    IF v_cancel->>'ok' IS DISTINCT FROM 'true'
       OR v_cancel->>'fully_settled' IS DISTINCT FROM 'true'
       OR v_cancel->>'status' IS DISTINCT FROM 'CANCELLED'
       OR v_cancel->>'tournament_id' IS DISTINCT FROM p_game_id::text
       OR (v_cancel->>'source_player_count')::integer IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION
        'managed tournament close did not return its exact atomic cancellation receipt'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
END;
$managed_close$;

-- The browser reaches fn_close_managed_game through this exactly-once command
-- gateway. The previous gateway locked the tournament before calling the
-- wrapper, which would still invert the terminal lock order even after the
-- wrapper was repaired. Acquire the terminal lock for tournament closes before
-- the gateway's canonical row lock; every non-close and cash-table command is
-- otherwise unchanged from the current Phase 3 definition.
CREATE OR REPLACE FUNCTION public.fn_execute_managed_game_command(
  p_command_id uuid,
  p_kind text,
  p_game_id uuid,
  p_action text,
  p_expected_version integer,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $managed_command$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_request_hash text;
  v_existing public.managed_game_command_receipts%ROWTYPE;
  v_before integer;
  v_after integer;
  v_action_result jsonb;
  v_result jsonb;
  v_status text;
  v_reason text;
  v_message text;
  v_sqlstate text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_command_id IS NULL
     OR p_game_id IS NULL
     OR p_kind NOT IN ('table', 'tournament')
     OR p_action NOT IN ('update', 'close')
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR jsonb_typeof(COALESCE(p_payload, '{}'::jsonb)) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  v_request_hash := public.fn_managed_game_command_hash(
    p_command_id, p_kind, p_game_id, p_action, p_expected_version, p_payload
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('managed-game-command:' || p_command_id::text, 0)
  );

  SELECT * INTO v_existing
    FROM public.managed_game_command_receipts
   WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_existing.actor_id <> v_uid OR v_existing.request_hash <> v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
    END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;

  IF p_kind = 'tournament' AND p_action = 'close' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1',0));
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id INTO v_club
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
  ELSE
    SELECT club_id INTO v_club
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  SELECT version INTO v_before
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'contract_not_found');
  END IF;

  INSERT INTO public.managed_game_command_receipts (
    command_id, actor_id, game_kind, game_id, command_action,
    expected_version, request_hash, status, contract_version_before
  ) VALUES (
    p_command_id, v_uid, p_kind, p_game_id, p_action,
    p_expected_version, v_request_hash, 'processing', v_before
  );

  IF p_expected_version <> v_before THEN
    v_result := jsonb_build_object(
      'ok', false,
      'reason', 'stale_contract_version',
      'command_id', p_command_id,
      'command_status', 'rejected',
      'expected_version', p_expected_version,
      'current_version', v_before,
      'version_before', v_before,
      'version_after', v_before,
      'replayed', false
    );
    UPDATE public.managed_game_command_receipts
       SET status = 'rejected', result = v_result,
           contract_version_after = v_before, completed_at = now()
     WHERE command_id = p_command_id;
    RETURN v_result;
  END IF;

  BEGIN
    IF p_action = 'update' THEN
      v_action_result := public.fn_update_managed_game(p_kind, p_game_id, p_payload);
    ELSE
      v_action_result := public.fn_close_managed_game(p_kind, p_game_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_reason := CASE
      WHEN v_sqlstate IN ('22P02', '22003', '23514') THEN 'invalid_payload'
      WHEN v_sqlstate = '42501' THEN 'not_authorized'
      WHEN v_sqlstate = '55000' THEN 'contract_rule_blocked'
      ELSE 'command_failed'
    END;
    v_action_result := jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'message', CASE
        WHEN v_sqlstate = '55000' THEN v_message
        ELSE NULL
      END
    );
  END;

  SELECT version INTO v_after
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;
  v_after := COALESCE(v_after, v_before);
  v_status := CASE WHEN COALESCE((v_action_result ->> 'ok')::boolean, false)
    THEN 'succeeded' ELSE 'rejected' END;

  v_result := COALESCE(v_action_result, jsonb_build_object(
    'ok', false, 'reason', 'command_failed'
  )) || jsonb_build_object(
    'command_id', p_command_id,
    'command_status', v_status,
    'expected_version', p_expected_version,
    'current_version', v_after,
    'version_before', v_before,
    'version_after', v_after,
    'replayed', false
  );

  UPDATE public.managed_game_command_receipts
     SET status = v_status, result = v_result,
         contract_version_after = v_after, completed_at = now()
   WHERE command_id = p_command_id;

  RETURN v_result;
END;
$managed_command$;

REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_managed_game(text, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_execute_managed_game_command(
  uuid, text, uuid, text, integer, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_execute_managed_game_command(
  uuid, text, uuid, text, integer, jsonb)
  TO authenticated, service_role;

DO $managed_cancel_proof$
DECLARE
  v_atomic text;
  v_close text;
  v_gateway text;
  v_close_global_at integer;
  v_close_row_at integer;
  v_gateway_global_at integer;
  v_gateway_row_at integer;
BEGIN
  SELECT p.prosrc INTO v_atomic
    FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)');
  SELECT p.prosrc INTO v_close
    FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_close_managed_game(text,uuid)');
  SELECT p.prosrc INTO v_gateway
    FROM pg_proc p
   WHERE p.oid=to_regprocedure(
     'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)');

  v_close_global_at:=position(
    'ca:tournament-terminal-settlement:v1' IN v_close);
  v_close_row_at:=position('FROM public.tournaments' IN v_close);
  v_gateway_global_at:=position(
    'ca:tournament-terminal-settlement:v1' IN v_gateway);
  v_gateway_row_at:=position('FROM public.tournaments' IN v_gateway);

  IF v_atomic IS NULL
     OR v_atomic NOT LIKE '%fn_can_create_games(v_t.club_id,v_uid)%'
     OR v_atomic LIKE '%is_club_admin(v_t.club_id,v_uid)%'
     OR v_close IS NULL
     OR v_close_global_at=0 OR v_close_row_at=0
     OR v_close_global_at>=v_close_row_at
     OR v_close NOT LIKE '%fn_can_create_games(v_club, v_uid)%'
     OR v_close NOT LIKE '%players_registered%'
     OR v_close NOT LIKE '%set_config(''app.managed_game_lifecycle'', ''on'', true)%'
     OR v_close NOT LIKE '%set_config(''app.managed_game_lifecycle'', '''', true)%'
     OR v_close NOT LIKE '%atomic_cancel_tournament(p_game_id, v_uid)%'
     OR v_close NOT LIKE '%managed tournament close did not return its exact atomic cancellation receipt%'
     OR v_close ~* 'update[[:space:]]+public[.]tournaments'
     OR v_gateway IS NULL
     OR v_gateway_global_at=0 OR v_gateway_row_at=0
     OR v_gateway_global_at>=v_gateway_row_at
     OR v_gateway NOT LIKE '%p_kind = ''tournament'' AND p_action = ''close''%'
     OR v_gateway NOT LIKE '%fn_close_managed_game(p_kind, p_game_id)%' THEN
    RAISE EXCEPTION 'managed cancellation source or lock-order proof failed'
      USING ERRCODE='P0404';
  END IF;

  IF NOT has_function_privilege(
       'service_role','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'anon','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_close_managed_game(text,uuid)','EXECUTE')
     OR has_function_privilege(
       'anon','public.fn_close_managed_game(text,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_close_managed_game(text,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'authenticated',
       'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'managed cancellation ACL proof failed'
      USING ERRCODE='42501';
  END IF;
END;
$managed_cancel_proof$;

-- A child row cannot cross the cancellation receipt boundary. INSERT takes a
-- parent key-share lock, so it either lands before cancellation's root lock and
-- is included, or waits and is refused. Existing rows were prelocked by the
-- authority, and become immutable once the receipt exists.
CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cancelled_child_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    v_old_tournament_id:=NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_new_tournament_id:=NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
      USING ERRCODE='55000';
  END IF;
  v_tournament_id:=COALESCE(v_new_tournament_id,v_old_tournament_id);
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='chip_ledger' AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$cancelled_child_guard$;

REVOKE ALL ON FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()
  FROM PUBLIC,anon,authenticated,service_role;

DO $install_cancellation_child_guards$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'tournament_players','tables','tournament_obligations',
    'tournament_payouts','chip_ledger','tournament_rake_settlements',
    'rake_records','tournament_guarantee_overlays','tournament_escrow',
    'tournament_refund_entitlements','tournament_refund_tranches',
    'spin_reserve_ledger',
    'tournament_spin_cancellation_unwinds'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS cancelled_tournament_evidence_is_immutable ON public.%I',
      v_table);
    EXECUTE format(
      'CREATE TRIGGER cancelled_tournament_evidence_is_immutable '
      ||'BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW '
      ||'EXECUTE FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()',
      v_table);
  END LOOP;
END;
$install_cancellation_child_guards$;

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_seat_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cancelled_seat_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id=OLD.table_id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id=NEW.table_id;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND v_new_tournament_id IS NOT NULL THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_new_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=COALESCE(v_new_tournament_id,v_old_tournament_id)) THEN
    RAISE EXCEPTION 'cancelled tournament seat evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$cancelled_seat_guard$;

REVOKE ALL ON FUNCTION public.fn_cancelled_tournament_seat_is_immutable()
  FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS cancelled_tournament_seat_is_immutable ON public.table_seats;
CREATE TRIGGER cancelled_tournament_seat_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_cancelled_tournament_seat_is_immutable();

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_wallet_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cancelled_wallet_guard$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN v_old_tournament_id:=OLD.related_entity_id; END IF;
  IF TG_OP<>'DELETE' THEN v_new_tournament_id:=NEW.related_entity_id; END IF;
  IF TG_OP='INSERT' AND v_new_tournament_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id=v_new_tournament_id) THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_new_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_old_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
                 WHERE h.tournament_id=v_new_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament wallet evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$cancelled_wallet_guard$;

REVOKE ALL ON FUNCTION public.fn_cancelled_tournament_wallet_is_immutable()
  FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS cancelled_tournament_wallet_is_immutable
  ON public.wallet_transactions;
CREATE TRIGGER cancelled_tournament_wallet_is_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_cancelled_tournament_wallet_is_immutable();

-- The parent transition is allowed only while no OLD receipt exists. Once the
-- receipt is committed every field used by replay is immutable.
CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_parent_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cancelled_parent_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=OLD.id) THEN
    RAISE EXCEPTION 'receipted cancellation % is immutable',OLD.id
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$cancelled_parent_guard$;

REVOKE ALL ON FUNCTION public.fn_cancelled_tournament_parent_is_immutable()
  FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS cancelled_tournament_parent_is_immutable
  ON public.tournaments;
CREATE TRIGGER cancelled_tournament_parent_is_immutable
  BEFORE DELETE OR UPDATE OF status,variant,tournament_type,
    satellite_target_id,satellite_target,satellite_seats,
    prize_pool,prize_pool_finalized,bounty_pool,bounty_pool_paid,
    is_bounty,is_pko,is_mystery_bounty,mystery_bounty_stage,
    mystery_bounty_pool_cents,club_id,ended_at,total_rake,current_players,
    on_break,break_started_at,break_ends_at
  ON public.tournaments FOR EACH ROW
  EXECUTE FUNCTION public.fn_cancelled_tournament_parent_is_immutable();

-- Replace the older sum-only cancellation check with a deferred exact receipt
-- invariant. The authority may publish CANCELLED before inserting its receipt,
-- but the transaction cannot commit unless the canonical replay verifier passes.
CREATE OR REPLACE FUNCTION public.trg_tournaments_cancel_must_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $cancelled_receipt_required$
DECLARE v_receipt jsonb;
BEGIN
  v_receipt:=public.fn_ca_tournament_cancellation_receipt(NEW.id,NULL);
  IF COALESCE((v_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR v_receipt->>'status' IS DISTINCT FROM 'CANCELLED' THEN
    RAISE EXCEPTION 'Tournament % cannot be CANCELLED without its exact receipt',
      NEW.id USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$cancelled_receipt_required$;

REVOKE ALL ON FUNCTION public.trg_tournaments_cancel_must_refund()
  FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS tournaments_cancel_must_refund ON public.tournaments;
CREATE CONSTRAINT TRIGGER tournaments_cancel_must_refund
AFTER UPDATE ON public.tournaments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (upper(COALESCE(NEW.status,'')) IN ('CANCELLED','CANCELED')
  AND upper(COALESCE(OLD.status,'')) IS DISTINCT FROM
      upper(COALESCE(NEW.status,'')))
EXECUTE FUNCTION public.trg_tournaments_cancel_must_refund();

-- Rolling cutover: this is the same legacy signature and ACL. The old engine
-- may continue calling it while the database lands first; no obligation or
-- cancellation door is retired in this stage.
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  TO service_role;

DO $settle_source_proof$
DECLARE
  v_cancel_source text;
  v_replay_source text;
  v_lock_at integer;
  v_tournament_lock_at integer;
BEGIN
  IF (SELECT count(*)
        FROM public.ca_settle_sources s
       WHERE s.source = 'atomic_cancel_tournament'
         AND s.note = '20260908153239: atomic cancellation receipt authority') <> 1 THEN
    RAISE EXCEPTION
      'atomic cancellation source ownership proof failed after function publish'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT p.prosrc,position('pg_advisory_xact_lock' IN p.prosrc),
         position('FOR UPDATE' IN p.prosrc)
    INTO v_cancel_source,v_lock_at,v_tournament_lock_at
    FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)');
  IF v_cancel_source IS NULL OR v_lock_at=0 OR v_tournament_lock_at=0
     OR v_lock_at>=v_tournament_lock_at
     OR v_cancel_source NOT LIKE '%tournament_players%FOR UPDATE%'
     OR v_cancel_source NOT LIKE '%table_seats%FOR UPDATE%'
     OR v_cancel_source NOT LIKE '%tournament_refund_entitlements%'
     OR v_cancel_source NOT LIKE '%fn_ca_tournament_refund_plan%'
     OR v_cancel_source NOT LIKE '%fn_settle_tournament_refund_exact%'
     OR v_cancel_source NOT LIKE '%fn_ca_return_satellite_entitlement_as_ticket%'
     OR v_cancel_source NOT LIKE '%entitlement_id%'
     OR v_cancel_source NOT LIKE '%tournament_spin_cancellation_unwinds%'
     OR v_cancel_source NOT LIKE '%tournament_cancellation_receipts%'
     OR v_cancel_source LIKE '%fn_settle_tournament_obligation(%' THEN
    RAISE EXCEPTION 'atomic cancellation source-shape proof failed'
      USING ERRCODE='P0404';
  END IF;

  SELECT p.prosrc INTO v_replay_source FROM pg_proc p
   WHERE p.oid=to_regprocedure(
     'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)')
     AND p.provolatile='s';
  IF v_replay_source IS NULL
     OR v_replay_source NOT LIKE '%tournament_refund_entitlements%'
     OR v_replay_source NOT LIKE '%tournament_refund_tranches%'
     OR v_replay_source NOT LIKE '%tournament_spin_cancellation_unwinds%'
     OR v_replay_source ~* '\m(insert|update|delete|merge)\M[[:space:]]' THEN
    RAISE EXCEPTION 'cancellation replay is not a read-only exact verifier'
      USING ERRCODE='P0404';
  END IF;

  IF NOT has_function_privilege(
       'service_role','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'anon','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_cancellation_receipts','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_spin_cancellation_unwinds','SELECT') THEN
    RAISE EXCEPTION 'cancellation authority ACL proof failed'
      USING ERRCODE='42501';
  END IF;

  IF (SELECT count(*) FROM pg_trigger g
       WHERE g.tgname='cancelled_tournament_evidence_is_immutable'
         AND g.tgrelid=ANY(ARRAY[
           'public.tournament_players'::regclass,
           'public.tables'::regclass,
           'public.tournament_obligations'::regclass,
           'public.tournament_payouts'::regclass,
           'public.chip_ledger'::regclass,
           'public.tournament_rake_settlements'::regclass,
           'public.rake_records'::regclass,
           'public.tournament_guarantee_overlays'::regclass,
           'public.tournament_escrow'::regclass,
           'public.tournament_refund_entitlements'::regclass,
           'public.tournament_refund_tranches'::regclass,
           'public.spin_reserve_ledger'::regclass,
           'public.tournament_spin_cancellation_unwinds'::regclass])
         AND NOT g.tgisinternal) <> 13
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
       WHERE g.tgrelid='public.table_seats'::regclass
         AND g.tgname='cancelled_tournament_seat_is_immutable'
         AND NOT g.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
       WHERE g.tgrelid='public.wallet_transactions'::regclass
         AND g.tgname='cancelled_tournament_wallet_is_immutable'
         AND NOT g.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
       WHERE g.tgrelid='public.tournaments'::regclass
         AND g.tgname='cancelled_tournament_parent_is_immutable'
         AND NOT g.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
       WHERE g.tgrelid='public.tournaments'::regclass
         AND g.tgname='tournaments_cancel_must_refund'
         AND g.tgdeferrable AND g.tginitdeferred AND NOT g.tgisinternal) THEN
    RAISE EXCEPTION 'cancellation immutability or deferred invariant proof failed'
      USING ERRCODE='P0404';
  END IF;
END;
$settle_source_proof$;

COMMIT;
