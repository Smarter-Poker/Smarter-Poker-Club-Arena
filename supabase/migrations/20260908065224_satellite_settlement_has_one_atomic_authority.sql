-- 20260908065224_satellite_settlement_has_one_atomic_authority.sql
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

  IF to_regprocedure('public.fn_ca_escrow_on_seat_transfer_leg()') IS NULL
     OR to_regprocedure('public.fn_ca_escrow_on_rake_record()') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'chip_ledger'
          AND tg.tgname = 'zz_ca_escrow_seat_transfer_leg'
          AND NOT tg.tgisinternal
          AND tg.tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION
      'atomic satellite settlement requires the active target escrow transfer rail';
  END IF;
  SELECT pg_get_functiondef(
           to_regprocedure('public.fn_ca_escrow_on_seat_transfer_leg()'))
    INTO v_seat_leg_source;
  SELECT pg_get_functiondef(
           to_regprocedure('public.fn_ca_escrow_on_rake_record()'))
    INTO v_rake_source;
  IF v_seat_leg_source NOT LIKE
       '%p_satellite_in => round(NEW.amount, 2)%'
     OR v_rake_source NOT LIKE
       '%p_satellite_fee_in => v_fee, p_satellite_in => -v_fee%' THEN
    RAISE EXCEPTION
      'target escrow transfer/reclassification semantics are not the required hardened version';
  END IF;

  IF to_regprocedure('public.fn_settle_tournament_rake(uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'atomic satellite settlement requires the terminal rake authority';
  END IF;
END;
$satellite_prerequisites$;

-- The cleanup stage needs an exact boundary between history that may have
-- completed through the legacy per-seat writer and every completion after
-- this whole-event authority began installing. transaction_timestamp() is
-- the start of this migration transaction, so a legacy completion racing the
-- installation is on the proof-required side of the boundary. The audited id
-- array records which of the five production cutover events existed at that
-- boundary; clean databases correctly record an empty array.
CREATE TABLE public.tournament_satellite_settlement_cutover (
  authority              text PRIMARY KEY
                              CHECK (authority = 'fn_settle_satellite_tournament:v2'),
  migration_version      text NOT NULL
                              CHECK (migration_version = '20260908065224'),
  installed_at           timestamptz NOT NULL,
  audited_tournament_ids uuid[] NOT NULL,
  CHECK (audited_tournament_ids <@ ARRAY[
    'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid,
    'a6a1b360-821c-4201-b378-1591e3df3892'::uuid,
    'e3570642-2e39-42ae-a8f6-164055ffd6e6'::uuid,
    'eddd8116-5792-47fd-b570-790c67581e9f'::uuid,
    '6b0c3243-75fb-487f-8da2-245b2426dbbe'::uuid
  ])
);

ALTER TABLE public.tournament_satellite_settlement_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_satellite_settlement_cutover
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.tournament_satellite_settlement_cutover (
  authority, migration_version, installed_at, audited_tournament_ids)
SELECT
  'fn_settle_satellite_tournament:v2',
  '20260908065224',
  transaction_timestamp(),
  ARRAY(
    SELECT expected.id
      FROM (VALUES
        ('b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid),
        ('a6a1b360-821c-4201-b378-1591e3df3892'::uuid),
        ('e3570642-2e39-42ae-a8f6-164055ffd6e6'::uuid),
        ('eddd8116-5792-47fd-b570-790c67581e9f'::uuid),
        ('6b0c3243-75fb-487f-8da2-245b2426dbbe'::uuid)
      ) AS expected(id)
     WHERE EXISTS (
       SELECT 1 FROM public.tournaments t WHERE t.id = expected.id)
     ORDER BY expected.id
  );

COMMENT ON TABLE public.tournament_satellite_settlement_cutover IS
  'Owner-only cutover watermark. Stage two must prove an exact whole-pool receipt for every satellite completed on or after installed_at and every audited production id captured here.';

CREATE TABLE public.tournament_satellite_settlements (
  tournament_id          uuid PRIMARY KEY
                              REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  target_id              uuid NOT NULL,
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
  settled_at             timestamptz NOT NULL DEFAULT now(),
  receipt_version        integer NOT NULL DEFAULT 2 CHECK (receipt_version = 2),
  CHECK (target_id <> tournament_id),
  CHECK (ticket_cost = target_buy_in + target_fee),
  CHECK (ticket_award_count = seat_count + cash_ticket_count),
  CHECK (ticket_award_count <= field_size),
  CHECK (pool = ticket_award_count * ticket_cost + remainder),
  CHECK (pool >= advertised_seats * ticket_cost),
  CHECK (remainder < ticket_cost),
  CHECK (NOT target_was_missing OR (target_contract_version IS NOT NULL AND seat_count = 0)),
  CHECK (source_table_count = cardinality(source_table_ids)),
  CHECK (source_seat_count = cardinality(source_seat_ids)),
  CHECK (released_seat_count = cardinality(released_seat_ids)),
  CHECK (array_position(source_table_ids, NULL) IS NULL),
  CHECK (array_position(source_seat_ids, NULL) IS NULL),
  CHECK (array_position(released_seat_ids, NULL) IS NULL),
  CHECK (released_seat_ids <@ source_seat_ids),
  CHECK (
    (remainder = 0 AND bubble_user_id IS NULL AND bubble_position IS NULL)
    OR
    (remainder > 0 AND bubble_user_id IS NOT NULL
     AND bubble_position = ticket_award_count + 1
     AND bubble_position <= field_size)
  )
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
  registration_id   uuid REFERENCES public.tournament_players(id) ON DELETE RESTRICT,
  obligation_id     uuid REFERENCES public.tournament_obligations(id) ON DELETE RESTRICT,
  obligation_kind   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, place),
  UNIQUE (tournament_id, user_id),
  UNIQUE (payout_id),
  UNIQUE (idempotency_key),
  UNIQUE (registration_id),
  CHECK (
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
  )
);

ALTER TABLE public.tournament_satellite_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_satellite_awards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_satellite_settlements,
              public.tournament_satellite_awards
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

COMMENT ON TABLE public.tournament_satellite_settlements IS
  'Immutable whole-pool satellite settlement header. Final pool = full ticket awards plus at most one next-finisher residual; exact source tables and seats close in the same transaction.';
COMMENT ON TABLE public.tournament_satellite_awards IS
  'Immutable per-place full-ticket delivery evidence. Each line is exactly one actual target seat or one exact cash substitution.';

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
  v_contract record;
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

  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.on_break, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR COALESCE(v_source.on_break, false)
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

  SELECT t.id, t.buy_in_amount, t.buy_in_fee
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id;
  IF v_target.id IS NOT NULL THEN
    IF v_target.buy_in_amount IS NULL
       OR v_target.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR round(v_target.buy_in_amount, 2) IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee, 0)::text IN ('NaN','Infinity','-Infinity')
       OR round(COALESCE(v_target.buy_in_fee, 0), 2) IS DISTINCT FROM v_h.target_fee THEN
      RAISE EXCEPTION 'satellite % target price differs from its immutable receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_h.target_was_missing THEN
    SELECT v.id, v.version, v.contract
      INTO v_contract
      FROM public.managed_game_contract_versions v
     WHERE v.version = v_h.target_contract_version
       AND v.game_kind = 'tournament'
       AND v.game_id = v_h.target_id;
    IF v_contract.id IS NULL
       OR (v_contract.contract->>'buy_in_amount')::numeric
            IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE((v_contract.contract->>'buy_in_fee')::numeric, 0)
            IS DISTINCT FROM v_h.target_fee THEN
      RAISE EXCEPTION 'satellite % missing target has no exact published price',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_h.seat_count > 0 THEN
    RAISE EXCEPTION 'satellite % actual-seat receipt lost its target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

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
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position > 1 AND tp.status::text <> 'eliminated'
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
     AND COALESCE(ts.status, '') = 'left'
     AND COALESCE(ts.leave_pending, false) IS FALSE
     AND COALESCE(ts.is_sitting_out, false) IS FALSE;
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
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
         FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND ts.left_at IS NULL
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
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
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
    IF NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_obligations o
          ON o.tournament_id = p_tournament_id
         AND o.kind = 'satellite_remainder'
         AND o.place = v_h.bubble_position
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.tournament_payouts p
          ON p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" = v_h.bubble_position
         AND p.amount = v_h.remainder
         AND p.source = 'satellite_remainder'
         AND p.idempotency_key = 'tourney:' || p_tournament_id::text
                                  || ':satellite_remainder:place:'
                                  || v_h.bubble_position::text
        JOIN public.wallet_credit_idempotency k
          ON k.key = p.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (
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
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
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
      'closed_at', v_h.settled_at),
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
  v_contract record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_lock_id uuid;
  v_target_found boolean := false;
  v_target_was_missing boolean := false;
  v_target_open boolean := false;
  v_target_contract_version bigint := NULL;
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

  SELECT t.id, t.name, t.club_id, t.status, t.buy_in_amount, t.buy_in_fee,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id;
  v_target_found := v_target.id IS NOT NULL;
  IF v_target_found THEN
    v_target_buy_in := v_target.buy_in_amount;
    v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  ELSE
    -- Deletion is a definitive no-seat outcome only when an immutable published
    -- target contract still proves the exact ticket price.
    SELECT v.version, v.contract
      INTO v_contract
      FROM public.managed_game_contract_versions v
     WHERE v.game_kind = 'tournament' AND v.game_id = v_target_id
     ORDER BY v.version DESC
     LIMIT 1;
    IF v_contract.version IS NULL THEN
      RAISE EXCEPTION
        'satellite % target % is missing without a published contract',
        p_tournament_id, v_target_id USING ERRCODE = 'P0404';
    END IF;
    v_target_was_missing := true;
    v_target_contract_version := v_contract.version;
    v_target_buy_in := (v_contract.contract->>'buy_in_amount')::numeric;
    v_target_fee := COALESCE((v_contract.contract->>'buy_in_fee')::numeric, 0);
  END IF;
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
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open/lock the source and any surviving target escrow in the same UUID
  -- order. A zero-delta first sight reconstructs existing value; it mints none.
  FOR v_lock_id IN
    SELECT t.id FROM public.tournaments t
     WHERE t.id IN (p_tournament_id, v_target_id)
     ORDER BY t.id
  LOOP
    PERFORM public.fn_ca_escrow_apply(
      v_lock_id, 'atomic satellite settlement lock');
  END LOOP;
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY e.tournament_id FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2) THEN
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
  IF v_target_found THEN
    SELECT count(*) INTO v_target_count FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
  END IF;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text NOT IN ('playing','winner','eliminated')
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
       AND tp.position = 1 AND tp.user_id <> v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1
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
  -- held. Only explicit terminal/full/missing states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF v_target_found THEN
    IF v_target.max_players IS NOT NULL AND v_target.max_players > 0
       AND v_target_count >= v_target.max_players THEN
      v_target_open := false;
    ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
      v_target_open := false;
    ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
      v_target_open := true;
    ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
      v_target_open :=
        COALESCE(NULLIF(v_target.late_reg_levels, 0),
                 NULLIF(v_target.rebuy_levels, 0), 0) > 0
        AND COALESCE(v_target.current_level, 0) <
            COALESCE(NULLIF(v_target.late_reg_levels, 0),
                     NULLIF(v_target.rebuy_levels, 0), 0);
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
        WHEN v_target.max_players IS NULL OR v_target.max_players <= 0
          THEN v_ticket_award_count
        ELSE GREATEST(v_target.max_players - v_target_count, 0)
      END;
    END IF;
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
      IF v_target_found THEN
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
  IF v_seat_count > 0 AND (
       v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed pool, rake, or fee ownership state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, settled_at)
  VALUES
    (p_tournament_id, v_target_id, v_target_was_missing, v_target_contract_version,
     p_observed_winner_id, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at);

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
    SELECT count(*) INTO v_target_count FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    UPDATE public.tournaments
       SET current_players = v_target_count,
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
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL);

    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => 'tourney:' || p_tournament_id::text
                           || ':satellite_remainder:place:'
                           || v_bubble_position::text,
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
     WHERE tournament_id = p_tournament_id
       AND kind = 'satellite_remainder'
       AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
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

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         on_break = false, break_ends_at = NULL, updated_at = now()
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
          AND ts.left_at IS NULL
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
  v_target_id uuid;
  v_source record;
  v_target record;
  v_winner public.tournament_players%ROWTYPE;
  v_bubble public.tournament_players%ROWTYPE;
  v_existing_payout public.tournament_payouts%ROWTYPE;
  v_existing_obligation public.tournament_obligations%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_advertised_seats integer;
  v_ticket_cost numeric;
  v_rows integer;
  v_paid numeric;
  v_payout_id uuid;
  v_remainder_obligation_id uuid;
  v_credited boolean;
  v_rake_result jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
BEGIN
  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_target_id FROM public.tournaments t
   WHERE t.id = v_tournament_id;
  IF v_target_id IS NULL OR v_target_id = v_tournament_id THEN
    RAISE EXCEPTION 'b066 adoption: source or target identity is missing'
      USING ERRCODE = 'P0404';
  END IF;
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (v_tournament_id, v_target_id)
   ORDER BY CASE WHEN t.id = v_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at
    INTO v_source FROM public.tournaments t WHERE t.id = v_tournament_id;
  SELECT t.id, t.buy_in_amount, t.buy_in_fee
    INTO v_target FROM public.tournaments t WHERE t.id = v_target_id;
  v_ticket_cost := round(COALESCE(v_target.buy_in_amount, 0)
                         + COALESCE(v_target.buy_in_fee, 0), 2);
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_source.id IS NULL OR v_target.id IS NULL
     OR upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR lower(COALESCE(v_source.variant, '')) <> 'satellite'
        AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
        AND v_source.satellite_target_id IS NULL
        AND v_source.satellite_target IS NULL
     OR COALESCE(v_source.satellite_target_id, v_source.satellite_target)
          IS DISTINCT FROM v_target_id
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.prize_pool IS DISTINCT FROM 285.00::numeric
     OR v_ticket_cost IS DISTINCT FROM 200.00::numeric
     OR v_advertised_seats < 0
     OR 285.00::numeric < v_advertised_seats * 200.00::numeric THEN
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
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'b066 adoption: source table is missing'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*) INTO v_rows FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tournament_id;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'b066 adoption: audited field was 2, found %', v_rows
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_winner FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tournament_id AND tp.position = 1;
  SELECT * INTO v_bubble FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tournament_id AND tp.position = 2;
  IF v_winner.id IS NULL OR lower(v_winner.username) <> 'beer710'
     OR v_winner.status::text <> 'winner'
     OR v_bubble.id IS NULL OR lower(v_bubble.username) <> 'detval'
     OR v_bubble.status::text <> 'eliminated'
     OR v_winner.user_id = v_bubble.user_id THEN
    RAISE EXCEPTION 'b066 adoption: audited beer710/DETVal standings are not exact'
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
              WHERE s.tournament_id = v_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_awards a
                 WHERE a.tournament_id = v_tournament_id) THEN
    RAISE EXCEPTION 'b066 adoption: immutable settlement evidence already exists'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_paid FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id;
  IF v_rows <> 1 OR v_paid IS DISTINCT FROM 200.00::numeric THEN
    RAISE EXCEPTION 'b066 adoption: expected one existing 200 payout, found % / %',
      v_rows, v_paid USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_existing_payout FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tournament_id
     AND p.user_id = v_winner.user_id
     AND p."position" = 1
     AND p.amount = 200.00::numeric
     AND p.source IS NOT NULL AND length(btrim(p.source)) > 0
     AND p.source <> 'satellite_seat'
     AND p.idempotency_key IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.wallet_credit_idempotency k
        WHERE k.key = p.idempotency_key
          AND k.user_id = p.user_id AND k.amount = p.amount);
  IF v_existing_payout.id IS NULL THEN
    RAISE EXCEPTION 'b066 adoption: existing 200 ticket has no exact cash evidence'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'b066 adoption: expected one existing debt row, found %', v_rows
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_existing_obligation FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id
     AND o.kind IN ('place','seat')
     AND o.place = 1
     AND o.user_id = v_winner.user_id
     AND o.amount_owed = 200.00::numeric
     AND o.amount_paid = 200.00::numeric
     AND o.settled_at IS NOT NULL;
  IF v_existing_obligation.id IS NULL THEN
    RAISE EXCEPTION 'b066 adoption: existing 200 ticket has no exact settled debt'
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
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_balance IS DISTINCT FROM 85.00::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'b066 adoption: audited escrow is not exactly prize 85 / bounty 0 / fee 0'
      USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, settled_at)
  VALUES
    (v_tournament_id, v_target_id, false, NULL,
     v_winner.user_id, 2, v_advertised_seats, 285.00,
     round(v_target.buy_in_amount, 2), round(COALESCE(v_target.buy_in_fee, 0), 2),
     200.00, 1, 0, 1, 85.00, v_bubble.user_id, 2,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at);

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
     85.00, 0, 'migration.20260908065224.b066', NULL)
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

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = v_tournament_id;
  UPDATE public.tournament_players SET prize = 200.00
   WHERE id = v_winner.id;
  UPDATE public.tournament_players SET prize = 85.00
   WHERE id = v_bubble.id;

  IF NOT EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                  WHERE r.tournament_id = v_tournament_id) THEN
    v_rake_result := public.fn_settle_tournament_rake(
      v_tournament_id, 'migration.20260908065224.b066');
    IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'b066 adoption: source rake did not settle: %', v_rake_result
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'b066 adoption: released % source seats, expected %',
      v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;
  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
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
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
         FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = v_tournament_id
          AND ts.left_at IS NULL
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

  RETURN public.fn_ca_satellite_settlement_receipt(
    v_tournament_id, v_winner.user_id);
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

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
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
  IF v_source IS NULL
     OR v_source NOT LIKE '%floor(v_pool / v_ticket_cost)%'
     OR v_source NOT LIKE '%pg_advisory_xact_lock(%ca:tournament-terminal-settlement:v1%'
     OR v_source NOT LIKE '%v_bubble_position := v_ticket_award_count + 1%'
     OR v_source NOT LIKE '%delivery_kind%'
     OR v_source NOT LIKE '%v_pool < v_advertised_seats * v_ticket_cost%'
     OR v_source NOT LIKE '%UPDATE public.table_seats%'
     OR v_source NOT LIKE '%UPDATE public.tables%'
     OR v_source NOT LIKE '%v_rows IS DISTINCT FROM v_released_seat_count%'
     OR v_source NOT LIKE '%RETURN public.fn_ca_satellite_settlement_receipt%'
     OR v_source LIKE '%EXCEPTION WHEN OTHERS%'
     OR v_source LIKE '%fn_apply_prize_guarantee%' THEN
    RAISE EXCEPTION 'atomic satellite authority lost a floor, guarantee, delivery, bubble, replay or fail-closed invariant';
  END IF;
  IF v_receipt_source IS NULL
     OR v_receipt_source NOT LIKE '%v_source_table_ids IS DISTINCT FROM v_h.source_table_ids%'
     OR v_receipt_source NOT LIKE '%v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids%'
     OR v_receipt_source NOT LIKE '%v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids%'
     OR v_receipt_source NOT LIKE '%v_durable_released_count IS DISTINCT FROM v_h.released_seat_count%'
     OR v_receipt_source NOT LIKE '%ts.left_at IS NULL%' THEN
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
  IF (SELECT count(*)
        FROM public.tournament_satellite_settlement_cutover c
       WHERE c.authority = 'fn_settle_satellite_tournament:v2'
         AND c.migration_version = '20260908065224'
         AND c.installed_at = transaction_timestamp()
         AND c.audited_tournament_ids <@ ARRAY[
           'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid,
           'a6a1b360-821c-4201-b378-1591e3df3892'::uuid,
           'e3570642-2e39-42ae-a8f6-164055ffd6e6'::uuid,
           'eddd8116-5792-47fd-b570-790c67581e9f'::uuid,
           '6b0c3243-75fb-487f-8da2-245b2426dbbe'::uuid
         ]) <> 1 THEN
    RAISE EXCEPTION 'satellite settlement cutover watermark is not exact';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_settle_satellite_tournament(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_satellite_settlement_receipt(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)', 'EXECUTE')
     OR has_table_privilege('service_role',
       'public.tournament_satellite_settlements', 'SELECT')
     OR has_table_privilege('service_role',
       'public.tournament_satellite_awards', 'SELECT')
     OR has_table_privilege('service_role',
       'public.tournament_satellite_settlement_cutover', 'SELECT') THEN
    RAISE EXCEPTION 'atomic satellite authority has an unsafe execute or table ACL';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournaments t
              WHERE t.id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlements s
        WHERE s.tournament_id = 'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'::uuid
          AND s.pool = 285.00 AND s.ticket_award_count = 1
          AND s.cash_ticket_count = 1 AND s.seat_count = 0
          AND s.remainder = 85.00 AND s.bubble_position = 2
          AND s.source_table_count = 1
          AND s.source_seat_count = 2
          AND s.released_seat_count = 0
     ) THEN
    RAISE EXCEPTION 'known b066 satellite miss was not adopted exactly';
  END IF;
END;
$verify_satellite_authority$;

COMMIT;

-- ROLLBACK (operator-reviewed, one transaction; never resurrect the unsafe
-- per-seat writer, which remains live only until the engine cutover cleanup):
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.fn_resolve_satellite_settlement_outcome(uuid,uuid);
-- DROP FUNCTION IF EXISTS public.fn_settle_satellite_tournament(uuid,uuid);
-- DROP FUNCTION IF EXISTS public.fn_ca_satellite_settlement_receipt(uuid,uuid);
-- DROP TRIGGER IF EXISTS tournament_satellite_awards_append_only
--   ON public.tournament_satellite_awards;
-- DROP TRIGGER IF EXISTS tournament_satellite_settlements_append_only
--   ON public.tournament_satellite_settlements;
-- DROP FUNCTION IF EXISTS public.fn_satellite_settlement_receipts_are_append_only();
-- DROP TABLE IF EXISTS public.tournament_satellite_awards;
-- DROP TABLE IF EXISTS public.tournament_satellite_settlements;
-- DROP TABLE IF EXISTS public.tournament_satellite_settlement_cutover;
-- DELETE FROM public.ca_money_rpc_registry
--  WHERE proname IN ('fn_settle_satellite_tournament',
--                    'fn_ca_satellite_settlement_receipt',
--                    'fn_resolve_satellite_settlement_outcome');
-- COMMIT;
