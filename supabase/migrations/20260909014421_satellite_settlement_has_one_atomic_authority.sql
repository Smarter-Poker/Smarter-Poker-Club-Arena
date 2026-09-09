-- 20260909014421_satellite_settlement_has_one_atomic_authority.sql
--
-- A satellite has one payer and one immutable allocation. The finalized
-- satellite prize pool buys every complete target ticket it can. Each ticket
-- is delivered as a target seat when admission is provably available, or as
-- the same full value in cash when the target is definitively unavailable or
-- the finisher already owns an independently funded target seat. Exactly one
-- next finisher receives every cent left below one full ticket. Admission,
-- payments, evidence, escrow, rake and completion commit or roll back together.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- This authority deliberately builds on two already-hardened money rails:
-- the cash cutover owns durable elimination order plus credit-and-evidence,
-- and the satellite escrow cutover books one full pool-transfer leg then
-- reclassifies the target fee. Refuse an out-of-order or partial deployment;
-- settling against either older contract would misstate balances. This file
-- supersedes the per-seat authorities introduced by 20260908020736,
-- 20260908022524 and the production 20260908032437 mirror.
DO $satellite_prerequisites$
DECLARE
  v_credit_source text;
  v_rake_source text;
  v_seat_leg_source text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tournament_players'
       AND c.column_name = 'elimination_sequence'
  ) OR to_regprocedure(
    'public.fn_stamp_tournament_elimination_sequence()') IS NULL THEN
    RAISE EXCEPTION
      'atomic satellite settlement requires the durable elimination-order cash cutover first';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.tournament_players'::regclass
          AND c.conname = 'tournament_players_elimination_sequence_positive'
          AND c.contype = 'c' AND c.convalidated)
     OR NOT EXISTS (
       SELECT 1
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
        WHERE i.indrelid = 'public.tournament_players'::regclass
          AND idx.relname = 'tournament_players_one_elimination_sequence'
          AND i.indisunique AND i.indisvalid
          AND pg_get_indexdef(i.indexrelid) =
            'CREATE UNIQUE INDEX tournament_players_one_elimination_sequence ON public.tournament_players USING btree (tournament_id, elimination_sequence) WHERE (elimination_sequence IS NOT NULL)')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid = 'public.tournament_players'::regclass
          AND g.tgname = 'zz_stamp_tournament_elimination_sequence'
          AND g.tgfoid =
              'public.fn_stamp_tournament_elimination_sequence()'::regprocedure
          AND NOT g.tgisinternal AND g.tgenabled IN ('O','A')
          AND pg_get_triggerdef(g.oid) =
            'CREATE TRIGGER zz_stamp_tournament_elimination_sequence BEFORE INSERT OR UPDATE OF status, elimination_sequence ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_elimination_sequence()')
     OR pg_get_functiondef(
          'public.fn_stamp_tournament_elimination_sequence()'::regprocedure)
          NOT LIKE '%NEW.elimination_sequence := nextval(%'
     OR pg_get_functiondef(
          'public.fn_stamp_tournament_elimination_sequence()'::regprocedure)
          NOT LIKE '%elimination_sequence is database-owned%' THEN
    RAISE EXCEPTION
      'atomic satellite settlement requires the exact elimination witness constraint, unique index and trigger';
  END IF;

  IF to_regprocedure(
       'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)')
       IS NULL THEN
    RAISE EXCEPTION
      'atomic satellite settlement requires the hardened credit-and-evidence door first';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(
           'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'))
    INTO v_credit_source;
  IF v_credit_source NOT LIKE '%INSERT INTO public.tournament_payouts%'
     OR v_credit_source NOT LIKE '%prize replay % exact payout rows%'
     OR v_credit_source NOT LIKE '%could not verify its payout evidence%' THEN
    RAISE EXCEPTION
      'fn_credit_and_log does not have the mandatory atomic payout-evidence contract';
  END IF;

  IF to_regprocedure('public.fn_ca_escrow_on_wallet_tx()') IS NULL
     OR to_regprocedure('public.fn_ca_escrow_on_rake_record()') IS NULL
     OR to_regprocedure('public.fn_ca_escrow_on_seat_payout()') IS NULL
     OR to_regprocedure('public.fn_ca_escrow_on_rake_settlement()') IS NULL
     OR to_regprocedure('public.fn_ca_escrow_on_close()') IS NULL
     OR to_regprocedure('public.fn_ca_escrow_on_seat_transfer_leg()') IS NULL
     OR (
       SELECT count(*)
         FROM (VALUES
           ('rake_records','zz_ca_escrow_rake_record',
             'public.fn_ca_escrow_on_rake_record()',5,
             'CREATE TRIGGER zz_ca_escrow_rake_record AFTER INSERT ON public.rake_records FOR EACH ROW WHEN (((new.is_tournament IS TRUE) AND (new.tournament_id IS NOT NULL))) EXECUTE FUNCTION fn_ca_escrow_on_rake_record()'),
           ('tournament_payouts','zz_ca_escrow_seat_payout',
             'public.fn_ca_escrow_on_seat_payout()',5,
             'CREATE TRIGGER zz_ca_escrow_seat_payout AFTER INSERT ON public.tournament_payouts FOR EACH ROW WHEN ((new.source = ''satellite_seat''::text)) EXECUTE FUNCTION fn_ca_escrow_on_seat_payout()'),
           ('tournament_rake_settlements','zz_ca_escrow_rake_settlement',
             'public.fn_ca_escrow_on_rake_settlement()',21,
             'CREATE TRIGGER zz_ca_escrow_rake_settlement AFTER INSERT OR UPDATE OF settled_at ON public.tournament_rake_settlements FOR EACH ROW EXECUTE FUNCTION fn_ca_escrow_on_rake_settlement()'),
           ('tournaments','zz_ca_escrow_close',
             'public.fn_ca_escrow_on_close()',17,
             'CREATE TRIGGER zz_ca_escrow_close AFTER UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = ''COMPLETED''::text) AND (old.status IS DISTINCT FROM ''COMPLETED''::text))) EXECUTE FUNCTION fn_ca_escrow_on_close()'),
           ('wallet_transactions','zz_ca_escrow_wallet_tx',
             'public.fn_ca_escrow_on_wallet_tx()',5,
             'CREATE TRIGGER zz_ca_escrow_wallet_tx AFTER INSERT ON public.wallet_transactions FOR EACH ROW WHEN ((new.related_entity_id IS NOT NULL)) EXECUTE FUNCTION fn_ca_escrow_on_wallet_tx()'),
           ('chip_ledger','zz_ca_escrow_seat_transfer_leg',
             'public.fn_ca_escrow_on_seat_transfer_leg()',5,
             'CREATE TRIGGER zz_ca_escrow_seat_transfer_leg AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.to_type = ''prize_liability''::text) AND (new.idempotency_key ~~ ''tourney:%:seat:%:pool_transfer''::text))) EXECUTE FUNCTION fn_ca_escrow_on_seat_transfer_leg()')
         ) AS required(relname, trigger_name, function_name, trigger_type,
                       trigger_definition)
         JOIN pg_namespace n ON n.nspname = 'public'
         JOIN pg_class c ON c.relnamespace = n.oid
                        AND c.relname = required.relname
         JOIN pg_trigger tg ON tg.tgrelid = c.oid
                           AND tg.tgname = required.trigger_name
                           AND tg.tgfoid = to_regprocedure(required.function_name)
        WHERE NOT tg.tgisinternal
          AND tg.tgenabled IN ('O','A')
          AND tg.tgtype = required.trigger_type
          AND pg_get_triggerdef(tg.oid) = required.trigger_definition
     ) <> 6 THEN
    RAISE EXCEPTION
      'atomic satellite settlement requires six exact origin-capable escrow trigger rails';
  END IF;
  SELECT pg_get_functiondef(
           to_regprocedure('public.fn_ca_escrow_on_seat_transfer_leg()'))
    INTO v_seat_leg_source;
  SELECT pg_get_functiondef(
           to_regprocedure('public.fn_ca_escrow_on_rake_record()'))
    INTO v_rake_source;
  IF v_seat_leg_source NOT LIKE
       '%p_satellite_in => round(NEW.amount, 2)%'
     OR v_seat_leg_source NOT LIKE
       '%NEW.metadata->>''entry_split_version'' = ''2''%'
     OR v_seat_leg_source NOT LIKE
       '%p_gross_in => round(NEW.amount - (NEW.metadata->>''entry_fee'')::numeric,2)%'
     OR v_rake_source NOT LIKE '%p_satellite_fee_in => v_fee%'
     OR v_rake_source NOT LIKE
       '%CASE WHEN NEW.metadata->>''entry_split_version''=''2'' THEN 0 ELSE -v_fee END%' THEN
    RAISE EXCEPTION
      'target escrow transfer/reclassification semantics are not the required hardened version';
  END IF;

  IF to_regprocedure('public.fn_settle_tournament_rake(uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'atomic satellite settlement requires the terminal rake authority';
  END IF;
END;
$satellite_prerequisites$;

-- Restate the elimination witness owner at this authority boundary. This makes
-- a retry safe even if the preceding cash migration was installed by an older
-- release before its all-busted promotion branch was hardened. Entering the
-- eliminated state receives a sequence; leaving it for a winner or legitimate
-- rebuy clears that stale witness; direct edits remain forbidden.
CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_elimination_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $stamp_elimination_sequence$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'eliminated' THEN
      NEW.elimination_sequence := nextval(
        'public.tournament_player_elimination_sequence'::regclass);
    ELSE
      NEW.elimination_sequence := NULL;
    END IF;
  ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'
        AND NEW.status::text = 'eliminated' THEN
    NEW.elimination_sequence := nextval(
      'public.tournament_player_elimination_sequence'::regclass);
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text IS DISTINCT FROM 'eliminated' THEN
    NEW.elimination_sequence := NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
    RAISE EXCEPTION 'elimination_sequence is database-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$stamp_elimination_sequence$;

REVOKE ALL ON FUNCTION public.fn_stamp_tournament_elimination_sequence()
  FROM PUBLIC, anon, authenticated, service_role;

-- The whole-event authority closes its escrow before publishing COMPLETED.
-- During the database-first rolling window the historical close observer is
-- still attached, so make it preserve that exact preclosed row instead of
-- overwriting its timestamp and note in the same transaction.
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $preserve_atomic_escrow_close$
DECLARE
  v public.tournament_escrow%ROWTYPE;
BEGIN
  IF NEW.status <> 'COMPLETED' OR OLD.status = 'COMPLETED' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v FROM public.tournament_escrow
   WHERE tournament_id = NEW.id FOR UPDATE;
  IF NOT FOUND OR NOT v.enforced THEN
    RETURN NULL;
  END IF;
  IF v.closed_at IS NOT NULL THEN
    IF v.prize_balance = 0 AND v.bounty_balance = 0 AND v.fee_balance = 0
       AND v.close_note = 'atomic satellite terminal receipt: exact zero' THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION
      'tournament % reached COMPLETED with contradictory preclosed escrow',
      NEW.id USING ERRCODE = '55000';
  END IF;
  UPDATE public.tournament_escrow
     SET closed_at = now(),
         close_note = CASE
           WHEN abs(v.prize_balance) <= 0.05
            AND abs(v.bounty_balance) <= 0.05
             THEN 'closed at zero'
           ELSE format(
             'closed with prize %s, bounty %s, fee %s still to settle; '
             || 'fn_ca_escrow_vs_counter_check judges this after settlement',
             v.prize_balance, v.bounty_balance, v.fee_balance)
         END
   WHERE tournament_id = NEW.id;
  RETURN NULL;
END;
$preserve_atomic_escrow_close$;

REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_close()
  FROM PUBLIC, anon, authenticated, service_role;

-- Terminal felt state is part of the satellite money receipt, not a later
-- lifecycle repair. Introduce its durable marker before creating the receipt
-- and stamp it in the same transaction as every new or adopted settlement.
ALTER TABLE public.tables
  ADD COLUMN terminal_closed_at timestamptz;

-- Drain every pre-existing tournament writer and block new legacy finish
-- transactions until this migration commits. Capturing history after this
-- barrier makes the inventory authoritative even when an older transaction
-- started before DDL and carried an earlier transaction_timestamp().
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE;

-- The cleanup stage needs an exact boundary between history that may have
-- completed through the legacy per-seat writer and every completion after
-- this whole-event authority began installing. The write barrier drains older
-- finish transactions first; the inventory then records every satellite that
-- was already COMPLETED behind that barrier. Any later completion must have a
-- whole-event receipt regardless of its timestamps. The audited id array
-- separately records which named production cutover events existed; clean
-- databases correctly record an empty audited array.
CREATE TABLE public.tournament_satellite_settlement_cutover (
  authority              text PRIMARY KEY
                              CHECK (authority = 'fn_settle_satellite_tournament:v2'),
  migration_version      text NOT NULL
                              CHECK (migration_version = '20260909014421'),
  installed_at           timestamptz NOT NULL,
  audited_tournament_ids uuid[] NOT NULL,
  preexisting_completed_ids uuid[] NOT NULL,
  CHECK (array_position(preexisting_completed_ids, NULL) IS NULL),
  CHECK (audited_tournament_ids <@ ARRAY[
    'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid,
    'a6a1b360-821c-4201-b378-1591e3df3892'::uuid,
    'e3570642-2e39-42ae-a8f6-164055ffd6e6'::uuid,
    'eddd8116-5792-47fd-b570-790c67581e9f'::uuid,
    '6b0c3243-75fb-487f-8da2-245b2426dbbe'::uuid,
    '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid,
    'ed78a8ac-d869-469f-a4da-c04b67429064'::uuid,
    'fe8dc50c-8995-4441-b289-43993975f74f'::uuid
  ])
);

ALTER TABLE public.tournament_satellite_settlement_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_satellite_settlement_cutover
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.tournament_satellite_settlement_cutover (
  authority, migration_version, installed_at, audited_tournament_ids,
  preexisting_completed_ids)
SELECT
  'fn_settle_satellite_tournament:v2',
  '20260909014421',
  clock_timestamp(),
  ARRAY(
    SELECT expected.id
      FROM (VALUES
        ('b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid),
        ('a6a1b360-821c-4201-b378-1591e3df3892'::uuid),
        ('e3570642-2e39-42ae-a8f6-164055ffd6e6'::uuid),
        ('eddd8116-5792-47fd-b570-790c67581e9f'::uuid),
        ('6b0c3243-75fb-487f-8da2-245b2426dbbe'::uuid),
        ('682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid),
        ('ed78a8ac-d869-469f-a4da-c04b67429064'::uuid),
        ('fe8dc50c-8995-4441-b289-43993975f74f'::uuid)
      ) AS expected(id)
     WHERE EXISTS (
       SELECT 1 FROM public.tournaments t WHERE t.id = expected.id)
     ORDER BY expected.id
  ),
  ARRAY(
    SELECT t.id
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status::text, '')) = 'COMPLETED'
       AND (
            lower(COALESCE(t.variant::text, '')) = 'satellite'
         OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
         OR t.satellite_target_id IS NOT NULL
         OR t.satellite_target IS NOT NULL)
     ORDER BY t.id
  );

COMMENT ON TABLE public.tournament_satellite_settlement_cutover IS
  'Owner-only cutover watermark captured behind a tournament write barrier. Stage two must prove an exact whole-pool receipt for every completed satellite outside the immutable preexisting inventory and every audited production id captured here.';

CREATE TABLE public.tournament_satellite_settlements (
  tournament_id          uuid PRIMARY KEY
                              REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  target_id              uuid NOT NULL
                              REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  target_was_missing     boolean NOT NULL DEFAULT false,
  target_contract_version bigint,
  winner_id              uuid NOT NULL,
  field_size             integer NOT NULL CHECK (field_size > 0),
  advertised_seats       integer NOT NULL CHECK (advertised_seats >= 0),
  pool                   numeric(15,2) NOT NULL
                              CHECK (pool >= 0 AND pool = round(pool, 2)),
  target_buy_in          numeric(15,2) NOT NULL
                              CHECK (target_buy_in >= 0 AND target_buy_in = round(target_buy_in, 2)),
  target_fee             numeric(15,2) NOT NULL
                              CHECK (target_fee >= 0 AND target_fee = round(target_fee, 2)),
  ticket_cost            numeric(15,2) NOT NULL
                              CHECK (ticket_cost > 0 AND ticket_cost = round(ticket_cost, 2)),
  ticket_award_count     integer NOT NULL CHECK (ticket_award_count >= 0),
  seat_count             integer NOT NULL CHECK (seat_count >= 0),
  cash_ticket_count      integer NOT NULL CHECK (cash_ticket_count >= 0),
  remainder              numeric(15,2) NOT NULL
                              CHECK (remainder >= 0 AND remainder = round(remainder, 2)),
  bubble_user_id         uuid,
  bubble_position        integer,
  source_table_count     integer NOT NULL CHECK (source_table_count > 0),
  source_table_ids       uuid[] NOT NULL,
  source_seat_count      integer NOT NULL CHECK (source_seat_count >= 0),
  source_seat_ids        uuid[] NOT NULL,
  released_seat_count    integer NOT NULL CHECK (released_seat_count >= 0),
  released_seat_ids      uuid[] NOT NULL,
  source_closed_at       timestamptz NOT NULL,
  source_escrow_closed_at timestamptz NOT NULL,
  source_escrow_close_note text NOT NULL
                              CHECK (length(btrim(source_escrow_close_note)) > 0),
  settled_at             timestamptz NOT NULL DEFAULT now(),
  receipt_version        integer NOT NULL DEFAULT 2 CHECK (receipt_version = 2),
  CHECK (target_id <> tournament_id),
  CHECK (ticket_cost = target_buy_in + target_fee),
  CHECK (ticket_award_count = seat_count + cash_ticket_count),
  CHECK (ticket_award_count <= field_size),
  CHECK (pool = ticket_award_count * ticket_cost + remainder),
  CHECK (pool >= advertised_seats * ticket_cost),
  CHECK (remainder < ticket_cost),
  CHECK (target_was_missing IS FALSE AND target_contract_version IS NULL),
  CHECK (source_table_count = cardinality(source_table_ids)),
  CHECK (source_seat_count = cardinality(source_seat_ids)),
  CHECK (released_seat_count = cardinality(released_seat_ids)),
  CHECK (source_closed_at <= settled_at),
  CHECK (source_escrow_closed_at <= settled_at),
  CHECK (array_position(source_table_ids, NULL) IS NULL),
  CHECK (array_position(source_seat_ids, NULL) IS NULL),
  CHECK (array_position(released_seat_ids, NULL) IS NULL),
  CHECK (released_seat_ids <@ source_seat_ids),
  CHECK ((
    (remainder = 0 AND bubble_user_id IS NULL AND bubble_position IS NULL)
    OR
    (remainder > 0 AND bubble_user_id IS NOT NULL
     AND bubble_position = ticket_award_count + 1
     AND bubble_position <= field_size)
  ) IS TRUE)
);

CREATE TABLE public.tournament_satellite_awards (
  tournament_id     uuid NOT NULL
                         REFERENCES public.tournament_satellite_settlements(tournament_id)
                         ON DELETE RESTRICT,
  place             integer NOT NULL CHECK (place > 0),
  user_id           uuid NOT NULL,
  delivery_kind     text NOT NULL CHECK (delivery_kind IN ('seat','cash')),
  amount            numeric(15,2) NOT NULL
                         CHECK (amount > 0 AND amount = round(amount, 2)),
  payout_id         uuid NOT NULL
                         REFERENCES public.tournament_payouts(id) ON DELETE RESTRICT,
  payout_source     text NOT NULL CHECK (length(btrim(payout_source)) > 0),
  idempotency_key   text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  -- Historical identity, deliberately not a foreign key to the live roster.
  -- A qualifier may unregister before the target starts, but the funded seat
  -- returns only as a tournament-entry ticket. It can never become wallet chips.
  registration_id   uuid,
  obligation_id     uuid REFERENCES public.tournament_obligations(id) ON DELETE RESTRICT,
  obligation_kind   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, place),
  UNIQUE (tournament_id, user_id),
  UNIQUE (payout_id),
  UNIQUE (idempotency_key),
  UNIQUE (registration_id),
  CHECK ((
    (delivery_kind = 'seat'
      AND registration_id IS NOT NULL
      AND obligation_id IS NULL
      AND obligation_kind IS NULL
      AND payout_source = 'satellite_seat')
    OR
    (delivery_kind = 'cash'
      AND registration_id IS NULL
      AND obligation_id IS NOT NULL
      AND obligation_kind IN ('seat','place')
      AND payout_source <> 'satellite_seat')
  ) IS TRUE)
);

-- A residual is money, not a ticket award. Give it its own immutable evidence
-- line instead of reconstructing its meaning from mutable cache columns. New
-- settlements always use the canonical place-bound key. One fully paid legacy
-- event is preserved under its exact original payout and claim identifiers;
-- that exception can describe no other tournament, player, amount or row.
CREATE TABLE public.tournament_satellite_remainders (
  tournament_id     uuid PRIMARY KEY
                         REFERENCES public.tournament_satellite_settlements(tournament_id)
                         ON DELETE RESTRICT,
  user_id           uuid NOT NULL,
  place             integer NOT NULL CHECK (place > 0),
  amount            numeric(15,2) NOT NULL
                         CHECK (amount > 0 AND amount = round(amount, 2)),
  payout_id         uuid NOT NULL UNIQUE
                         REFERENCES public.tournament_payouts(id) ON DELETE RESTRICT,
  payout_source     text NOT NULL CHECK (payout_source = 'satellite_remainder'),
  payout_position   integer,
  idempotency_key   text NOT NULL UNIQUE
                         CHECK (length(btrim(idempotency_key)) > 0),
  obligation_id     uuid NOT NULL UNIQUE
                         REFERENCES public.tournament_obligations(id) ON DELETE RESTRICT,
  obligation_kind   text NOT NULL CHECK (obligation_kind = 'satellite_remainder'),
  obligation_place  integer,
  evidence_kind     text NOT NULL
                         CHECK (evidence_kind IN ('atomic','legacy_20260908_682')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (evidence_kind = 'atomic'
      AND payout_position IS NOT DISTINCT FROM place
      AND obligation_place IS NOT DISTINCT FROM place
      AND idempotency_key = 'tourney:' || tournament_id::text
          || ':satellite_remainder:place:' || place::text)
    OR
    (evidence_kind = 'legacy_20260908_682'
      AND tournament_id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
      AND user_id = '146cf7a5-7f99-4dd3-858d-26dae69d9c80'::uuid
      AND place = 2
      AND amount = 85.00
      AND payout_id = '0de0bc80-dd26-4631-b7f5-3baf0fb4a9da'::uuid
      AND payout_position IS NULL
      AND idempotency_key = 'tourney:682045c5-cb07-47ed-ad0e-adbff9cb41af:obl:a15db36e-6684-4edd-be48-277bfb3113ba:0'
      AND obligation_id = 'a15db36e-6684-4edd-be48-277bfb3113ba'::uuid
      AND obligation_place IS NULL)
  )
);

-- A refund is a return of one previously funded entitlement, not a fresh
-- calculation from today's tournament header. Capture every wallet charge and
-- every funded target seat as its own immutable source record. The ledger row
-- names the exact club wallet or source pool, while these columns freeze the
-- prize, bounty and fee rails at the instant the money moves.
CREATE TABLE public.tournament_refund_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  entitlement_kind text NOT NULL
    CHECK (entitlement_kind IN (
      'wallet_charge','satellite_seat','tournament_ticket')),
  charge_category text NOT NULL
    CHECK (charge_category IN (
      'tournament_buyin','rebuy','addon','satellite_seat','tournament_ticket')),
  refund_wallet_club_id uuid NOT NULL
    REFERENCES public.clubs(id) ON DELETE RESTRICT,
  gross numeric(15,2) NOT NULL,
  refund_prize numeric(15,2) NOT NULL,
  refund_bounty numeric(15,2) NOT NULL,
  refund_fee numeric(15,2) NOT NULL,
  source_ledger_id uuid NOT NULL UNIQUE
    REFERENCES public.chip_ledger(id) ON DELETE RESTRICT,
  registration_id uuid,
  source_satellite_id uuid
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  source_award_place integer,
  source_ticket_id uuid
    REFERENCES public.tournament_tickets(id) ON DELETE RESTRICT,
  escrow_bucket text NOT NULL
    CHECK (escrow_bucket IN (
      'wallet_gross','satellite_gross','satellite_in','ticket_gross')),
  evidence_kind text NOT NULL
    CHECK (evidence_kind IN (
      'atomic_wallet_charge','cutover_wallet_charge',
      'atomic_satellite_seat','cutover_satellite_seat',
      'atomic_tournament_ticket')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (gross::text NOT IN ('NaN','Infinity','-Infinity')
     AND gross > 0 AND gross = round(gross,2)),
  CHECK (refund_prize::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_prize >= 0 AND refund_prize = round(refund_prize,2)),
  CHECK (refund_bounty::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_bounty >= 0 AND refund_bounty = round(refund_bounty,2)),
  CHECK (refund_fee::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_fee >= 0 AND refund_fee = round(refund_fee,2)),
  CHECK (gross = refund_prize + refund_bounty + refund_fee),
  CHECK ((
    (entitlement_kind = 'wallet_charge'
      AND charge_category IN ('tournament_buyin','rebuy','addon')
      AND registration_id IS NULL
      AND source_satellite_id IS NULL
      AND source_award_place IS NULL
      AND source_ticket_id IS NULL
      AND escrow_bucket = 'wallet_gross'
      AND evidence_kind IN ('atomic_wallet_charge','cutover_wallet_charge'))
    OR
    (entitlement_kind = 'satellite_seat'
      AND charge_category = 'satellite_seat'
      AND registration_id IS NOT NULL
      AND source_satellite_id IS NOT NULL
      AND source_satellite_id <> tournament_id
      AND source_award_place > 0
      AND source_ticket_id IS NULL
      AND escrow_bucket IN ('satellite_gross','satellite_in')
      AND evidence_kind IN ('atomic_satellite_seat','cutover_satellite_seat'))
    OR
    (entitlement_kind = 'tournament_ticket'
      AND charge_category = 'tournament_ticket'
      AND registration_id IS NOT NULL
      AND source_satellite_id IS NOT NULL
      AND source_award_place IS NULL
      AND source_ticket_id IS NOT NULL
      AND escrow_bucket = 'ticket_gross'
      AND evidence_kind = 'atomic_tournament_ticket')
  ) IS TRUE),
  UNIQUE (tournament_id,user_id,entitlement_kind,source_ledger_id)
);

CREATE INDEX tournament_refund_entitlements_player
  ON public.tournament_refund_entitlements(tournament_id,user_id,id);

CREATE UNIQUE INDEX tournament_refund_entitlement_one_source_ticket
  ON public.tournament_refund_entitlements(source_ticket_id)
  WHERE source_ticket_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_charge_split(
  p_tournament_id uuid,
  p_charge_category text,
  p_gross numeric
)
RETURNS TABLE(refund_prize numeric,refund_bounty numeric,refund_fee numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $charge_split$
DECLARE
  v_t record;
  v_entry record;
  v_kind text := lower(btrim(COALESCE(p_charge_category,'')));
  v_gross numeric := round(COALESCE(p_gross,0),2);
  v_is_bounty boolean;
  v_ratio numeric;
  v_fee numeric;
  v_bounty numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_gross IS NULL
     OR p_gross::text IN ('NaN','Infinity','-Infinity')
     OR p_gross IS DISTINCT FROM v_gross OR v_gross <= 0
     OR v_kind NOT IN ('tournament_buyin','rebuy','addon') THEN
    RAISE EXCEPTION 'tournament charge split received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  SELECT t.buy_in_amount,t.buy_in_fee,t.bounty_amount,
         t.is_bounty,t.is_pko,t.is_mystery_bounty
    INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament charge split has no tournament %',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_is_bounty := COALESCE(v_t.is_bounty,false)
              OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_kind='tournament_buyin' THEN
    SELECT * INTO v_entry FROM public.fn_tournament_entry_split(
      v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
    IF v_entry.charge IS DISTINCT FROM v_gross THEN
      RAISE EXCEPTION
        'tournament buy-in ledger amount % does not match its funded split %',
        v_gross,v_entry.charge USING ERRCODE = '23514';
    END IF;
    refund_prize := v_entry.prize;
    refund_bounty := v_entry.bounty;
    refund_fee := v_entry.rake;
  ELSIF v_kind='addon' THEN
    IF v_gross IS DISTINCT FROM round(v_gross) THEN
      RAISE EXCEPTION 'add-on charge must be a positive whole chip amount'
        USING ERRCODE = '23514';
    END IF;
    refund_prize := v_gross;
    refund_bounty := 0;
    refund_fee := 0;
  ELSE
    IF v_gross IS DISTINCT FROM round(v_gross) THEN
      RAISE EXCEPTION 'rebuy charge must be a positive whole chip amount'
        USING ERRCODE = '23514';
    END IF;
    v_ratio := CASE
      WHEN COALESCE(v_t.buy_in_amount,0)+COALESCE(v_t.buy_in_fee,0)>0
           AND COALESCE(v_t.buy_in_fee,0)>0
        THEN v_t.buy_in_fee/(v_t.buy_in_amount+v_t.buy_in_fee)
      ELSE 0.1 END;
    v_fee := LEAST(
      trunc(v_gross*v_ratio*100+0.000001)/100,
      trunc(v_gross*0.1*100+0.000001)/100);
    v_bounty := CASE WHEN v_is_bounty THEN LEAST(
      GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),v_gross-v_fee)
      ELSE 0 END;
    refund_fee := v_fee;
    refund_bounty := v_bounty;
    refund_prize := round(v_gross-v_fee-v_bounty,2);
  END IF;
  IF refund_prize IS NULL OR refund_bounty IS NULL OR refund_fee IS NULL
     OR refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR refund_prize < 0 OR refund_bounty < 0 OR refund_fee < 0
     OR v_gross IS DISTINCT FROM
          round(refund_prize+refund_bounty+refund_fee,2) THEN
    RAISE EXCEPTION 'tournament charge split produced invalid component rails'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEXT;
END;
$charge_split$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_charge_split(uuid,text,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_charge_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $capture_charge_entitlement$
DECLARE
  v_split record;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.from_type IS DISTINCT FROM 'player_wallet'
     OR NEW.to_type IS DISTINCT FROM 'prize_liability'
     OR NEW.to_entity_id IS DISTINCT FROM NEW.tournament_id
     OR lower(COALESCE(NEW.category,'')) NOT IN (
          'tournament_buyin','rebuy','addon') THEN
    RETURN NULL;
  END IF;
  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN
    RAISE EXCEPTION 'tournament charge ledger omitted player or source club'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
    NEW.tournament_id,NEW.category,NEW.amount);
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    NEW.tournament_id,NEW.from_entity_id,'wallet_charge',lower(NEW.category),
    NEW.club_id,round(NEW.amount,2),v_split.refund_prize,
    v_split.refund_bounty,v_split.refund_fee,NEW.id,NULL,NULL,NULL,
    'wallet_gross','atomic_wallet_charge',transaction_timestamp());
  RETURN NULL;
END;
$capture_charge_entitlement$;

REVOKE ALL ON FUNCTION public.fn_ca_capture_tournament_charge_entitlement()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER aa_ca_capture_tournament_charge_entitlement
  AFTER INSERT ON public.chip_ledger
  FOR EACH ROW
  WHEN (NEW.tournament_id IS NOT NULL
    AND NEW.from_type = 'player_wallet'
    AND NEW.to_type = 'prize_liability')
  EXECUTE FUNCTION public.fn_ca_capture_tournament_charge_entitlement();

-- The historical registration cores caught a roster uniqueness error after
-- debiting, issued a second compensating wallet write, and then committed.
-- Tournament row serialization already makes that branch unreachable during
-- a valid registration. If identity nevertheless changes, abort the complete
-- transaction so the debit, entitlement, reporting row and roster all roll
-- back together.
-- Complete source-controlled definitions for both registration cores follow.
-- Neither contains a compensating credit branch: a uniqueness failure raises
-- and rolls the original debit, entitlement, roster, fee and pool mutation
-- back as one transaction.

-- One admission predicate owns every RUNNING entry rail. NULL level fields
-- retain their documented fallbacks; malformed negative bounds fail closed.
CREATE OR REPLACE FUNCTION public.fn_tournament_late_registration_open(
  p_tournament_id uuid
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $canonical_late_registration$
  SELECT COALESCE((
    SELECT t.status='RUNNING'
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND COALESCE(t.current_level,0)>=0
       AND COALESCE(t.late_reg_levels,0)>=0
       AND COALESCE(t.rebuy_levels,0)>=0
       AND COALESCE(t.late_reg_mins,0)>=0
       AND (
         CASE
           WHEN COALESCE(t.late_reg_levels,t.rebuy_levels,0)>0
             THEN COALESCE(t.current_level,0)
                    <COALESCE(t.late_reg_levels,t.rebuy_levels,0)
           WHEN COALESCE(t.late_reg_mins,0)>0
             THEN t.started_at IS NOT NULL
              AND clock_timestamp()
                    <t.started_at+make_interval(mins=>t.late_reg_mins)
           ELSE false
         END
       )
       AND (
         t.max_players IS NULL OR t.max_players<=0 OR (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id=t.id
         )<t.max_players
       )
      FROM public.tournaments t
     WHERE t.id=p_tournament_id
  ),false);
$canonical_late_registration$;

REVOKE ALL ON FUNCTION public.fn_tournament_late_registration_open(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_late_registration_open(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_players_before integer;
  v_expected_cached_players integer;
  v_rows integer;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
  v_seat_reason text;                                    -- SEAT FIX 2026-08-27
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name, prize_pool_finalized,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips,
         variant
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- SEAT-FIRST GUARD 2026-08-27, REBUILT 2026-08-28. A seat-first event is
  -- bought by taking a seat; registering into one debits the player for a
  -- seat that is never allocated. But the seat path ITSELF registers the
  -- player through this function, so the guard admits that caller via
  -- p_seat_first_internal - the original guard refused it too and no human
  -- could buy a Spin or Heads-Up seat at all. And the predicate is now the
  -- CANONICAL seat-first test (variant 'spin' OR a positive max_players <= 2), matching
  -- fn_take_seat_and_buy_in and fn_sync_seat_first_player_count: the original
  -- blocked ALL sngs, which left 6-max and 9-max SNGs with no entry path in
  -- either door.
  IF NOT p_seat_first_internal
     AND (lower(COALESCE(v_t.variant, '')) = 'spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players > 0 AND v_t.max_players <= 2)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_first_variant',
      'detail', 'This format is entered by taking a seat, not by registering. '
                || 'Call fn_take_seat_and_buy_in for the seat you want.',
      'variant', v_t.variant);
  END IF;

  IF v_t.status = 'RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  SELECT count(*)::integer INTO v_players_before
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_t.current_players IS DISTINCT FROM v_players_before THEN
    RAISE EXCEPTION
      'Tournament roster cache diverged before registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  IF v_t.max_players IS NOT NULL AND v_t.max_players > 0
     AND v_players_before >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY GATE 1 (2026-08-22): owner-approved registration list.
  IF COALESCE(v_t.authorized_to_register, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_registration_approvals a
                    WHERE a.tournament_id = p_tournament_id AND a.user_id = v_uid)
       AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized_to_register');
    END IF;
  END IF;

  -- PARITY GATE 2 (2026-08-22): VIP-only events.
  IF COALESCE(v_t.is_vip_only, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr
                    WHERE pr.id = v_uid AND COALESCE(pr.is_vip, false)
                      AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.club_id = v_t.club_id AND m.user_id = v_uid
                          AND m.role IN ('owner', 'co_owner', 'admin', 'agent')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'vip_only');
    END IF;
  END IF;

  -- PARITY 3 (2026-08-22): early bird bonus chips for pre-start registration.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty',
      'detail', format('bounty %s + rake %s exceeds buy-in %s',
                       v_split.bounty, v_split.rake, v_split.charge));
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: every bounty format puts the flat bounty on
  -- the head; the mystery value is drawn from a funded inventory at the
  -- knockout, not from a seeded PRNG at the till.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT NAMES ITS COUNTERPARTY.
    -- trg_club_members_audit_chip_movement journals the wallet write below; with no
    -- declaration it landed as adjustment player_wallet -> table_stack with no
    -- tournament_id (19,538 rows / 407,412.00 a day). Declared with set_config, not
    -- fn_ca_declare_ledger, so a vocabulary miss can never refuse a buy-in (the
    -- writer falls back to adjustment on its own). The whole charge (prize + bounty
    -- + fee) is ONE wallet write and so ONE row, booked against the tournament
    -- (prize_liability) that holds all three until it completes. The four settings
    -- are restored right after so nothing later in this transaction inherits them.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_is_bounty
             THEN ' (' || v_split.prize || ' prize + ' || v_split.bounty || ' bounty + ' || v_split.rake || ' fee)'
             WHEN v_split.rake > 0
             THEN ' (' || v_split.prize || ' + ' || v_split.rake || ' fee)'
             ELSE '' END,
      NULL, NULL, p_tournament_id);
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'Tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  -- The roster trigger already writes the exact count while an event is
  -- ANNOUNCED/REGISTERING, but deliberately leaves RUNNING counts to the
  -- transaction that also seats the late entrant. Incrementing the cached
  -- value here therefore double-counted every pre-start entry. Require the
  -- exact state produced by that trigger (or the unchanged RUNNING state),
  -- then publish one roster-derived value together with the funded pools.
  v_expected_cached_players:=CASE
    WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
    ELSE v_players_before
  END;
  UPDATE public.tournaments
     SET current_players = v_players_before + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_expected_cached_players;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION
      'Tournament roster cache changed during registration'
      USING ERRCODE='40001';
  END IF;

  -- LATE SEAT 2026-08-23
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);

    -- SEAT FIX 2026-08-27: a late registrant who cannot be seated must not be
    -- charged; abort so debit, roster row, rake record and pool increments
    -- roll back together. 'already_seated_or_missing' is NOT a failure.
    v_seat_reason := v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean, false)
       AND COALESCE(v_seat_reason, '') <> 'already_seated_or_missing' THEN
      RAISE EXCEPTION
        'Late registration could not seat the player (%) - no charge has been made',
        COALESCE(v_seat_reason, 'unknown')
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END;
$function$;

REVOKE ALL ON FUNCTION
  public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;

-- The lifecycle wrapper previously duplicated the levels/minutes rule and
-- rejected NULL current_level even though the canonical authority reads it as
-- level zero. It now locks the contract, rejects closed lifecycles, and asks
-- the one predicate above for every RUNNING decision.
CREATE OR REPLACE FUNCTION
  public.fn_register_for_tournament_before_maintenance_announcement_gate(
    p_tournament_id uuid,
    p_seat_first_internal boolean
  ) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $canonical_registration_lifecycle$
DECLARE
  v_t record;
BEGIN
  SELECT t.status,COALESCE(t.prize_pool_finalized,false) AS finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_t.finalized THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF v_t.status='RUNNING' THEN
    IF NOT public.fn_tournament_late_registration_open(p_tournament_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_closed');
    END IF;
  ELSIF v_t.status NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  RETURN public.fn_register_for_tournament_before_atomic_lifecycle_gate(
    p_tournament_id,COALESCE(p_seat_first_internal,false));
END;
$canonical_registration_lifecycle$;

REVOKE ALL ON FUNCTION
  public.fn_register_for_tournament_before_maintenance_announcement_gate(
    uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
  v_start_chips integer := 0;
  v_players_before integer;
  v_rows integer;
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, start_time, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  SELECT count(*)::integer INTO v_players_before
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_t.current_players IS DISTINCT FROM v_players_before THEN
    RAISE EXCEPTION
      'Tournament roster cache diverged before horse registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  /* ONE DEFINITION OF FULL (2026-09-06). This read `current_players >=
     max_players`, and on a seat-first event that column is overwritten with
     the live SEATED count - so an emptied seat read as a vacancy and this
     function walked back through the door, up to 32 paid entries into a
     two-handed sit-and-go. fn_enforce_tournament_capacity is the authority
     and would now refuse the insert outright; asking here keeps the refusal a
     reason rather than an exception, and rolls back nothing. */
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: no roll here either. A horse and a human must
  -- enter the same event on the same terms; when the two register functions
  -- disagreed about how a bounty head was set, they were two tournaments.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN
    -- DOOR (R11 - horses and humans are identical on every path). The wallet write
    -- below is journaled by trg_club_members_audit_chip_movement; undeclared it landed
    -- as adjustment player_wallet -> table_stack with no tournament. set_config, not
    -- fn_ca_declare_ledger, for the same reason as fn_register_for_tournament: a
    -- vocabulary miss must never refuse a buy-in. Restored right after the write.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'Horse tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_horse_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',p_user_id,
                               'registration_id',v_player_id));
  END IF;

  -- ANNOUNCED/REGISTERING roster inserts already refresh the denormalized
  -- count in trg_sync_tournament_current_players. Publish the one exact
  -- post-insert count instead of incrementing that trigger result again.
  UPDATE public.tournaments
     SET current_players = v_players_before + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_players_before+1;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION
      'Tournament roster cache changed during horse registration'
      USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake);
END; $function$;

REVOKE ALL ON FUNCTION
  public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- The table lock above drained every tournament purchase before this cutover.
-- Snapshot only still-open liabilities, and refuse the migration if the two
-- existing journals do not describe the same funded charges.
INSERT INTO public.tournament_refund_entitlements(
  tournament_id,user_id,entitlement_kind,charge_category,
  refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
  source_ledger_id,registration_id,source_satellite_id,source_award_place,
  escrow_bucket,evidence_kind,created_at)
SELECT l.tournament_id,l.from_entity_id,'wallet_charge',lower(l.category),
       l.club_id,round(l.amount,2),s.refund_prize,s.refund_bounty,s.refund_fee,
       l.id,NULL,NULL,NULL,'wallet_gross','cutover_wallet_charge',
       COALESCE(l.created_at,transaction_timestamp())
  FROM public.chip_ledger l
  JOIN public.tournaments t ON t.id=l.tournament_id
 CROSS JOIN LATERAL public.fn_ca_tournament_charge_split(
   l.tournament_id,l.category,l.amount) s
 WHERE upper(COALESCE(t.status,'')) IN (
         'ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
   AND l.from_type='player_wallet'
   AND l.to_type='prize_liability'
   AND l.to_entity_id=l.tournament_id
   AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
   AND l.from_entity_id IS NOT NULL
   AND l.club_id IS NOT NULL;

DO $prove_charge_cutover$
DECLARE
  v_bad bigint;
BEGIN
  WITH active AS MATERIALIZED (
    SELECT t.id FROM public.tournaments t
     WHERE upper(COALESCE(t.status,'')) IN (
       'ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
  ), wallet AS (
    SELECT w.related_entity_id AS tournament_id,w.user_id,
           lower(w.category) AS category,count(*) AS row_count,
           round(sum(w.amount),2) AS amount
      FROM public.wallet_transactions w JOIN active a
        ON a.id=w.related_entity_id
     WHERE w.type='debit'
       AND lower(w.category) IN ('tournament_buyin','rebuy','addon')
     GROUP BY 1,2,3
  ), receipt AS (
    SELECT e.tournament_id,e.user_id,e.charge_category AS category,
           count(*) AS row_count,round(sum(e.gross),2) AS amount
      FROM public.tournament_refund_entitlements e JOIN active a
        ON a.id=e.tournament_id
     WHERE e.entitlement_kind='wallet_charge'
     GROUP BY 1,2,3
  )
  SELECT count(*) INTO v_bad
    FROM wallet w FULL JOIN receipt r
      USING(tournament_id,user_id,category)
   WHERE w.row_count IS DISTINCT FROM r.row_count
      OR w.amount IS DISTINCT FROM r.amount;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'open tournament charge cutover has % wallet/ledger receipt mismatches',
      v_bad USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions w
    JOIN public.tournaments t ON t.id=w.related_entity_id
    JOIN public.tournament_players tp
      ON tp.tournament_id=w.related_entity_id AND tp.user_id=w.user_id
    WHERE upper(COALESCE(t.status,'')) IN (
        'ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
      AND w.type='credit'
      AND lower(w.category) IN ('refund','tournament_refund')
  ) THEN
    RAISE EXCEPTION
      'open tournament roster contains a pre-cutover refund without an immutable entitlement receipt'
      USING ERRCODE = 'P0404';
  END IF;
END;
$prove_charge_cutover$;

-- Existing open qualifier seats already carry an immutable source payout and
-- pool-transfer ledger row. Bind only exact one-to-one rows. This preserves
-- live registrations without inventing a source wallet or re-pricing a seat.
DO $prove_satellite_entitlement_cutover$
DECLARE
  v_bad bigint;
BEGIN
  WITH qualifiers AS (
    SELECT tp.id,tp.tournament_id,tp.user_id,tp.source_satellite_id
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
     WHERE COALESCE(tp.is_satellite_qualifier,false)
       AND upper(COALESCE(t.status,'')) IN (
         'ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
  )
  SELECT count(*) INTO v_bad
    FROM qualifiers q
   WHERE q.source_satellite_id IS NULL
      OR (SELECT count(*) FROM public.tournament_payouts p
           WHERE p.tournament_id=q.source_satellite_id
             AND p.user_id=q.user_id AND p.source='satellite_seat') <> 1
      OR (SELECT count(*) FROM public.chip_ledger l
           WHERE l.from_type='prize_liability'
             AND l.from_entity_id=q.source_satellite_id
             AND l.to_type='prize_liability'
             AND l.to_entity_id=q.tournament_id
             AND l.metadata->>'user_id'=q.user_id::text
             AND l.metadata->>'registration_id'=q.id::text) <> 1;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'open qualifier cutover has % seats without one exact payout and pool transfer',
      v_bad USING ERRCODE = 'P0404';
  END IF;

  WITH qualifiers AS (
    SELECT tp.id,tp.tournament_id,tp.user_id,tp.source_satellite_id
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
     WHERE COALESCE(tp.is_satellite_qualifier,false)
       AND upper(COALESCE(t.status,'')) IN (
         'ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
  ), evidence AS (
    SELECT q.*,p.id AS payout_id,p."position" AS place,p.amount AS payout_amount,
           p.metadata AS payout_metadata,l.id AS ledger_id,l.club_id,
           l.amount AS ledger_amount,l.metadata AS ledger_metadata,
           CASE WHEN l.metadata->>'entry_split_version'='2'
                THEN 'satellite_gross' ELSE 'satellite_in' END AS bucket,
           (p.metadata->>'target_fee')::numeric AS fee,
           COALESCE((l.metadata->>'entry_bounty')::numeric,0) AS bounty
      FROM qualifiers q
      JOIN public.tournament_payouts p
        ON p.tournament_id=q.source_satellite_id
       AND p.user_id=q.user_id AND p.source='satellite_seat'
      JOIN public.chip_ledger l
        ON l.from_type='prize_liability'
       AND l.from_entity_id=q.source_satellite_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=q.tournament_id
       AND l.metadata->>'user_id'=q.user_id::text
       AND l.metadata->>'registration_id'=q.id::text
  )
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  SELECT e.tournament_id,e.user_id,'satellite_seat','satellite_seat',
         e.club_id,round(e.payout_amount,2),
         round(e.payout_amount-e.fee-e.bounty,2),e.bounty,e.fee,
         e.ledger_id,e.id,e.source_satellite_id,e.place,e.bucket,
         'cutover_satellite_seat',transaction_timestamp()
    FROM evidence e
   WHERE e.club_id IS NOT NULL
     AND e.place > 0
     AND e.payout_amount IS NOT NULL
     AND e.payout_amount::text NOT IN ('NaN','Infinity','-Infinity')
     AND e.payout_amount > 0
     AND e.payout_amount = round(e.payout_amount,2)
     AND e.ledger_amount IS NOT DISTINCT FROM e.payout_amount
     AND e.fee IS NOT NULL AND e.fee >= 0 AND e.fee=round(e.fee,2)
     AND e.bounty IS NOT NULL AND e.bounty >= 0
     AND e.bounty=round(e.bounty,2)
     AND e.payout_amount-e.fee-e.bounty >= 0;

  GET DIAGNOSTICS v_bad = ROW_COUNT;
  IF v_bad IS DISTINCT FROM (
    SELECT count(*) FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id=tp.tournament_id
    WHERE COALESCE(tp.is_satellite_qualifier,false)
      AND upper(COALESCE(t.status,'')) IN (
        'ANNOUNCED','REGISTERING','RUNNING','COMPLETING')
  ) THEN
    RAISE EXCEPTION
      'open qualifier cutover did not create one exact entitlement per seat'
      USING ERRCODE = 'P0404';
  END IF;
END;
$prove_satellite_entitlement_cutover$;

CREATE OR REPLACE FUNCTION public.fn_ca_capture_satellite_seat_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $capture_satellite_entitlement$
DECLARE
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_l public.chip_ledger%ROWTYPE;
  v_rows integer;
BEGIN
  IF NEW.delivery_kind IS DISTINCT FROM 'seat' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_h FROM public.tournament_satellite_settlements h
   WHERE h.tournament_id=NEW.tournament_id;
  SELECT * INTO v_l FROM public.chip_ledger l
   WHERE l.idempotency_key=NEW.idempotency_key||':pool_transfer'
     AND l.from_type='prize_liability'
     AND l.from_entity_id=NEW.tournament_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_h.target_id
     AND l.amount=NEW.amount;
  IF v_h.tournament_id IS NULL OR v_l.id IS NULL OR v_l.club_id IS NULL
     OR NEW.registration_id IS NULL
     OR v_h.ticket_cost IS DISTINCT FROM NEW.amount
     OR v_h.ticket_cost IS DISTINCT FROM
          round(v_h.target_buy_in+v_h.target_fee,2) THEN
    RAISE EXCEPTION
      'satellite seat award has no exact target contract and pool-transfer source'
      USING ERRCODE = 'P0404';
  END IF;
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    v_h.target_id,NEW.user_id,'satellite_seat','satellite_seat',
    v_l.club_id,NEW.amount,v_h.target_buy_in,0,v_h.target_fee,
    v_l.id,NEW.registration_id,NEW.tournament_id,NEW.place,
    'satellite_in','atomic_satellite_seat',transaction_timestamp())
  ON CONFLICT(source_ledger_id) DO NOTHING;
  SELECT count(*) INTO v_rows
    FROM public.tournament_refund_entitlements e
   WHERE e.source_ledger_id=v_l.id
     AND e.tournament_id=v_h.target_id AND e.user_id=NEW.user_id
     AND e.entitlement_kind='satellite_seat'
     AND e.charge_category='satellite_seat'
     AND e.refund_wallet_club_id=v_l.club_id
     AND e.gross=NEW.amount
     AND e.refund_prize=v_h.target_buy_in
     AND e.refund_bounty=0 AND e.refund_fee=v_h.target_fee
     AND e.registration_id=NEW.registration_id
     AND e.source_satellite_id=NEW.tournament_id
     AND e.source_award_place=NEW.place;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite seat entitlement identity conflicts with its source'
      USING ERRCODE = 'P0404';
  END IF;
  RETURN NULL;
END;
$capture_satellite_entitlement$;

REVOKE ALL ON FUNCTION public.fn_ca_capture_satellite_seat_entitlement()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_satellite_award_captures_refund_entitlement
  AFTER INSERT ON public.tournament_satellite_awards
  FOR EACH ROW
  WHEN (NEW.delivery_kind='seat')
  EXECUTE FUNCTION public.fn_ca_capture_satellite_seat_entitlement();

-- Cashier-issued tickets may be redeemed to chips. A returned satellite seat
-- is a different instrument: it can fund tournament entry only. Keep both in
-- the existing player-visible ticket inventory, but make the noncash contract
-- explicit and bind it one-to-one to the satellite entitlement it replaces.
ALTER TABLE public.tournament_tickets
  ADD COLUMN redemption_mode text NOT NULL DEFAULT 'wallet_chips',
  ADD COLUMN source_tournament_id uuid
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  ADD COLUMN source_satellite_id uuid
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  ADD COLUMN source_refund_entitlement_id uuid
    REFERENCES public.tournament_refund_entitlements(id) ON DELETE RESTRICT,
  ADD COLUMN entry_prize numeric(15,2),
  ADD COLUMN entry_bounty numeric(15,2),
  ADD COLUMN entry_fee numeric(15,2);

ALTER TABLE public.tournament_tickets
  ADD CONSTRAINT tournament_tickets_redemption_mode_check
    CHECK (redemption_mode IN ('wallet_chips','tournament_entry_only')),
  ADD CONSTRAINT tournament_tickets_satellite_entry_contract_check
    CHECK ((
      (redemption_mode='wallet_chips'
       AND source_tournament_id IS NULL
       AND source_satellite_id IS NULL
       AND source_refund_entitlement_id IS NULL
       AND entry_prize IS NULL AND entry_bounty IS NULL AND entry_fee IS NULL)
      OR
      (redemption_mode='tournament_entry_only'
       AND issued_by='2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
       AND source_tournament_id IS NOT NULL
       AND source_satellite_id IS NOT NULL
       AND source_refund_entitlement_id IS NOT NULL
       AND entry_prize IS NOT NULL AND entry_prize >= 0
       AND entry_prize=round(entry_prize,2)
       AND entry_bounty IS NOT NULL AND entry_bounty >= 0
       AND entry_bounty=round(entry_bounty,2)
       AND entry_fee IS NOT NULL AND entry_fee >= 0
       AND entry_fee=round(entry_fee,2)
       AND value=round(entry_prize+entry_bounty+entry_fee,2))
    ) IS TRUE);

CREATE UNIQUE INDEX tournament_ticket_one_satellite_entitlement
  ON public.tournament_tickets(source_refund_entitlement_id)
  WHERE source_refund_entitlement_id IS NOT NULL;

-- A session setting alone is not an authorization boundary because an
-- authenticated SQL caller can set arbitrary custom GUC values. Admission
-- therefore creates one private, owner-only authorization row and the ticket
-- guard consumes that row exactly once in the same transaction. A leaked or
-- stale setting cannot redeem a different ticket.
CREATE TABLE public.tournament_ticket_admission_authorizations (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL UNIQUE
    REFERENCES public.tournament_tickets(id) ON DELETE RESTRICT,
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  registration_id uuid NOT NULL UNIQUE
    REFERENCES public.tournament_players(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

ALTER TABLE public.tournament_ticket_admission_authorizations
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_ticket_admission_authorizations
  FROM PUBLIC, anon, authenticated, service_role;

-- The cashier RPCs turn ordinary issuer-funded tickets back into wallet chips.
-- Returned satellite entries are noncash instruments. Keep both functions as
-- complete source-controlled definitions and refuse the noncash row directly
-- after its locking read, before authorization checks, ledger settings, wallet
-- writes, receipt writes, or ticket mutation. The trigger below is an
-- independent database backstop for every other caller.
CREATE OR REPLACE FUNCTION public.fn_redeem_tournament_ticket(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $redeem_cash_ticket_only$
DECLARE
  v_me uuid:=auth.uid();
  v_t public.tournament_tickets%ROWTYPE;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_receipt public.chip_transactions%ROWTYPE;
  v_issue public.chip_transactions%ROWTYPE;
  v_escrow_entity uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Not Authenticated');
  END IF;
  IF p_ticket_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Choose A Ticket');
  END IF;

  SELECT * INTO v_t FROM public.tournament_tickets
   WHERE id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'error','Ticket Not Found');
  END IF;
  IF v_t.redemption_mode='tournament_entry_only' THEN
    RETURN jsonb_build_object(
      'success',false,
      'error','Tournament-Entry Tickets Can Only Be Used To Enter A Tournament');
  END IF;
  IF v_t.holder_id IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('success',false,'error','This Ticket Is Not Yours');
  END IF;
  IF v_t.status='redeemed' THEN
    SELECT * INTO v_receipt FROM public.chip_transactions
     WHERE transaction_type='tournament_ticket_redeem'
       AND metadata->>'ticket_id'=p_ticket_id::text LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success',true,'replayed',true,'value',v_t.value,
        'your_balance',(v_receipt.metadata->>'holder_balance_after')::numeric,
        'transaction_id',v_receipt.id);
    END IF;
  END IF;
  IF v_t.status<>'issued' THEN
    RETURN jsonb_build_object(
      'success',false,'error','Ticket Already '||initcap(v_t.status));
  END IF;

  SELECT * INTO v_issue FROM public.chip_transactions
   WHERE transaction_type='tournament_ticket_issue'
     AND metadata->>'ticket_id'=p_ticket_id::text LIMIT 1;
  IF FOUND AND v_issue.metadata ? 'escrow_entity_id' THEN
    IF v_issue.club_id IS DISTINCT FROM v_t.club_id
       OR v_issue.from_user_id IS DISTINCT FROM v_t.issued_by
       OR v_issue.to_user_id IS DISTINCT FROM v_t.holder_id
       OR v_issue.amount IS DISTINCT FROM v_t.value
       OR v_issue.metadata->>'escrow_entity_id'
            IS DISTINCT FROM p_ticket_id::text THEN
      RAISE EXCEPTION 'Ticket escrow receipt does not match its entitlement'
        USING ERRCODE='22023';
    END IF;
    v_escrow_entity:=p_ticket_id;
  END IF;
  SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),''))
    INTO v_context
    FROM unnest(ARRAY[
      'app.ledger_category','app.ledger_counterparty',
      'app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM set_config('app.ledger_category','ticket_redeem',true);
  PERFORM set_config('app.ledger_counterparty','escrow',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_escrow_entity::text,''),true);
  UPDATE public.club_members
     SET chip_balance=COALESCE(chip_balance,0)+v_t.value,updated_at=now()
   WHERE club_id=v_t.club_id AND user_id=v_me
     AND COALESCE(status,'active') IN ('active','approved')
   RETURNING chip_balance INTO v_after;
  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
  IF v_after IS NULL THEN
    RETURN jsonb_build_object(
      'success',false,'error','You Are No Longer A Member Of That Club');
  END IF;

  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=now()
   WHERE id=p_ticket_id;
  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_t.club_id,NULL,v_me,v_t.value,'tournament_ticket_redeem',
    'Tournament Ticket Redeemed: Escrow Released',v_after,
    jsonb_build_object(
      'ticket_id',p_ticket_id,'issuer_id',v_t.issued_by,
      'holder_id',v_t.holder_id,'escrow_action','release_to_holder',
      'holder_balance_after',v_after))
  RETURNING * INTO v_receipt;

  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,balance_after)
  VALUES(
    v_me,'PLAYER','credit',v_t.value,'transfer',
    'Tournament Ticket Redeemed: Escrow Released',v_after);

  RETURN jsonb_build_object(
    'success',true,'replayed',false,'value',v_t.value,
    'your_balance',v_after,'transaction_id',v_receipt.id);
END;
$redeem_cash_ticket_only$;

REVOKE ALL ON FUNCTION public.fn_redeem_tournament_ticket(uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_redeem_tournament_ticket(uuid)
  TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_cancel_tournament_ticket(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $cancel_cash_ticket_only$
DECLARE
  v_me uuid:=auth.uid();
  v_t public.tournament_tickets%ROWTYPE;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_receipt public.chip_transactions%ROWTYPE;
  v_issue public.chip_transactions%ROWTYPE;
  v_escrow_entity uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Not Authenticated');
  END IF;
  IF p_ticket_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Choose A Ticket');
  END IF;

  SELECT * INTO v_t FROM public.tournament_tickets
   WHERE id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'error','Ticket Not Found');
  END IF;
  IF v_t.redemption_mode='tournament_entry_only' THEN
    RETURN jsonb_build_object(
      'success',false,
      'error','Returned Tournament-Entry Tickets Cannot Be Cancelled For Chips');
  END IF;
  IF v_t.issued_by IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object(
      'success',false,'error','Only The Issuer May Cancel A Ticket');
  END IF;
  IF v_t.status='cancelled' THEN
    SELECT * INTO v_receipt FROM public.chip_transactions
     WHERE transaction_type='tournament_ticket_cancel'
       AND metadata->>'ticket_id'=p_ticket_id::text LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success',true,'replayed',true,'refunded',v_t.value,
        'your_balance',(v_receipt.metadata->>'issuer_balance_after')::numeric,
        'transaction_id',v_receipt.id);
    END IF;
  END IF;
  IF v_t.status<>'issued' THEN
    RETURN jsonb_build_object(
      'success',false,'error','Ticket Already '||initcap(v_t.status));
  END IF;

  SELECT * INTO v_issue FROM public.chip_transactions
   WHERE transaction_type='tournament_ticket_issue'
     AND metadata->>'ticket_id'=p_ticket_id::text LIMIT 1;
  IF FOUND AND v_issue.metadata ? 'escrow_entity_id' THEN
    IF v_issue.club_id IS DISTINCT FROM v_t.club_id
       OR v_issue.from_user_id IS DISTINCT FROM v_t.issued_by
       OR v_issue.to_user_id IS DISTINCT FROM v_t.holder_id
       OR v_issue.amount IS DISTINCT FROM v_t.value
       OR v_issue.metadata->>'escrow_entity_id'
            IS DISTINCT FROM p_ticket_id::text THEN
      RAISE EXCEPTION 'Ticket escrow receipt does not match its entitlement'
        USING ERRCODE='22023';
    END IF;
    v_escrow_entity:=p_ticket_id;
  END IF;
  SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),''))
    INTO v_context
    FROM unnest(ARRAY[
      'app.ledger_category','app.ledger_counterparty',
      'app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM set_config('app.ledger_category','escrow_release',true);
  PERFORM set_config('app.ledger_counterparty','escrow',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_escrow_entity::text,''),true);
  UPDATE public.club_members
     SET chip_balance=COALESCE(chip_balance,0)+v_t.value,updated_at=now()
   WHERE club_id=v_t.club_id AND user_id=v_me
     AND COALESCE(status,'active') IN ('active','approved')
   RETURNING chip_balance INTO v_after;
  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
  IF v_after IS NULL THEN
    RETURN jsonb_build_object(
      'success',false,
      'error','You Are No Longer A Member Of That Club, So The Escrow Has Nowhere To Land');
  END IF;

  UPDATE public.tournament_tickets
     SET status='cancelled',cancelled_at=now()
   WHERE id=p_ticket_id;
  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_t.club_id,NULL,v_me,v_t.value,'tournament_ticket_cancel',
    'Tournament Ticket Cancelled: Escrow Refunded',v_after,
    jsonb_build_object(
      'ticket_id',p_ticket_id,'issuer_id',v_t.issued_by,
      'holder_id',v_t.holder_id,'escrow_action','refund_to_issuer',
      'issuer_balance_after',v_after))
  RETURNING * INTO v_receipt;

  RETURN jsonb_build_object(
    'success',true,'replayed',false,'refunded',v_t.value,
    'your_balance',v_after,'transaction_id',v_receipt.id);
END;
$cancel_cash_ticket_only$;

REVOKE ALL ON FUNCTION public.fn_cancel_tournament_ticket(uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_cancel_tournament_ticket(uuid)
  TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_entry_ticket_is_guarded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_entry_ticket_guard$
DECLARE
  v_token uuid := NULLIF(
    current_setting('app.ca_satellite_ticket_use_token',true),'')::uuid;
  v_authorization public.tournament_ticket_admission_authorizations%ROWTYPE;
  v_rows integer;
BEGIN
  IF TG_OP='DELETE' AND OLD.redemption_mode='tournament_entry_only' THEN
    RAISE EXCEPTION 'tournament-entry tickets are durable financial evidence'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.redemption_mode='tournament_entry_only' THEN
    IF ROW(NEW.id,NEW.club_id,NEW.issued_by,NEW.holder_id,NEW.value,NEW.note,
           NEW.redemption_mode,NEW.source_tournament_id,
           NEW.source_satellite_id,NEW.source_refund_entitlement_id,
           NEW.entry_prize,NEW.entry_bounty,NEW.entry_fee,NEW.created_at,
           NEW.cancelled_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.club_id,OLD.issued_by,OLD.holder_id,OLD.value,OLD.note,
           OLD.redemption_mode,OLD.source_tournament_id,
           OLD.source_satellite_id,OLD.source_refund_entitlement_id,
           OLD.entry_prize,OLD.entry_bounty,OLD.entry_fee,OLD.created_at,
           OLD.cancelled_at) THEN
      RAISE EXCEPTION 'tournament-entry ticket identity and rails are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.status='issued' AND NEW.status='redeemed'
              AND v_token IS NOT NULL
              AND OLD.redeemed_at IS NULL
              AND NEW.redeemed_at IS NOT NULL
              AND NEW.redeemed_at=transaction_timestamp()) THEN
        RAISE EXCEPTION
          'tournament-entry tickets can only be consumed by tournament admission'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO v_authorization
        FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id
       FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.user_id IS DISTINCT FROM OLD.holder_id
         OR NOT EXISTS(
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.id=v_authorization.registration_id
              AND tp.tournament_id=v_authorization.tournament_id
              AND tp.user_id=v_authorization.user_id
              AND tp.status::text IN ('registered','playing')) THEN
        RAISE EXCEPTION
          'tournament-entry ticket has no exact admission authorization'
          USING ERRCODE = '42501';
      END IF;
      DELETE FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION
          'tournament-entry ticket admission authorization was not consumed once'
          USING ERRCODE = 'P0404';
      END IF;
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at THEN
      RAISE EXCEPTION
        'tournament-entry ticket redemption time is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$satellite_entry_ticket_guard$;

REVOKE ALL ON FUNCTION public.fn_ca_satellite_entry_ticket_is_guarded()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_satellite_entry_ticket_is_guarded
  BEFORE UPDATE OR DELETE ON public.tournament_tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_satellite_entry_ticket_is_guarded();

CREATE OR REPLACE FUNCTION public.fn_ca_return_satellite_entitlement_as_ticket(
  p_entitlement_id uuid,
  p_source text,
  p_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $return_satellite_ticket$
DECLARE
  v_e public.tournament_refund_entitlements%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_tournament_id uuid;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_key text;
  v_before numeric;
  v_rows integer;
  v_ledger_id uuid;
  v_tx_id uuid;
BEGIN
  IF p_entitlement_id IS NULL OR p_source IS NULL
     OR length(btrim(p_source))=0 OR p_description IS NULL
     OR length(btrim(p_description))=0 THEN
    RAISE EXCEPTION 'satellite ticket return received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_settle_sources s
     WHERE s.source=lower(btrim(p_source))) THEN
    RAISE EXCEPTION 'satellite ticket return source % is not an authority',p_source
      USING ERRCODE = '42501';
  END IF;
  SELECT e.tournament_id INTO v_tournament_id
    FROM public.tournament_refund_entitlements e
   WHERE e.id=p_entitlement_id;
  IF v_tournament_id IS NULL THEN
    RAISE EXCEPTION 'satellite refund entitlement % does not exist',p_entitlement_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=v_tournament_id FOR UPDATE;
  SELECT * INTO v_e FROM public.tournament_refund_entitlements e
   WHERE e.id=p_entitlement_id FOR UPDATE;
  IF v_e.id IS NULL
     OR v_e.entitlement_kind NOT IN ('satellite_seat','tournament_ticket')
     OR v_e.tournament_id IS DISTINCT FROM v_t.id THEN
    RAISE EXCEPTION
      'entitlement % is not a satellite-funded tournament entry',p_entitlement_id
      USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_tranches tr
     WHERE tr.entitlement_id=v_e.id) THEN
    RAISE EXCEPTION 'satellite seat entitlement was incorrectly converted to chips'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.source_refund_entitlement_id=v_e.id FOR UPDATE;
  IF FOUND THEN
    SELECT count(*),min(l.id::text)::uuid
      INTO v_rows,v_ledger_id FROM public.chip_ledger l
     WHERE l.idempotency_key='tourney:'||v_e.tournament_id::text
             ||':satellite-ticket-return:'||v_e.id::text
       AND l.from_type='prize_liability'
       AND l.from_entity_id=v_e.tournament_id
       AND l.to_type='escrow' AND l.to_entity_id=v_ticket.id
       AND l.club_id=v_e.refund_wallet_club_id AND l.amount=v_e.gross;
    IF v_rows<>1 OR v_ledger_id IS NULL
       OR (SELECT count(*) FROM public.chip_transactions ct
            WHERE ct.transaction_type='tournament_ticket_issue'
              AND ct.club_id=v_e.refund_wallet_club_id
              AND ct.from_user_id IS NULL AND ct.to_user_id=v_e.user_id
              AND ct.amount=v_e.gross
              AND ct.metadata->>'ticket_id'=v_ticket.id::text
              AND ct.metadata->>'entitlement_id'=v_e.id::text
              AND ct.metadata->>'ledger_id'=v_ledger_id::text) <> 1
       OR v_ticket.status NOT IN ('issued','redeemed')
       OR v_ticket.holder_id IS DISTINCT FROM v_e.user_id
       OR v_ticket.value IS DISTINCT FROM v_e.gross
       OR v_ticket.redemption_mode<>'tournament_entry_only'
       OR v_ticket.source_tournament_id IS DISTINCT FROM v_e.tournament_id
       OR v_ticket.source_satellite_id IS DISTINCT FROM v_e.source_satellite_id
       OR v_ticket.source_refund_entitlement_id IS DISTINCT FROM v_e.id
       OR v_ticket.entry_prize IS DISTINCT FROM v_e.refund_prize
       OR v_ticket.entry_bounty IS DISTINCT FROM v_e.refund_bounty
       OR v_ticket.entry_fee IS DISTINCT FROM v_e.refund_fee THEN
      RAISE EXCEPTION 'satellite ticket replay evidence is incomplete'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'replayed',true,'ticket_id',v_ticket.id,
      'entitlement_id',v_e.id,'value',v_e.gross,
      'refund_prize',v_e.refund_prize,
      'refund_bounty',v_e.refund_bounty,'refund_fee',v_e.refund_fee,
      'refund_wallet_club_id',v_e.refund_wallet_club_id);
  END IF;

  PERFORM public.fn_ca_escrow_apply(
    v_e.tournament_id,'satellite ticket return escrow prelock');
  SELECT round(e.prize_balance+e.bounty_balance+e.fee_balance,2)
    INTO v_before FROM public.tournament_escrow e
   WHERE e.tournament_id=v_e.tournament_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'satellite ticket return has no enforced target escrow'
      USING ERRCODE = 'P0404';
  END IF;
  v_ticket.id:=gen_random_uuid();
  INSERT INTO public.tournament_tickets(
    id,club_id,issued_by,holder_id,value,status,note,
    redemption_mode,source_tournament_id,source_satellite_id,
    source_refund_entitlement_id,entry_prize,entry_bounty,entry_fee,created_at)
  VALUES(
    v_ticket.id,v_e.refund_wallet_club_id,
    '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
    v_e.user_id,v_e.gross,'issued',
    p_description,'tournament_entry_only',v_e.tournament_id,
    v_e.source_satellite_id,v_e.id,v_e.refund_prize,v_e.refund_bounty,
    v_e.refund_fee,transaction_timestamp())
  RETURNING * INTO v_ticket;
  v_key:='tourney:'||v_e.tournament_id::text
         ||':satellite-ticket-return:'||v_e.id::text;
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'prize_liability',v_e.tournament_id,'tournaments escrow',
    'escrow',v_ticket.id,'satellite tournament entry ticket',
    v_e.gross,'ticket_issue',v_e.refund_wallet_club_id,v_e.tournament_id,
    v_key,'satellite-ticket:'||v_ticket.id::text,lower(btrim(p_source)),
    p_description,jsonb_build_object(
      'kind','tournament_entry_ticket_return','ticket_id',v_ticket.id,
      'entitlement_id',v_e.id,'user_id',v_e.user_id,
      'entitlement_kind',v_e.entitlement_kind,
      'source_satellite_id',v_e.source_satellite_id,
      'refund_prize',v_e.refund_prize,'refund_bounty',v_e.refund_bounty,
      'refund_fee',v_e.refund_fee),
    v_before,round(v_before-v_e.gross,2),0,v_e.gross)
  RETURNING id INTO v_ledger_id;
  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_e.refund_wallet_club_id,NULL,v_e.user_id,v_e.gross,
    'tournament_ticket_issue',p_description,NULL,jsonb_build_object(
      'ticket_id',v_ticket.id,'escrow_entity_id',v_ticket.id,
      'holder_id',v_e.user_id,'value',v_e.gross,
      'redemption_mode','tournament_entry_only',
      'source_tournament_id',v_e.tournament_id,
      'source_satellite_id',v_e.source_satellite_id,
      'entitlement_id',v_e.id,'entitlement_kind',v_e.entitlement_kind,
      'ledger_id',v_ledger_id,
      'idempotency_key',v_key))
  RETURNING id INTO v_tx_id;
  PERFORM public.fn_ca_escrow_apply_exact_refund(
    v_e.tournament_id,'satellite seat returned as tournament ticket',
    v_e.refund_prize,v_e.refund_bounty,v_e.refund_fee);
  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'entitlement_id',v_e.id,'value',v_e.gross,
    'refund_prize',v_e.refund_prize,
    'refund_bounty',v_e.refund_bounty,'refund_fee',v_e.refund_fee,
    'refund_wallet_club_id',v_e.refund_wallet_club_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id);
END;
$return_satellite_ticket$;

REVOKE ALL ON FUNCTION public.fn_ca_return_satellite_entitlement_as_ticket(
  uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;

-- Every exact refund credit carries the entitlement identity and the prize,
-- bounty and fee rails that fund that one wallet movement.
CREATE TABLE public.tournament_refund_tranches (
  wallet_transaction_id uuid PRIMARY KEY
    REFERENCES public.wallet_transactions(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE
    REFERENCES public.wallet_credit_idempotency(key) ON DELETE RESTRICT,
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  obligation_id uuid NOT NULL
    REFERENCES public.tournament_obligations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  source_wallet_club_id uuid NOT NULL
    REFERENCES public.clubs(id) ON DELETE RESTRICT,
  entitlement_id uuid NOT NULL UNIQUE
    REFERENCES public.tournament_refund_entitlements(id) ON DELETE RESTRICT,
  credit_ledger_id uuid NOT NULL UNIQUE
    REFERENCES public.chip_ledger(id) ON DELETE RESTRICT,
  amount_paid_before numeric(15,2) NOT NULL,
  amount_paid_now numeric(15,2) NOT NULL,
  refund_prize numeric(15,2) NOT NULL,
  refund_bounty numeric(15,2) NOT NULL,
  refund_fee numeric(15,2) NOT NULL,
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (obligation_id,amount_paid_before),
  CHECK (amount_paid_before >= 0
     AND amount_paid_before::text NOT IN ('NaN','Infinity','-Infinity')
     AND amount_paid_before = round(amount_paid_before,2)),
  CHECK (amount_paid_now::text NOT IN ('NaN','Infinity','-Infinity')
     AND amount_paid_now > 0 AND amount_paid_now = round(amount_paid_now,2)),
  CHECK (refund_prize::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_prize >= 0 AND refund_prize = round(refund_prize,2)),
  CHECK (refund_bounty::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_bounty >= 0 AND refund_bounty = round(refund_bounty,2)),
  CHECK (refund_fee::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_fee >= 0 AND refund_fee = round(refund_fee,2)),
  CHECK (amount_paid_now = refund_prize + refund_bounty + refund_fee),
  CHECK (idempotency_key = 'tourney:' || tournament_id::text
         || ':refund-entitlement:' || entitlement_id::text)
);

-- This one-use row is the capability the wallet trigger consumes. A custom
-- session setting only points at the row; it is never authority by itself.
-- Browser and service roles cannot read or create capabilities.
CREATE TABLE public.tournament_refund_authorizations (
  token uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  tournament_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_wallet_club_id uuid NOT NULL
    REFERENCES public.clubs(id) ON DELETE RESTRICT,
  entitlement_id uuid NOT NULL UNIQUE
    REFERENCES public.tournament_refund_entitlements(id) ON DELETE RESTRICT,
  amount_paid_before numeric(15,2) NOT NULL,
  amount_paid_now numeric(15,2) NOT NULL,
  refund_prize numeric(15,2) NOT NULL,
  refund_bounty numeric(15,2) NOT NULL,
  refund_fee numeric(15,2) NOT NULL,
  source text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (amount_paid_before >= 0
     AND amount_paid_before::text NOT IN ('NaN','Infinity','-Infinity')
     AND amount_paid_before = round(amount_paid_before,2)),
  CHECK (amount_paid_now::text NOT IN ('NaN','Infinity','-Infinity')
     AND amount_paid_now > 0 AND amount_paid_now = round(amount_paid_now,2)),
  CHECK (refund_prize::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_prize >= 0 AND refund_prize = round(refund_prize,2)),
  CHECK (refund_bounty::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_bounty >= 0 AND refund_bounty = round(refund_bounty,2)),
  CHECK (refund_fee::text NOT IN ('NaN','Infinity','-Infinity')
     AND refund_fee >= 0 AND refund_fee = round(refund_fee,2)),
  CHECK (amount_paid_now = refund_prize + refund_bounty + refund_fee),
  CHECK (length(btrim(source)) > 0),
  CHECK (length(btrim(description)) > 0)
);

-- One immutable receipt makes the complete unregister intent replayable after
-- a lost response. The registration row is deliberately not a foreign key:
-- successful unregistration deletes it in the same transaction and preserves
-- its id here as the durable idempotency identity.
CREATE TABLE public.tournament_unregistration_receipts (
  registration_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  source_table_id uuid REFERENCES public.tables(id) ON DELETE RESTRICT,
  refunded_chips numeric(15,2) NOT NULL,
  returned_ticket_value numeric(15,2) NOT NULL,
  entitlement_ids uuid[] NOT NULL,
  ticket_ids uuid[] NOT NULL,
  source_wallet_club_ids uuid[] NOT NULL,
  credit_ledger_ids uuid[] NOT NULL,
  wallet_transaction_ids uuid[] NOT NULL,
  fees_reversed numeric(15,2) NOT NULL,
  fee_reversal_ids uuid[] NOT NULL,
  fee_source_rake_record_ids uuid[] NOT NULL,
  seat_number integer,
  seats_taken integer,
  scheduled_start_at timestamptz NOT NULL,
  settled_at timestamptz NOT NULL,
  CHECK (refunded_chips >= 0
     AND refunded_chips::text NOT IN ('NaN','Infinity','-Infinity')
     AND refunded_chips=round(refunded_chips,2)),
  CHECK (returned_ticket_value >= 0
     AND returned_ticket_value::text NOT IN ('NaN','Infinity','-Infinity')
     AND returned_ticket_value=round(returned_ticket_value,2)),
  CHECK (fees_reversed >= 0
     AND fees_reversed::text NOT IN ('NaN','Infinity','-Infinity')
     AND fees_reversed=round(fees_reversed,2)),
  CHECK (array_position(entitlement_ids,NULL) IS NULL
     AND array_position(ticket_ids,NULL) IS NULL
     AND array_position(source_wallet_club_ids,NULL) IS NULL
     AND array_position(credit_ledger_ids,NULL) IS NULL
     AND array_position(wallet_transaction_ids,NULL) IS NULL
     AND array_position(fee_reversal_ids,NULL) IS NULL
     AND array_position(fee_source_rake_record_ids,NULL) IS NULL),
  CHECK (cardinality(entitlement_ids)=cardinality(source_wallet_club_ids)),
  CHECK (cardinality(entitlement_ids)=
         cardinality(ticket_ids)+cardinality(wallet_transaction_ids)),
  CHECK (cardinality(credit_ledger_ids)=cardinality(wallet_transaction_ids)),
  CHECK ((returned_ticket_value=0)=(cardinality(ticket_ids)=0)),
  CHECK ((refunded_chips=0)=(cardinality(wallet_transaction_ids)=0)),
  CHECK ((fees_reversed=0)=(cardinality(fee_reversal_ids)=0)),
  CHECK ((fees_reversed=0)=(cardinality(fee_source_rake_record_ids)=0)),
  CHECK ((source_table_id IS NULL AND seat_number IS NULL)
      OR (source_table_id IS NOT NULL AND seat_number IS NOT NULL)),
  CHECK (settled_at < scheduled_start_at)
);

CREATE INDEX tournament_unregistration_receipt_replay
  ON public.tournament_unregistration_receipts(
    tournament_id,user_id,source_table_id,settled_at DESC,registration_id);
CREATE INDEX tournament_unregistration_receipt_fee_reversals
  ON public.tournament_unregistration_receipts
  USING gin(fee_reversal_ids);
CREATE INDEX tournament_unregistration_receipt_fee_sources
  ON public.tournament_unregistration_receipts
  USING gin(fee_source_rake_record_ids);

ALTER TABLE public.tournament_satellite_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_satellite_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_satellite_remainders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_refund_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_refund_tranches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_refund_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_unregistration_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_satellite_settlements,
              public.tournament_satellite_awards,
              public.tournament_satellite_remainders,
              public.tournament_refund_entitlements,
              public.tournament_refund_tranches,
              public.tournament_refund_authorizations,
              public.tournament_unregistration_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_satellite_settlement_receipts_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $satellite_receipts_append_only$
BEGIN
  RAISE EXCEPTION
    'satellite settlement evidence is immutable; % is refused for tournament %',
    TG_OP, OLD.tournament_id USING ERRCODE = '55000';
END;
$satellite_receipts_append_only$;

REVOKE ALL ON FUNCTION public.fn_satellite_settlement_receipts_are_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_satellite_settlements_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_satellite_settlements
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();
CREATE TRIGGER tournament_satellite_awards_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_satellite_awards
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();
CREATE TRIGGER tournament_satellite_remainders_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_satellite_remainders
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();
CREATE TRIGGER tournament_refund_entitlements_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_refund_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();
CREATE TRIGGER tournament_refund_tranches_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_refund_tranches
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();
CREATE TRIGGER tournament_unregistration_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_unregistration_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();

-- Once an unregistration receipt names the positive fee sources and their
-- negative reversals, both sides are financial evidence. Refuse mutation at
-- the journal itself so replay never depends on a watcher or later repair.
CREATE OR REPLACE FUNCTION public.fn_ca_unregistration_rake_evidence_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $unregistration_rake_evidence_is_immutable$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournament_unregistration_receipts receipt
     WHERE ARRAY[OLD.id] && receipt.fee_reversal_ids
        OR ARRAY[OLD.id] && receipt.fee_source_rake_record_ids) THEN
    RAISE EXCEPTION
      'committed tournament unregistration rake evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$unregistration_rake_evidence_is_immutable$;

REVOKE ALL ON FUNCTION
  public.fn_ca_unregistration_rake_evidence_is_immutable()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER tournament_unregistration_rake_evidence_is_immutable
  BEFORE UPDATE OR DELETE ON public.rake_records
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_ca_unregistration_rake_evidence_is_immutable();

-- A direct charge receipt and its reporting wallet debit must both exist by
-- commit. This is deliberately deferred because the canonical buy-in writes
-- the source ledger before its wallet transaction, while rebuy does the same
-- work in the opposite half of a longer atomic purchase.
CREATE OR REPLACE FUNCTION public.fn_ca_refund_entitlement_commit_valid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $refund_entitlement_commit_valid$
DECLARE
  v_ent_count bigint;
  v_ent_amount numeric;
  v_wallet_count bigint;
  v_wallet_amount numeric;
  v_rows integer;
BEGIN
  IF NEW.entitlement_kind='wallet_charge' THEN
    SELECT count(*) INTO v_rows FROM public.chip_ledger l
     WHERE l.id=NEW.source_ledger_id
       AND l.tournament_id=NEW.tournament_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='player_wallet' AND l.from_entity_id=NEW.user_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND lower(l.category)=NEW.charge_category
       AND l.amount=NEW.gross;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'wallet charge entitlement lost its exact source ledger'
        USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*),round(COALESCE(sum(e.gross),0),2)
      INTO v_ent_count,v_ent_amount
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=NEW.tournament_id AND e.user_id=NEW.user_id
       AND e.entitlement_kind='wallet_charge'
       AND e.charge_category=NEW.charge_category;
    SELECT count(*),round(COALESCE(sum(w.amount),0),2)
      INTO v_wallet_count,v_wallet_amount
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=NEW.tournament_id AND w.user_id=NEW.user_id
       AND w.type='debit' AND lower(w.category)=NEW.charge_category;
    IF v_ent_count IS DISTINCT FROM v_wallet_count
       OR v_ent_amount IS DISTINCT FROM v_wallet_amount THEN
      RAISE EXCEPTION
        'wallet charge entitlement and reporting debit do not commit together'
        USING ERRCODE = 'P0404';
    END IF;
  ELSIF NEW.entitlement_kind='satellite_seat' THEN
    SELECT count(*) INTO v_rows FROM public.chip_ledger l
     WHERE l.id=NEW.source_ledger_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='prize_liability'
       AND l.from_entity_id=NEW.source_satellite_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND l.amount=NEW.gross
       AND l.metadata->>'user_id'=NEW.user_id::text
       AND l.metadata->>'registration_id'=NEW.registration_id::text;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite seat entitlement lost its exact pool transfer'
        USING ERRCODE = 'P0404';
    END IF;
  ELSE
    SELECT count(*) INTO v_rows
      FROM public.chip_ledger l
      JOIN public.tournament_tickets tk ON tk.id=NEW.source_ticket_id
     WHERE l.id=NEW.source_ledger_id
       AND l.tournament_id=NEW.tournament_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='escrow' AND l.from_entity_id=NEW.source_ticket_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND l.category='ticket_redeem' AND l.amount=NEW.gross
       AND l.metadata->>'user_id'=NEW.user_id::text
       AND l.metadata->>'registration_id'=NEW.registration_id::text
       AND tk.holder_id=NEW.user_id
       AND tk.status='redeemed'
       AND tk.redemption_mode='tournament_entry_only'
       AND tk.value=NEW.gross
       AND tk.entry_prize=NEW.refund_prize
       AND tk.entry_bounty=NEW.refund_bounty
       AND tk.entry_fee=NEW.refund_fee
       AND tk.source_satellite_id=NEW.source_satellite_id;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament-ticket entitlement lost its exact admission transfer'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
  RETURN NULL;
END;
$refund_entitlement_commit_valid$;

REVOKE ALL ON FUNCTION public.fn_ca_refund_entitlement_commit_valid()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER tournament_refund_entitlement_commit_valid
  AFTER INSERT ON public.tournament_refund_entitlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_refund_entitlement_commit_valid();

-- Put the economic-contract lock on the parent row that every editor must
-- update. A statement queued behind registration sees the new parent version
-- through PostgreSQL's row recheck and cannot rely on a stale child-table
-- snapshot to overwrite the now-funded contract.
ALTER TABLE public.tournaments
  ADD COLUMN entry_contract_locked boolean NOT NULL DEFAULT false;

UPDATE public.tournaments t
   SET entry_contract_locked=true
 WHERE EXISTS(
   SELECT 1 FROM public.tournament_refund_entitlements e
    WHERE e.tournament_id=t.id);

CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_contract_from_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $lock_contract_from_entitlement$
BEGIN
  UPDATE public.tournaments t
     SET entry_contract_locked=true
   WHERE t.id=NEW.tournament_id AND NOT t.entry_contract_locked;
  RETURN NULL;
END;
$lock_contract_from_entitlement$;

REVOKE ALL ON FUNCTION public.fn_ca_lock_tournament_contract_from_entitlement()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tournament_refund_entitlement_locks_parent_contract
  AFTER INSERT ON public.tournament_refund_entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_lock_tournament_contract_from_entitlement();

-- A target's entry contract becomes durable the instant a real satellite seat
-- is delivered. Install this guard in the satellite migration itself, rather
-- than waiting for the later terminal-hardening migration, so there is no
-- rolling-deploy window in which the header and target can diverge.
CREATE OR REPLACE FUNCTION public.fn_satellite_target_contract_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_target_contract_guard$
BEGIN
  IF COALESCE(OLD.entry_contract_locked,false)
     AND NEW.entry_contract_locked IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'tournament % funded-entry contract marker cannot be cleared',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.buy_in_amount,NEW.buy_in_fee,NEW.bounty_amount,
      NEW.rebuy_cost,NEW.addon_cost,
      NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,NEW.is_premium_spin,
      NEW.variant,NEW.tournament_type,NEW.club_id)
       IS NOT DISTINCT FROM
     (OLD.buy_in_amount,OLD.buy_in_fee,OLD.bounty_amount,
      OLD.rebuy_cost,OLD.addon_cost,
      OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,OLD.is_premium_spin,
      OLD.variant,OLD.tournament_type,OLD.club_id) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.entry_contract_locked,false) THEN
    RAISE EXCEPTION
      'tournament % economic contract is immutable after its first funded entry',
      OLD.id USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.tournament_id = OLD.id
       AND l.from_type = 'player_wallet'
       AND l.to_type = 'prize_liability'
       AND l.to_entity_id = OLD.id
       AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
  ) OR EXISTS (
    SELECT 1
      FROM public.tournament_satellite_settlements h
      JOIN public.tournament_satellite_awards a
        ON a.tournament_id = h.tournament_id
       AND a.delivery_kind = 'seat'
     WHERE h.target_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'tournament % economic contract is immutable after its first funded entry',
      OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$satellite_target_contract_guard$;

REVOKE ALL ON FUNCTION public.fn_satellite_target_contract_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS satellite_target_contract_is_immutable
  ON public.tournaments;
CREATE TRIGGER satellite_target_contract_is_immutable
  BEFORE UPDATE OF buy_in_amount,buy_in_fee,bounty_amount,rebuy_cost,addon_cost,
    is_bounty,is_pko,is_mystery_bounty,is_premium_spin,
    variant,tournament_type,club_id,entry_contract_locked
  ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_satellite_target_contract_is_immutable();

COMMENT ON TABLE public.tournament_satellite_settlements IS
  'Immutable whole-pool satellite settlement header. Final pool = full ticket awards plus at most one next-finisher residual; exact source tables and seats close in the same transaction.';
COMMENT ON TABLE public.tournament_satellite_awards IS
  'Immutable per-place full-ticket delivery evidence. Each line is exactly one actual target seat or one exact cash substitution.';
COMMENT ON TABLE public.tournament_satellite_remainders IS
  'Immutable evidence for the one next-finisher residual. Atomic rows bind the canonical place key; the single named legacy row preserves its original append-only financial evidence.';
COMMENT ON TABLE public.tournament_refund_entitlements IS
  'Immutable per-purchase or noncash-entry source facts. Wallet charges may return only to their recorded club wallet; satellite and ticket entries may return only as tournament-entry tickets.';
COMMENT ON TABLE public.tournament_refund_tranches IS
  'Immutable per-credit refund rail evidence. Each row binds one wallet credit and obligation offset to exact prize, bounty and fee escrow debits.';
COMMENT ON TABLE public.tournament_refund_authorizations IS
  'Owner-only one-use capabilities consumed inside the exact wallet-refund transaction. No browser or service role can inspect or mint them.';
COMMENT ON TABLE public.tournament_unregistration_receipts IS
  'Immutable, request-keyed outcome of one exact pre-start registration removal. It records the scheduled-start cutoff, wallet and tournament-ticket rails separately, and the exact original and reversing rake row ids by fee-recipient club, so a lost response can be replayed without performing a post-start unregister or reconstructing money from mutable tournament pricing or the funding wallet club.';
COMMENT ON TABLE public.tournament_ticket_admission_authorizations IS
  'Owner-only one-use capabilities consumed by the ticket row guard during atomic tournament admission. Session settings alone never authorize redemption.';
COMMENT ON COLUMN public.tournament_tickets.redemption_mode IS
  'wallet_chips for cashier-issued value; tournament_entry_only for returned satellite value that can never be redeemed or cancelled into chips.';

-- Exact refunds never infer their rails from event-wide ratios. The caller
-- opens and locks escrow first; this primitive moves the three named banks and
-- refuses the wallet statement if even one would become negative.
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply_exact_refund(
  p_tournament_id uuid,
  p_what text,
  p_refund_prize numeric,
  p_refund_bounty numeric,
  p_refund_fee numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $exact_refund_escrow$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_prize numeric := round(COALESCE(p_refund_prize,0),2);
  v_bounty numeric := round(COALESCE(p_refund_bounty,0),2);
  v_fee numeric := round(COALESCE(p_refund_fee,0),2);
BEGIN
  IF p_tournament_id IS NULL
     OR p_refund_prize IS NULL OR p_refund_bounty IS NULL OR p_refund_fee IS NULL
     OR p_refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_prize < 0 OR p_refund_bounty < 0 OR p_refund_fee < 0
     OR p_refund_prize IS DISTINCT FROM v_prize
     OR p_refund_bounty IS DISTINCT FROM v_bounty
     OR p_refund_fee IS DISTINCT FROM v_fee
     OR v_prize + v_bounty + v_fee <= 0 THEN
    RAISE EXCEPTION 'exact refund requires finite nonnegative whole-cent rails'
      USING ERRCODE = '22003';
  END IF;

  UPDATE public.tournament_escrow
     SET refund_prize = refund_prize + v_prize,
         refund_bounty = refund_bounty + v_bounty,
         refund_fee = refund_fee + v_fee,
         prize_balance = round(
           (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in
           - reserve_out + reserve_in - prize_out - refund_prize - v_prize,2),
         bounty_balance = round(
           bounty_in - bounty_out - refund_bounty - v_bounty,2),
         fee_balance = round(
           fee_entries_in + satellite_fee_in - fee_out - refund_fee - v_fee,2),
         updated_at = now()
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;
  IF v.tournament_id IS NULL OR v.enforced IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'exact refund escrow for tournament % is absent or unenforced',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v.prize_balance IS NULL OR v.bounty_balance IS NULL OR v.fee_balance IS NULL
     OR v.refund_prize IS NULL OR v.refund_bounty IS NULL OR v.refund_fee IS NULL
     OR v.prize_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.bounty_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR v.prize_balance IS DISTINCT FROM round(v.prize_balance,2)
     OR v.bounty_balance IS DISTINCT FROM round(v.bounty_balance,2)
     OR v.fee_balance IS DISTINCT FROM round(v.fee_balance,2)
     OR v.refund_prize IS DISTINCT FROM round(v.refund_prize,2)
     OR v.refund_bounty IS DISTINCT FROM round(v.refund_bounty,2)
     OR v.refund_fee IS DISTINCT FROM round(v.refund_fee,2)
     OR v.prize_balance < -0.005
     OR v.bounty_balance < -0.005
     OR v.fee_balance < -0.005 THEN
    RAISE EXCEPTION
      'escrow_short: tournament % cannot pay exact % rails %, %, %; balances would be %, %, %',
      p_tournament_id,p_what,v_prize,v_bounty,v_fee,
      v.prize_balance,v.bounty_balance,v.fee_balance USING ERRCODE = 'P0403';
  END IF;
END;
$exact_refund_escrow$;

REVOKE ALL ON FUNCTION public.fn_ca_escrow_apply_exact_refund(
  uuid,text,numeric,numeric,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

-- A returned satellite seat is spent directly into another matching
-- tournament. No player wallet participates in either direction. Admission,
-- ticket consumption, pool funding, fee evidence, roster creation, optional
-- late seating and the next immutable refund entitlement commit together.
CREATE OR REPLACE FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(
  p_tournament_id uuid,
  p_ticket_id uuid,
  p_beneficiary_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $ticket_admission_for$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_split record;
  v_username text;
  v_registration_id uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_entitlement_id uuid;
  v_resolved_club uuid;
  v_is_bounty boolean;
  v_late_open boolean:=false;
  v_start_chips integer:=0;
  v_seat jsonb;
  v_seat_reason text;
  v_players_before integer;
  v_wallet_rows_before bigint;
  v_wallet_rows_after bigint;
  v_rows integer;
  v_key text;
  v_ticket_use_token uuid:=gen_random_uuid();
  v_previous_ticket_use_token text:=
    current_setting('app.ca_satellite_ticket_use_token',true);
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  IF v_ticket.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_ticket.redemption_mode IS DISTINCT FROM 'tournament_entry_only' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_is_wallet_only');
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_refund_entitlements source_e
    JOIN public.chip_ledger issue_l
      ON issue_l.idempotency_key='tourney:'
           ||source_e.tournament_id::text
           ||':satellite-ticket-return:'||source_e.id::text
     AND issue_l.from_type='prize_liability'
     AND issue_l.from_entity_id=source_e.tournament_id
     AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
     AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
     AND issue_l.category='ticket_issue'
   WHERE source_e.id=v_ticket.source_refund_entitlement_id
     AND source_e.user_id=v_uid
     AND source_e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND source_e.gross=v_ticket.value
     AND source_e.refund_prize=v_ticket.entry_prize
     AND source_e.refund_bounty=v_ticket.entry_bounty
     AND source_e.refund_fee=v_ticket.entry_fee
     AND source_e.source_satellite_id=v_ticket.source_satellite_id
     AND source_e.tournament_id=v_ticket.source_tournament_id
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=source_e.id)
     AND (SELECT count(*) FROM public.chip_transactions issue_tx
           WHERE issue_tx.transaction_type='tournament_ticket_issue'
             AND issue_tx.club_id=v_ticket.club_id
             AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
             AND issue_tx.amount=v_ticket.value
             AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
             AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
             AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket has no exact noncash issue evidence'
      USING ERRCODE='P0404';
  END IF;

  IF v_ticket.status='redeemed' THEN
    SELECT count(*),min(e.id::text)::uuid,min(e.registration_id::text)::uuid
      INTO v_rows,v_entitlement_id,v_registration_id
      FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
     WHERE e.source_ticket_id=v_ticket.id
       AND e.entitlement_kind='tournament_ticket'
       AND e.tournament_id=p_tournament_id
       AND e.user_id=v_uid
       AND tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id;
    IF v_rows=1 AND v_entitlement_id IS NOT NULL
       AND v_registration_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok',true,'replayed',true,'ticket_id',v_ticket.id,
        'registration_id',v_registration_id,
        'entitlement_id',v_entitlement_id,'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_ticket.status<>'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  IF lower(COALESCE(v_t.variant,''))='spin'
     OR (v_t.max_players IS NOT NULL
       AND v_t.max_players>0 AND v_t.max_players<=2) THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_first_variant');
  END IF;
  IF v_t.status='RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id)
                 AND NOT COALESCE(v_t.prize_pool_finalized,false);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED','REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
  END IF;
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_full');
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','already_registered');
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.club_members m
     WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
       AND COALESCE(m.status,'active') IN ('active','approved')) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  IF v_t.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_mismatch');
  END IF;
  IF v_t.union_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.union_clubs uc
     WHERE uc.union_id=v_t.union_id AND uc.club_id=v_ticket.club_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_union_mismatch');
  END IF;
  v_resolved_club:=public.fn_tournament_club_for_user(
    v_uid,p_tournament_id,v_ticket.club_id);
  IF v_resolved_club IS DISTINCT FROM v_ticket.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  IF COALESCE(v_t.authorized_to_register,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_registration_approvals a
        WHERE a.tournament_id=p_tournament_id AND a.user_id=v_uid)
     AND NOT public.is_club_admin(v_ticket.club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized_to_register');
  END IF;
  IF COALESCE(v_t.is_vip_only,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.profiles pr
        WHERE pr.id=v_uid AND COALESCE(pr.is_vip,false)
          AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at>now()))
     AND NOT EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
          AND m.role IN ('owner','co_owner','admin','agent')) THEN
    RETURN jsonb_build_object('ok',false,'reason','vip_only');
  END IF;

  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<=0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2)
     OR v_ticket.value IS DISTINCT FROM v_split.charge
     OR v_ticket.entry_prize IS DISTINCT FROM v_split.prize
     OR v_ticket.entry_bounty IS DISTINCT FROM v_split.bounty
     OR v_ticket.entry_fee IS DISTINCT FROM v_split.rake THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;

  IF COALESCE(v_t.early_bird_enabled,false)
     AND now()<v_t.start_time AND COALESCE(v_t.early_bird_chips,0)>0 THEN
    v_start_chips:=v_t.early_bird_chips;
  END IF;
  SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),'Player')
    INTO v_username FROM public.profiles p WHERE p.id=v_uid;
  v_username:=COALESCE(v_username,'Player');

  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'ticket admission prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  SELECT count(*) INTO v_wallet_rows_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance THEN
    RAISE EXCEPTION 'ticket admission found divergent tournament escrow'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_players(
    tournament_id,user_id,username,chips,status,current_bounty,
    mystery_bounty_value,bounties_collected,bounty_winnings,
    club_id,is_satellite_qualifier,source_satellite_id)
  VALUES(
    p_tournament_id,v_uid,v_username,v_start_chips,'registered',
    v_split.bounty,0,0,0,v_ticket.club_id,true,v_ticket.source_satellite_id)
  RETURNING id INTO v_registration_id;

  v_key:='ticket:'||v_ticket.id::text||':tournament:'
         ||p_tournament_id::text||':entry';
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    v_uid,'escrow',v_ticket.id,'tournament entry ticket',
    'prize_liability',p_tournament_id,'tournaments escrow',
    v_ticket.value,'ticket_redeem',v_ticket.club_id,p_tournament_id,
    v_key,'ticket-entry:'||v_ticket.id::text,
    'fn_register_for_tournament_with_ticket',
    'Tournament-entry ticket committed to tournament admission',
    jsonb_build_object(
      'kind','tournament_entry_ticket_admission','ticket_id',v_ticket.id,
      'user_id',v_uid,'registration_id',v_registration_id,
      'source_tournament_id',v_ticket.source_tournament_id,
      'source_satellite_id',v_ticket.source_satellite_id,
      'entry_prize',v_ticket.entry_prize,
      'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee),
    v_ticket.value,0,
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance,2),
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance+v_ticket.value,2))
  RETURNING id INTO v_ledger_id;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'tournament-entry ticket admission',
    p_gross_in=>v_ticket.value,p_bounty_in=>v_ticket.entry_bounty);
  IF v_ticket.entry_fee>0 THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_ticket.club_id,v_ticket.entry_fee,v_ticket.value,1,
      0,true,p_tournament_id,'fn_register_for_tournament_with_ticket',
      jsonb_build_object(
        'kind','tournament_ticket_entry_fee','user_id',v_uid,
        'registration_id',v_registration_id,'ticket_id',v_ticket.id));
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before+1,
         prize_pool=round(v_t.prize_pool+v_ticket.entry_prize,2),
         bounty_pool=round(v_t.bounty_pool+v_ticket.entry_bounty,2),
         total_rake=round(v_t.total_rake+v_ticket.entry_fee,2),
         updated_at=now()
   WHERE id=p_tournament_id
     -- The canonical roster trigger has already counted the row inserted
     -- above. Require that exact post-insert count instead of expecting the
     -- stale pre-insert cache and then reporting a false registration race.
     AND current_players IS NOT DISTINCT FROM v_players_before+1
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket admission tournament cache changed'
      USING ERRCODE='40001';
  END IF;

  INSERT INTO public.tournament_ticket_admission_authorizations(
    token,ticket_id,tournament_id,user_id,registration_id)
  VALUES(
    v_ticket_use_token,v_ticket.id,p_tournament_id,v_uid,v_registration_id);

  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',v_ticket_use_token::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_ticket.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',
    COALESCE(v_previous_ticket_use_token,''),true);
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket changed during admission'
      USING ERRCODE='40001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournament_ticket_admission_authorizations a
     WHERE a.token=v_ticket_use_token) THEN
    RAISE EXCEPTION
      'tournament-entry ticket authorization was not consumed by admission'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    source_ticket_id,escrow_bucket,evidence_kind,created_at)
  VALUES(
    p_tournament_id,v_uid,'tournament_ticket','tournament_ticket',
    v_ticket.club_id,v_ticket.value,v_ticket.entry_prize,
    v_ticket.entry_bounty,v_ticket.entry_fee,v_ledger_id,
    v_registration_id,v_ticket.source_satellite_id,NULL,v_ticket.id,
    'ticket_gross','atomic_tournament_ticket',transaction_timestamp())
  RETURNING id INTO v_entitlement_id;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_ticket.club_id,v_uid,NULL,v_ticket.value,
    'tournament_ticket_entry','Tournament-Entry Ticket Used',NULL,
    jsonb_build_object(
      'ticket_id',v_ticket.id,'holder_id',v_uid,
      'target_tournament_id',p_tournament_id,
      'registration_id',v_registration_id,
      'entitlement_id',v_entitlement_id,'ledger_id',v_ledger_id,
      'idempotency_key',v_key,'wallet_chips_credited',0))
  RETURNING id INTO v_tx_id;

  IF v_late_open THEN
    BEGIN
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      PERFORM public.fn_create_late_registration_capacity(p_tournament_id);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    END;
    v_seat_reason:=v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean,false)
       AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
      PERFORM public.fn_create_late_registration_capacity(p_tournament_id);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
      v_seat_reason:=v_seat->>'reason';
      IF NOT COALESCE((v_seat->>'ok')::boolean,false)
         AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
        RAISE EXCEPTION
          'Late ticket admission could not seat the player (%)',
          COALESCE(v_seat_reason,'unknown') USING ERRCODE='55000';
      END IF;
    END IF;
    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_ticket_registration');
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_wallet_rows_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_after.prize_balance IS DISTINCT FROM
       round(v_escrow_before.prize_balance+v_ticket.entry_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
       round(v_escrow_before.bounty_balance+v_ticket.entry_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
       round(v_escrow_before.fee_balance+v_ticket.entry_fee,2)
     OR v_wallet_rows_after IS DISTINCT FROM v_wallet_rows_before THEN
    RAISE EXCEPTION 'ticket admission did not preserve exact noncash rails'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'registration_id',v_registration_id,'entitlement_id',v_entitlement_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'ticket_value',v_ticket.value,'wallet_chips_credited',0,
    'prize_contribution',v_ticket.entry_prize,
    'bounty_contribution',v_ticket.entry_bounty,
    'fee_contribution',v_ticket.entry_fee,'late_registration',v_late_open,
    'seat',v_seat);
END;
$ticket_admission_for$;

REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(
  uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Browser callers may only spend their own ticket. The beneficiary-aware
-- implementation above stays owner-only so the service-role horse door can
-- use the same exact admission authority without forging an auth session.
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_with_ticket(
  p_tournament_id uuid,
  p_ticket_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $ticket_admission$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'fn_register_for_tournament_with_ticket requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  RETURN public.fn_ca_register_for_tournament_with_ticket_for(
    p_tournament_id,p_ticket_id,v_uid);
END;
$ticket_admission$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid)
  TO authenticated, service_role;

CREATE INDEX tournament_ticket_entry_lookup
  ON public.tournament_tickets(holder_id,status,redemption_mode,created_at,id)
  WHERE status='issued' AND redemption_mode='tournament_entry_only';

-- One read-only selector tells every registration surface whether the player
-- owns an exact noncash entry instrument for this event. It proves the issue
-- journal before exposing the id. The admission RPC locks and proves the same
-- facts again, so a ticket changed after this read is refused without falling
-- through to a wallet charge.
CREATE OR REPLACE FUNCTION public.fn_ca_find_tournament_entry_ticket_for(
  p_tournament_id uuid,
  p_beneficiary_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $find_tournament_entry_ticket_for$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_is_bounty boolean;
  v_candidate_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','ticket_id',NULL);
  END IF;
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2) THEN
    RAISE EXCEPTION 'tournament % has no finite ticket contract',p_tournament_id
      USING ERRCODE='P0404';
  END IF;
  IF v_split.charge=0 THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;

  -- Presence and validity are separate facts. If an exact-price ticket exists
  -- but its issue proof or scope is unreadable, do not erase it through an
  -- inner join and silently charge the wallet instead.
  SELECT count(*) INTO v_candidate_count
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid
     AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge
     AND tk.entry_prize=v_split.prize
     AND tk.entry_bounty=v_split.bounty
     AND tk.entry_fee=v_split.rake
     AND EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id;

  SELECT tk.* INTO v_ticket
    FROM public.tournament_tickets tk
    JOIN public.tournament_refund_entitlements source_e
      ON source_e.id=tk.source_refund_entitlement_id
    JOIN public.chip_ledger issue_l
      ON issue_l.idempotency_key='tourney:'
           ||source_e.tournament_id::text
           ||':satellite-ticket-return:'||source_e.id::text
     AND issue_l.from_type='prize_liability'
     AND issue_l.from_entity_id=source_e.tournament_id
     AND issue_l.to_type='escrow' AND issue_l.to_entity_id=tk.id
     AND issue_l.club_id=tk.club_id AND issue_l.amount=tk.value
     AND issue_l.category='ticket_issue'
   WHERE tk.holder_id=v_uid
     AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge
     AND tk.entry_prize=v_split.prize
     AND tk.entry_bounty=v_split.bounty
     AND tk.entry_fee=v_split.rake
     AND source_e.user_id=v_uid
     AND source_e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND source_e.gross=tk.value
     AND source_e.refund_prize=tk.entry_prize
     AND source_e.refund_bounty=tk.entry_bounty
     AND source_e.refund_fee=tk.entry_fee
     AND source_e.source_satellite_id=tk.source_satellite_id
     AND source_e.tournament_id=tk.source_tournament_id
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=source_e.id)
     AND EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id
     AND (SELECT count(*) FROM public.chip_transactions issue_tx
           WHERE issue_tx.transaction_type='tournament_ticket_issue'
             AND issue_tx.club_id=tk.club_id
             AND issue_tx.from_user_id IS NULL
             AND issue_tx.to_user_id=v_uid
             AND issue_tx.amount=tk.value
             AND issue_tx.metadata->>'ticket_id'=tk.id::text
             AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
             AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1
   ORDER BY tk.created_at,tk.id
   LIMIT 1;

  IF v_ticket.id IS NULL THEN
    IF v_candidate_count>0 THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','matching_tournament_ticket_unavailable',
        'ticket_id',NULL);
    END IF;
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'ticket_id',v_ticket.id,'ticket_value',v_ticket.value,
    'entry_prize',v_ticket.entry_prize,
    'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee,
    'source_satellite_id',v_ticket.source_satellite_id);
END;
$find_tournament_entry_ticket_for$;

REVOKE ALL ON FUNCTION public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Browser callers may only discover their own ticket. The beneficiary-aware
-- selector remains owner-only for atomic service authorities such as the
-- horse entry door below.
CREATE OR REPLACE FUNCTION public.fn_find_tournament_entry_ticket(
  p_tournament_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $find_tournament_entry_ticket$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'fn_find_tournament_entry_ticket requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  RETURN public.fn_ca_find_tournament_entry_ticket_for(
    p_tournament_id,v_uid);
END;
$find_tournament_entry_ticket$;

REVOKE ALL ON FUNCTION public.fn_find_tournament_entry_ticket(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_find_tournament_entry_ticket(uuid)
  TO authenticated, service_role;

-- One service-only, read-only hint prevents the server's lane, bankroll and
-- count filters from hiding a horse that already owns this event's instrument.
-- This deliberately returns candidate presence before issue-proof validation:
-- a corrupt matching candidate must still be marked no-wallet, then refused
-- by the exact selector inside the atomic registration door.
CREATE OR REPLACE FUNCTION public.fn_horse_tournament_entry_ticket_hints(
  p_tournament_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $horse_ticket_hints$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_holder_ids jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'tournament id is required' USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','holder_ids','[]'::jsonb);
  END IF;
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2) THEN
    RAISE EXCEPTION 'tournament % has no finite ticket contract',p_tournament_id
      USING ERRCODE='P0404';
  END IF;
  IF v_split.charge=0 THEN
    RETURN jsonb_build_object('ok',true,'holder_ids','[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(candidate.holder_id ORDER BY candidate.holder_id),
                  '[]'::jsonb)
    INTO v_holder_ids
    FROM (
      SELECT DISTINCT tk.holder_id
        FROM public.tournament_tickets tk
        JOIN public.profiles p ON p.id=tk.holder_id
       WHERE COALESCE(p.is_horse,false)
         AND tk.status='issued'
         AND tk.redemption_mode='tournament_entry_only'
         AND tk.value=v_split.charge
         AND tk.entry_prize=v_split.prize
         AND tk.entry_bounty=v_split.bounty
         AND tk.entry_fee=v_split.rake
         AND EXISTS(
           SELECT 1 FROM public.club_members m
            WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
              AND COALESCE(m.status,'active') IN ('active','approved'))
         AND (v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
         AND (v_t.union_id IS NULL OR EXISTS(
           SELECT 1 FROM public.union_clubs uc
            WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
         AND public.fn_tournament_club_for_user(
               tk.holder_id,p_tournament_id,tk.club_id)
               IS NOT DISTINCT FROM tk.club_id
    ) candidate;
  RETURN jsonb_build_object('ok',true,'holder_ids',v_holder_ids);
END;
$horse_ticket_hints$;

REVOKE ALL ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid)
  TO service_role;

-- Horses are auth-backed beneficiaries but the engine has no horse browser
-- session. Keep one service-only door: under the same terminal and maintenance
-- boundaries it replays a committed ticket admission, selects and spends an
-- issued exact ticket, or reaches the existing wallet core only after the
-- authoritative selector proves that no matching ticket exists. A corrupt
-- matching ticket is a refusal, never permission to charge the wallet.
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(
  p_tournament_id uuid,
  p_user_id uuid,
  p_allow_wallet_charge boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','pg_temp'
SET statement_timeout = '30s'
AS $horse_ticket_first$
DECLARE
  v_is_horse boolean;
  v_ticket_lookup jsonb;
  v_ticket_id uuid;
  v_ticket_registration_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_allow_wallet_charge IS NULL THEN
    RAISE EXCEPTION 'tournament, horse and wallet authority are required'
      USING ERRCODE='22004';
  END IF;

  -- Ticket return, ticket admission and terminal settlement use this order.
  -- Holding both locks through the no-ticket decision prevents a concurrent
  -- unregister from issuing a ticket between selection and a wallet debit.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT is_horse INTO v_is_horse
    FROM public.profiles WHERE id=p_user_id;
  IF NOT COALESCE(v_is_horse,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_a_horse');
  END IF;

  -- An ambiguous-response retry arrives after the issued ticket has become
  -- redeemed. Recover that exact ticket id from the active immutable entry
  -- entitlement and let the admission core prove and replay the receipt.
  SELECT count(*),min(e.source_ticket_id::text)::uuid
    INTO v_ticket_registration_count,v_ticket_id
    FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
   WHERE e.tournament_id=p_tournament_id
     AND e.user_id=p_user_id
     AND e.entitlement_kind='tournament_ticket'
     AND e.source_ticket_id IS NOT NULL
     AND tp.tournament_id=e.tournament_id
     AND tp.user_id=e.user_id
     AND tp.status::text IN ('registered','playing');
  IF v_ticket_registration_count>1 THEN
    RAISE EXCEPTION
      'horse ticket admission has multiple active immutable entitlements'
      USING ERRCODE='P0404';
  END IF;
  IF v_ticket_registration_count=1 AND v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  v_ticket_lookup:=public.fn_ca_find_tournament_entry_ticket_for(
    p_tournament_id,p_user_id);
  IF COALESCE((v_ticket_lookup->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_ticket_lookup;
  END IF;
  v_ticket_id:=NULLIF(v_ticket_lookup->>'ticket_id','')::uuid;
  IF v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  IF p_allow_wallet_charge IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','hinted_tournament_ticket_no_longer_available');
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_maintenance_gate(
    p_tournament_id,p_user_id);
END;
$horse_ticket_first$;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(
  uuid,uuid,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(
  uuid,uuid,boolean)
  TO service_role;

-- Rolling server compatibility. New callers must pass their per-candidate
-- wallet authority explicitly; this two-argument shape keeps the already
-- deployed engine callable while the application and database roll together.
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(
  p_tournament_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout = '30s'
AS $horse_ticket_first_compat$
BEGIN
  RETURN public.fn_register_horse_for_tournament(
    p_tournament_id,p_user_id,true);
END;
$horse_ticket_first_compat$;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid,uuid)
  TO service_role;

-- The wallet journal trigger is the atomic join between a credit and its
-- exact refund rails. Only the owner-only exact payer below sets a tranche
-- key, and the inserted immutable row must match the wallet statement.
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_wallet_tx()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $wallet_escrow_exact_refund$
DECLARE
  v_cat text := lower(COALESCE(NEW.category,''));
  v_amt numeric := round(COALESCE(NEW.amount,0),2);
  v_bounty numeric;
  v_split record;
  v_ent_count bigint;
  v_ent_amount numeric;
  v_wallet_count bigint;
  v_wallet_amount numeric;
  v_exact_token uuid := NULLIF(
    current_setting('app.ca_exact_refund_token',true),'')::uuid;
  v_authorization public.tournament_refund_authorizations%ROWTYPE;
  v_rows integer;
  v_credit_ledger_id uuid;
BEGIN
  IF NEW.related_entity_id IS NULL OR v_amt = 0 THEN RETURN NULL; END IF;
  IF NEW.type = 'debit' AND v_cat IN ('tournament_buyin','rebuy','addon') THEN
    SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
      NEW.related_entity_id,v_cat,v_amt);
    SELECT count(*),round(COALESCE(sum(e.gross),0),2)
      INTO v_ent_count,v_ent_amount
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=NEW.related_entity_id AND e.user_id=NEW.user_id
       AND e.entitlement_kind='wallet_charge'
       AND e.charge_category=v_cat;
    SELECT count(*),round(COALESCE(sum(w.amount),0),2)
      INTO v_wallet_count,v_wallet_amount
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=NEW.related_entity_id AND w.user_id=NEW.user_id
       AND w.type='debit' AND lower(w.category)=v_cat;
    IF v_ent_count IS DISTINCT FROM v_wallet_count
       OR v_ent_amount IS DISTINCT FROM v_wallet_amount THEN
      RAISE EXCEPTION
        'tournament wallet debit has no exact immutable charge entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    v_bounty := v_split.refund_bounty;
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,v_cat,p_gross_in => v_amt,p_bounty_in => v_bounty);
  ELSIF NEW.type = 'credit' AND v_cat = 'prize' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize',p_prize_out => v_amt);
  ELSIF NEW.type = 'debit' AND v_cat IN ('prize','prize_reversal') THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize reversal',p_prize_out => -v_amt);
  ELSIF NEW.type = 'credit' AND v_cat = 'bounty' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'bounty',p_bounty_out => v_amt);
  ELSIF NEW.type = 'credit' AND v_cat IN ('refund','tournament_refund') THEN
    IF v_exact_token IS NULL THEN
      RAISE EXCEPTION
        'tournament refund credits require the one-use exact refund authority'
        USING ERRCODE = '42501';
    ELSE
      SELECT * INTO v_authorization
        FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.tournament_id IS DISTINCT FROM NEW.related_entity_id
         OR v_authorization.user_id IS DISTINCT FROM NEW.user_id
         OR v_authorization.amount_paid_now IS DISTINCT FROM v_amt
         OR v_authorization.description IS DISTINCT FROM NEW.description
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_entitlements e
            WHERE e.id=v_authorization.entitlement_id
              AND e.tournament_id=NEW.related_entity_id
              AND e.user_id=NEW.user_id
              AND e.refund_wallet_club_id=
                    v_authorization.source_wallet_club_id
              AND e.gross=v_authorization.amount_paid_now
              AND e.refund_prize=v_authorization.refund_prize
              AND e.refund_bounty=v_authorization.refund_bounty
              AND e.refund_fee=v_authorization.refund_fee)
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.id = v_authorization.obligation_id
              AND o.tournament_id = NEW.related_entity_id
              AND o.kind = 'refund' AND o.place IS NULL
              AND o.user_id = NEW.user_id
              AND o.amount_paid IS NOT DISTINCT FROM
                    v_authorization.amount_paid_before)
         OR NOT EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency k
            WHERE k.key = v_authorization.idempotency_key
              AND k.user_id = NEW.user_id AND k.amount = v_amt) THEN
        RAISE EXCEPTION 'wallet refund has no exact authorized component tranche'
          USING ERRCODE = 'P0404';
      END IF;
      DELETE FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'exact refund authorization was not consumed once'
          USING ERRCODE = '40001';
      END IF;
      SELECT count(*),min(l.id::text)::uuid
        INTO v_rows,v_credit_ledger_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key = v_authorization.idempotency_key
         AND l.tournament_id = NEW.related_entity_id
         AND l.club_id = v_authorization.source_wallet_club_id
         AND l.category = 'refund'
         AND l.from_type = 'prize_liability'
         AND l.from_entity_id = NEW.related_entity_id
         AND l.to_type = 'player_wallet'
         AND l.to_entity_id = NEW.user_id
         AND l.amount = v_amt;
      IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
        RAISE EXCEPTION
          'wallet refund has no single exact source-club journal credit'
          USING ERRCODE = 'P0404';
      END IF;
      INSERT INTO public.tournament_refund_tranches(
        wallet_transaction_id,idempotency_key,tournament_id,obligation_id,user_id,
        source_wallet_club_id,entitlement_id,credit_ledger_id,
        amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
        source,description,created_at)
      VALUES(
        NEW.id,v_authorization.idempotency_key,NEW.related_entity_id,
        v_authorization.obligation_id,NEW.user_id,
        v_authorization.source_wallet_club_id,
        v_authorization.entitlement_id,v_credit_ledger_id,
        v_authorization.amount_paid_before,v_amt,
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee,v_authorization.source,
        NEW.description,transaction_timestamp());
      PERFORM public.fn_ca_escrow_apply_exact_refund(
        NEW.related_entity_id,'authorized exact refund',
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee);
    END IF;
  END IF;
  RETURN NULL;
END;
$wallet_escrow_exact_refund$;

REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_wallet_tx()
  FROM PUBLIC, anon, authenticated;

-- A refund obligation remains the cumulative public contract, while every
-- new credit is now a component-exact immutable tranche. This payer refuses
-- partial settlement and never lets an earlier refund satisfy a later entry.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_refund_exact(
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_wallet_club_id uuid,
  p_total_owed numeric,
  p_refund_prize numeric,
  p_refund_bounty numeric,
  p_refund_fee numeric,
  p_source text,
  p_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $exact_refund_payer$
DECLARE
  v_total numeric := round(COALESCE(p_total_owed,0),2);
  v_prize numeric := round(COALESCE(p_refund_prize,0),2);
  v_bounty numeric := round(COALESCE(p_refund_bounty,0),2);
  v_fee numeric := round(COALESCE(p_refund_fee,0),2);
  v_ob public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_pay numeric;
  v_key text;
  v_rows integer;
  v_token uuid;
  v_source_debits numeric;
  v_source_credits numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_credit_ledger_id uuid;
  v_wallet_transaction_id uuid;
  v_prev_category text;
  v_prev_counterparty text;
  v_prev_counterparty_entity text;
  v_prev_tournament text;
  v_prev_tournament_id text;
  v_prev_idempotency text;
  v_entitlement record;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_wallet_club_id IS NULL
     OR p_total_owed IS NULL OR p_refund_prize IS NULL
     OR p_refund_bounty IS NULL OR p_refund_fee IS NULL
     OR p_total_owed::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR p_total_owed IS DISTINCT FROM v_total
     OR p_refund_prize IS DISTINCT FROM v_prize
     OR p_refund_bounty IS DISTINCT FROM v_bounty
     OR p_refund_fee IS DISTINCT FROM v_fee
     OR v_total <= 0 OR v_prize < 0 OR v_bounty < 0 OR v_fee < 0
     OR p_source IS NULL OR length(btrim(p_source)) = 0
     OR p_description IS NULL OR length(btrim(p_description)) = 0 THEN
    RAISE EXCEPTION 'exact refund payer received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_settle_sources s
     WHERE s.source = lower(btrim(p_source))) THEN
    RAISE EXCEPTION 'exact refund source % is not a platform authority',p_source
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact refund tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'exact refund escrow prelock');

  SELECT * INTO v_ob FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'refund' AND o.place IS NULL AND o.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    SELECT round(COALESCE(sum(w.amount),0),2) INTO v_seeded_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND w.user_id = p_user_id AND w.type = 'credit'
       AND lower(w.category) IN ('refund','tournament_refund');
    IF v_seeded_paid > v_total THEN
      RAISE EXCEPTION 'refund ledger already exceeds exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.tournament_obligations(
      tournament_id,kind,place,user_id,amount_owed,amount_paid,source)
    VALUES(
      p_tournament_id,'refund',NULL,p_user_id,v_total,v_seeded_paid,p_source)
    RETURNING * INTO v_ob;
  ELSE
    IF v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
       OR v_ob.amount_paid > v_ob.amount_owed
       OR v_total < v_ob.amount_owed THEN
      RAISE EXCEPTION 'existing refund obligation is incompatible with exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_pay := round(v_total - v_ob.amount_paid,2);
  IF v_pay <= 0 OR v_pay IS DISTINCT FROM round(v_prize + v_bounty + v_fee,2) THEN
    RAISE EXCEPTION
      'exact refund components %, %, % do not equal newly owed amount %',
      v_prize,v_bounty,v_fee,v_pay USING ERRCODE = '23514';
  END IF;

  -- The caller cannot choose money. Resolve one deterministic, still-open
  -- immutable entitlement whose stored club and rails exactly match this
  -- tranche. A funded satellite seat is deliberately excluded: that source
  -- can be returned only as another tournament-entry ticket, never as chips.
  SELECT e.* INTO v_entitlement
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.refund_wallet_club_id = p_source_wallet_club_id
     AND e.gross = v_pay
     AND e.refund_prize = v_prize
     AND e.refund_bounty = v_bounty
     AND e.refund_fee = v_fee
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND e.entitlement_kind='wallet_charge'
   ORDER BY e.entitlement_kind,e.id
   LIMIT 1;
  IF v_entitlement.id IS NULL THEN
    RAISE EXCEPTION
      'refund source club and component rails do not match one immutable entitlement'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*) INTO v_rows FROM public.chip_ledger l
   WHERE l.id=v_entitlement.source_ledger_id
     AND l.tournament_id=v_entitlement.tournament_id
     AND l.club_id=v_entitlement.refund_wallet_club_id
     AND l.from_type='player_wallet'
     AND l.from_entity_id=v_entitlement.user_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_entitlement.tournament_id
     AND lower(l.category)=v_entitlement.charge_category
     AND l.amount=v_entitlement.gross;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'refund entitlement lost its exact wallet-debit source'
      USING ERRCODE = 'P0404';
  END IF;
  v_key := 'tourney:' || p_tournament_id::text
           || ':refund-entitlement:'
           || v_entitlement.id::text;

  v_token := gen_random_uuid();
  INSERT INTO public.tournament_refund_authorizations(
    token,idempotency_key,tournament_id,obligation_id,user_id,
    source_wallet_club_id,entitlement_id,
    amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
    source,description,created_at)
  VALUES(
    v_token,v_key,p_tournament_id,v_ob.id,p_user_id,
    p_source_wallet_club_id,v_entitlement.id,
    v_ob.amount_paid,v_pay,v_prize,v_bounty,v_fee,
    lower(btrim(p_source)),p_description,transaction_timestamp());
  -- The debit journal is the immutable source-wallet fact. A refund may land
  -- only in that same club wallet, and never through the generic tournament
  -- wallet chooser. Existing credits in that wallet reduce its remaining
  -- capacity, so even an owner-only caller cannot redirect or over-credit it.
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_debits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'player_wallet'
     AND l.from_entity_id = p_user_id
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.category IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_credits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category IN ('refund','tournament_refund');
  IF v_source_debits IS NULL OR v_source_credits IS NULL
     OR v_source_debits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_credits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_debits < 0 OR v_source_credits < 0
     OR round(v_source_debits-v_source_credits,2) < v_pay THEN
    RAISE EXCEPTION
      'source club % has only % of exact tournament debit left for refund %',
      p_source_wallet_club_id,
      round(v_source_debits-v_source_credits,2),v_pay
      USING ERRCODE = 'P0404';
  END IF;

  SELECT m.chip_balance INTO v_balance_before
    FROM public.club_members m
   WHERE m.user_id = p_user_id AND m.club_id = p_source_wallet_club_id
   FOR UPDATE;
  IF NOT FOUND OR v_balance_before IS NULL
     OR v_balance_before::text IN ('NaN','Infinity','-Infinity')
     OR v_balance_before IS DISTINCT FROM round(v_balance_before,2) THEN
    RAISE EXCEPTION
      'exact source wallet % for player % is absent or invalid',
      p_source_wallet_club_id,p_user_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_pay)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit key % was already claimed',v_key
      USING ERRCODE = '23505';
  END IF;

  v_prev_category := current_setting('app.ledger_category',true);
  v_prev_counterparty := current_setting('app.ledger_counterparty',true);
  v_prev_counterparty_entity := current_setting(
    'app.ledger_counterparty_entity',true);
  v_prev_tournament := current_setting('app.ledger_tournament',true);
  v_prev_tournament_id := current_setting('app.ledger_tournament_id',true);
  v_prev_idempotency := current_setting('app.ledger_idempotency_key',true);
  PERFORM public.fn_ca_declare_ledger(
    'refund','prize_liability',p_tournament_id,NULL,v_key,NULL);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament_id',p_tournament_id::text,true);
  UPDATE public.club_members
     SET chip_balance = chip_balance + v_pay,updated_at = now()
   WHERE user_id = p_user_id AND club_id = p_source_wallet_club_id
     AND chip_balance IS NOT DISTINCT FROM v_balance_before
  RETURNING chip_balance INTO v_balance_after;
  PERFORM set_config('app.ledger_category',COALESCE(v_prev_category,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_prev_counterparty,''),true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(v_prev_counterparty_entity,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_prev_tournament,''),true);
  PERFORM set_config('app.ledger_tournament_id',COALESCE(v_prev_tournament_id,''),true);
  PERFORM set_config('app.ledger_idempotency_key',COALESCE(v_prev_idempotency,''),true);
  IF v_balance_after IS NULL
     OR v_balance_after IS DISTINCT FROM round(v_balance_before+v_pay,2) THEN
    RAISE EXCEPTION 'exact source wallet changed during refund'
      USING ERRCODE = '40001';
  END IF;
  SELECT count(*),min(l.id::text)::uuid INTO v_rows,v_credit_ledger_id
    FROM public.chip_ledger l
   WHERE l.idempotency_key = v_key
     AND l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category = 'refund' AND l.amount = v_pay;
  IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
    RAISE EXCEPTION 'exact source-wallet credit % has no single journal row',v_key
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM set_config('app.ca_exact_refund_token',v_token::text,true);
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,amount,type,category,description,
    related_entity_id,table_id,hand_id,balance_after)
  VALUES(
    p_user_id,'PLAYER',v_pay,'credit','refund',p_description,
    p_tournament_id,NULL,NULL,v_balance_after)
  RETURNING id INTO v_wallet_transaction_id;
  PERFORM set_config('app.ca_exact_refund_token','',true);
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_authorizations a
     WHERE a.token = v_token) THEN
    RAISE EXCEPTION 'exact refund authorization % was not consumed',v_token
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows FROM public.tournament_refund_tranches tr
   WHERE tr.wallet_transaction_id = v_wallet_transaction_id
     AND tr.idempotency_key = v_key
     AND tr.tournament_id = p_tournament_id
     AND tr.obligation_id = v_ob.id AND tr.user_id = p_user_id
     AND tr.source_wallet_club_id = p_source_wallet_club_id
     AND tr.entitlement_id = v_entitlement.id
     AND tr.credit_ledger_id = v_credit_ledger_id
     AND tr.amount_paid_before = v_ob.amount_paid
     AND tr.amount_paid_now = v_pay
     AND tr.refund_prize = v_prize
     AND tr.refund_bounty = v_bounty
     AND tr.refund_fee = v_fee
     AND tr.source = lower(btrim(p_source))
     AND tr.description = p_description;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit % has no single component receipt',v_key
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         amount_owed = v_total,
         source = p_source,
         updated_at = now(),settled_at = now()
   WHERE id = v_ob.id AND amount_paid = v_ob.amount_paid
  RETURNING * INTO v_ob;
  IF v_ob.id IS NULL OR v_ob.amount_paid IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'exact refund obligation did not close at %',v_total
      USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'fully_settled',true,'remaining',0,
    'obligation_id',v_ob.id,'idempotency_key',v_key,
    'entitlement_id',v_entitlement.id,
    'entitlement_kind',v_entitlement.entitlement_kind,
    'source_wallet_club_id',p_source_wallet_club_id,
    'credit_ledger_id',v_credit_ledger_id,
    'wallet_transaction_id',v_wallet_transaction_id,
    'already_paid',round(v_total-v_pay,2),'paid',v_pay,
    'amount_owed',v_total,'amount_paid',v_total,
    'refund_prize',v_prize,'refund_bounty',v_bounty,'refund_fee',v_fee);
END;
$exact_refund_payer$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_refund_exact(
  uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- The sole refund-plan authority is entitlement-backed. Every returned row is
-- one independently funded and independently consumable fact.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_refund_plan(
  p_tournament_id uuid,
  p_user_id uuid
)
RETURNS TABLE(
  source_wallet_club_id uuid,
  gross_remaining numeric,
  prize_remaining numeric,
  bounty_remaining numeric,
  fee_remaining numeric,
  debit_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $entitlement_refund_plan$
DECLARE
  v_escrow public.tournament_escrow%ROWTYPE;
  v_wallet_count bigint;
  v_wallet_total numeric;
  v_charge_count bigint;
  v_charge_total numeric;
  v_refund_count bigint;
  v_refund_total numeric;
  v_tranche_count bigint;
  v_tranche_total numeric;
  v_wallet_gross numeric;
  v_direct_fee numeric;
  v_satellite_fee numeric;
  v_bounty numeric;
  v_satellite_in numeric;
  v_invalid bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'refund plan requires tournament and player ids'
      USING ERRCODE = '22004';
  END IF;
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund plan tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
   ORDER BY e.user_id,e.entitlement_kind,e.id FOR SHARE;
  PERFORM 1 FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id
   ORDER BY tr.user_id,tr.entitlement_id FOR SHARE;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT count(*),round(COALESCE(sum(e.gross),0),2)
    INTO v_charge_count,v_charge_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
     AND e.entitlement_kind='wallet_charge';
  IF v_wallet_count IS DISTINCT FROM v_charge_count
     OR v_wallet_total IS DISTINCT FROM v_charge_total THEN
    RAISE EXCEPTION
      'tournament % wallet charges and immutable entitlements disagree',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_invalid
    FROM public.tournament_refund_entitlements e
    LEFT JOIN public.chip_ledger l ON l.id=e.source_ledger_id
   WHERE e.tournament_id=p_tournament_id
     AND (
       l.id IS NULL OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
       OR l.amount IS DISTINCT FROM e.gross
       OR (e.entitlement_kind='wallet_charge' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'player_wallet'
         OR l.from_entity_id IS DISTINCT FROM e.user_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR lower(l.category) IS DISTINCT FROM e.charge_category))
       OR (e.entitlement_kind='satellite_seat' AND (
         l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
       OR (e.entitlement_kind='tournament_ticket' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'escrow'
         OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.category IS DISTINCT FROM 'ticket_redeem'
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
     );
  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'tournament % has % invalid refund entitlement sources',
      p_tournament_id,v_invalid USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN ('wallet_gross','ticket_gross')
             THEN e.gross
           WHEN e.escrow_bucket='satellite_gross'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind IN ('wallet_charge','tournament_ticket')
             THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind='satellite_seat' THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN (
             'wallet_gross','satellite_gross','ticket_gross')
             THEN e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket='satellite_in'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2)
    INTO v_wallet_gross,v_direct_fee,v_satellite_fee,v_bounty,v_satellite_in
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id;
  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR SHARE;
  IF v_escrow.tournament_id IS NULL
     OR v_escrow.enforced IS DISTINCT FROM true
     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross
     OR v_escrow.fee_entries_in IS DISTINCT FROM v_direct_fee
     OR v_escrow.satellite_fee_in IS DISTINCT FROM v_satellite_fee
     OR v_escrow.bounty_in IS DISTINCT FROM v_bounty
     OR v_escrow.satellite_in IS DISTINCT FROM v_satellite_in THEN
    RAISE EXCEPTION
      'tournament % escrow does not equal its immutable entitlement rails',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_refund_count,v_refund_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_tranche_count,v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_refund_count IS DISTINCT FROM v_tranche_count
     OR v_refund_total IS DISTINCT FROM v_tranche_total THEN
    RAISE EXCEPTION
      'player % tournament % has refund money without exact entitlement tranches',
      p_user_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
    WHERE tr.tournament_id=p_tournament_id AND (
      e.tournament_id IS DISTINCT FROM tr.tournament_id
      OR e.user_id IS DISTINCT FROM tr.user_id
      OR e.refund_wallet_club_id IS DISTINCT FROM tr.source_wallet_club_id
      OR e.gross IS DISTINCT FROM tr.amount_paid_now
      OR e.refund_prize IS DISTINCT FROM tr.refund_prize
      OR e.refund_bounty IS DISTINCT FROM tr.refund_bounty
      OR e.refund_fee IS DISTINCT FROM tr.refund_fee)
  ) THEN
    RAISE EXCEPTION 'tournament % has a tranche detached from its entitlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  RETURN QUERY
  SELECT e.refund_wallet_club_id,e.gross,e.refund_prize,e.refund_bounty,
         e.refund_fee,1::bigint
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge'
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
   ORDER BY e.entitlement_kind,e.id;
END;
$entitlement_refund_plan$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_refund_plan(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The public generic payer remains the authority for prizes and bounties, but
-- a refund has more facts: source wallet and exact component rails. Refuse the
-- old generic route explicitly before it can claim an obligation key.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_description text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $refunds_require_exact_authority$
BEGIN
  IF lower(btrim(COALESCE(p_kind,'')))='refund' THEN
    RETURN jsonb_build_object(
      'ok',false,'paid',0,'already_paid',0,
      'refused_reason','exact_refund_authority_required',
      'obligation_id',NULL,'idempotency_key',NULL);
  END IF;
  RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
    p_tournament_id,p_kind,p_place,p_user_id,p_amount,p_source,
    p_description,p_adjustment_id);
END;
$refunds_require_exact_authority$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid) TO service_role;

-- Reconciliation keeps the pre-cutover aggregate allocation only for wallet
-- credits that existed before immutable tranches. Every credit created after
-- this migration is token-gated above and therefore contributes its recorded
-- prize, bounty and fee rails exactly. No future refund is ratio-apportioned.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
RETURNS TABLE(
  prize_in numeric,bounty_in numeric,fee_in numeric,overlay_in numeric,
  satellite_in numeric,prize_out numeric,bounty_out numeric,fee_out numeric,
  refund_out numeric,prize_balance numeric,bounty_balance numeric,
  fee_balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $exact_refund_read_model$
WITH t AS (
  SELECT id,COALESCE(buy_in_amount,0) AS buy_in_amount,
         COALESCE(buy_in_fee,0) AS buy_in_fee,
         COALESCE(bounty_amount,0) AS bounty_amount,
         (COALESCE(is_bounty,false) OR COALESCE(is_pko,false)
          OR COALESCE(is_mystery_bounty,false)) AS is_b
    FROM public.tournaments WHERE id=p_tournament_id
), w AS (
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type='debit'
      AND category IN ('tournament_buyin','rebuy','addon')),0) AS gross_in,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='prize'),0)
      - COALESCE(sum(amount) FILTER (WHERE type='debit'
          AND category IN ('prize','prize_reversal')),0) AS prize_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='bounty'),0)
      AS bounty_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit'
      AND category IN ('refund','tournament_refund')),0) AS refund_out
  FROM public.wallet_transactions WHERE related_entity_id=p_tournament_id
), direct_bounty AS (
  SELECT round(COALESCE(sum(CASE
    WHEN NOT t.is_b OR lower(l.category)='addon' THEN 0
    WHEN lower(l.category)='tournament_buyin' THEN round(t.bounty_amount,2)
    ELSE LEAST(
      GREATEST(0,round(t.bounty_amount,2)),
      round(l.amount,2)-LEAST(
        trunc(round(l.amount,2)*(CASE
          WHEN t.buy_in_amount+t.buy_in_fee>0 AND t.buy_in_fee>0
            THEN t.buy_in_fee/(t.buy_in_amount+t.buy_in_fee)
          ELSE 0.1 END)*100+0.000001)/100,
        trunc(round(l.amount,2)*0.1*100+0.000001)/100))
    END),0),2) AS amount
  FROM t LEFT JOIN public.chip_ledger l
    ON l.tournament_id=p_tournament_id
   AND l.from_type='player_wallet' AND l.to_type='prize_liability'
   AND l.to_entity_id=p_tournament_id
   AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
), rr AS (
  SELECT
    COALESCE(sum(rake_amount),0) AS fee_in,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS fee_sat,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'
        AND metadata->>'entry_split_version'='2'),0) AS fee_sat_split,
    COALESCE(sum(COALESCE(pot_size,0)-rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS satellite_in
  FROM public.rake_records
  WHERE tournament_id=p_tournament_id AND is_tournament
    AND NOT (rake_amount<0 AND source IN (
      'atomic_cancel_tournament','fn_unregister_from_tournament'))
), ov AS (
  SELECT COALESCE(sum(a.amount),0) AS ledger_overlay
    FROM public.chip_ledger a
   WHERE a.to_entity_id=p_tournament_id
     AND a.to_type='prize_liability'
     AND (a.category='overlay' OR
       (a.category='correction' AND a.from_type IN ('union_bank','club_treasury')))
     AND NOT (COALESCE(a.description,'') LIKE 'auto-ledgered%'
       AND EXISTS (
         SELECT 1 FROM public.chip_ledger b
          WHERE b.to_entity_id=a.to_entity_id AND b.category='overlay'
            AND b.to_type='prize_liability' AND b.id<>a.id
            AND b.amount=a.amount
            AND COALESCE(b.description,'') NOT LIKE 'auto-ledgered%'
            AND abs(extract(epoch FROM (b.created_at-a.created_at)))<5))
), stl AS (
  SELECT COALESCE(sum(amount),0) AS moved,
    COALESCE(sum(amount) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_moved,
    COALESCE(sum((metadata->>'entry_fee')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_fee,
    COALESCE(sum((metadata->>'entry_bounty')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_bounty
  FROM public.chip_ledger
  WHERE to_entity_id=p_tournament_id AND to_type='prize_liability'
    AND idempotency_key LIKE 'tourney:%:seat:%:pool_transfer'
), tgo AS (
  SELECT COALESCE(sum(amount),0) AS tgo_amount
    FROM public.tournament_guarantee_overlays
   WHERE tournament_id=p_tournament_id
), sat AS (
  SELECT COALESCE(sum(amount),0) AS seats_out
    FROM public.tournament_payouts
   WHERE tournament_id=p_tournament_id AND source='satellite_seat'
), fo AS (
  SELECT COALESCE(sum(amount),0) AS fee_out
    FROM public.tournament_rake_settlements
   WHERE tournament_id=p_tournament_id AND settled_at IS NOT NULL
), exact_refunds AS (
  SELECT COALESCE(sum(amount_paid_now),0) AS total,
         COALESCE(sum(refund_prize),0) AS prize,
         COALESCE(sum(refund_bounty),0) AS bounty,
         COALESCE(sum(refund_fee),0) AS fee
    FROM public.tournament_refund_tranches
   WHERE tournament_id=p_tournament_id
), calc AS (
  SELECT
    round(w.gross_in+stl.split_moved-stl.split_fee,2) AS gross_in,
    round(rr.fee_in,2) AS fee_in,
    round(rr.fee_in-rr.fee_sat,2) AS fee_entries,
    round(direct_bounty.amount+stl.split_bounty,2) AS bounty_in,
    round(CASE WHEN ov.ledger_overlay>0 THEN ov.ledger_overlay
      ELSE tgo.tgo_amount END,2) AS overlay_in,
    round(stl.moved-stl.split_moved-rr.fee_sat+rr.fee_sat_split,2)
      AS satellite_in,
    round(w.prize_out+sat.seats_out,2) AS prize_out,
    round(w.bounty_out,2) AS bounty_out,
    round(fo.fee_out,2) AS fee_out,
    round(w.refund_out,2) AS refund_out,
    round(exact_refunds.total,2) AS exact_total,
    round(exact_refunds.prize,2) AS exact_prize,
    round(exact_refunds.bounty,2) AS exact_bounty,
    round(exact_refunds.fee,2) AS exact_fee
  FROM t,w,direct_bounty,rr,stl,ov,tgo,sat,fo,exact_refunds
), split AS (
  SELECT c.*,round(c.gross_in-c.fee_entries-c.bounty_in,2) AS prize_in,
         round(c.refund_out-c.exact_total,2) AS legacy_refund
    FROM calc c
), apportioned AS (
  SELECT s.*,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*(s.prize_in+s.satellite_in)
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE s.legacy_refund END AS legacy_prize,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*s.bounty_in
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE 0 END AS legacy_bounty
  FROM split s
)
SELECT a.prize_in,a.bounty_in,a.fee_in,a.overlay_in,a.satellite_in,
       a.prize_out,a.bounty_out,a.fee_out,a.refund_out,
       round(a.prize_in+a.overlay_in+a.satellite_in-a.prize_out
         -a.legacy_prize-a.exact_prize,2) AS prize_balance,
       round(a.bounty_in-a.bounty_out-a.legacy_bounty-a.exact_bounty,2)
         AS bounty_balance,
       round(a.fee_in-a.fee_out
         -(a.legacy_refund-a.legacy_prize-a.legacy_bounty)-a.exact_fee,2)
         AS fee_balance
  FROM apportioned a;
$exact_refund_read_model$;

-- This aggregate exposes the complete internal prize, bounty and fee rails.
-- It is an owner/service diagnostic, never a player-facing RLS bypass.
REVOKE ALL ON FUNCTION public.fn_ca_tournament_escrow(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_escrow(uuid)
  TO service_role;

-- Refund credits already debit escrow. Their negative rake rows reverse
-- attribution only and must never debit a fee bank a second time.
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $satellite_refund_fee_is_attribution$
DECLARE
  v_fee numeric := round(COALESCE(NEW.rake_amount,0),2);
BEGIN
  IF NOT COALESCE(NEW.is_tournament,false) OR NEW.tournament_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_fee < 0 AND NEW.source IN (
       'atomic_cancel_tournament',
       'fn_unregister_from_tournament') THEN
    RETURN NULL;
  END IF;
  IF NEW.source = 'fn_award_satellite_seat' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'satellite seat fee',
      p_satellite_fee_in => v_fee,p_satellite_in => -v_fee);
  ELSE
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'entry fee',p_fee_entries_in => v_fee);
  END IF;
  RETURN NULL;
END;
$satellite_refund_fee_is_attribution$;

REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_rake_record()
  FROM PUBLIC, anon, authenticated;

-- Rebuild one committed unregister result only from immutable receipt and
-- source evidence. NULL means no prior intent exists for this player/event.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unregistration_receipt(
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $unregistration_receipt$
DECLARE
  v_r public.tournament_unregistration_receipts%ROWTYPE;
  v_entitlement_count integer;
  v_fee_entitlement_count integer;
  v_entitlement_total numeric;
  v_entitlement_fee numeric;
  v_source_count integer;
  v_wallet_count integer;
  v_wallet_total numeric;
  v_ticket_count integer;
  v_ticket_total numeric;
  v_ticket_ledger_count integer;
  v_ticket_transaction_count integer;
  v_fee_reversal_count integer;
  v_fee_reversal_total numeric;
  v_fee_source_ids uuid[];
  v_fee_mapping_count integer;
  v_fee_mapping_entitlement_count integer;
  v_fee_mapping_ids uuid[];
BEGIN
  SELECT * INTO v_r
    FROM public.tournament_unregistration_receipts r
   WHERE r.tournament_id=p_tournament_id AND r.user_id=p_user_id
     AND r.source_table_id IS NOT DISTINCT FROM p_source_table_id
     AND (p_request_id IS NULL OR r.request_id=p_request_id)
   ORDER BY r.settled_at DESC,r.registration_id DESC
   LIMIT 1;
  IF v_r.registration_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A later registration, including an eliminated one, makes an unkeyed
  -- "latest receipt" unsafe. The exact request-key path is also refused while
  -- any later registration row exists: a replay is an outcome read, never an
  -- operation against a new lifecycle.
  IF EXISTS(
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=v_r.tournament_id AND tp.user_id=v_r.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*),count(*) FILTER (WHERE e.refund_fee>0),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.refund_fee),0),2)
    INTO v_entitlement_count,v_fee_entitlement_count,
         v_entitlement_total,v_entitlement_fee
    FROM public.tournament_refund_entitlements e
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*) INTO v_source_count
    FROM unnest(v_r.entitlement_ids) WITH ORDINALITY entitlement(id,n)
    JOIN unnest(v_r.source_wallet_club_ids) WITH ORDINALITY source(club_id,n)
      USING(n)
    JOIN public.tournament_refund_entitlements e
      ON e.id=entitlement.id AND e.refund_wallet_club_id=source.club_id
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind='wallet_charge'
     AND tr.wallet_transaction_id=ANY(v_r.wallet_transaction_ids)
     AND tr.credit_ledger_id=ANY(v_r.credit_ledger_ids)
     AND tr.tournament_id=v_r.tournament_id AND tr.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tk.value),0),2)
    INTO v_ticket_count,v_ticket_total
    FROM public.tournament_tickets tk
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND tk.redemption_mode='tournament_entry_only'
     AND e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id
     AND tk.value=e.gross;
  SELECT count(*) INTO v_ticket_ledger_count
    FROM public.chip_ledger l
    JOIN public.tournament_tickets tk ON tk.id=l.to_entity_id
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text
     AND l.from_type='prize_liability'
     AND l.from_entity_id=e.tournament_id
     AND l.to_type='escrow' AND l.to_entity_id=tk.id
     AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross;
  SELECT count(*) INTO v_ticket_transaction_count
    FROM public.chip_transactions ct
    JOIN public.tournament_tickets tk
      ON tk.id::text=ct.metadata->>'ticket_id'
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
    JOIN public.chip_ledger l
      ON l.id::text=ct.metadata->>'ledger_id'
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND ct.transaction_type='tournament_ticket_issue'
     AND ct.club_id=e.refund_wallet_club_id
     AND ct.from_user_id IS NULL AND ct.to_user_id=e.user_id
     AND ct.amount=e.gross
     AND ct.metadata->>'entitlement_id'=e.id::text
     AND l.to_entity_id=tk.id
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text;

  SELECT count(*),round(COALESCE(-sum(reversal.rake_amount),0),2)
    INTO v_fee_reversal_count,v_fee_reversal_total
    FROM public.rake_records reversal
   WHERE reversal.id=ANY(v_r.fee_reversal_ids)
     AND reversal.tournament_id=v_r.tournament_id
     AND reversal.is_tournament IS TRUE
     AND reversal.source='fn_unregister_from_tournament'
     AND reversal.rake_amount<0
     AND reversal.metadata->>'kind'='tournament_fee_refund'
     AND reversal.metadata->>'user_id'=v_r.user_id::text
     AND reversal.metadata->>'registration_id'=v_r.registration_id::text;
  SELECT COALESCE(array_agg(source.id ORDER BY source.id),ARRAY[]::uuid[])
    INTO v_fee_source_ids
    FROM public.rake_records reversal
   CROSS JOIN LATERAL jsonb_array_elements_text(
     reversal.metadata->'original_rake_record_ids') raw(id)
   JOIN LATERAL (SELECT raw.id::uuid AS id) source ON true
   WHERE reversal.id=ANY(v_r.fee_reversal_ids);
  WITH exact_fee_mapping AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.id=ANY(v_r.fee_source_rake_record_ids)
       AND r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_r.registration_id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_r.entitlement_ids) AND e.refund_fee>0
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_mapping_count,v_fee_mapping_entitlement_count,v_fee_mapping_ids
    FROM exact_fee_mapping;

  IF v_r.settled_at>=v_r.scheduled_start_at
     OR v_entitlement_count<>cardinality(v_r.entitlement_ids)
     OR v_source_count<>cardinality(v_r.entitlement_ids)
     OR v_entitlement_total IS DISTINCT FROM
          round(v_r.refunded_chips+v_r.returned_ticket_value,2)
     OR v_wallet_count<>cardinality(v_r.wallet_transaction_ids)
     OR v_wallet_total IS DISTINCT FROM v_r.refunded_chips
     OR v_ticket_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_total IS DISTINCT FROM v_r.returned_ticket_value
     OR v_ticket_ledger_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_transaction_count<>cardinality(v_r.ticket_ids)
     OR v_r.fees_reversed IS DISTINCT FROM v_entitlement_fee
     OR v_fee_reversal_count<>cardinality(v_r.fee_reversal_ids)
     OR v_fee_reversal_total IS DISTINCT FROM v_r.fees_reversed
     OR v_fee_source_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_count<>v_fee_entitlement_count
     OR v_fee_mapping_entitlement_count<>v_fee_entitlement_count
     OR cardinality(v_fee_source_ids)<>(
       SELECT count(DISTINCT id) FROM unnest(v_fee_source_ids) source(id))
     OR EXISTS (
       SELECT 1 FROM public.tournament_unregistration_receipts other
        WHERE other.registration_id<>v_r.registration_id
          AND (other.fee_reversal_ids && v_r.fee_reversal_ids
            OR other.fee_source_rake_record_ids
                 && v_r.fee_source_rake_record_ids))
     OR EXISTS (
       SELECT 1
         FROM public.rake_records reversal
        WHERE reversal.id=ANY(v_r.fee_reversal_ids)
          AND (
            jsonb_typeof(reversal.metadata->'original_rake_record_ids')
              IS DISTINCT FROM 'array'
            OR jsonb_array_length(
                 reversal.metadata->'original_rake_record_ids')=0
            OR (SELECT round(COALESCE(sum(original.rake_amount),0),2)
                  FROM jsonb_array_elements_text(
                    reversal.metadata->'original_rake_record_ids') raw(id)
                  JOIN public.rake_records original
                    ON original.id=raw.id::uuid
                 WHERE original.tournament_id=v_r.tournament_id
                   AND original.club_id=reversal.club_id
                   AND original.is_tournament IS TRUE
                   AND original.rake_amount>0
                   AND original.metadata->>'user_id'=v_r.user_id::text
                   AND (
                     (original.source IN (
                        'fn_register_for_tournament',
                        'fn_register_horse_for_tournament')
                       AND original.metadata->>'kind'='tournament_entry_fee')
                     OR (original.source='process_tournament_rebuy'
                       AND original.metadata->>'kind' IN (
                         'tournament_rebuy_fee','tournament_reentry_fee'))
                     OR (original.source=
                           'fn_register_for_tournament_with_ticket'
                       AND original.metadata->>'kind'=
                           'tournament_ticket_entry_fee')
                     OR (original.source='fn_award_satellite_seat'
                       AND original.metadata->>'kind'=
                           'satellite_seat_entry_fee')))
                IS DISTINCT FROM -reversal.rake_amount))
     OR (v_r.source_table_id IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM public.tables tb
        WHERE tb.id=v_r.source_table_id
          AND tb.tournament_id=v_r.tournament_id)) THEN
    RAISE EXCEPTION 'tournament unregistration receipt % is not exact',
      v_r.registration_id USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'request_id',v_r.request_id,
    'registration_id',v_r.registration_id,
    'refunded_chips',v_r.refunded_chips,
    'returned_ticket_value',v_r.returned_ticket_value,
    'wallet_chips_from_satellite_entitlements',0,
    'entitlement_ids',to_jsonb(v_r.entitlement_ids),
    'ticket_ids',to_jsonb(v_r.ticket_ids),
    'source_wallet_club_ids',to_jsonb(v_r.source_wallet_club_ids),
    'credit_ledger_ids',to_jsonb(v_r.credit_ledger_ids),
    'wallet_transaction_ids',to_jsonb(v_r.wallet_transaction_ids),
    'fees_reversed',v_r.fees_reversed,
    'fee_reversal_ids',to_jsonb(v_r.fee_reversal_ids),
    'fee_source_rake_record_ids',to_jsonb(v_r.fee_source_rake_record_ids),
    'seat_number',v_r.seat_number,'seats_taken',v_r.seats_taken,
    'scheduled_start_at',v_r.scheduled_start_at,
    'settled_at',v_r.settled_at);
END;
$unregistration_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_unregistration_receipt(
  uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The sole entitlement-backed unregistration owner. Each personally funded
-- charge returns to its exact source club wallet. Each satellite-funded or
-- ticket-funded entry returns as another tournament-entry ticket. The latter
-- path has no wallet credit under any circumstance.
CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_table_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $entitlement_unregister_core$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_reg public.tournament_players%ROWTYPE;
  v_ent record;
  v_fee_group record;
  v_settle jsonb;
  v_ticket jsonb;
  v_receipt jsonb;
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
  v_players_before integer;
  v_rows integer;
  v_seat_number integer;
  v_seats_taken integer;
  v_non_cash_count integer;
  v_wallet_debits numeric:=0;
  v_wallet_refunds_before numeric:=0;
  v_wallet_refunds_after numeric:=0;
  v_entitled_wallet_total numeric:=0;
  v_tranche_total numeric:=0;
  v_refund_prize numeric:=0;
  v_refund_bounty numeric:=0;
  v_refund_fee numeric:=0;
  v_refund_total numeric:=0;
  v_wallet_amount numeric:=0;
  v_ticket_amount numeric:=0;
  v_running_owed numeric:=0;
  v_rake_before numeric:=0;
  v_rake_after numeric:=0;
  v_fees_reversed numeric:=0;
  v_entitlement_ids uuid[]:='{}'::uuid[];
  v_ticket_ids uuid[]:='{}'::uuid[];
  v_credit_ledger_ids uuid[]:='{}'::uuid[];
  v_wallet_transaction_ids uuid[]:='{}'::uuid[];
  v_source_wallet_club_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_ids uuid[]:='{}'::uuid[];
  v_fee_source_rake_record_ids uuid[]:='{}'::uuid[];
  v_fee_entitlement_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_id uuid;
  v_fee_source_count integer:=0;
  v_fee_source_entitlement_count integer:=0;
  v_fee_source_amount numeric:=0;
  v_request_id uuid:=COALESCE(p_request_id,gen_random_uuid());
  v_unregistered_at timestamptz;
  v_description text:=COALESCE(
    NULLIF(btrim(p_description),''),'Tournament unregistration refund');
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player ids are required'
      USING ERRCODE='22004';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- A caller-supplied request id is a durable operation identity. It may only
  -- name this exact player/event/endpoint scope. If its pre-start outcome is
  -- already committed, replay that immutable outcome even when the wall clock
  -- is now past the start; this branch performs no new unregistration writes.
  IF p_request_id IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id
         AND (r.tournament_id IS DISTINCT FROM p_tournament_id
           OR r.user_id IS DISTINCT FROM p_user_id
           OR r.source_table_id IS DISTINCT FROM p_expected_table_id)) THEN
      RAISE EXCEPTION 'unregistration request id belongs to another intent'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id) THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,p_request_id);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
      RAISE EXCEPTION
        'unregistration request id belongs to a prior registration lifecycle'
        USING ERRCODE='P0404';
    END IF;
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND tp.status::text IN ('registered','playing')
   ORDER BY tp.id LIMIT 1 FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF v_t.start_time IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
  END IF;
  IF clock_timestamp()>=v_t.start_time THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_reg.id IS NULL THEN
    -- Rolling clients without a request id may recover a just-lost response
    -- only while registration remains open. They can never turn an old receipt
    -- into a successful post-start response.
    IF p_request_id IS NULL THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,NULL);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT s.seat_number INTO v_seat_number
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id
       AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
     ORDER BY s.id LIMIT 1 FOR UPDATE OF s;
    IF v_seat_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok',false,'reason','spin_entry_already_booked');
  END IF;

  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
   ORDER BY e.entitlement_kind,e.id FOR UPDATE;
  SELECT count(*) INTO v_non_cash_count
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.registration_id=v_reg.id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id);
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>1 THEN
    RAISE EXCEPTION
      'satellite-funded registration % requires one unspent ticket entitlement',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  IF NOT COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>0 THEN
    RAISE EXCEPTION
      'cash registration % cannot own a satellite ticket entitlement',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(e.refund_prize),0),2),
         round(COALESCE(sum(e.refund_bounty),0),2),
         round(COALESCE(sum(e.refund_fee),0),2),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind='wallet_charge'),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind IN ('satellite_seat','tournament_ticket')),0),2)
    INTO v_refund_prize,v_refund_bounty,v_refund_fee,v_refund_total,
         v_wallet_amount,v_ticket_amount
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  IF v_refund_total IS DISTINCT FROM
       round(v_refund_prize+v_refund_bounty+v_refund_fee,2)
     OR v_refund_total IS DISTINCT FROM
       round(v_wallet_amount+v_ticket_amount,2) THEN
    RAISE EXCEPTION 'registration % has invalid entitlement totals',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  -- A satellite seat, including a returned ticket that was used for a later
  -- target entry, is a noncash entry for its entire registration lifecycle.
  -- Any wallet-charge entitlement attached to that registration is corrupt;
  -- refuse the whole transaction instead of ever returning chips.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND (v_wallet_amount<>0 OR v_ticket_amount<=0
       OR v_refund_total IS DISTINCT FROM v_ticket_amount) THEN
    RAISE EXCEPTION
      'satellite-funded registration % can return only a tournament ticket',
      v_reg.id USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_debits
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(e.gross),0),2) INTO v_entitled_wallet_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge';
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT round(COALESCE(sum(tr.amount_paid_now),0),2) INTO v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_wallet_debits IS DISTINCT FROM v_entitled_wallet_total
     OR v_wallet_refunds_before IS DISTINCT FROM v_tranche_total
     OR v_wallet_refunds_before>v_wallet_debits THEN
    RAISE EXCEPTION 'registration % wallet and entitlement journals disagree',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  v_running_owed:=v_tranche_total;

  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_before
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[])
    INTO v_fee_entitlement_ids
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND e.refund_fee>0
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);

  -- Bind every fee-bearing entitlement to its actual same-transaction rake
  -- journal. The refund wallet club is deliberately absent from this match:
  -- it identifies the payer, while rake_records.club_id identifies the fee
  -- recipient and can be a different club.
  WITH fee_sources AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id,
           r.club_id,r.rake_amount
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_fee_entitlement_ids)
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         round(COALESCE(sum(rake_amount),0),2),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_source_count,v_fee_source_entitlement_count,
         v_fee_source_amount,v_fee_source_rake_record_ids
    FROM fee_sources;
  IF v_fee_source_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_entitlement_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_count<>(
       SELECT count(DISTINCT id)
         FROM unnest(v_fee_source_rake_record_ids) source(id))
     OR v_fee_source_amount IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % fee entitlements do not map one-to-one to exact rake evidence',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  PERFORM 1 FROM public.rake_records r
   WHERE r.id=ANY(v_fee_source_rake_record_ids)
   ORDER BY r.club_id,r.id FOR UPDATE;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'unregister entitlement escrow prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_players_before<=0
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance
     OR v_t.total_rake IS DISTINCT FROM v_rake_before
     OR v_t.prize_pool<v_refund_prize
     OR v_t.bounty_pool<v_refund_bounty
     OR v_t.total_rake<v_refund_fee THEN
    RAISE EXCEPTION 'registration % cannot leave divergent tournament state',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.entitlement_kind='wallet_charge'
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_running_owed:=round(v_running_owed+v_ent.gross,2);
    v_settle:=public.fn_settle_tournament_refund_exact(
      p_tournament_id,p_user_id,v_ent.refund_wallet_club_id,v_running_owed,
      v_ent.refund_prize,v_ent.refund_bounty,v_ent.refund_fee,
      'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
       OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_settle->>'amount_paid')::numeric IS DISTINCT FROM v_running_owed
       OR (v_settle->>'source_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id THEN
      RAISE EXCEPTION 'registration % exact wallet refund failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_credit_ledger_ids:=array_append(
      v_credit_ledger_ids,(v_settle->>'credit_ledger_id')::uuid);
    v_wallet_transaction_ids:=array_append(
      v_wallet_transaction_ids,(v_settle->>'wallet_transaction_id')::uuid);
  END LOOP;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.registration_id=v_reg.id
       AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
      v_ent.id,'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
       OR (v_ticket->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_ticket->>'refund_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id
       OR (v_ticket->>'ticket_id') IS NULL THEN
      RAISE EXCEPTION 'registration % tournament-ticket return failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_ticket_ids:=array_append(v_ticket_ids,(v_ticket->>'ticket_id')::uuid);
  END LOOP;

  FOR v_fee_group IN
    SELECT r.club_id,round(sum(r.rake_amount),2) AS fee,
           array_agg(r.id ORDER BY r.id) AS source_rake_record_ids,
           array_agg(e.id ORDER BY e.id) AS entitlement_ids
      FROM public.rake_records r
      JOIN public.tournament_refund_entitlements e
        ON e.id=ANY(v_fee_entitlement_ids)
       AND e.refund_fee=r.rake_amount
       AND e.tournament_id=r.tournament_id
       AND e.user_id=p_user_id
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
      JOIN public.chip_ledger l
        ON l.id=e.source_ledger_id AND l.created_at=r.created_at
     WHERE r.id=ANY(v_fee_source_rake_record_ids)
     GROUP BY r.club_id ORDER BY r.club_id
  LOOP
    IF v_fee_group.fee>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,metadata)
      VALUES(
        NULL,NULL,v_fee_group.club_id,-v_fee_group.fee,v_fee_group.fee,1,
        0,true,p_tournament_id,'fn_unregister_from_tournament',
        jsonb_build_object(
          'kind','tournament_fee_refund','user_id',p_user_id,
          'registration_id',v_reg.id,
          'fee_recipient_club_id',v_fee_group.club_id,
          'entitlement_ids',to_jsonb(v_fee_group.entitlement_ids),
          'original_rake_record_ids',
            to_jsonb(v_fee_group.source_rake_record_ids)))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(
        v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee_group.fee,2);
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids
    FROM unnest(v_fee_reversal_ids) reversal(id);
  IF v_fees_reversed IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % reversed % in exact fee rows but owes %',
      v_reg.id,v_fees_reversed,v_refund_fee USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(v_t.prize_pool-v_refund_prize,2),
         bounty_pool=round(v_t.bounty_pool-v_refund_bounty,2),
         total_rake=round(v_t.total_rake-v_refund_fee,2),updated_at=now()
   WHERE id=p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_players_before
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % tournament cache changed',v_reg.id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,
         scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb
                 WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s
                           WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % was not deleted after settlement',v_reg.id
      USING ERRCODE='40001';
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_after
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.status::text IN ('registered','playing'))<>v_players_before-1
     OR v_wallet_refunds_after IS DISTINCT FROM
          round(v_wallet_refunds_before+v_wallet_amount,2)
     OR v_escrow_after.prize_balance IS DISTINCT FROM
          round(v_escrow_before.prize_balance-v_refund_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
          round(v_escrow_before.bounty_balance-v_refund_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
          round(v_escrow_before.fee_balance-v_refund_fee,2)
     OR v_rake_after IS DISTINCT FROM round(v_rake_before-v_refund_fee,2)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=p_tournament_id
          AND t.current_players=v_players_before-1
          AND t.prize_pool=v_escrow_after.prize_balance
          AND t.bounty_pool=v_escrow_after.bounty_balance
          AND t.total_rake=v_rake_after) THEN
    RAISE EXCEPTION 'registration % did not leave exact final state',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT count(*) INTO v_seats_taken FROM public.table_seats s
     WHERE s.table_id=p_expected_table_id AND s.left_at IS NULL;
  END IF;

  -- The entire transaction is refused if its final verified outcome was not
  -- established before the locked schedule cutoff. All preceding writes then
  -- roll back atomically; no wall-clock grace period exists.
  v_unregistered_at:=clock_timestamp();
  IF v_unregistered_at>=v_t.start_time THEN
    RAISE EXCEPTION 'tournament started before unregistration could commit'
      USING ERRCODE='55000';
  END IF;

  INSERT INTO public.tournament_unregistration_receipts(
    registration_id,request_id,tournament_id,user_id,source_table_id,
    refunded_chips,returned_ticket_value,entitlement_ids,ticket_ids,
    source_wallet_club_ids,credit_ledger_ids,wallet_transaction_ids,
    fees_reversed,fee_reversal_ids,fee_source_rake_record_ids,
    seat_number,seats_taken,scheduled_start_at,settled_at)
  VALUES(
    v_reg.id,v_request_id,p_tournament_id,p_user_id,p_expected_table_id,
    v_wallet_amount,v_ticket_amount,v_entitlement_ids,v_ticket_ids,
    v_source_wallet_club_ids,v_credit_ledger_ids,v_wallet_transaction_ids,
    v_fees_reversed,v_fee_reversal_ids,v_fee_source_rake_record_ids,
    v_seat_number,v_seats_taken,v_t.start_time,v_unregistered_at);
  v_receipt:=public.fn_ca_tournament_unregistration_receipt(
    p_tournament_id,p_user_id,p_expected_table_id,v_request_id);
  IF v_receipt IS NULL
     OR (v_receipt->>'registration_id')::uuid IS DISTINCT FROM v_reg.id THEN
    RAISE EXCEPTION 'registration % has no exact unregistration receipt',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  RETURN v_receipt||jsonb_build_object('replayed',false);
END;
$entitlement_unregister_core$;

REVOKE ALL ON FUNCTION public.fn_ca_unregister_tournament_player_exact(
  uuid,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(
  p_tournament_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $unregister_wrapper$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a live session'
      USING ERRCODE='28000';
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id,v_uid,NULL,'Tournament unregistration refund');
END;
$unregister_wrapper$;

REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(
  p_tournament_id uuid,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $unregister_request_wrapper$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a live session'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a request id'
      USING ERRCODE='22004';
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id,v_uid,NULL,'Tournament unregistration refund',p_request_id);
END;
$unregister_request_wrapper$;

REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(uuid,uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_leave_seat_and_refund(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $leave_wrapper$
DECLARE
  v_uid uuid:=auth.uid();
  v_tournament_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires a live session'
      USING ERRCODE='28000';
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb
   WHERE tb.id=p_table_id;
  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','table_not_found');
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    v_tournament_id,v_uid,p_table_id,'Tournament seat unregistration refund');
END;
$leave_wrapper$;

REVOKE ALL ON FUNCTION public.fn_leave_seat_and_refund(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_leave_seat_and_refund(
  p_table_id uuid,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $leave_request_wrapper$
DECLARE
  v_uid uuid:=auth.uid();
  v_tournament_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires a live session'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'fn_leave_seat_and_refund requires a request id'
      USING ERRCODE='22004';
  END IF;
  SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb
   WHERE tb.id=p_table_id;
  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','table_not_found');
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    v_tournament_id,v_uid,p_table_id,
    'Tournament seat unregistration refund',p_request_id);
END;
$leave_request_wrapper$;

REVOKE ALL ON FUNCTION public.fn_leave_seat_and_refund(uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leave_seat_and_refund(uuid,uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_admin_remove_tournament_player(
  p_tournament_id uuid,p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $admin_remove_wrapper$
DECLARE
  v_uid uuid:=auth.uid();
  v_club_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_remove_tournament_player requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_admin_remove_tournament_player requires a live session'
      USING ERRCODE='28000';
  END IF;
  SELECT t.club_id INTO v_club_id FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id,p_user_id,NULL,'Administrator tournament removal refund');
END;
$admin_remove_wrapper$;

REVOKE ALL ON FUNCTION public.fn_admin_remove_tournament_player(uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_admin_remove_tournament_player(uuid,uuid)
  TO authenticated, service_role;

-- Owner-only verifier used for both the first return and every replay. It
-- proves persisted facts and never reruns admission or repairs evidence.
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_settlement_receipt(
  p_tournament_id uuid,
  p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $satellite_receipt$
DECLARE
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_source record;
  v_target record;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement record;
  v_field_size integer;
  v_position_count integer;
  v_rows integer;
  v_expected_rows integer;
  v_amount numeric;
  v_rake numeric;
  v_awards jsonb := '[]'::jsonb;
  v_seats jsonb := '[]'::jsonb;
  v_remainder jsonb := NULL;
  v_winner_amount numeric := 0;
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
BEGIN
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'satellite % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;
  IF v_h.receipt_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'satellite % has unsupported receipt version %',
      p_tournament_id, v_h.receipt_version USING ERRCODE = 'P0404';
  END IF;

  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.current_players, t.on_break, t.break_started_at, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.ended_at IS DISTINCT FROM v_h.source_closed_at
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'satellite % receipt is not attached to one completed close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % no longer identifies as a satellite',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_source.satellite_target_id, v_source.satellite_target)
       IS DISTINCT FROM v_h.target_id
     OR v_source.prize_pool IS NULL
     OR v_source.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_source.prize_pool, 2) IS DISTINCT FROM v_h.pool
     OR COALESCE(v_source.satellite_seats, 0) IS DISTINCT FROM v_h.advertised_seats
     OR v_h.pool < v_h.advertised_seats * v_h.ticket_cost
     OR floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count
     OR round(v_h.pool - v_h.ticket_award_count * v_h.ticket_cost, 2)
          IS DISTINCT FROM v_h.remainder THEN
    RAISE EXCEPTION 'satellite % immutable receipt disagrees with its locked contract',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id,t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty,
         t.is_pko,t.is_mystery_bounty,t.is_premium_spin,t.variant,
         t.tournament_type,t.club_id
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id
   FOR SHARE;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR (v_h.seat_count > 0 AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR COALESCE(v_target.bounty_amount,0) <> 0
       OR COALESCE(v_target.is_bounty,false)
       OR COALESCE(v_target.is_pko,false)
       OR COALESCE(v_target.is_mystery_bounty,false)
       OR COALESCE(v_target.is_premium_spin,false)
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN')) THEN
    RAISE EXCEPTION 'satellite % immutable receipt lost its locked target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- The header is the immutable settlement-time contract. Replay proves that
  -- exact value through its award, transfer and fee evidence. The terminal
  -- hardening migration also freezes the target's economic columns after its
  -- first actual seat, so cancellation and unregister use the same split.

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  SELECT count(*), count(DISTINCT tp.position)
    INTO v_field_size, v_position_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size <> v_h.field_size
     OR v_position_count <> v_h.field_size
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.position IS NULL OR tp.position < 1 OR tp.position > v_h.field_size)
    ) OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.position = 1 AND tp.status::text = 'winner'
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position > 1
          AND tp.status::text IS DISTINCT FROM 'eliminated'
     ) THEN
    RAISE EXCEPTION 'satellite % receipt has no exact final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A satellite is not terminal while its felt still owns live seats. The
  -- header freezes every source table and seat identity, plus the subset that
  -- this settlement itself released. Replay requires the exact same durable
  -- rows, every table closed at zero and no live seat left behind.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_durable_released_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NOT DISTINCT FROM v_h.settled_at
     AND ts.status IS NOT DISTINCT FROM 'left'
     AND ts.leave_pending IS FALSE
     AND ts.is_sitting_out IS FALSE
     AND ts.is_away IS FALSE
     AND ts.sit_out_at IS NULL
     AND ts.scheduled_leave_hands IS NULL;
  v_durable_released_count := cardinality(v_durable_released_ids);
  IF v_source_table_ids IS DISTINCT FROM v_h.source_table_ids
     OR cardinality(v_source_table_ids) IS DISTINCT FROM v_h.source_table_count
     OR v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR cardinality(v_source_seat_ids) IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % source table or seat closeout differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  IF v_rows <> v_h.ticket_award_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'seat')
          <> v_h.seat_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'cash')
          <> v_h.cash_ticket_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
         JOIN public.tournament_players tp
           ON tp.tournament_id = p_tournament_id AND tp.position = a.place
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR a.user_id IS DISTINCT FROM tp.user_id
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position BETWEEN 1 AND v_h.ticket_award_count
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.place = tp.position AND a.user_id = tp.user_id)
     ) THEN
    RAISE EXCEPTION 'satellite % has incomplete or non-contiguous award lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every line has one exact payout row. Cash lines additionally prove the
  -- wallet credit and closed obligation; seats prove the registration and
  -- source-to-target funding leg below.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id = a.payout_id
     WHERE a.tournament_id = p_tournament_id
       AND (p.id IS NULL
         OR p.tournament_id IS DISTINCT FROM p_tournament_id
         OR p.user_id IS DISTINCT FROM a.user_id
         OR p."position" IS DISTINCT FROM a.place
         OR p.amount IS DISTINCT FROM a.amount
         OR p.source IS DISTINCT FROM a.payout_source
         OR p.idempotency_key IS DISTINCT FROM a.idempotency_key)
  ) THEN
    RAISE EXCEPTION 'satellite % award line has no exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_obligations o ON o.id = a.obligation_id
      LEFT JOIN public.wallet_credit_idempotency k ON k.key = a.idempotency_key
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'cash'
       AND (o.id IS NULL
         OR o.tournament_id IS DISTINCT FROM p_tournament_id
         OR o.kind IS DISTINCT FROM a.obligation_kind
         OR o.place IS DISTINCT FROM a.place
         OR o.user_id IS DISTINCT FROM a.user_id
         OR o.amount_owed IS DISTINCT FROM a.amount
         OR o.amount_paid IS DISTINCT FROM a.amount
         OR o.settled_at IS NULL
         OR k.key IS NULL
         OR k.user_id IS DISTINCT FROM a.user_id
         OR k.amount IS DISTINCT FROM a.amount)
  ) THEN
    RAISE EXCEPTION 'satellite % cash ticket has no exact wallet/debt evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key = 'tourney:' || p_tournament_id::text
                               || ':seat:' || a.user_id::text || ':pool_transfer'
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
           OR target_player.user_id IS DISTINCT FROM a.user_id
           OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
           OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR l.id IS NULL
         OR l.amount IS DISTINCT FROM v_h.ticket_cost
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM v_h.target_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(r.rake_amount), 0), 2)
    INTO v_rows, v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = v_h.target_id
     AND r.is_tournament
     AND r.source = 'fn_award_satellite_seat'
     AND r.metadata->>'satellite_id' = p_tournament_id::text;
  IF v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR v_rake IS DISTINCT FROM round(v_h.seat_count * v_h.target_fee, 2)
     OR (SELECT count(DISTINCT r.metadata->>'registration_id')
           FROM public.rake_records r
          WHERE r.tournament_id = v_h.target_id
            AND r.is_tournament
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = p_tournament_id::text)
          <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR r.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_entry_fee'
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
     ) OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.delivery_kind = 'seat'
          AND v_h.target_fee > 0
          AND (SELECT count(*)
                 FROM public.rake_records r
                WHERE r.tournament_id = v_h.target_id
                  AND r.is_tournament
                  AND r.source = 'fn_award_satellite_seat'
                  AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
                  AND r.metadata->>'satellite_id' = p_tournament_id::text
                  AND r.metadata->>'user_id' = a.user_id::text
                  AND r.metadata->>'registration_id' = a.registration_id::text
                  AND r.rake_amount = v_h.target_fee
                  AND r.pot_size = v_h.ticket_cost) <> 1
     ) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;
  IF v_rows <> (v_h.cash_ticket_count
                + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'satellite % has missing or extra obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.remainder > 0 THEN
    IF (SELECT count(*) FROM public.tournament_satellite_remainders r
         WHERE r.tournament_id = p_tournament_id) <> 1
       OR NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_satellite_remainders r
          ON r.tournament_id = p_tournament_id
         AND r.user_id = bubble.user_id
         AND r.place = v_h.bubble_position
         AND r.amount = v_h.remainder
        JOIN public.tournament_payouts p
          ON p.id = r.payout_id
         AND p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" IS NOT DISTINCT FROM r.payout_position
         AND p.amount = v_h.remainder
         AND p.source = r.payout_source
         AND p.idempotency_key = r.idempotency_key
        JOIN public.tournament_obligations o
          ON o.id = r.obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = r.obligation_kind
         AND o.place IS NOT DISTINCT FROM r.obligation_place
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.wallet_credit_idempotency k
          ON k.key = r.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
         AND (
           (r.evidence_kind = 'atomic'
             AND r.payout_position IS NOT DISTINCT FROM r.place
             AND r.obligation_place IS NOT DISTINCT FROM r.place
             AND r.idempotency_key = 'tourney:' || p_tournament_id::text
                 || ':satellite_remainder:place:' || r.place::text)
           OR r.evidence_kind = 'legacy_20260908_682')
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'satellite_remainder'
     ) THEN
    RAISE EXCEPTION 'satellite % has remainder evidence when remainder is zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_expected_rows := v_h.ticket_award_count
                     + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_amount
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_rows <> v_expected_rows OR v_amount IS DISTINCT FROM v_h.pool THEN
    RAISE EXCEPTION
      'satellite % payout evidence has % rows / % chips, expected % / %',
      p_tournament_id, v_rows, v_amount, v_expected_rows, v_h.pool
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.prize IS DISTINCT FROM CASE
         WHEN tp.position BETWEEN 1 AND v_h.ticket_award_count THEN v_h.ticket_cost
         WHEN v_h.remainder > 0 AND tp.position = v_h.bubble_position
           THEN v_h.remainder
         ELSE 0::numeric
       END
  ) THEN
    RAISE EXCEPTION 'satellite % prize cache disagrees with its receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_out IS DISTINCT FROM v_h.pool
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at
     OR v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION 'satellite % did not close every escrow bank at zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  IF v_rake_settlement.tournament_id IS NULL
     OR v_rake_settlement.settled_at IS NULL
     OR v_rake_settlement.amount IS DISTINCT FROM v_rake
     OR (v_rake > 0 AND v_rake_settlement.attributed_at IS NULL) THEN
    RAISE EXCEPTION 'satellite % rake has no exact terminal settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'delivery_kind', a.delivery_kind,
           'payout_id', a.payout_id,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_awards
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  v_winner_amount := CASE WHEN v_h.ticket_award_count > 0
                          THEN v_h.ticket_cost ELSE v_h.remainder END;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', 'COMPLETED',
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'winner_id', v_h.winner_id,
    'field_size', v_h.field_size,
    'pool', v_h.pool,
    'ticket_cost', v_h.ticket_cost,
    'ticket_award_count', v_h.ticket_award_count,
    'seat_count', v_h.seat_count,
    'cash_ticket_count', v_h.cash_ticket_count,
    'awards', v_awards,
    'seats', v_seats,
    'remainder', v_remainder,
    'winner_amount', v_winner_amount,
    'source_table_count', v_h.source_table_count,
    'source_seat_count', v_h.source_seat_count,
    'released_seat_count', v_h.released_seat_count,
    'source_closeout', jsonb_build_object(
      'source_table_count', v_h.source_table_count,
      'source_table_ids', to_jsonb(v_h.source_table_ids),
      'source_seat_count', v_h.source_seat_count,
      'source_seat_ids', to_jsonb(v_h.source_seat_ids),
      'released_seat_count', v_h.released_seat_count,
      'released_seat_ids', to_jsonb(v_h.released_seat_ids),
      'closed_at', v_h.source_closed_at,
      'escrow_closed_at', v_h.source_escrow_closed_at,
      'escrow_close_note', v_h.source_escrow_close_note),
    'settled_at', v_h.settled_at,
    'receipt_version', v_h.receipt_version);
END;
$satellite_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_satellite_settlement_receipt(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The only service-facing settlement door. There are no exception handlers:
-- any failed registration, credit, evidence row, escrow movement, rake step,
-- cache write or receipt proof aborts this complete database transaction.
CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(
  p_tournament_id uuid,
  p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $settle_satellite$
DECLARE
  v_source record;
  v_target record;
  v_target_after record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_rows integer;
  v_registration_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '40001';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A bounty or Spin target needs a different, fully receipted split across
  -- prize, fee and bounty rails. This authority deliberately refuses that
  -- contract instead of silently classifying the bounty slice as prize.
  IF (
       v_target.is_bounty IS DISTINCT FROM false
       OR v_target.is_pko IS DISTINCT FROM false
       OR v_target.is_mystery_bounty IS DISTINCT FROM false
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported bounty or Spin entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'satellite % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'satellite % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
           OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL
     OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'observed winner % does not match the locked last survivor in satellite %',
      p_observed_winner_id, p_tournament_id USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = 1 AND tp.user_id IS DISTINCT FROM v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1,
         eliminated_at = NULL, elimination_sequence = NULL
   WHERE id = v_winner.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not promote exactly one winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;

  SELECT count(*), count(DISTINCT tp.position)
    INTO v_rows, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position BETWEEN 1 AND v_field_size;
  IF v_rows <> v_field_size OR v_distinct_sequence_count <> v_field_size THEN
    RAISE EXCEPTION 'satellite % could not prove contiguous final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = v_place;
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_delivery_kind := 'seat';
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     p_observed_winner_id, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_place
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING id INTO v_registration_id;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_target.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'position', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id));
      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_place,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" = v_place
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_target_buy_in, 2),
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_target_buy_in, 2)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM v_target_escrow.gross_in
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM v_target_escrow.bounty_in
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM v_target_escrow.bounty_balance
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND position BETWEEN 1 AND v_ticket_award_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  RETURN public.fn_ca_satellite_settlement_receipt(
    p_tournament_id, p_observed_winner_id);
END;
$settle_satellite$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid) IS
  'Single atomic satellite finish. The finalized pool funds floor(pool/ticket) full ticket awards (actual seat or exact cash substitution), then one next finisher receives all residual; source seats, source tables and lifecycle close in the same transaction. No settlement-time house funding, split or retained dust.';

-- A lost HTTP response cannot tell the engine whether PostgreSQL committed.
-- Wait behind the same first lock as the whole-event authority, then return
-- either the exact immutable receipt or a definitive no-receipt live state.
-- This resolver is read-only apart from its transaction-scoped locks.
CREATE OR REPLACE FUNCTION public.fn_resolve_satellite_settlement_outcome(
  p_tournament_id uuid,
  p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '45s'
AS $satellite_outcome$
DECLARE
  v_t record;
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_receipt jsonb;
  v_observed_target_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite outcome requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT COALESCE(t.satellite_target_id,t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL
     OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target',p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- The rolling legacy seat door locks target then source. Use that same
  -- order until stage two removes it, and revalidate the relationship after
  -- both rows are locked. The global lock serializes every new authority;
  -- this order also prevents an old target-first caller from forming a cycle.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id,v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END,t.id
   FOR UPDATE;
  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND
     OR COALESCE(v_t.satellite_target_id,v_t.satellite_target)
          IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while outcome acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;
  IF lower(COALESCE(v_t.variant::text,'')) <> 'satellite'
     AND upper(COALESCE(v_t.tournament_type::text,'')) <> 'SATELLITE'
     AND v_t.satellite_target_id IS NULL
     AND v_t.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite',p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_h FROM public.tournament_satellite_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
      RAISE EXCEPTION
        'satellite outcome winner disagrees with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    v_receipt := public.fn_ca_satellite_settlement_receipt(
      p_tournament_id,p_observed_winner_id);
    RETURN jsonb_build_object(
      'ok',true,
      'satellite_committed',true,
      'definitively_not_committed',false,
      'status','COMPLETED',
      'tournament_id',p_tournament_id,
      'winner_id',p_observed_winner_id,
      'receipt',v_receipt);
  END IF;

  IF upper(COALESCE(v_t.status::text,'')) = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed satellite % has no atomic settlement receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % has non-terminal-outcome status %',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,
    'satellite_committed',false,
    'definitively_not_committed',true,
    'status',upper(v_t.status::text),
    'tournament_id',p_tournament_id,
    'winner_id',p_observed_winner_id,
    'receipt','null'::jsonb);
END;
$satellite_outcome$;

REVOKE ALL ON FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid) IS
  'Service-only serialized transport-outcome resolver. It waits behind the global terminal lock and returns either the verified committed satellite receipt or definitive no-receipt RUNNING/COMPLETING state.';

-- One known production event completed through the legacy split authority:
-- place 1 (beer710) received the exact 200 ticket in cash, but 85 remained in
-- the satellite escrow instead of going to place 2 (DETVal). This owner-only,
-- event-specific adoption accepts no nearby shape: every identity, amount,
-- row count, wallet claim, debt, standing and escrow balance is asserted. It
-- adopts the already-paid leg, pays only the missing 85, writes the immutable
-- receipt, proves conservation, and is dropped in this transaction.
CREATE OR REPLACE FUNCTION public.fn_ca_adopt_b066_satellite_remainder()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $adopt_b066$
DECLARE
  v_tournament_id constant uuid := 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f';
  v_target_id constant uuid := '13dd6b98-b882-4690-a479-3a6f77783ad6';
  v_winner_id constant uuid := '3d15bbe7-f752-4a49-be3a-079232d23b0f';
  v_bubble_id constant uuid := 'ed3f0662-8da7-4c24-b8d7-a1000d60cb1f';
  v_winner_row_id constant uuid := '73a2e426-9c82-4674-a267-d73502cd2df8';
  v_bubble_row_id constant uuid := '438045e8-d7d3-4a05-b8ba-c7b25f8e9b03';
  v_existing_payout_id constant uuid := 'bbcb41fc-dfa4-4a56-a6e6-00601279a1ce';
  v_existing_obligation_id constant uuid := 'ce188179-6b89-45aa-b0d0-94c5441ca2a2';
  v_table_id constant uuid := 'f2ab8f6c-cb2b-4585-b4b4-90cb5e775d99';
  v_winner_seat_id constant uuid := '4c67b481-22e6-4edd-887a-cdb665b2257f';
  v_bubble_seat_id constant uuid := '5a771fcc-2d5c-4fcf-a126-64abd9377125';
  v_existing_key constant text :=
    'tourney:b066f432-2aae-4994-85c8-f9bfbfa4cd2f:obl:ce188179-6b89-45aa-b0d0-94c5441ca2a2:0';
  v_source record;
  v_target record;
  v_winner public.tournament_players%ROWTYPE;
  v_bubble public.tournament_players%ROWTYPE;
  v_existing_payout public.tournament_payouts%ROWTYPE;
  v_existing_obligation public.tournament_obligations%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement public.tournament_rake_settlements%ROWTYPE;
  v_advertised_seats integer;
  v_ticket_cost numeric;
  v_rows integer;
  v_paid numeric;
  v_receipt jsonb;
  v_payout_id uuid;
  v_remainder_obligation_id uuid;
  v_credited boolean;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
BEGIN
  -- The event-specific payer takes the same global lock before every row lock.
  -- No identity is discovered dynamically and no money moves until every
  -- immutable source, roster, wallet, ledger, rake and escrow fact is exact.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (v_tournament_id, v_target_id)
   ORDER BY CASE WHEN t.id = v_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.union_id,
         t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.total_rake, t.prize_pool_finalized,
         t.buy_in_amount, t.buy_in_fee,
         t.created_at, t.start_time, t.started_at, t.ended_at,
         t.level_started_at, t.current_players, t.max_players, t.table_size,
         t.on_break, t.break_started_at, t.break_ends_at,
         t.is_bounty, t.is_pko, t.is_mystery_bounty,
         t.is_premium_spin, t.spin_multiplier
    INTO v_source FROM public.tournaments t WHERE t.id = v_tournament_id;
  SELECT t.id, t.name, t.club_id, t.union_id,
         t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.created_at, t.start_time,
         t.max_players, t.current_players, t.prize_pool, t.total_rake,
         t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin, t.spin_multiplier
    INTO v_target FROM public.tournaments t WHERE t.id = v_target_id;
  v_ticket_cost := round(COALESCE(v_target.buy_in_amount, 0)
                         + COALESCE(v_target.buy_in_fee, 0), 2);
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_source.id IS DISTINCT FROM v_tournament_id
     OR v_target.id IS DISTINCT FROM v_target_id
     OR v_source.name IS DISTINCT FROM
          'Sunday $200 Deep Stack Satellite Heads-Up'
     OR v_source.club_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_source.union_id IS DISTINCT FROM v_source.club_id
     OR upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR lower(COALESCE(v_source.variant, '')) <> 'sng'
     OR upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     OR v_source.satellite_target_id IS DISTINCT FROM v_target_id
     OR v_source.satellite_target IS NOT NULL
     OR v_source.satellite_seats IS DISTINCT FROM 1
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.prize_pool IS DISTINCT FROM 285.00::numeric
     OR v_source.total_rake IS DISTINCT FROM 15.00::numeric
     OR v_source.buy_in_amount IS DISTINCT FROM 142.50::numeric
     OR v_source.buy_in_fee IS DISTINCT FROM 7.50::numeric
     OR v_source.created_at IS DISTINCT FROM
          '2026-09-07 06:22:57.037268+00'::timestamptz
     OR v_source.start_time IS DISTINCT FROM
          '2026-09-07 06:52:28.265114+00'::timestamptz
     OR v_source.started_at IS DISTINCT FROM
          '2026-09-07 07:04:23.341+00'::timestamptz
     OR v_source.ended_at IS DISTINCT FROM
          '2026-09-07 07:10:38.412+00'::timestamptz
     OR v_source.level_started_at IS DISTINCT FROM
          '2026-09-07 07:10:38.457+00'::timestamptz
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.max_players IS DISTINCT FROM 2
     OR v_source.table_size IS DISTINCT FROM 2
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL
     OR v_source.is_bounty IS DISTINCT FROM false
     OR v_source.is_pko IS DISTINCT FROM false
     OR v_source.is_mystery_bounty IS DISTINCT FROM false
     OR v_source.is_premium_spin IS DISTINCT FROM false
     OR v_source.spin_multiplier IS DISTINCT FROM 0
     OR v_target.name IS DISTINCT FROM 'Sunday $200 Deep Stack'
     OR v_target.club_id IS DISTINCT FROM v_source.club_id
     OR v_target.union_id IS DISTINCT FROM v_source.union_id
     OR upper(COALESCE(v_target.status,'')) <> 'REGISTERING'
     OR lower(COALESCE(v_target.variant,'')) <> 'freezeout'
     OR upper(COALESCE(v_target.tournament_type,'')) <> 'MTT'
     OR v_target.buy_in_amount IS DISTINCT FROM 180.00::numeric
     OR v_target.buy_in_fee IS DISTINCT FROM 20.00::numeric
     OR v_target.created_at IS DISTINCT FROM
          '2026-09-06 17:03:26.037453+00'::timestamptz
     OR v_target.start_time IS DISTINCT FROM
          '2026-09-13 17:00:00+00'::timestamptz
     OR v_target.max_players IS DISTINCT FROM 1000
     OR v_target.prize_pool_finalized IS DISTINCT FROM false
     OR v_target.is_bounty IS DISTINCT FROM false
     OR v_target.is_pko IS DISTINCT FROM false
     OR v_target.is_mystery_bounty IS DISTINCT FROM false
     OR v_target.is_premium_spin IS DISTINCT FROM false
     OR v_target.spin_multiplier IS DISTINCT FROM 0
     OR v_ticket_cost IS DISTINCT FROM 200.00::numeric
     OR v_advertised_seats IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'b066 adoption: immutable source/target contract differs from the audited 285/200 event'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (v_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = v_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = v_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id ORDER BY p.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id ORDER BY o.id FOR UPDATE;
  PERFORM 1 FROM public.wallet_credit_idempotency k
   WHERE k.key LIKE 'tourney:' || v_tournament_id::text || ':%'
   ORDER BY k.key FOR UPDATE;
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = v_tournament_id ORDER BY w.id FOR UPDATE;
  PERFORM 1 FROM public.chip_ledger l
   WHERE l.tournament_id = v_tournament_id
      OR l.from_entity_id = v_tournament_id
      OR l.to_entity_id = v_tournament_id
   ORDER BY l.id FOR UPDATE;
  PERFORM 1 FROM public.rake_records r
   WHERE r.tournament_id = v_tournament_id ORDER BY r.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_rake_settlements r
   WHERE r.tournament_id = v_tournament_id FOR UPDATE;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = v_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = v_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count IS DISTINCT FROM 1
     OR v_source_table_ids IS DISTINCT FROM ARRAY[v_table_id]
     OR v_source_seat_count IS DISTINCT FROM 2
     OR v_source_seat_ids IS DISTINCT FROM
          ARRAY[v_winner_seat_id,v_bubble_seat_id]
     OR v_released_seat_count IS DISTINCT FROM 0
     OR v_released_seat_ids IS DISTINCT FROM ARRAY[]::uuid[]
     OR NOT EXISTS (
       SELECT 1 FROM public.tables tb WHERE tb.id = v_table_id
         AND tb.tournament_id = v_tournament_id
         AND lower(COALESCE(tb.status::text,'')) = 'closed'
         AND tb.lifecycle IS NULL AND tb.current_players = 0
         AND tb.created_at =
           '2026-09-07 06:22:57.862021+00'::timestamptz
         AND tb.updated_at =
           '2026-09-07 16:44:22.087914+00'::timestamptz)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats ts WHERE ts.id = v_winner_seat_id
         AND ts.table_id = v_table_id AND ts.user_id = v_winner_id
         AND ts.horse_id = v_winner_id AND ts.seat_number = 2
         AND ts.status = 'active' AND ts.stack = 600.00::numeric
         AND ts.joined_at =
           '2026-09-07 07:03:18.475653+00'::timestamptz
         AND ts.left_at =
           '2026-09-07 07:09:47.978638+00'::timestamptz
         AND ts.leave_pending IS FALSE AND ts.is_sitting_out IS FALSE
         AND ts.is_away IS FALSE AND ts.sit_out_at IS NULL
         AND ts.scheduled_leave_hands IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats ts WHERE ts.id = v_bubble_seat_id
         AND ts.table_id = v_table_id AND ts.user_id = v_bubble_id
         AND ts.horse_id = v_bubble_id AND ts.seat_number = 1
         AND ts.status = 'active' AND ts.stack = 0::numeric
         AND ts.joined_at =
           '2026-09-07 06:50:52.265114+00'::timestamptz
         AND ts.left_at = '2026-09-07 07:09:43.905+00'::timestamptz
         AND ts.leave_pending IS FALSE AND ts.is_sitting_out IS FALSE
         AND ts.is_away IS FALSE AND ts.sit_out_at IS NULL
         AND ts.scheduled_leave_hands IS NULL) THEN
    RAISE EXCEPTION 'b066 adoption: exact source felt closeout changed'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*) INTO v_rows FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tournament_id;
  SELECT * INTO v_winner FROM public.tournament_players tp
   WHERE tp.id = v_winner_row_id;
  SELECT * INTO v_bubble FROM public.tournament_players tp
   WHERE tp.id = v_bubble_row_id;
  IF v_rows <> 2
     OR v_winner.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_winner.user_id IS DISTINCT FROM v_winner_id
     OR lower(COALESCE(v_winner.username,'')) <> 'beer710'
     OR v_winner.status::text IS DISTINCT FROM 'winner'
     OR v_winner.position IS DISTINCT FROM 1
     OR v_winner.chips IS DISTINCT FROM 600.00::numeric
     OR v_winner.chip_count IS DISTINCT FROM 0::numeric
     OR v_winner.prize IS DISTINCT FROM 200.00::numeric
     OR v_winner.table_id IS DISTINCT FROM v_table_id
     OR v_winner.seat_number IS DISTINCT FROM 2
     OR v_winner.club_id IS DISTINCT FROM
          'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid
     OR v_winner.registered_at IS DISTINCT FROM
          '2026-09-07 07:03:18.475653+00'::timestamptz
     OR v_winner.eliminated_at IS NOT NULL
     OR v_winner.source_satellite_id IS NOT NULL
     OR v_winner.is_satellite_qualifier IS DISTINCT FROM false
     OR v_bubble.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_bubble.user_id IS DISTINCT FROM v_bubble_id
     OR lower(COALESCE(v_bubble.username,'')) <> 'detval'
     OR v_bubble.status::text IS DISTINCT FROM 'eliminated'
     OR v_bubble.position IS DISTINCT FROM 2
     OR v_bubble.chips IS DISTINCT FROM 0::numeric
     OR v_bubble.chip_count IS DISTINCT FROM 0::numeric
     OR v_bubble.prize IS DISTINCT FROM 0::numeric
     OR v_bubble.table_id IS DISTINCT FROM v_table_id
     OR v_bubble.seat_number IS DISTINCT FROM 1
     OR v_bubble.club_id IS DISTINCT FROM
          'a0000000-0000-0000-0000-000000000001'::uuid
     OR v_bubble.registered_at IS DISTINCT FROM
          '2026-09-07 06:50:52.265114+00'::timestamptz
     OR v_bubble.eliminated_at IS DISTINCT FROM
          '2026-09-07 07:09:42.422+00'::timestamptz
     OR v_bubble.source_satellite_id IS NOT NULL
     OR v_bubble.is_satellite_qualifier IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'b066 adoption: audited beer710/DETVal standings are not exact'
      USING ERRCODE = 'P0404';
  END IF;
  IF v_target.current_players IS DISTINCT FROM
       (SELECT count(*)::integer FROM public.tournament_players tp
         WHERE tp.tournament_id = v_target_id)
     OR v_target.prize_pool IS DISTINCT FROM
          round(v_target.current_players * 180.00::numeric, 2)
     OR v_target.total_rake IS DISTINCT FROM
          round(v_target.current_players * 20.00::numeric, 2) THEN
    RAISE EXCEPTION 'b066 adoption: target roster, pool, or rake aggregate is inconsistent'
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
              WHERE s.tournament_id = v_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_awards a
                 WHERE a.tournament_id = v_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = v_tournament_id) THEN
    RAISE EXCEPTION 'b066 adoption: immutable settlement evidence already exists'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_paid FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id;
  SELECT * INTO v_existing_payout FROM public.tournament_payouts p
   WHERE p.id = v_existing_payout_id;
  IF v_rows <> 1 OR v_paid IS DISTINCT FROM 200.00::numeric
     OR v_existing_payout.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_existing_payout.user_id IS DISTINCT FROM v_winner_id
     OR v_existing_payout."position" IS DISTINCT FROM 1
     OR v_existing_payout.amount IS DISTINCT FROM 200.00::numeric
     OR v_existing_payout.source IS DISTINCT FROM 'structure'
     OR v_existing_payout.idempotency_key IS DISTINCT FROM v_existing_key
     OR v_existing_payout.recorded_by IS DISTINCT FROM 'credit_and_log'
     OR v_existing_payout.created_at IS DISTINCT FROM
          '2026-09-07 07:09:55.308421+00'::timestamptz
     OR v_existing_payout.paid_at IS DISTINCT FROM
          '2026-09-07 07:09:55.308421+00'::timestamptz
     OR v_existing_payout.field_size IS DISTINCT FROM 2
     OR v_existing_payout.prize_pool IS DISTINCT FROM 285.00::numeric
     OR v_existing_payout.tournament_type IS DISTINCT FROM 'SATELLITE'
     OR v_existing_payout.metadata IS NOT NULL
     OR v_existing_payout.payout_structure IS DISTINCT FROM
          '{"payout_structure":"[{\"place\": 1, \"percentage\": 100.0000000000000000}]"}'::jsonb THEN
    RAISE EXCEPTION 'b066 adoption: exact existing 200 payout changed'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_existing_obligation FROM public.tournament_obligations o
   WHERE o.id = v_existing_obligation_id;
  IF (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = v_tournament_id) <> 1
     OR v_existing_obligation.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_existing_obligation.kind IS DISTINCT FROM 'place'
     OR v_existing_obligation.place IS DISTINCT FROM 1
     OR v_existing_obligation.user_id IS DISTINCT FROM v_winner_id
     OR v_existing_obligation.amount_owed IS DISTINCT FROM 200.00::numeric
     OR v_existing_obligation.amount_paid IS DISTINCT FROM 200.00::numeric
     OR v_existing_obligation.source IS DISTINCT FROM 'engine.processSatelliteAwards'
     OR v_existing_obligation.created_at IS DISTINCT FROM
          '2026-09-07 07:09:55.308421+00'::timestamptz
     OR v_existing_obligation.updated_at IS DISTINCT FROM
          '2026-09-07 07:09:55.308421+00'::timestamptz
     OR v_existing_obligation.settled_at IS DISTINCT FROM
          '2026-09-07 07:09:55.308421+00'::timestamptz
     OR v_existing_obligation.adjustment_id IS NOT NULL THEN
    RAISE EXCEPTION 'b066 adoption: exact existing 200 obligation changed'
      USING ERRCODE = 'P0404';
  END IF;

  IF (SELECT count(*) FROM public.wallet_credit_idempotency k
       WHERE k.key LIKE 'tourney:' || v_tournament_id::text || ':%') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_credit_idempotency k
        WHERE k.key = v_existing_key AND k.user_id = v_winner_id
          AND k.amount = 200.00
          AND k.created_at =
            '2026-09-07 07:09:55.308421+00'::timestamptz) THEN
    RAISE EXCEPTION 'b066 adoption: exact existing wallet claim changed'
      USING ERRCODE = 'P0404';
  END IF;

  IF (SELECT count(*) FROM public.wallet_transactions w
       WHERE w.related_entity_id = v_tournament_id) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = '80c1bb2e-4469-4d80-b812-856af0d7bc9a'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_bubble_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'debit' AND w.category = 'tournament_buyin'
          AND w.amount = 150.00 AND w.balance_after = 22857.00
          AND w.created_at =
            '2026-09-07 06:50:52.265114+00'::timestamptz
          AND w.description =
            'Tournament buy-in: Sunday $200 Deep Stack Satellite Heads-Up')
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = '6428e924-3a68-4d17-9b81-89b3aa0346f3'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_winner_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'debit' AND w.category = 'tournament_buyin'
          AND w.amount = 150.00 AND w.balance_after = 108400.11
          AND w.created_at =
            '2026-09-07 07:03:18.475653+00'::timestamptz
          AND w.description =
            'Tournament buy-in: Sunday $200 Deep Stack Satellite Heads-Up')
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = 'aa8ad737-3946-4d58-8875-9b4a308f22a4'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_winner_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'credit' AND w.category = 'prize'
          AND w.amount = 200.00 AND w.balance_after = 108600.11
          AND w.created_at =
            '2026-09-07 07:09:55.308421+00'::timestamptz
          AND w.description =
            'Satellite seat fallback (registration failed): Sunday $200 Deep Stack') THEN
    RAISE EXCEPTION 'b066 adoption: exact wallet movement evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.tournament_id = v_tournament_id) <> 4
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '26177949-d18c-4032-871f-a7d6d85174cb'::uuid
          AND l.chain_seq = 2222226
          AND l.row_hash =
            'e26371eb8b31f4715064ad659aff8fad7cd4b9700050fb22cc66e949ab6e4a5a'
          AND l.status = 'posted' AND l.amount = 150.00
          AND l.category = 'tournament_buyin'
          AND l.from_type = 'player_wallet' AND l.from_entity_id = v_bubble_id
          AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tournament_id
          AND l.tournament_id = v_tournament_id
          AND l.created_at =
            '2026-09-07 06:50:52.265114+00'::timestamptz)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '6c32cb63-6d83-4a55-8e94-42516be37096'::uuid
          AND l.chain_seq = 2222890
          AND l.row_hash =
            'd35dd16f9e9185b4d477efae1d25ea948b8a6bd63b25849dc325fb39bb760c30'
          AND l.status = 'posted' AND l.amount = 150.00
          AND l.category = 'tournament_buyin'
          AND l.from_type = 'player_wallet' AND l.from_entity_id = v_winner_id
          AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tournament_id
          AND l.tournament_id = v_tournament_id
          AND l.created_at =
            '2026-09-07 07:03:18.475653+00'::timestamptz)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '33a89e79-b729-423b-85e2-2f9c6f523526'::uuid
          AND l.chain_seq = 2224571
          AND l.row_hash =
            'a390e8e672982c97a5eb7bea89c26f9f258cd55a770de9e5f1edd08b08b38b17'
          AND l.status = 'posted' AND l.amount = 200.00
          AND l.category = 'tournament_prize'
          AND l.from_type = 'prize_liability'
          AND l.from_entity_id = v_tournament_id
          AND l.to_type = 'player_wallet' AND l.to_entity_id = v_winner_id
          AND l.tournament_id = v_tournament_id
          AND l.created_at =
            '2026-09-07 07:09:55.308421+00'::timestamptz)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '87f72498-190c-4daf-8707-ac919d3250f5'::uuid
          AND l.chain_seq = 2224698
          AND l.row_hash =
            '7abfd8d54ebbdd1eabb890237f6c99a3e04dffee32d8df9b2002ac2f7f2c2eb8'
          AND l.status = 'posted' AND l.amount = 15.00
          AND l.category = 'rake'
          AND l.from_type = 'prize_liability'
          AND l.from_entity_id = v_tournament_id
          AND l.to_type = 'union_wallet'
          AND l.to_entity_id =
            '059bb325-6eeb-4bbd-957d-3a82e755bb0c'::uuid
          AND l.union_id =
            'fade0000-0000-0000-0000-000000000001'::uuid
          AND l.tournament_id = v_tournament_id
          AND l.created_at =
            '2026-09-07 07:10:25.089098+00'::timestamptz) THEN
    RAISE EXCEPTION 'b066 adoption: exact append-only ledger evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  IF (SELECT count(*) FROM public.rake_records r
       WHERE r.tournament_id = v_tournament_id AND r.is_tournament) <> 2
     OR (SELECT round(COALESCE(sum(r.rake_amount),0),2)
           FROM public.rake_records r
          WHERE r.tournament_id = v_tournament_id AND r.is_tournament)
          IS DISTINCT FROM 15.00::numeric
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.id = '9d44ed89-eb3f-436a-a7d6-e8f8cf6bc50d'::uuid
          AND r.tournament_id = v_tournament_id AND r.is_tournament
          AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
          AND r.hand_id IS NULL AND r.table_id IS NULL
          AND r.source = 'fn_register_horse_for_tournament'
          AND r.rake_amount = 7.50 AND r.pot_size = 150.00
          AND r.num_players = 1 AND r.global_hand_id = 21386753
          AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
          AND r.rake_method = 'DEALT_EQUAL'
          AND r.created_at =
            '2026-09-07 06:50:52.265114+00'::timestamptz
          AND r.metadata = jsonb_build_object(
            'kind','tournament_entry_fee','user_id',v_bubble_id,
            'registration_id',v_bubble_row_id)
          AND r.player_contributions IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.id = '4e2ded0c-0a92-4ffb-93d2-2beb81c37a10'::uuid
          AND r.tournament_id = v_tournament_id AND r.is_tournament
          AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
          AND r.hand_id IS NULL AND r.table_id IS NULL
          AND r.source = 'fn_register_horse_for_tournament'
          AND r.rake_amount = 7.50 AND r.pot_size = 150.00
          AND r.num_players = 1 AND r.global_hand_id = 21392442
          AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
          AND r.rake_method = 'DEALT_EQUAL'
          AND r.created_at =
            '2026-09-07 07:03:18.475653+00'::timestamptz
          AND r.metadata = jsonb_build_object(
            'kind','tournament_entry_fee','user_id',v_winner_id,
            'registration_id',v_winner_row_id)
          AND r.player_contributions IS NULL) THEN
    RAISE EXCEPTION 'b066 adoption: exact entry-fee evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement FROM public.tournament_rake_settlements r
   WHERE r.tournament_id = v_tournament_id;
  IF (SELECT count(*) FROM public.tournament_rake_settlements r
       WHERE r.tournament_id = v_tournament_id) <> 1
     OR v_rake_settlement.amount IS DISTINCT FROM 15.00::numeric
     OR v_rake_settlement.source IS DISTINCT FROM 'engine_finish'
     OR v_rake_settlement.club_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_rake_settlement.union_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_rake_settlement.destination IS DISTINCT FROM
          'union:fade0000-0000-0000-0000-000000000001'
     OR v_rake_settlement.created_at IS DISTINCT FROM
          '2026-09-07 07:10:25.089098+00'::timestamptz
     OR v_rake_settlement.settled_at IS DISTINCT FROM
          '2026-09-07 07:10:25.089098+00'::timestamptz
     OR v_rake_settlement.attributed_at IS DISTINCT FROM
          '2026-09-07 07:25:13.951356+00'::timestamptz
     OR v_rake_settlement.attributed_users IS DISTINCT FROM 2
     OR v_rake_settlement.attribution_error IS NOT NULL THEN
    RAISE EXCEPTION 'b066 adoption: exact terminal rake settlement changed'
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = v_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || v_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = v_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = v_tournament_id::text) THEN
    RAISE EXCEPTION 'b066 adoption: an unreceipted seat leg exists'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = v_tournament_id FOR UPDATE;
  IF v_source_escrow.tournament_id IS DISTINCT FROM v_tournament_id
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.gross_in IS DISTINCT FROM 300.00::numeric
     OR v_source_escrow.fee_entries_in IS DISTINCT FROM 15.00::numeric
     OR v_source_escrow.satellite_fee_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.overlay_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.satellite_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_out IS DISTINCT FROM 200.00::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_out IS DISTINCT FROM 15.00::numeric
     OR v_source_escrow.refund_prize IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_fee IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 85.00::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.opened_at IS DISTINCT FROM
          '2026-09-07 06:50:52.265114+00'::timestamptz
     OR v_source_escrow.updated_at IS DISTINCT FROM
          '2026-09-07 07:10:25.089098+00'::timestamptz
     OR v_source_escrow.closed_at IS DISTINCT FROM
          '2026-09-07 07:10:38.664363+00'::timestamptz
     OR v_source_escrow.opened_from IS DISTINCT FROM
          'shadow at first sight (tournament_buyin)'
     OR v_source_escrow.close_note IS DISTINCT FROM
          'closed with prize 85.00, bounty 0.00, fee 0.00 still to settle; fn_ca_escrow_vs_counter_check judges this after settlement' THEN
    RAISE EXCEPTION 'b066 adoption: exact closed source escrow changed'
      USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (v_tournament_id, v_target_id, false, NULL,
     v_winner.user_id, 2, v_advertised_seats, 285.00,
     round(v_target.buy_in_amount, 2), round(COALESCE(v_target.buy_in_fee, 0), 2),
     200.00, 1, 0, 1, 85.00, v_bubble.user_id, 2,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_source.ended_at, v_source_escrow.closed_at,
     v_source_escrow.close_note, v_closeout_at);

  INSERT INTO public.tournament_satellite_awards
    (tournament_id, place, user_id, delivery_kind, amount,
     payout_id, payout_source, idempotency_key,
     obligation_id, obligation_kind)
  VALUES
    (v_tournament_id, 1, v_winner.user_id, 'cash', 200.00,
     v_existing_payout.id, v_existing_payout.source,
     v_existing_payout.idempotency_key,
     v_existing_obligation.id, v_existing_obligation.kind);

  INSERT INTO public.tournament_obligations
    (tournament_id, kind, place, user_id, amount_owed, amount_paid,
     source, settled_at)
  VALUES
    (v_tournament_id, 'satellite_remainder', 2, v_bubble.user_id,
     85.00, 0, 'migration.20260909014421.b066', NULL)
  RETURNING id INTO v_remainder_obligation_id;

  v_credited := public.fn_credit_and_log(
    p_user_id => v_bubble.user_id,
    p_amount => 85.00,
    p_idempotency_key => 'tourney:' || v_tournament_id::text
                         || ':satellite_remainder:place:2',
    p_category => 'prize',
    p_description => 'Satellite pool remainder paid to the single bubble',
    p_related_entity_id => v_tournament_id,
    p_wallet_type => 'PLAYER',
    p_table_id => NULL,
    p_hand_id => NULL,
    p_payout_position => 2,
    p_payout_source => 'satellite_remainder');
  IF v_credited IS NOT TRUE THEN
    RAISE EXCEPTION 'b066 adoption: exact 85 remainder credit was refused'
      USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.tournament_obligations o
     SET amount_paid = 85.00, settled_at = now(), updated_at = now()
   WHERE o.id = v_remainder_obligation_id
     AND o.amount_owed = 85.00 AND o.amount_paid = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'b066 adoption: exact remainder debt did not close'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id
     AND p.user_id = v_bubble.user_id
     AND p."position" = 2
     AND p.amount = 85.00
     AND p.source = 'satellite_remainder'
     AND p.idempotency_key = 'tourney:' || v_tournament_id::text
                              || ':satellite_remainder:place:2';
  IF v_payout_id IS NULL THEN
    RAISE EXCEPTION 'b066 adoption: exact remainder payout evidence is missing'
      USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_remainders
    (tournament_id, user_id, place, amount,
     payout_id, payout_source, payout_position, idempotency_key,
     obligation_id, obligation_kind, obligation_place, evidence_kind)
  VALUES
    (v_tournament_id, v_bubble.user_id, 2, 85.00,
     v_payout_id, 'satellite_remainder', 2,
     'tourney:' || v_tournament_id::text || ':satellite_remainder:place:2',
     v_remainder_obligation_id, 'satellite_remainder', 2, 'atomic');

  UPDATE public.tournament_players SET prize = 85.00
   WHERE id = v_bubble_row_id AND tournament_id = v_tournament_id
     AND user_id = v_bubble_id AND position = 2 AND prize = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'b066 adoption: Bubble prize cache did not update exactly'
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'b066 adoption: released % source seats, expected %',
      v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);
  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_source.ended_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = v_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = v_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_source.ended_at)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = v_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'b066 adoption: source felt did not close exactly'
      USING ERRCODE = '40001';
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_paid FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = v_tournament_id FOR UPDATE;
  IF v_rows <> 2 OR v_paid IS DISTINCT FROM 285.00::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'b066 adoption: conservation proof failed after correction'
      USING ERRCODE = 'P0404';
  END IF;

  v_receipt := public.fn_ca_satellite_settlement_receipt(
    v_tournament_id, v_winner_id);
  IF COALESCE((v_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
     OR (v_receipt->'remainder'->>'user_id')::uuid IS DISTINCT FROM v_bubble_id
     OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 2
     OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM 85.00::numeric THEN
    RAISE EXCEPTION 'b066 adoption: immutable whole-pool receipt did not verify'
      USING ERRCODE = 'P0404';
  END IF;
  RETURN v_receipt;
END;
$adopt_b066$;

REVOKE ALL ON FUNCTION public.fn_ca_adopt_b066_satellite_remainder()
  FROM PUBLIC, anon, authenticated, service_role;

DO $adopt_exact_known_miss$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournaments t
              WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid) THEN
    PERFORM public.fn_ca_adopt_b066_satellite_remainder();
  END IF;
END;
$adopt_exact_known_miss$;

DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder();

-- A second production event finished while this change was being verified.
-- The legacy path paid its complete 285 exactly once: one 200 target seat and
-- all 85 left below a ticket to place 2. It then left the source pool counter,
-- prize cache and felt lifecycle stale. Preserve every append-only financial
-- row. This one-time block accepts only the exact audited identities, amounts,
-- claims, transfer, target registration, rake and zero escrow; it normalizes
-- only caches/lifecycle and records the immutable whole-pool receipt.
DO $adopt_exact_682_completion$
DECLARE
  v_tournament_id constant uuid := '682045c5-cb07-47ed-ad0e-adbff9cb41af';
  v_target_id constant uuid := '13dd6b98-b882-4690-a479-3a6f77783ad6';
  v_winner_id constant uuid := '22af2652-f8ae-4b84-8f3d-d2894f435d79';
  v_bubble_id constant uuid := '146cf7a5-7f99-4dd3-858d-26dae69d9c80';
  v_registration_id constant uuid := '324aedef-7f12-4935-8530-dde405ea6351';
  v_seat_payout_id constant uuid := '57b96759-2acd-4142-bc4e-37b273cd3542';
  v_remainder_payout_id constant uuid := '0de0bc80-dd26-4631-b7f5-3baf0fb4a9da';
  v_obligation_id constant uuid := 'a15db36e-6684-4edd-be48-277bfb3113ba';
  v_table_id constant uuid := 'ae520859-1727-4576-9b4a-98f0e0392ace';
  v_seat_one_id constant uuid := '24a9b8a9-6bd6-47da-9c8d-ce11634955c1';
  v_seat_two_id constant uuid := '2ddc7740-eb2d-4928-af42-ac05d8c852c9';
  v_seat_key constant text :=
    'tourney:682045c5-cb07-47ed-ad0e-adbff9cb41af:seat:22af2652-f8ae-4b84-8f3d-d2894f435d79';
  v_remainder_key constant text :=
    'tourney:682045c5-cb07-47ed-ad0e-adbff9cb41af:obl:a15db36e-6684-4edd-be48-277bfb3113ba:0';
  v_source record;
  v_target record;
  v_winner public.tournament_players%ROWTYPE;
  v_bubble public.tournament_players%ROWTYPE;
  v_registration public.tournament_players%ROWTYPE;
  v_seat_payout public.tournament_payouts%ROWTYPE;
  v_remainder_payout public.tournament_payouts%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_transfer public.chip_ledger%ROWTYPE;
  v_rake_settlement public.tournament_rake_settlements%ROWTYPE;
  v_rows integer;
  v_amount numeric;
  v_receipt jsonb;
  v_closeout_at timestamptz := transaction_timestamp();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id = v_tournament_id) THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (v_tournament_id, v_target_id)
   ORDER BY CASE WHEN t.id = v_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.union_id,
         t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.total_rake, t.prize_pool_finalized, t.ended_at,
         t.buy_in_amount, t.buy_in_fee, t.created_at, t.start_time,
         t.started_at, t.level_started_at, t.table_size,
         t.current_players, t.max_players, t.on_break,
         t.break_started_at, t.break_ends_at,
         t.is_bounty, t.is_pko, t.is_mystery_bounty,
         t.is_premium_spin, t.spin_multiplier
    INTO v_source FROM public.tournaments t WHERE t.id = v_tournament_id;
  SELECT t.id, t.status, t.club_id, t.union_id, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee,
         t.prize_pool_finalized, t.current_players, t.max_players,
         t.prize_pool, t.total_rake, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin, t.spin_multiplier
    INTO v_target FROM public.tournaments t WHERE t.id = v_target_id;
  IF v_source.id IS NULL OR v_target.id IS NULL
     OR v_source.name IS DISTINCT FROM
          'Sunday $200 Deep Stack Satellite Heads-Up'
     OR upper(COALESCE(v_source.status::text,'')) <> 'COMPLETED'
     OR lower(COALESCE(v_source.variant::text,'')) <> 'sng'
     OR upper(COALESCE(v_source.tournament_type::text,'')) <> 'SATELLITE'
     OR v_source.satellite_target_id IS DISTINCT FROM v_target_id
     OR v_source.satellite_target IS NOT NULL
     OR v_source.satellite_seats IS DISTINCT FROM 1
     OR v_source.prize_pool IS DISTINCT FROM 85.00::numeric
     OR v_source.total_rake IS DISTINCT FROM 15.00::numeric
     OR v_source.buy_in_amount IS DISTINCT FROM 142.50::numeric
     OR v_source.buy_in_fee IS DISTINCT FROM 7.50::numeric
     OR v_source.created_at IS DISTINCT FROM
          '2026-09-08 11:17:39.702118+00'::timestamptz
     OR v_source.start_time IS DISTINCT FROM
          '2026-09-08 11:21:08.923+00'::timestamptz
     OR v_source.started_at IS DISTINCT FROM
          '2026-09-08 11:21:40.535+00'::timestamptz
     OR COALESCE(v_source.prize_pool_finalized,false) IS NOT TRUE
     OR v_source.ended_at IS DISTINCT FROM
          '2026-09-08 11:23:11.485+00'::timestamptz
     OR v_source.level_started_at IS DISTINCT FROM
          '2026-09-08 11:21:41.794+00'::timestamptz
     OR v_source.table_size IS DISTINCT FROM 2
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.max_players IS DISTINCT FROM 2
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL
     OR v_source.club_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_source.union_id IS DISTINCT FROM v_source.club_id
     OR v_source.is_bounty IS DISTINCT FROM false
     OR v_source.is_pko IS DISTINCT FROM false
     OR v_source.is_mystery_bounty IS DISTINCT FROM false
     OR v_source.is_premium_spin IS DISTINCT FROM false
     OR v_source.spin_multiplier IS DISTINCT FROM 0
     OR upper(COALESCE(v_target.status::text,'')) <> 'REGISTERING'
     OR v_target.club_id IS DISTINCT FROM v_source.club_id
     OR v_target.union_id IS DISTINCT FROM v_source.union_id
     OR lower(COALESCE(v_target.variant::text,'')) <> 'freezeout'
     OR upper(COALESCE(v_target.tournament_type::text,'')) <> 'MTT'
     OR v_target.buy_in_amount IS DISTINCT FROM 180.00::numeric
     OR v_target.buy_in_fee IS DISTINCT FROM 20.00::numeric
     OR v_target.max_players IS DISTINCT FROM 1000
     OR v_target.prize_pool_finalized IS DISTINCT FROM false
     OR v_target.is_bounty IS DISTINCT FROM false
     OR v_target.is_pko IS DISTINCT FROM false
     OR v_target.is_mystery_bounty IS DISTINCT FROM false
     OR v_target.is_premium_spin IS DISTINCT FROM false
     OR v_target.spin_multiplier IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '682 adoption: source or target differs from the audited 285/200 completion'
      USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
              WHERE s.tournament_id = v_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_awards a
                 WHERE a.tournament_id = v_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = v_tournament_id) THEN
    RAISE EXCEPTION '682 adoption: immutable settlement evidence already exists'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (v_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;
  SELECT count(*) INTO v_rows FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tournament_id;
  SELECT * INTO v_winner FROM public.tournament_players tp
   WHERE tp.id = 'af7c21a6-b0a1-432b-9e40-04084320ba08'::uuid;
  SELECT * INTO v_bubble FROM public.tournament_players tp
   WHERE tp.id = 'b4e9c058-03ed-4bb0-956c-49e1e64ac901'::uuid;
  SELECT * INTO v_registration FROM public.tournament_players tp
   WHERE tp.id = v_registration_id;
  IF v_rows <> 2
     OR v_winner.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_winner.user_id IS DISTINCT FROM v_winner_id
     OR lower(COALESCE(v_winner.username,'')) <> 'sadwizard'
     OR v_winner.status::text IS DISTINCT FROM 'winner'
     OR v_winner.position IS DISTINCT FROM 1
     OR v_winner.chips IS DISTINCT FROM 600.00::numeric
     OR v_winner.chip_count IS DISTINCT FROM 0::numeric
     OR v_winner.prize IS DISTINCT FROM 200.00::numeric
     OR v_winner.table_id IS DISTINCT FROM v_table_id
     OR v_winner.seat_number IS DISTINCT FROM 1
     OR v_winner.club_id IS DISTINCT FROM
          'a0000000-0000-0000-0000-000000000001'::uuid
     OR v_winner.registered_at IS DISTINCT FROM
          '2026-09-08 11:17:46.273993+00'::timestamptz
     OR v_winner.eliminated_at IS NOT NULL
     OR v_winner.source_satellite_id IS NOT NULL
     OR v_winner.is_satellite_qualifier IS DISTINCT FROM false
     OR v_bubble.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_bubble.user_id IS DISTINCT FROM v_bubble_id
     OR lower(COALESCE(v_bubble.username,'')) <> 'connorford'
     OR v_bubble.status::text IS DISTINCT FROM 'eliminated'
     OR v_bubble.position IS DISTINCT FROM 2
     OR v_bubble.chips IS DISTINCT FROM 0::numeric
     OR v_bubble.chip_count IS DISTINCT FROM 0::numeric
     OR v_bubble.prize IS DISTINCT FROM 0::numeric
     OR v_bubble.table_id IS DISTINCT FROM v_table_id
     OR v_bubble.seat_number IS DISTINCT FROM 2
     OR v_bubble.club_id IS DISTINCT FROM
          'a0000000-0000-0000-0000-000000000001'::uuid
     OR v_bubble.registered_at IS DISTINCT FROM
          '2026-09-08 11:21:31.396373+00'::timestamptz
     OR v_bubble.eliminated_at IS DISTINCT FROM
          '2026-09-08 11:22:56.43+00'::timestamptz
     OR v_bubble.source_satellite_id IS NOT NULL
     OR v_bubble.is_satellite_qualifier IS DISTINCT FROM false
     OR v_registration.tournament_id IS DISTINCT FROM v_target_id
     OR v_registration.user_id IS DISTINCT FROM v_winner_id
     OR lower(COALESCE(v_registration.username,'')) <> 'sadwizard'
     OR v_registration.status::text IS DISTINCT FROM 'registered'
     OR v_registration.chips IS DISTINCT FROM 0
     OR v_registration.chip_count IS DISTINCT FROM 0
     OR v_registration.position IS NOT NULL
     OR v_registration.prize IS DISTINCT FROM 0::numeric
     OR v_registration.table_id IS NOT NULL
     OR v_registration.seat_number IS NOT NULL
     OR v_registration.club_id IS DISTINCT FROM
          'a0000000-0000-0000-0000-000000000001'::uuid
     OR v_registration.eliminated_at IS NOT NULL
     OR v_registration.registered_at IS DISTINCT FROM
          '2026-09-08 11:23:07.343372+00'::timestamptz
     OR COALESCE(v_registration.is_satellite_qualifier,false) IS NOT TRUE
     OR v_registration.source_satellite_id IS DISTINCT FROM v_tournament_id THEN
    RAISE EXCEPTION '682 adoption: exact source standings or target registration changed'
      USING ERRCODE = 'P0404';
  END IF;
  IF v_target.current_players IS DISTINCT FROM
       (SELECT count(*)::integer FROM public.tournament_players tp
         WHERE tp.tournament_id = v_target_id)
     OR v_target.prize_pool IS DISTINCT FROM
          round(v_target.current_players * 180.00::numeric, 2)
     OR v_target.total_rake IS DISTINCT FROM
          round(v_target.current_players * 20.00::numeric, 2) THEN
    RAISE EXCEPTION '682 adoption: target roster, pool, or rake aggregate is inconsistent'
      USING ERRCODE = 'P0404';
  END IF;
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.source_satellite_id = v_tournament_id) <> 1 THEN
    RAISE EXCEPTION '682 adoption: target contains extra or missing source registrations'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id ORDER BY p.id FOR UPDATE;
  SELECT count(*), round(COALESCE(sum(p.amount),0),2)
    INTO v_rows, v_amount FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id;
  SELECT * INTO v_seat_payout FROM public.tournament_payouts p
   WHERE p.id = v_seat_payout_id;
  SELECT * INTO v_remainder_payout FROM public.tournament_payouts p
   WHERE p.id = v_remainder_payout_id;
  IF v_rows <> 2 OR v_amount IS DISTINCT FROM 285.00::numeric
     OR v_seat_payout.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_seat_payout.user_id IS DISTINCT FROM v_winner_id
     OR v_seat_payout."position" IS DISTINCT FROM 1
     OR v_seat_payout.amount IS DISTINCT FROM 200.00::numeric
     OR v_seat_payout.source IS DISTINCT FROM 'satellite_seat'
     OR v_seat_payout.idempotency_key IS DISTINCT FROM v_seat_key
     OR v_seat_payout.recorded_by IS DISTINCT FROM 'award_satellite_seat'
     OR v_seat_payout.paid_at IS DISTINCT FROM
          '2026-09-08 11:23:07.343372+00'::timestamptz
     OR v_seat_payout.created_at IS DISTINCT FROM
          '2026-09-08 11:23:07.343372+00'::timestamptz
     OR v_seat_payout.tournament_type IS DISTINCT FROM 'SATELLITE'
     OR v_seat_payout.field_size IS DISTINCT FROM 2
     OR v_seat_payout.prize_pool IS DISTINCT FROM 285.00::numeric
     OR v_seat_payout.payout_structure IS NOT NULL
     OR v_seat_payout.metadata IS DISTINCT FROM
          '{"unbacked":0.00,"target_fee":20.00,"target_name":"Sunday $200 Deep Stack","pool_transfer":200.00,"target_buy_in":180.00,"registration_id":"324aedef-7f12-4935-8530-dde405ea6351","satellite_target_id":"13dd6b98-b882-4690-a479-3a6f77783ad6"}'::jsonb
     OR v_seat_payout.metadata->>'satellite_target_id' IS DISTINCT FROM v_target_id::text
     OR v_seat_payout.metadata->>'registration_id' IS DISTINCT FROM v_registration_id::text
     OR (v_seat_payout.metadata->>'target_buy_in')::numeric IS DISTINCT FROM 180.00
     OR (v_seat_payout.metadata->>'target_fee')::numeric IS DISTINCT FROM 20.00
     OR (v_seat_payout.metadata->>'pool_transfer')::numeric IS DISTINCT FROM 200.00
     OR (v_seat_payout.metadata->>'unbacked')::numeric IS DISTINCT FROM 0
     OR v_remainder_payout.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_remainder_payout.user_id IS DISTINCT FROM v_bubble_id
     OR v_remainder_payout."position" IS NOT NULL
     OR v_remainder_payout.amount IS DISTINCT FROM 85.00::numeric
     OR v_remainder_payout.source IS DISTINCT FROM 'satellite_remainder'
     OR v_remainder_payout.idempotency_key IS DISTINCT FROM v_remainder_key
     OR v_remainder_payout.recorded_by IS DISTINCT FROM 'credit_and_log'
     OR v_remainder_payout.paid_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_remainder_payout.created_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_remainder_payout.tournament_type IS DISTINCT FROM 'SATELLITE'
     OR v_remainder_payout.field_size IS DISTINCT FROM 2
     OR v_remainder_payout.prize_pool IS DISTINCT FROM 85.00::numeric
     OR v_remainder_payout.metadata IS NOT NULL
     OR v_remainder_payout.payout_structure IS DISTINCT FROM
          '{"payout_structure":"[{\"place\": 1, \"percentage\": 100.0000000000000000}]"}'::jsonb THEN
    RAISE EXCEPTION '682 adoption: exact append-only payout evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id ORDER BY o.id FOR UPDATE;
  SELECT * INTO v_obligation FROM public.tournament_obligations o
   WHERE o.id = v_obligation_id;
  IF (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = v_tournament_id) <> 1
     OR v_obligation.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_obligation.kind IS DISTINCT FROM 'satellite_remainder'
     OR v_obligation.place IS NOT NULL
     OR v_obligation.user_id IS DISTINCT FROM v_bubble_id
     OR v_obligation.amount_owed IS DISTINCT FROM 85.00::numeric
     OR v_obligation.amount_paid IS DISTINCT FROM 85.00::numeric
     OR v_obligation.source IS DISTINCT FROM 'engine.processSatelliteAwards'
     OR v_obligation.created_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_obligation.updated_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz
     OR v_obligation.adjustment_id IS NOT NULL
     OR v_obligation.settled_at IS DISTINCT FROM
          '2026-09-08 11:23:08.82402+00'::timestamptz THEN
    RAISE EXCEPTION '682 adoption: exact residual obligation changed'
      USING ERRCODE = 'P0404';
  END IF;
  PERFORM 1 FROM public.wallet_credit_idempotency k
   WHERE k.key = v_remainder_key FOR UPDATE;
  IF (SELECT count(*) FROM public.wallet_credit_idempotency k
       WHERE k.key LIKE 'tourney:' || v_tournament_id::text || ':%') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_credit_idempotency k
        WHERE k.key = v_remainder_key
          AND k.user_id = v_bubble_id AND k.amount = 85.00
          AND k.created_at =
            '2026-09-08 11:23:08.82402+00'::timestamptz) THEN
    RAISE EXCEPTION '682 adoption: exact wallet credit claim changed'
      USING ERRCODE = 'P0404';
  END IF;
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = v_tournament_id ORDER BY w.id FOR UPDATE;
  IF (SELECT count(*) FROM public.wallet_transactions w
       WHERE w.related_entity_id = v_tournament_id) <> 3
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tournament_id AND w.type = 'debit')
          IS DISTINCT FROM 300.00::numeric
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = '82bf3222-25f5-460a-aa99-e4ac265da926'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_winner_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'debit' AND w.category = 'tournament_buyin'
          AND w.amount = 150.00 AND w.balance_after = 73257.10
          AND w.created_at = '2026-09-08 11:17:46.273993+00'::timestamptz
          AND w.description =
            'Tournament buy-in: Sunday $200 Deep Stack Satellite Heads-Up')
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = 'fe1fa3f9-65ae-4bf4-948d-64be24c07021'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_bubble_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'debit' AND w.category = 'tournament_buyin'
          AND w.amount = 150.00 AND w.balance_after = 17355.64
          AND w.created_at = '2026-09-08 11:21:31.396373+00'::timestamptz
          AND w.description =
            'Tournament buy-in: Sunday $200 Deep Stack Satellite Heads-Up')
     OR NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.id = '3ac0222c-0fb9-4be8-bd15-4f9a6bfc4143'::uuid
          AND w.related_entity_id = v_tournament_id
          AND w.user_id = v_bubble_id AND w.wallet_type = 'PLAYER'
          AND w.type = 'credit'
          AND w.category = 'prize' AND w.amount = 85.00
          AND w.balance_after = 17355.64
          AND w.created_at = '2026-09-08 11:23:08.82402+00'::timestamptz
          AND w.description =
            'Satellite remainder payout: Sunday $200 Deep Stack Satellite Heads-Up') THEN
    RAISE EXCEPTION '682 adoption: exact wallet movement evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.chip_ledger l
   WHERE l.from_entity_id = v_tournament_id
      OR l.to_entity_id = v_tournament_id
   ORDER BY l.id FOR UPDATE;
  SELECT * INTO v_transfer FROM public.chip_ledger l
   WHERE l.id = '74457684-606b-4e21-bf5d-2080b3d59529'::uuid;
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.from_entity_id = v_tournament_id
          OR l.to_entity_id = v_tournament_id) <> 5
     OR (SELECT count(*) FROM public.chip_ledger l
       WHERE l.from_entity_id = v_tournament_id
         AND l.idempotency_key LIKE 'tourney:' || v_tournament_id::text
                                      || ':seat:%:pool_transfer') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '41587c9a-d438-4d68-9b27-457eaff480e7'::uuid
          AND l.chain_seq = 2655342
          AND l.row_hash = '95a1bcaa9b5b19b8ec749d6bd5b282b3c21d7b4de3a36599885fbc9c9c351ce9'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 150.00 AND l.category = 'tournament_buyin'
          AND l.from_type = 'player_wallet' AND l.from_entity_id = v_winner_id
          AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tournament_id
          AND l.tournament_id = v_tournament_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '1541288b-b050-44db-ad91-c1d85ede307d'::uuid
          AND l.chain_seq = 2656271
          AND l.row_hash = 'a29f2b5301e7752414b263577320b9b1743c3d2ac7bc0889e7153bcdc8aac43d'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 150.00 AND l.category = 'tournament_buyin'
          AND l.from_type = 'player_wallet' AND l.from_entity_id = v_bubble_id
          AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tournament_id
          AND l.tournament_id = v_tournament_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '7083eb3b-0d1a-4649-9c17-9020e2ba3926'::uuid
          AND l.chain_seq = 2656635
          AND l.row_hash = 'a39fe03421b4c453c8a2e4ec98b56b73fd67766a577e0175e3a77368a8413f34'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 85.00 AND l.category = 'tournament_prize'
          AND l.from_type = 'prize_liability' AND l.from_entity_id = v_tournament_id
          AND l.to_type = 'player_wallet' AND l.to_entity_id = v_bubble_id
          AND l.tournament_id = v_tournament_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = '321d8e0d-fa53-4e25-a4fa-3cf15e55f027'::uuid
          AND l.chain_seq = 2656641
          AND l.row_hash = '49c8c65956a1d75d3cfa400ce23508c49e9aee16987f3a51e64e34979e48c8dc'
          AND l.idempotency_key IS NULL AND l.status = 'posted'
          AND l.amount = 15.00 AND l.category = 'rake'
          AND l.from_type = 'prize_liability' AND l.from_entity_id = v_tournament_id
          AND l.to_type = 'union_wallet'
          AND l.to_entity_id = '059bb325-6eeb-4bbd-957d-3a82e755bb0c'::uuid
          AND l.tournament_id = v_tournament_id)
     OR v_transfer.amount IS DISTINCT FROM 200.00::numeric
     OR v_transfer.chain_seq IS DISTINCT FROM 2656629
     OR v_transfer.row_hash IS DISTINCT FROM
          'fce3bf285df3a16e2624fa8c35e231af12e9378dc890b7cf7e9892b3db360f70'
     OR v_transfer.status IS DISTINCT FROM 'posted'
     OR v_transfer.from_type IS DISTINCT FROM 'prize_liability'
     OR v_transfer.from_entity_id IS DISTINCT FROM v_tournament_id
     OR v_transfer.from_label IS DISTINCT FROM 'tournaments.prize_pool'
     OR v_transfer.to_type IS DISTINCT FROM 'prize_liability'
     OR v_transfer.to_entity_id IS DISTINCT FROM v_target_id
     OR v_transfer.to_label IS DISTINCT FROM 'tournaments.prize_pool+total_rake'
     OR v_transfer.category IS DISTINCT FROM 'tournament_buyin'
     OR v_transfer.tournament_id IS DISTINCT FROM v_tournament_id
     OR v_transfer.idempotency_key IS DISTINCT FROM v_seat_key || ':pool_transfer'
     OR v_transfer.pre_from_balance IS DISTINCT FROM 285.00::numeric
     OR v_transfer.post_from_balance IS DISTINCT FROM 85.00::numeric
     OR v_transfer.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_pool_transfer'
     OR (v_transfer.metadata->>'moved')::numeric IS DISTINCT FROM 200.00
     OR v_transfer.metadata->>'user_id' IS DISTINCT FROM v_winner_id::text
     OR (v_transfer.metadata->>'unbacked')::numeric IS DISTINCT FROM 0
     OR (v_transfer.metadata->>'seat_value')::numeric IS DISTINCT FROM 200.00
     OR v_transfer.metadata->>'satellite_id' IS DISTINCT FROM v_tournament_id::text
     OR v_transfer.metadata->>'satellite_target_id' IS DISTINCT FROM v_target_id::text
     OR v_transfer.metadata->>'registration_id' IS DISTINCT FROM v_registration_id::text THEN
    RAISE EXCEPTION '682 adoption: exact pool-transfer evidence changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.rake_records r
   WHERE r.tournament_id IN (v_tournament_id, v_target_id)
   ORDER BY r.id FOR UPDATE;
  IF (SELECT count(*) FROM public.rake_records r
       WHERE r.tournament_id = v_tournament_id AND r.is_tournament) <> 2
     OR (SELECT round(COALESCE(sum(r.rake_amount),0),2)
           FROM public.rake_records r
          WHERE r.tournament_id = v_tournament_id AND r.is_tournament)
          IS DISTINCT FROM 15.00::numeric
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.id = '848ac57b-75b9-49d8-befb-bc0ef5c6c02a'::uuid
          AND r.tournament_id = v_tournament_id AND r.is_tournament
          AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
          AND r.hand_id IS NULL AND r.table_id IS NULL
          AND r.source = 'fn_register_horse_for_tournament'
          AND r.rake_amount = 7.50 AND r.pot_size = 150.00
          AND r.num_players = 1 AND r.global_hand_id = 23165563
          AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
          AND r.rake_method = 'DEALT_EQUAL'
          AND r.created_at = '2026-09-08 11:17:46.273993+00'::timestamptz
          AND r.metadata->>'kind' = 'tournament_entry_fee'
          AND r.metadata->>'user_id' = v_winner_id::text
          AND r.metadata->>'registration_id' = v_winner.id::text
          AND jsonb_object_length(r.player_contributions) = 1
          AND (r.player_contributions->>v_winner_id::text)::numeric = 7.50)
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.id = '426a7616-f00f-4858-95dc-032b1e3e8d09'::uuid
          AND r.tournament_id = v_tournament_id AND r.is_tournament
          AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
          AND r.hand_id IS NULL AND r.table_id IS NULL
          AND r.source = 'fn_register_horse_for_tournament'
          AND r.rake_amount = 7.50 AND r.pot_size = 150.00
          AND r.num_players = 1 AND r.global_hand_id = 23163763
          AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
          AND r.rake_method = 'DEALT_EQUAL'
          AND r.created_at = '2026-09-08 11:21:31.396373+00'::timestamptz
          AND r.metadata->>'kind' = 'tournament_entry_fee'
          AND r.metadata->>'user_id' = v_bubble_id::text
          AND r.metadata->>'registration_id' = v_bubble.id::text
          AND jsonb_object_length(r.player_contributions) = 1
          AND (r.player_contributions->>v_bubble_id::text)::numeric = 7.50)
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id = v_target_id
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = v_tournament_id::text
            AND r.id = '0599e505-09a0-4949-9fff-e1a3b342fa31'::uuid
            AND r.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
            AND r.hand_id IS NULL AND r.table_id IS NULL
            AND r.rake_amount = 20.00 AND r.pot_size = 200.00
            AND r.num_players = 1 AND r.global_hand_id = 23166965
            AND r.bbj_contribution = 0 AND r.returned_uncalled IS NULL
            AND r.rake_method = 'DEALT_EQUAL'
            AND r.created_at = '2026-09-08 11:23:07.343372+00'::timestamptz
            AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
            AND r.metadata->>'user_id' = v_winner_id::text
            AND r.metadata->>'registration_id' = v_registration_id::text
            AND jsonb_object_length(r.player_contributions) = 1
            AND (r.player_contributions->>v_winner_id::text)::numeric = 20.00) <> 1 THEN
    RAISE EXCEPTION '682 adoption: exact source or target rake evidence changed'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_rake_settlement FROM public.tournament_rake_settlements r
   WHERE r.tournament_id = v_tournament_id FOR UPDATE;
  IF v_rake_settlement.amount IS DISTINCT FROM 15.00::numeric
     OR v_rake_settlement.source IS DISTINCT FROM 'engine_finish'
     OR v_rake_settlement.club_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_rake_settlement.union_id IS DISTINCT FROM
          'fade0000-0000-0000-0000-000000000001'::uuid
     OR v_rake_settlement.destination IS DISTINCT FROM
          'union:fade0000-0000-0000-0000-000000000001'
     OR v_rake_settlement.created_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_rake_settlement.settled_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_rake_settlement.attributed_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_rake_settlement.attributed_users IS DISTINCT FROM 2
     OR v_rake_settlement.attribution_error IS NOT NULL THEN
    RAISE EXCEPTION '682 adoption: exact terminal rake settlement changed'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = v_tournament_id FOR UPDATE;
  SELECT * INTO v_target_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = v_target_id FOR UPDATE;
  IF v_escrow.tournament_id IS NULL OR COALESCE(v_escrow.enforced,false) IS NOT TRUE
     OR v_escrow.gross_in IS DISTINCT FROM 300.00::numeric
     OR v_escrow.fee_entries_in IS DISTINCT FROM 15.00::numeric
     OR v_escrow.satellite_fee_in IS DISTINCT FROM 0::numeric
     OR v_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_escrow.overlay_in IS DISTINCT FROM 0::numeric
     OR v_escrow.satellite_in IS DISTINCT FROM 0::numeric
     OR v_escrow.prize_out IS DISTINCT FROM 285.00::numeric
     OR v_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_escrow.fee_out IS DISTINCT FROM 15.00::numeric
     OR v_escrow.refund_prize IS DISTINCT FROM 0::numeric
     OR v_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_escrow.refund_fee IS DISTINCT FROM 0::numeric
     OR v_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_escrow.opened_at IS DISTINCT FROM
          '2026-09-08 11:17:46.273993+00'::timestamptz
     OR v_escrow.updated_at IS DISTINCT FROM
          '2026-09-08 11:23:11.343473+00'::timestamptz
     OR v_escrow.closed_at IS DISTINCT FROM
          '2026-09-08 11:23:12.112839+00'::timestamptz
     OR v_escrow.opened_from IS DISTINCT FROM
          'shadow at first sight (tournament_buyin)'
     OR v_escrow.close_note IS DISTINCT FROM 'closed at zero'
     OR v_target_escrow.tournament_id IS DISTINCT FROM v_target_id
     OR v_target_escrow.enforced IS DISTINCT FROM true
     OR v_target_escrow.gross_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.fee_entries_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.overlay_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.prize_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.fee_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.refund_prize IS DISTINCT FROM 0::numeric
     OR v_target_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_target_escrow.refund_fee IS DISTINCT FROM 0::numeric
     OR v_target_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_target_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_target_escrow.prize_balance IS DISTINCT FROM v_target.prize_pool
     OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_target_escrow.fee_balance IS DISTINCT FROM v_target.total_rake
     OR v_target_escrow.satellite_in IS DISTINCT FROM
          (SELECT round(COALESCE(sum(l.amount),0)
                        - COALESCE((SELECT sum(r.rake_amount)
                           FROM public.rake_records r
                          WHERE r.tournament_id = v_target_id
                            AND r.is_tournament
                            AND r.source = 'fn_award_satellite_seat'),0),2)
             FROM public.chip_ledger l
            WHERE l.to_entity_id = v_target_id
              AND l.to_type = 'prize_liability'
              AND l.idempotency_key LIKE 'tourney:%:seat:%:pool_transfer')
     OR v_target_escrow.satellite_fee_in IS DISTINCT FROM
          (SELECT round(COALESCE(sum(r.rake_amount),0),2)
             FROM public.rake_records r
            WHERE r.tournament_id = v_target_id
              AND r.is_tournament
              AND r.source = 'fn_award_satellite_seat')
     OR v_target_escrow.opened_at IS DISTINCT FROM
          '2026-09-06 18:35:47.808074+00'::timestamptz
     OR v_target_escrow.opened_from IS DISTINCT FROM
          'shadow at first sight (satellite seat fee)'
     OR v_target_escrow.closed_at IS NOT NULL
     OR v_target_escrow.close_note IS NOT NULL THEN
    RAISE EXCEPTION '682 adoption: exact closed escrow changed'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = v_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.table_id = v_table_id ORDER BY ts.id FOR UPDATE;
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.tournament_id = v_tournament_id) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tables tb WHERE tb.id = v_table_id
         AND tb.tournament_id = v_tournament_id
         AND tb.name = 'Sunday $200 Deep Stack Satellite Heads-Up'
         AND tb.club_id =
           'fade0000-0000-0000-0000-000000000001'::uuid
         AND tb.union_id =
           'fade0000-0000-0000-0000-000000000001'::uuid
         AND tb.created_at =
           '2026-09-08 11:17:40.324914+00'::timestamptz
         AND lower(COALESCE(tb.status::text,'')) = 'closed'
         AND tb.lifecycle IS NULL AND tb.current_players = 0)
     OR (SELECT count(*) FROM public.table_seats ts
          WHERE ts.table_id = v_table_id) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats ts WHERE ts.id = v_seat_one_id
         AND ts.table_id = v_table_id AND ts.user_id = v_winner_id
         AND ts.horse_id = v_winner_id
         AND ts.club_id =
           'a0000000-0000-0000-0000-000000000001'::uuid
         AND ts.seat_number = 1 AND ts.status = 'active'
         AND ts.stack = 600.00::numeric
         AND ts.joined_at =
           '2026-09-08 11:17:46.273993+00'::timestamptz
         AND ts.leave_pending IS FALSE AND ts.is_sitting_out IS FALSE
         AND ts.is_away IS FALSE
         AND ts.sit_out_at IS NULL AND ts.scheduled_leave_hands IS NULL
         AND ts.left_at = '2026-09-08 11:23:09.284818+00'::timestamptz)
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats ts WHERE ts.id = v_seat_two_id
         AND ts.table_id = v_table_id AND ts.user_id = v_bubble_id
         AND ts.horse_id = v_bubble_id
         AND ts.club_id =
           'a0000000-0000-0000-0000-000000000001'::uuid
         AND ts.seat_number = 2 AND ts.status = 'active'
         AND ts.stack = 0::numeric
         AND ts.joined_at =
           '2026-09-08 11:21:31.396373+00'::timestamptz
         AND ts.leave_pending IS FALSE AND ts.is_sitting_out IS FALSE
         AND ts.is_away IS FALSE
         AND ts.sit_out_at IS NULL AND ts.scheduled_leave_hands IS NULL
         AND ts.left_at = '2026-09-08 11:22:47.875+00'::timestamptz) THEN
    RAISE EXCEPTION '682 adoption: exact source felt closeout changed'
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournaments
     SET prize_pool = 285.00, updated_at = now()
   WHERE id = v_tournament_id AND prize_pool = 85.00
     AND status = 'COMPLETED' AND prize_pool_finalized;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '682 adoption: source pool cache did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.tournament_players SET prize = 85.00
   WHERE id = v_bubble.id AND tournament_id = v_tournament_id
     AND position = 2 AND prize = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '682 adoption: Bubble prize cache did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.tables
     SET lifecycle = 'closed', terminal_closed_at = v_source.ended_at,
         updated_at = now()
   WHERE id = v_table_id AND tournament_id = v_tournament_id
     AND status = 'closed' AND lifecycle IS NULL AND current_players = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '682 adoption: table lifecycle did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;
  UPDATE public.table_seats
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE id IN (v_seat_one_id, v_seat_two_id)
     AND table_id = v_table_id AND status = 'active'
     AND leave_pending IS FALSE AND is_sitting_out IS FALSE AND is_away IS FALSE
     AND sit_out_at IS NULL AND scheduled_leave_hands IS NULL
     AND ((id = v_seat_one_id AND stack = 600.00::numeric
           AND left_at = '2026-09-08 11:23:09.284818+00'::timestamptz)
       OR (id = v_seat_two_id AND stack = 0::numeric
           AND left_at = '2026-09-08 11:22:47.875+00'::timestamptz));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION '682 adoption: departed seat caches did not normalize exactly'
      USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (v_tournament_id, v_target_id, false, NULL,
     v_winner_id, 2, 1, 285.00,
     180.00, 20.00, 200.00, 1,
     1, 0, 85.00, v_bubble_id, 2,
     1, ARRAY[v_table_id], 2, ARRAY[v_seat_one_id,v_seat_two_id],
     0, ARRAY[]::uuid[], v_source.ended_at, v_escrow.closed_at,
     v_escrow.close_note, v_closeout_at);
  INSERT INTO public.tournament_satellite_awards
    (tournament_id, place, user_id, delivery_kind, amount,
     payout_id, payout_source, idempotency_key, registration_id)
  VALUES
    (v_tournament_id, 1, v_winner_id, 'seat', 200.00,
     v_seat_payout_id, 'satellite_seat', v_seat_key, v_registration_id);
  INSERT INTO public.tournament_satellite_remainders
    (tournament_id, user_id, place, amount,
     payout_id, payout_source, payout_position, idempotency_key,
     obligation_id, obligation_kind, obligation_place, evidence_kind)
  VALUES
    (v_tournament_id, v_bubble_id, 2, 85.00,
     v_remainder_payout_id, 'satellite_remainder', NULL, v_remainder_key,
     v_obligation_id, 'satellite_remainder', NULL, 'legacy_20260908_682');

  v_receipt := public.fn_ca_satellite_settlement_receipt(
    v_tournament_id, v_winner_id);
  IF COALESCE((v_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR (v_receipt->>'pool')::numeric IS DISTINCT FROM 285.00::numeric
     OR (v_receipt->'remainder'->>'user_id')::uuid IS DISTINCT FROM v_bubble_id
     OR (v_receipt->'remainder'->>'position')::integer IS DISTINCT FROM 2
     OR (v_receipt->'remainder'->>'amount')::numeric IS DISTINCT FROM 85.00::numeric THEN
    RAISE EXCEPTION '682 adoption: immutable whole-pool receipt did not verify'
      USING ERRCODE = 'P0404';
  END IF;
END;
$adopt_exact_682_completion$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_find_tournament_entry_ticket_for', 'approved',
   'Owner-only beneficiary-aware exact-ticket selector shared by authenticated player and service-only horse registration authorities. Moves no money and fails closed on corrupt matching evidence.'),
  ('fn_ca_register_for_tournament_with_ticket_for', 'approved',
   'Owner-only beneficiary-aware atomic ticket admission shared by authenticated player and service-only horse registration authorities. It credits no wallet chips.'),
  ('fn_find_tournament_entry_ticket', 'approved',
   'Authenticated read-only selector for one exact noncash tournament-entry ticket. Moves no money and fails closed when its issue evidence is incomplete.'),
  ('fn_register_for_tournament_with_ticket', 'approved',
   'Authenticated atomic admission funded only by one immutable tournament-entry ticket. It credits no player wallet chips.'),
  ('fn_horse_tournament_entry_ticket_hints', 'approved',
   'Service-only read of horse beneficiaries holding an exact-price, exact-scope issued ticket candidate. Includes corrupt candidates so the caller suppresses wallet fallback.'),
  ('fn_register_horse_for_tournament', 'approved',
   'Service-only ticket-first horse admission. The three-argument shape requires explicit per-candidate wallet authority; a hinted ticket that disappears is refused without a wallet debit.'),
  ('fn_ca_return_satellite_entitlement_as_ticket', 'approved',
   'Owner-only conversion of a satellite-seat or ticket-funded registration into another noncash tournament-entry ticket. It has no wallet-credit path.'),
  ('fn_ca_tournament_unregistration_receipt', 'approved',
   'Owner-only immutable outcome verifier. It proves an exact request-keyed pre-start unregister from stored entitlement, wallet, ticket and issue evidence and moves no money.'),
  ('fn_ca_unregister_tournament_player_exact', 'approved',
   'Owner-only all-or-nothing unregister authority. Personally paid value returns to exact source wallets; satellite and ticket-funded value returns only as noncash tournament-entry tickets.'),
  ('fn_unregister_from_tournament', 'approved',
   'Authenticated player unregister wrapper. The request-key overload supports exact lost-response replay; the rolling one-argument wrapper cannot report a stale success after start.'),
  ('fn_leave_seat_and_refund', 'approved',
   'Authenticated table-seat unregister wrapper with the same request-keyed, pre-start-only financial contract.'),
  ('fn_ca_satellite_settlement_receipt', 'approved',
   'Owner-only proof of immutable satellite header, seat|cash award lines, one residual, escrow, rake and exact source-felt closeout. Moves no money.'),
  ('fn_settle_satellite_tournament', 'approved',
   'Service-only all-or-nothing satellite finish: floor(final pool/ticket) full ticket awards plus one next-finisher residual and source-felt closeout.'),
  ('fn_resolve_satellite_settlement_outcome', 'approved',
   'Service-only serialized read after an ambiguous satellite transport result; moves no money and returns a verified stored receipt when committed.')
ON CONFLICT (proname) DO UPDATE
   SET status = EXCLUDED.status,
       notes = EXCLUDED.notes;

DO $verify_satellite_authority$
DECLARE
  v_source text;
  v_receipt_source text;
  v_outcome_source text;
  v_unregister_source text;
  v_unregister_receipt_source text;
  v_unregister_wrapper_source text;
  v_leave_wrapper_source text;
  v_ticket_return_source text;
  v_ticket_admission_source text;
  v_ticket_admission_wrapper_source text;
  v_ticket_guard_source text;
  v_ticket_selector_source text;
  v_ticket_selector_wrapper_source text;
  v_horse_ticket_hint_source text;
  v_horse_registration_source text;
  v_horse_registration_compat_source text;
  v_refund_plan_source text;
  v_ticket_redeem_source text;
  v_ticket_cancel_source text;
  v_charge_split_source text;
  v_escrow_reader_source text;
  v_late_registration_source text;
  v_wallet_registration_source text;
  v_horse_wallet_registration_source text;
  v_registration_lifecycle_source text;
BEGIN
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE proname = 'fn_settle_satellite_tournament'
     AND pronamespace = 'public'::regnamespace;
  SELECT prosrc INTO v_receipt_source FROM pg_proc
   WHERE proname = 'fn_ca_satellite_settlement_receipt'
     AND pronamespace = 'public'::regnamespace;
  SELECT prosrc INTO v_outcome_source FROM pg_proc
   WHERE oid =
     'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_unregister_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'::regprocedure;
  SELECT prosrc INTO v_unregister_receipt_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_unregister_wrapper_source FROM pg_proc
   WHERE oid =
     'public.fn_unregister_from_tournament(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_leave_wrapper_source FROM pg_proc
   WHERE oid =
     'public.fn_leave_seat_and_refund(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_ticket_return_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_return_satellite_entitlement_as_ticket(uuid,text,text)'::regprocedure;
  SELECT prosrc INTO v_ticket_admission_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_ticket_admission_wrapper_source FROM pg_proc
   WHERE oid =
     'public.fn_register_for_tournament_with_ticket(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_ticket_guard_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_satellite_entry_ticket_is_guarded()'::regprocedure;
  SELECT prosrc INTO v_ticket_selector_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_ticket_selector_wrapper_source FROM pg_proc
   WHERE oid =
     'public.fn_find_tournament_entry_ticket(uuid)'::regprocedure;
  SELECT prosrc INTO v_horse_ticket_hint_source FROM pg_proc
   WHERE oid =
     'public.fn_horse_tournament_entry_ticket_hints(uuid)'::regprocedure;
  SELECT prosrc INTO v_horse_registration_source FROM pg_proc
   WHERE oid =
     'public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure;
  SELECT prosrc INTO v_horse_registration_compat_source FROM pg_proc
   WHERE oid =
     'public.fn_register_horse_for_tournament(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_refund_plan_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_tournament_refund_plan(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_ticket_redeem_source FROM pg_proc
   WHERE oid = 'public.fn_redeem_tournament_ticket(uuid)'::regprocedure;
  SELECT prosrc INTO v_ticket_cancel_source FROM pg_proc
   WHERE oid = 'public.fn_cancel_tournament_ticket(uuid)'::regprocedure;
  SELECT prosrc INTO v_charge_split_source FROM pg_proc
   WHERE oid =
     'public.fn_ca_tournament_charge_split(uuid,text,numeric)'::regprocedure;
  SELECT prosrc INTO v_escrow_reader_source FROM pg_proc
   WHERE oid = 'public.fn_ca_tournament_escrow(uuid)'::regprocedure;
  SELECT prosrc INTO v_late_registration_source FROM pg_proc
   WHERE oid =
     'public.fn_tournament_late_registration_open(uuid)'::regprocedure;
  SELECT prosrc INTO v_wallet_registration_source FROM pg_proc
   WHERE oid =
     'public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)'::regprocedure;
  SELECT prosrc INTO v_horse_wallet_registration_source FROM pg_proc
   WHERE oid =
     'public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'::regprocedure;
  SELECT prosrc INTO v_registration_lifecycle_source FROM pg_proc
   WHERE oid =
     'public.fn_register_for_tournament_before_maintenance_announcement_gate(uuid,boolean)'::regprocedure;
  IF v_source IS NULL
     OR v_source NOT LIKE '%floor(v_pool / v_ticket_cost)%'
     OR v_source NOT LIKE '%pg_advisory_xact_lock(%ca:tournament-terminal-settlement:v1%'
     OR v_source NOT LIKE '%v_bubble_position := v_ticket_award_count + 1%'
     OR v_source NOT LIKE
          '%public.fn_tournament_late_registration_open(v_target_id)%'
     OR v_source LIKE '%NULLIF(v_target.late_reg_levels, 0)%'
     OR v_source NOT LIKE '%delivery_kind%'
     OR v_source NOT LIKE '%INSERT INTO public.tournament_satellite_remainders%'
     OR v_source NOT LIKE '%v_pool < v_advertised_seats * v_ticket_cost%'
     OR v_source NOT LIKE '%UPDATE public.table_seats%'
     OR v_source NOT LIKE '%ts.id = ANY(v_source_seat_ids)%'
     OR v_source NOT LIKE '%ts.status IS DISTINCT FROM ''left''%'
     OR v_source NOT LIKE '%ts.leave_pending IS DISTINCT FROM false%'
     OR v_source NOT LIKE '%ts.is_sitting_out IS DISTINCT FROM false%'
     OR v_source NOT LIKE '%ts.is_away IS DISTINCT FROM false%'
     OR v_source NOT LIKE '%ts.sit_out_at IS NOT NULL%'
     OR v_source NOT LIKE '%ts.scheduled_leave_hands IS NOT NULL%'
     OR v_source NOT LIKE '%v_target_escrow_after.satellite_in IS DISTINCT FROM%'
     OR v_source NOT LIKE '%v_target_escrow_after.satellite_fee_in IS DISTINCT FROM%'
     OR v_source NOT LIKE '%v_target_escrow_after.prize_balance IS DISTINCT FROM%'
     OR v_source NOT LIKE '%v_target_escrow_after.fee_balance IS DISTINCT FROM%'
     OR v_source NOT LIKE '%UPDATE public.tables%'
     OR v_source NOT LIKE '%terminal_closed_at = v_closeout_at%'
     OR v_source NOT LIKE '%v_rows IS DISTINCT FROM v_released_seat_count%'
     OR v_source NOT LIKE '%RETURN public.fn_ca_satellite_settlement_receipt%'
     OR v_source LIKE '%EXCEPTION WHEN OTHERS%'
     OR v_source LIKE '%fn_apply_prize_guarantee%' THEN
    RAISE EXCEPTION 'atomic satellite authority lost a floor, guarantee, delivery, bubble, replay or fail-closed invariant';
  END IF;
  IF v_late_registration_source IS NULL
     OR v_late_registration_source NOT LIKE
          '%COALESCE(t.late_reg_levels,t.rebuy_levels,0)%'
     OR v_late_registration_source NOT LIKE
          '%COALESCE(t.current_level,0)>=0%'
     OR v_late_registration_source NOT LIKE '%t.max_players<=0%'
     OR v_wallet_registration_source IS NULL
     OR v_wallet_registration_source NOT LIKE
          '%public.fn_tournament_late_registration_open(p_tournament_id)%'
     OR v_wallet_registration_source LIKE '%registration_state_unknown%'
     OR v_wallet_registration_source LIKE
          '%COALESCE(v_t.max_players, 0) <= 2%'
     OR v_wallet_registration_source NOT LIKE '%v_t.max_players > 0%'
     OR v_wallet_registration_source LIKE
          '%current_players = COALESCE(current_players, 0) + 1%'
     OR v_wallet_registration_source NOT LIKE
          '%SET current_players = v_players_before + 1%'
     OR v_wallet_registration_source NOT LIKE
          '%current_players IS NOT DISTINCT FROM v_expected_cached_players%'
     OR v_horse_wallet_registration_source IS NULL
     OR v_horse_wallet_registration_source LIKE
          '%current_players = COALESCE(current_players, 0) + 1%'
     OR v_horse_wallet_registration_source NOT LIKE
          '%SET current_players = v_players_before + 1%'
     OR v_horse_wallet_registration_source NOT LIKE
          '%current_players IS NOT DISTINCT FROM v_players_before+1%'
     OR v_registration_lifecycle_source IS NULL
     OR v_registration_lifecycle_source NOT LIKE
          '%public.fn_tournament_late_registration_open(p_tournament_id)%'
     OR v_registration_lifecycle_source LIKE '%registration_state_unknown%'
     OR v_ticket_admission_source LIKE '%COALESCE(v_t.max_players,0)<=2%'
     OR v_ticket_admission_source NOT LIKE '%v_t.max_players>0%' THEN
    RAISE EXCEPTION
      'wallet and ticket admission no longer share the canonical lifecycle and uncapped-event contract';
  END IF;
  IF v_charge_split_source IS NULL
     OR position(
          'round(COALESCE(v_t.bounty_amount,0),2)'
          IN v_charge_split_source)=0
     OR v_charge_split_source ~
          'round\([[:space:]]*COALESCE\(v_t\.bounty_amount,0\)[[:space:]]*\)'
     OR v_escrow_reader_source IS NULL
     OR position(
          'GREATEST(0,round(t.bounty_amount,2))'
          IN v_escrow_reader_source)=0
     OR v_escrow_reader_source ~
          'round\([[:space:]]*t\.bounty_amount[[:space:]]*\)'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.fn_ca_tournament_escrow(uuid)'::regprocedure
          AND p.prosecdef
          AND p.provolatile = 's'
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
          AND has_function_privilege(
                'service_role', p.oid, 'EXECUTE')
          AND EXISTS (
            SELECT 1
              FROM aclexplode(p.proacl) acl
             WHERE acl.grantee = 'service_role'::regrole::oid
               AND acl.privilege_type = 'EXECUTE'
          )
          AND EXISTS (
            SELECT 1
              FROM aclexplode(p.proacl) acl
             WHERE acl.grantee = p.proowner
               AND acl.privilege_type = 'EXECUTE'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM aclexplode(COALESCE(
                     p.proacl, acldefault('f', p.proowner))) acl
             WHERE acl.privilege_type = 'EXECUTE'
               AND acl.grantee NOT IN (
                     p.proowner, 'service_role'::regrole::oid)
          )
     ) THEN
    RAISE EXCEPTION
      'tournament split/escrow lost cent-accurate bounty rails or owner/service-only security';
  END IF;
  IF v_receipt_source IS NULL
     OR v_receipt_source NOT LIKE '%v_source_table_ids IS DISTINCT FROM v_h.source_table_ids%'
     OR v_receipt_source NOT LIKE '%v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids%'
     OR v_receipt_source NOT LIKE '%v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids%'
     OR v_receipt_source NOT LIKE '%v_durable_released_count IS DISTINCT FROM v_h.released_seat_count%'
     OR v_receipt_source NOT LIKE '%public.tournament_satellite_remainders%'
     OR v_receipt_source NOT LIKE '%ts.left_at IS NULL%'
     OR v_receipt_source NOT LIKE '%ts.status IS DISTINCT FROM ''left''%'
     OR v_receipt_source NOT LIKE '%ts.leave_pending IS DISTINCT FROM false%'
     OR v_receipt_source NOT LIKE '%ts.is_sitting_out IS DISTINCT FROM false%'
     OR v_receipt_source NOT LIKE '%ts.is_away IS DISTINCT FROM false%'
     OR v_receipt_source NOT LIKE '%ts.sit_out_at IS NOT NULL%'
     OR v_receipt_source NOT LIKE '%ts.scheduled_leave_hands IS NOT NULL%'
     OR v_receipt_source NOT LIKE '%v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at%'
     OR v_receipt_source NOT LIKE '%v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note%'
     OR v_receipt_source NOT LIKE
          '%v_source.ended_at IS DISTINCT FROM v_h.source_closed_at%'
     OR v_receipt_source NOT LIKE
          '%tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at%'
     OR v_receipt_source NOT LIKE
          '%''closed_at'', v_h.source_closed_at%' THEN
    RAISE EXCEPTION 'atomic satellite receipt lost its exact source-felt closeout proof';
  END IF;
  IF v_outcome_source IS NULL
     OR position('ca:tournament-terminal-settlement:v1' IN v_outcome_source) = 0
     OR position('pg_advisory_xact_lock(' IN v_outcome_source) = 0
     OR position('public.fn_ca_satellite_settlement_receipt(' IN v_outcome_source) = 0
     OR position('''definitively_not_committed'',true' IN v_outcome_source) = 0
     OR position('public.fn_settle_satellite_tournament(' IN v_outcome_source) <> 0 THEN
    RAISE EXCEPTION 'satellite transport outcome resolver lost serialization or purity';
  END IF;
  IF v_unregister_source IS NULL
     OR position('clock_timestamp()>=v_t.start_time' IN v_unregister_source)=0
     OR position('p_request_id IS NOT NULL' IN v_unregister_source)=0
     OR position('unregistration request id belongs to another intent'
          IN v_unregister_source)=0
     OR position('INSERT INTO public.tournament_unregistration_receipts'
          IN v_unregister_source)=0
     OR position('v_unregistered_at:=clock_timestamp()'
          IN v_unregister_source)=0
     OR position('v_unregistered_at>=v_t.start_time'
          IN v_unregister_source)=0
     OR position(
          'entitlement_kind IN (''satellite_seat'',''tournament_ticket'')'
          IN v_unregister_source)=0
     OR position('fn_ca_return_satellite_entitlement_as_ticket('
          IN v_unregister_source)=0
     OR position('v_wallet_amount,v_ticket_amount,v_entitlement_ids,v_ticket_ids'
          IN v_unregister_source)=0
     OR position('original_rake_record_ids' IN v_unregister_source)=0
     OR position('fee_recipient_club_id' IN v_unregister_source)=0
     OR position('v_fee_source_rake_record_ids' IN v_unregister_source)=0
     OR position('e.refund_wallet_club_id AS club_id'
          IN v_unregister_source)<>0
     OR position('credit_player_wallet' IN v_unregister_source)<>0
     OR position('interval ''1 minute''' IN lower(v_unregister_source))<>0 THEN
    RAISE EXCEPTION
      'unregistration lost its exact pre-start wallet-versus-ticket contract';
  END IF;
  IF v_unregister_receipt_source IS NULL
     OR position('r.request_id=p_request_id'
          IN v_unregister_receipt_source)=0
     OR position('r.source_table_id IS NOT DISTINCT FROM p_source_table_id'
          IN v_unregister_receipt_source)=0
     OR position('FROM public.tournament_refund_entitlements'
          IN v_unregister_receipt_source)=0
     OR position('FROM public.tournament_refund_tranches'
          IN v_unregister_receipt_source)=0
     OR position('FROM public.chip_transactions'
          IN v_unregister_receipt_source)=0
     OR position('FROM public.chip_ledger'
          IN v_unregister_receipt_source)=0
     OR position('FROM public.tournament_players'
          IN v_unregister_receipt_source)=0
     OR position('v_r.settled_at>=v_r.scheduled_start_at'
          IN v_unregister_receipt_source)=0
     OR position('''refunded_chips'',v_r.refunded_chips'
          IN v_unregister_receipt_source)=0
     OR position('''returned_ticket_value'',v_r.returned_ticket_value'
          IN v_unregister_receipt_source)=0
     OR position('''wallet_chips_from_satellite_entitlements'',0'
          IN v_unregister_receipt_source)=0
     OR position('''fees_reversed'',v_r.fees_reversed'
          IN v_unregister_receipt_source)=0
     OR position('''fee_reversal_ids'',to_jsonb(v_r.fee_reversal_ids)'
          IN v_unregister_receipt_source)=0
     OR position('''fee_source_rake_record_ids'',to_jsonb('
          IN v_unregister_receipt_source)=0
     OR position('INSERT INTO ' IN upper(v_unregister_receipt_source))<>0
     OR position('UPDATE ' IN upper(v_unregister_receipt_source))<>0
     OR position('DELETE FROM ' IN upper(v_unregister_receipt_source))<>0 THEN
    RAISE EXCEPTION
      'unregistration receipt lost request identity, pre-start proof or immutable evidence';
  END IF;
  IF v_unregister_wrapper_source IS NULL
     OR position('v_uid uuid:=auth.uid()' IN v_unregister_wrapper_source)=0
     OR position('p_request_id IS NULL' IN v_unregister_wrapper_source)=0
     OR position(
          'p_tournament_id,v_uid,NULL,''Tournament unregistration refund'',p_request_id'
          IN v_unregister_wrapper_source)=0
     OR v_leave_wrapper_source IS NULL
     OR position('v_uid uuid:=auth.uid()' IN v_leave_wrapper_source)=0
     OR position('p_request_id IS NULL' IN v_leave_wrapper_source)=0
     OR position(
          '''Tournament seat unregistration refund'',p_request_id'
          IN v_leave_wrapper_source)=0
     OR position('public.fn_caller_session_is_live()'
          IN v_unregister_wrapper_source)=0
     OR position('public.fn_caller_session_is_live()'
          IN v_leave_wrapper_source)=0
     OR (SELECT count(*) FROM pg_proc p
          WHERE p.oid=ANY(ARRAY[
            'public.fn_unregister_from_tournament(uuid)'::regprocedure::oid,
            'public.fn_unregister_from_tournament(uuid,uuid)'::regprocedure::oid,
            'public.fn_leave_seat_and_refund(uuid)'::regprocedure::oid,
            'public.fn_leave_seat_and_refund(uuid,uuid)'::regprocedure::oid,
            'public.fn_admin_remove_tournament_player(uuid,uuid)'::regprocedure::oid])
            AND p.prosrc LIKE '%public.fn_caller_session_is_live()%')<>5 THEN
    RAISE EXCEPTION
      'request-keyed unregister wrappers lost caller identity or retry identity';
  END IF;
  IF v_ticket_return_source IS NULL
     OR position(
          'entitlement_kind NOT IN (''satellite_seat'',''tournament_ticket'')'
          IN v_ticket_return_source)=0
     OR position('INSERT INTO public.tournament_tickets'
          IN v_ticket_return_source)=0
     OR position('''tournament_entry_only''' IN v_ticket_return_source)=0
     OR position('fn_ca_escrow_apply_exact_refund('
          IN v_ticket_return_source)=0
     OR position('player_wallet' IN v_ticket_return_source)<>0
     OR position('wallet_transactions' IN v_ticket_return_source)<>0
     OR position('credit_player_wallet' IN v_ticket_return_source)<>0 THEN
    RAISE EXCEPTION
      'satellite unregistration can reach chips or lost its durable ticket';
  END IF;
  IF v_ticket_admission_source IS NULL
     OR position('v_uid uuid:=p_beneficiary_id'
          IN v_ticket_admission_source)=0
     OR position(
          'v_ticket.redemption_mode IS DISTINCT FROM ''tournament_entry_only'''
          IN v_ticket_admission_source)=0
     OR position('current_players IS NOT DISTINCT FROM v_players_before+1'
          IN v_ticket_admission_source)=0
     OR position('INSERT INTO public.tournament_ticket_admission_authorizations'
          IN v_ticket_admission_source)=0
     OR position('INSERT INTO public.tournament_refund_entitlements'
          IN v_ticket_admission_source)=0
     OR position('''atomic_tournament_ticket''' IN v_ticket_admission_source)=0
     OR position('''wallet_chips_credited'',0' IN v_ticket_admission_source)=0
     OR position('INSERT INTO public.wallet_transactions'
          IN v_ticket_admission_source)<>0
     OR position('credit_player_wallet' IN v_ticket_admission_source)<>0 THEN
    RAISE EXCEPTION
      'tournament-entry ticket admission lost its noncash or receipt invariant';
  END IF;
  IF v_ticket_guard_source IS NULL
     OR position('FROM public.tournament_ticket_admission_authorizations'
          IN v_ticket_guard_source)=0
     OR position('DELETE FROM public.tournament_ticket_admission_authorizations'
          IN v_ticket_guard_source)=0
     OR position('v_authorization.user_id IS DISTINCT FROM OLD.holder_id'
          IN v_ticket_guard_source)=0 THEN
    RAISE EXCEPTION
      'tournament-entry ticket guard lost its one-use admission authorization';
  END IF;
  IF v_ticket_selector_source IS NULL
     OR position('v_uid uuid:=p_beneficiary_id'
          IN v_ticket_selector_source)=0
     OR position('tk.redemption_mode=''tournament_entry_only'''
          IN v_ticket_selector_source)=0
     OR position('IF v_split.charge=0 THEN'
          IN v_ticket_selector_source)=0
     OR position('SELECT count(*) INTO v_candidate_count'
          IN v_ticket_selector_source)=0
     OR position('''matching_tournament_ticket_unavailable'''
          IN v_ticket_selector_source)=0
     OR position('issue_tx.transaction_type=''tournament_ticket_issue'''
          IN v_ticket_selector_source)=0
     OR position('INSERT INTO ' IN upper(v_ticket_selector_source))<>0
     OR position('UPDATE ' IN upper(v_ticket_selector_source))<>0
     OR position('DELETE FROM ' IN upper(v_ticket_selector_source))<>0 THEN
    RAISE EXCEPTION
      'tournament-entry ticket selector is not a pure exact-evidence read';
  END IF;
  IF v_ticket_admission_wrapper_source IS NULL
     OR position('v_uid uuid:=auth.uid()'
          IN v_ticket_admission_wrapper_source)=0
     OR position('fn_ca_register_for_tournament_with_ticket_for('
          IN v_ticket_admission_wrapper_source)=0
     OR v_ticket_selector_wrapper_source IS NULL
     OR position('v_uid uuid:=auth.uid()'
          IN v_ticket_selector_wrapper_source)=0
     OR position('fn_ca_find_tournament_entry_ticket_for('
          IN v_ticket_selector_wrapper_source)=0 THEN
    RAISE EXCEPTION
      'authenticated ticket wrappers lost their exact caller isolation';
  END IF;
  IF v_horse_registration_source IS NULL
     OR position('ca:tournament-terminal-settlement:v1'
          IN v_horse_registration_source)=0
     OR position('pg_advisory_xact_lock_shared(530090,1)'
          IN v_horse_registration_source)=0
     OR position('fn_entry_purchases_frozen()'
          IN v_horse_registration_source)=0
     OR position('SELECT is_horse INTO v_is_horse'
          IN v_horse_registration_source)=0
     OR position('fn_ca_find_tournament_entry_ticket_for('
          IN v_horse_registration_source)=0
     OR position('(v_ticket_lookup->>''ok'')::boolean'
          IN v_horse_registration_source)=0
     OR position('fn_ca_register_for_tournament_with_ticket_for('
          IN v_horse_registration_source)=0
     OR position('fn_register_horse_for_tournament_before_maintenance_gate('
          IN v_horse_registration_source)=0
     OR position('p_allow_wallet_charge IS NOT TRUE'
          IN v_horse_registration_source)=0
     OR position('''hinted_tournament_ticket_no_longer_available'''
          IN v_horse_registration_source)=0
     OR position('auth.uid()' IN v_horse_registration_source)<>0 THEN
    RAISE EXCEPTION
      'horse registration lost its service-only ticket-first admission contract';
  END IF;
  IF v_horse_ticket_hint_source IS NULL
     OR position('COALESCE(p.is_horse,false)'
          IN v_horse_ticket_hint_source)=0
     OR position('tk.status=''issued'''
          IN v_horse_ticket_hint_source)=0
     OR position('tk.redemption_mode=''tournament_entry_only'''
          IN v_horse_ticket_hint_source)=0
     OR position('SELECT DISTINCT tk.holder_id'
          IN v_horse_ticket_hint_source)=0
     OR position('chip_ledger' IN v_horse_ticket_hint_source)<>0
     OR position('chip_transactions' IN v_horse_ticket_hint_source)<>0
     OR position('INSERT INTO ' IN upper(v_horse_ticket_hint_source))<>0
     OR position('UPDATE ' IN upper(v_horse_ticket_hint_source))<>0
     OR position('DELETE FROM ' IN upper(v_horse_ticket_hint_source))<>0 THEN
    RAISE EXCEPTION
      'horse ticket hint lost candidate-presence or read-only semantics';
  END IF;
  IF v_horse_registration_compat_source IS NULL
     OR position(
          'public.fn_register_horse_for_tournament( p_tournament_id,p_user_id,true)'
          IN regexp_replace(v_horse_registration_compat_source,'\s+',' ','g'))=0
     OR position('fn_register_horse_for_tournament_before_maintenance_gate('
          IN v_horse_registration_compat_source)<>0 THEN
    RAISE EXCEPTION
      'rolling horse registration wrapper bypasses the ticket-first authority';
  END IF;
  IF v_refund_plan_source IS NULL
     OR position('e.entitlement_kind=''wallet_charge'''
          IN v_refund_plan_source)=0
     OR position('fn_tournament_entry_split' IN v_refund_plan_source)<>0
     OR position('RETURN QUERY' IN upper(v_refund_plan_source))=0 THEN
    RAISE EXCEPTION
      'refund plan is not derived exclusively from immutable entitlements';
  END IF;
  IF v_ticket_redeem_source IS NULL
     OR position(
          'Tournament-Entry Tickets Can Only Be Used To Enter A Tournament'
          IN v_ticket_redeem_source)=0
     OR v_ticket_cancel_source IS NULL
     OR position(
          'Returned Tournament-Entry Tickets Cannot Be Cancelled For Chips'
          IN v_ticket_cancel_source)=0 THEN
    RAISE EXCEPTION
      'cashier ticket RPCs can still convert returned satellite value to chips';
  END IF;
  IF to_regclass('public.tournament_refund_entitlements') IS NULL
     OR to_regclass('public.tournament_refund_tranches') IS NULL
     OR to_regclass('public.tournament_refund_authorizations') IS NULL
     OR to_regclass('public.tournament_unregistration_receipts') IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM pg_constraint c
       JOIN pg_attribute a
         ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
        WHERE c.conrelid='public.tournament_unregistration_receipts'::regclass
          AND c.contype='u' AND cardinality(c.conkey)=1
          AND a.attname='request_id')
     OR NOT EXISTS(
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_unregistration_receipts'::regclass
          AND c.contype='c'
          AND pg_get_constraintdef(c.oid)='CHECK ((settled_at < scheduled_start_at))')
     OR (SELECT count(*) FROM information_schema.columns c
          WHERE c.table_schema='public'
            AND c.table_name='tournament_unregistration_receipts'
            AND c.column_name IN (
              'fees_reversed','fee_reversal_ids',
              'fee_source_rake_record_ids'))<>3
     OR (SELECT count(*) FROM pg_index i
          JOIN pg_class idx ON idx.oid=i.indexrelid
         WHERE i.indrelid=
                 'public.tournament_unregistration_receipts'::regclass
           AND idx.relname IN (
             'tournament_unregistration_receipt_fee_reversals',
             'tournament_unregistration_receipt_fee_sources')
           AND i.indisvalid)<>2
     OR NOT EXISTS(
       SELECT 1 FROM pg_proc p
        WHERE p.oid=
          'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'::regprocedure
          AND p.provolatile='v')
     OR to_regclass(
          'public.tournament_ticket_admission_authorizations') IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema='public' AND c.table_name='tournaments'
          AND c.column_name='entry_contract_locked'
          AND c.data_type='boolean' AND c.is_nullable='NO')
     OR NOT EXISTS(
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_tickets'::regclass
          AND c.conname='tournament_tickets_satellite_entry_contract_check'
          AND c.contype='c' AND c.convalidated)
     OR NOT EXISTS(
       SELECT 1 FROM pg_index i
       JOIN pg_class idx ON idx.oid=i.indexrelid
        WHERE i.indrelid='public.tournament_tickets'::regclass
          AND idx.relname='tournament_ticket_one_satellite_entitlement'
          AND i.indisunique AND i.indisvalid)
     OR NOT EXISTS(
       SELECT 1 FROM pg_index i
       JOIN pg_class idx ON idx.oid=i.indexrelid
        WHERE i.indrelid='public.tournament_tickets'::regclass
          AND idx.relname='tournament_ticket_entry_lookup'
          AND i.indisvalid) THEN
    RAISE EXCEPTION
      'refund entitlements or tournament-entry ticket schema is incomplete';
  END IF;
  IF (
    SELECT count(*)
      FROM (VALUES
        ('public.tournament_tickets'::regclass,
         'tournament_satellite_entry_ticket_is_guarded',
         'public.fn_ca_satellite_entry_ticket_is_guarded()'::regprocedure,27),
        ('public.tournament_refund_entitlements'::regclass,
         'tournament_refund_entitlements_append_only',
         'public.fn_satellite_settlement_receipts_are_append_only()'::regprocedure,27),
        ('public.tournament_refund_tranches'::regclass,
         'tournament_refund_tranches_append_only',
         'public.fn_satellite_settlement_receipts_are_append_only()'::regprocedure,27),
        ('public.tournament_refund_entitlements'::regclass,
         'tournament_refund_entitlement_commit_valid',
         'public.fn_ca_refund_entitlement_commit_valid()'::regprocedure,5),
        ('public.tournament_refund_entitlements'::regclass,
         'tournament_refund_entitlement_locks_parent_contract',
         'public.fn_ca_lock_tournament_contract_from_entitlement()'::regprocedure,5),
        ('public.tournament_unregistration_receipts'::regclass,
         'tournament_unregistration_receipts_append_only',
         'public.fn_satellite_settlement_receipts_are_append_only()'::regprocedure,27),
        ('public.rake_records'::regclass,
         'tournament_unregistration_rake_evidence_is_immutable',
         'public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure,27),
        ('public.tournaments'::regclass,
         'satellite_target_contract_is_immutable',
         'public.fn_satellite_target_contract_is_immutable()'::regprocedure,19)
      ) required(relid,trigger_name,function_id,trigger_type)
      JOIN pg_trigger tg
        ON tg.tgrelid=required.relid
       AND tg.tgname=required.trigger_name
       AND tg.tgfoid=required.function_id
     WHERE NOT tg.tgisinternal
       AND tg.tgenabled IN ('O','A')
       AND tg.tgtype=required.trigger_type
  ) <> 8 THEN
    RAISE EXCEPTION
      'refund or tournament-entry ticket guards are not exactly installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.conrelid = 'public.tournament_satellite_settlements'::regclass
       AND c.confrelid = 'public.tournaments'::regclass
       AND c.contype = 'f' AND c.confdeltype = 'r'
       AND cardinality(c.conkey) = 1 AND a.attname = 'target_id'
  ) THEN
    RAISE EXCEPTION 'immutable satellite header does not preserve its target row';
  END IF;
  IF (SELECT count(*)
        FROM public.tournament_satellite_settlement_cutover c
         WHERE c.authority = 'fn_settle_satellite_tournament:v2'
         AND c.migration_version = '20260909014421'
         AND c.installed_at >= transaction_timestamp()
         AND c.installed_at <= clock_timestamp()
         AND array_position(c.preexisting_completed_ids, NULL) IS NULL
         AND cardinality(c.preexisting_completed_ids) =
             (SELECT count(DISTINCT captured.id)
                FROM unnest(c.preexisting_completed_ids) captured(id))
         AND c.audited_tournament_ids <@ ARRAY[
           'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid,
           'a6a1b360-821c-4201-b378-1591e3df3892'::uuid,
           'e3570642-2e39-42ae-a8f6-164055ffd6e6'::uuid,
           'eddd8116-5792-47fd-b570-790c67581e9f'::uuid,
           '6b0c3243-75fb-487f-8da2-245b2426dbbe'::uuid,
           '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid,
           'ed78a8ac-d869-469f-a4da-c04b67429064'::uuid,
           'fe8dc50c-8995-4441-b289-43993975f74f'::uuid
         ]) <> 1 THEN
    RAISE EXCEPTION 'satellite settlement cutover watermark is not exact';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_ca_tournament_escrow(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_ca_tournament_escrow(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_ca_tournament_escrow(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_satellite_settlement_receipt(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_find_tournament_entry_ticket(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.fn_find_tournament_entry_ticket(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_find_tournament_entry_ticket(uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_register_for_tournament_with_ticket(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.fn_register_for_tournament_with_ticket(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_register_for_tournament_with_ticket(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_horse_tournament_entry_ticket_hints(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_horse_tournament_entry_ticket_hints(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_horse_tournament_entry_ticket_hints(uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_register_horse_for_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_register_horse_for_tournament(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_register_horse_for_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_register_horse_for_tournament(uuid,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_register_horse_for_tournament(uuid,uuid,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_register_horse_for_tournament(uuid,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_unregister_from_tournament(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.fn_unregister_from_tournament(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_unregister_from_tournament(uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_unregister_from_tournament(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.fn_unregister_from_tournament(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_unregister_from_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_leave_seat_and_refund(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.fn_leave_seat_and_refund(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_leave_seat_and_refund(uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_leave_seat_and_refund(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.fn_leave_seat_and_refund(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_leave_seat_and_refund(uuid,uuid)', 'EXECUTE')
     OR EXISTS(
       SELECT 1
         FROM (VALUES
           ('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'::regprocedure),
           ('public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'::regprocedure),
           ('public.fn_ca_return_satellite_entitlement_as_ticket(uuid,text,text)'::regprocedure),
           ('public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)'::regprocedure),
           ('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure),
           ('public.fn_ca_tournament_refund_plan(uuid,uuid)'::regprocedure),
           ('public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure),
           ('public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)'::regprocedure)
         ) internal(function_id)
         CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) app(role_name)
        WHERE has_function_privilege(
          app.role_name,internal.function_id,'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'atomic satellite authority has an unsafe execute ACL';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.tournament_satellite_settlement_cutover'::regclass),
           ('public.tournament_satellite_settlements'::regclass),
           ('public.tournament_satellite_awards'::regclass),
           ('public.tournament_satellite_remainders'::regclass),
           ('public.tournament_refund_entitlements'::regclass),
           ('public.tournament_refund_tranches'::regclass),
           ('public.tournament_refund_authorizations'::regclass),
           ('public.tournament_unregistration_receipts'::regclass),
           ('public.tournament_ticket_admission_authorizations'::regclass)
         ) evidence(relid)
         CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) app(role_name)
         CROSS JOIN (VALUES
           ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),
           ('REFERENCES'),('TRIGGER')
         ) access(privilege_name)
        WHERE has_table_privilege(
                app.role_name, evidence.relid, access.privilege_name)
     ) OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.tournament_satellite_settlement_cutover'::regclass),
           ('public.tournament_satellite_settlements'::regclass),
           ('public.tournament_satellite_awards'::regclass),
           ('public.tournament_satellite_remainders'::regclass),
           ('public.tournament_refund_entitlements'::regclass),
           ('public.tournament_refund_tranches'::regclass),
           ('public.tournament_refund_authorizations'::regclass),
           ('public.tournament_unregistration_receipts'::regclass),
           ('public.tournament_ticket_admission_authorizations'::regclass)
         ) evidence(relid)
         JOIN pg_class c ON c.oid = evidence.relid
        WHERE c.relrowsecurity IS DISTINCT FROM true
           OR c.relowner IS DISTINCT FROM (
             SELECT p.proowner FROM pg_proc p
              WHERE p.oid =
                'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)
           OR EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid)
     ) THEN
    RAISE EXCEPTION
      'atomic satellite evidence lost its owner-only, no-policy RLS boundary';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournaments t
              WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlements s
        WHERE s.tournament_id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
          AND s.pool = 285.00 AND s.ticket_award_count = 1
          AND s.cash_ticket_count = 1 AND s.seat_count = 0
          AND s.remainder = 85.00 AND s.bubble_position = 2
          AND s.source_closed_at =
                '2026-09-07 07:10:38.412+00'::timestamptz
          AND s.source_table_count = 1
          AND s.source_seat_count = 2
          AND s.released_seat_count = 0
          AND EXISTS (
            SELECT 1 FROM public.tournament_satellite_remainders r
             WHERE r.tournament_id = s.tournament_id
               AND r.place = 2 AND r.amount = 85.00
               AND r.evidence_kind = 'atomic')
     ) THEN
    RAISE EXCEPTION 'known b066 satellite miss was not adopted exactly';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournaments t
              WHERE t.id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlements s
       JOIN public.tournament_satellite_remainders r
         ON r.tournament_id = s.tournament_id
        AND r.evidence_kind = 'legacy_20260908_682'
        AND r.user_id = '146cf7a5-7f99-4dd3-858d-26dae69d9c80'::uuid
        AND r.place = 2 AND r.amount = 85.00
        WHERE s.tournament_id = '682045c5-cb07-47ed-ad0e-adbff9cb41af'::uuid
          AND s.pool = 285.00 AND s.ticket_award_count = 1
          AND s.seat_count = 1 AND s.cash_ticket_count = 0
          AND s.remainder = 85.00 AND s.bubble_position = 2
          AND s.source_closed_at =
                '2026-09-08 11:23:11.485+00'::timestamptz
          AND s.source_table_count = 1 AND s.source_seat_count = 2
          AND s.released_seat_count = 0
     ) THEN
    RAISE EXCEPTION 'known 682 legacy completion was not adopted exactly';
  END IF;
END;
$verify_satellite_authority$;

COMMIT;

-- DATA-FORWARD RELEASE: a statement failure rolls this migration transaction
-- back automatically. After commit, immutable settlement evidence and the
-- exact b066/682 cache and felt normalization are intentionally irreversible.
-- Repair a post-commit defect with a reviewed forward migration. Never drop
-- the receipts, reverse the normalized caches, or reopen the per-seat writer.
