-- 20260908034440_tournament_cancellation_commits_one_stored_receipt
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
-- complete per-player refund receipt is persisted only after refunds, fee
-- reversals and all three closeouts succeed, and a retry returns those exact
-- immutable bytes. Every refund obligation must report fully_settled and its
-- final paid total must equal the evidence-derived gross, otherwise an
-- exception rolls the entire call back. The old function signature and
-- service-role ACL remain in place for rolling deploy compatibility.
--
-- No tournament is cancelled or backfilled by this migration.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

DO $prerequisites$
DECLARE
  v_cancel_source text;
  v_settle_source text;
BEGIN
  IF to_regclass('public.ca_settle_sources') IS NULL THEN
    RAISE EXCEPTION 'platform settlement-source registry is missing';
  END IF;

  IF to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'atomic cancellation authority is missing';
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
       'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)')
       IS NULL THEN
    RAISE EXCEPTION 'tournament obligation authority is missing';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'))
    INTO v_settle_source;
  IF v_settle_source NOT LIKE '%fully_settled%'
     OR v_settle_source NOT LIKE '%amount_paid%' THEN
    RAISE EXCEPTION
      'tournament obligation authority cannot prove a complete refund';
  END IF;
END;
$prerequisites$;

-- A refund is paid through the obligation authority, whose fail-closed source
-- registry must recognize the caller before it can move chips. Claim the
-- existing legacy registration only when it has the known predecessor note;
-- any unrelated row using this authority name aborts the cutover.
DO $own_settle_source$
DECLARE
  c_source constant text := 'atomic_cancel_tournament';
  c_note constant text :=
    '20260908034440: atomic cancellation receipt authority';
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

CREATE TABLE public.tournament_cancellation_receipts (
  tournament_id   uuid PRIMARY KEY
                       REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  actor_id        uuid NOT NULL,
  receipt_version integer NOT NULL DEFAULT 1 CHECK (receipt_version = 1),
  refunded_count integer NOT NULL CHECK (refunded_count >= 0),
  total_refunded numeric(15,2) NOT NULL
                       CHECK (total_refunded >= 0 AND total_refunded = round(total_refunded, 2)),
  fees_reversed  numeric(15,2) NOT NULL
                       CHECK (fees_reversed >= 0 AND fees_reversed = round(fees_reversed, 2)
                              AND fees_reversed <= total_refunded),
  player_count   integer NOT NULL CHECK (player_count >= 0),
  table_count    integer NOT NULL CHECK (table_count >= 0),
  receipt        jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  settled_at     timestamptz NOT NULL,
  CHECK ((receipt->>'tournament_id')::uuid IS NOT DISTINCT FROM tournament_id),
  CHECK ((receipt->>'actor_id')::uuid IS NOT DISTINCT FROM actor_id),
  CHECK ((receipt->>'receipt_version')::integer IS NOT DISTINCT FROM receipt_version),
  CHECK ((receipt->>'refunded_count')::integer IS NOT DISTINCT FROM refunded_count),
  CHECK ((receipt->>'total_refunded')::numeric IS NOT DISTINCT FROM total_refunded),
  CHECK ((receipt->>'fees_reversed')::numeric IS NOT DISTINCT FROM fees_reversed),
  CHECK ((receipt->>'player_count')::integer IS NOT DISTINCT FROM player_count),
  CHECK ((receipt->>'table_count')::integer IS NOT DISTINCT FROM table_count),
  CHECK ((receipt->>'settled_at')::timestamptz IS NOT DISTINCT FROM settled_at),
  CHECK (receipt->>'status' IS NOT DISTINCT FROM 'CANCELLED'),
  CHECK ((receipt->>'ok')::boolean IS TRUE),
  CHECK ((receipt->>'success')::boolean IS TRUE),
  CHECK ((receipt->>'fully_settled')::boolean IS TRUE),
  CHECK (jsonb_typeof(receipt->'refunds') IS NOT DISTINCT FROM 'array'),
  CHECK (jsonb_array_length(receipt->'refunds') = refunded_count),
  CHECK (refunded_count <= player_count)
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

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(
  p_tournament_id uuid,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
SET statement_timeout TO '120s'
AS $cancel$
DECLARE
  v_uid uuid := auth.uid();
  v_actor uuid := COALESCE(
    auth.uid(), p_admin_id, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_t public.tournaments%ROWTYPE;
  v_stored public.tournament_cancellation_receipts%ROWTYPE;
  v_player record;
  v_fee_row record;
  v_gross numeric;
  v_fee_net numeric;
  v_settle jsonb;
  v_amount_refunded numeric;
  v_amount_paid_before numeric;
  v_amount_paid_now numeric;
  v_obligation_id uuid;
  v_idempotency_key text;
  v_refunds jsonb := '[]'::jsonb;
  v_refunded_count integer := 0;
  v_total_refunded numeric := 0;
  v_fees_reversed numeric := 0;
  v_player_count integer;
  v_table_count integer;
  v_cancelled_at timestamptz;
  v_receipt jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Tournament id is required' USING ERRCODE = '22004';
  END IF;

  -- The tournament lock serializes first execution and replay. A concurrent
  -- caller waits here, then sees the immutable receipt written by the winner.
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;

  -- Preserve the current authorization rule. The service role may name the
  -- automation actor; any JWT-bearing caller must itself administer the club.
  IF v_uid IS NOT NULL AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
    RAISE EXCEPTION 'Only a club admin may cancel a tournament'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stored
    FROM public.tournament_cancellation_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR SHARE;
  IF FOUND THEN
    -- Replay proves both terminal state and every stored refund line. A
    -- refund's durable payout evidence is its wallet credit (refunds do not
    -- create tournament_payouts rows), paired with the obligation and, when
    -- this call moved a balance, the exact wallet-credit idempotency key.
    -- Re-deriving entry, refund, and fee evidence here detects evidence added
    -- or altered after cancellation. No replay branch writes a second
    -- reversal or refund.
    IF upper(COALESCE(v_t.status, '')) NOT IN ('CANCELLED', 'CANCELED')
       OR v_t.ended_at IS NULL
       OR v_t.ended_at IS DISTINCT FROM v_stored.settled_at
       OR COALESCE(v_t.prize_pool, 0) <> 0
       OR COALESCE(v_t.bounty_pool, 0) <> 0
       OR (SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id) <> v_stored.player_count
       OR (SELECT count(*) FROM public.tables tb
            WHERE tb.tournament_id = p_tournament_id) <> v_stored.table_count
       OR (SELECT round(COALESCE(-sum(r.rake_amount), 0), 2)
             FROM public.rake_records r
            WHERE r.tournament_id = p_tournament_id
              AND r.is_tournament
              AND r.source = 'atomic_cancel_tournament'
              AND r.metadata->>'kind' IN
                    ('tournament_fee_refund','spin_rake_refund'))
            IS DISTINCT FROM v_stored.fees_reversed
       OR EXISTS (
         SELECT 1 FROM public.rake_records r
          WHERE r.tournament_id = p_tournament_id
            AND r.is_tournament
            AND r.source = 'atomic_cancel_tournament'
            AND (r.rake_amount >= 0
              OR r.metadata->>'kind' IS NULL
              OR r.metadata->>'kind' NOT IN
                   ('tournament_fee_refund','spin_rake_refund'))
       )
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.status IN ('registered', 'playing')
       )
       OR EXISTS (
         SELECT 1 FROM public.tables tb
          WHERE tb.tournament_id = p_tournament_id
            AND (COALESCE(tb.status, '') <> 'closed'
              OR COALESCE(tb.current_players, 0) <> 0)
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_to_recordset(v_stored.receipt->'refunds') AS line(
                  user_id uuid,
                  gross_paid numeric,
                  amount_refunded numeric,
                  amount_paid_before numeric,
                  amount_paid_now numeric,
                  obligation_id uuid,
                  idempotency_key text)
           LEFT JOIN public.tournament_obligations o
             ON o.id = line.obligation_id
           LEFT JOIN LATERAL (
             SELECT tp.user_id,
                    COALESCE(tp.is_satellite_qualifier, false) AS is_q,
                    tp.source_satellite_id
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = line.user_id
              ORDER BY tp.id
              LIMIT 1
           ) player ON true
           LEFT JOIN LATERAL (
             SELECT round(COALESCE(sum(
                      CASE
                        WHEN w.type = 'debit'
                         AND w.category IN ('tournament_buyin','rebuy','addon')
                        THEN w.amount
                        ELSE 0
                      END), 0), 2) AS gross
               FROM public.wallet_transactions w
              WHERE w.user_id = line.user_id
                AND w.related_entity_id = p_tournament_id
           ) entry_payment ON true
           LEFT JOIN LATERAL (
             SELECT round(COALESCE(sum(l.amount), 0), 2) AS gross
               FROM public.chip_ledger l
              WHERE l.to_entity_id = p_tournament_id
                AND l.to_type = 'prize_liability'
                AND l.idempotency_key =
                    'tourney:' || player.source_satellite_id::text ||
                    ':seat:' || line.user_id::text || ':pool_transfer'
           ) satellite_payment ON true
           LEFT JOIN LATERAL (
             SELECT round(COALESCE(sum(w.amount), 0), 2) AS paid
               FROM public.wallet_transactions w
              WHERE w.user_id = line.user_id
                AND w.related_entity_id = p_tournament_id
                AND w.type = 'credit'
                AND lower(w.category) IN ('refund','tournament_refund')
           ) refund_payment ON true
           LEFT JOIN LATERAL (
             SELECT round(COALESCE(sum(r.rake_amount), 0), 2) AS fee_paid
               FROM public.rake_records r
              WHERE r.tournament_id = p_tournament_id
                AND r.is_tournament
                AND r.metadata->>'user_id' = line.user_id::text
                AND r.rake_amount > 0
           ) player_fee ON true
           LEFT JOIN LATERAL (
          SELECT round(COALESCE(sum(r.rake_amount), 0), 2) AS fee_refunded,
                 count(*)::integer AS refund_rows
               FROM public.rake_records r
              WHERE r.tournament_id = p_tournament_id
                AND r.is_tournament
                AND r.source = 'atomic_cancel_tournament'
                AND r.metadata->>'kind' = 'tournament_fee_refund'
                AND r.metadata->>'user_id' = line.user_id::text
           ) player_fee_refund ON true
          WHERE line.user_id IS NULL
             OR line.obligation_id IS NULL
             OR line.gross_paid IS NULL
             OR line.gross_paid <= 0
             OR line.gross_paid <> round(line.gross_paid, 2)
             OR line.amount_refunded IS DISTINCT FROM line.gross_paid
             OR line.amount_paid_before IS NULL
             OR line.amount_paid_before < 0
             OR line.amount_paid_before <> round(line.amount_paid_before, 2)
             OR line.amount_paid_now IS NULL
             OR line.amount_paid_now < 0
             OR line.amount_paid_now <> round(line.amount_paid_now, 2)
             OR line.amount_paid_before + line.amount_paid_now
                  IS DISTINCT FROM line.amount_refunded
             OR line.idempotency_key IS DISTINCT FROM
                  CASE WHEN line.amount_paid_now > 0 THEN
                    'tourney:' || p_tournament_id::text || ':obl:' ||
                    line.obligation_id::text || ':' ||
                    (round(line.amount_paid_before * 100))::bigint::text
                  ELSE NULL END
             OR o.id IS NULL
             OR o.tournament_id IS DISTINCT FROM p_tournament_id
             OR o.kind IS DISTINCT FROM 'refund'
             OR o.place IS NOT NULL
             OR o.user_id IS DISTINCT FROM line.user_id
             OR o.amount_owed IS DISTINCT FROM line.gross_paid
             OR o.amount_paid IS DISTINCT FROM line.amount_refunded
             OR o.settled_at IS NULL
             OR player.user_id IS NULL
             OR line.gross_paid IS DISTINCT FROM
                  CASE
                    WHEN entry_payment.gross > 0 THEN entry_payment.gross
                    WHEN player.is_q AND player.source_satellite_id IS NOT NULL
                      THEN satellite_payment.gross
                    ELSE entry_payment.gross
                  END
             OR refund_payment.paid IS DISTINCT FROM line.amount_refunded
             OR player_fee.fee_paid IS DISTINCT FROM
                  COALESCE(-player_fee_refund.fee_refunded, 0)
             OR player_fee_refund.refund_rows IS DISTINCT FROM
                  CASE WHEN player_fee.fee_paid > 0 THEN 1 ELSE 0 END
             OR (line.amount_paid_now > 0 AND NOT EXISTS (
                  SELECT 1
                    FROM public.wallet_credit_idempotency k
                   WHERE k.key = line.idempotency_key
                     AND k.user_id IS NOT DISTINCT FROM line.user_id
                     AND round(k.amount, 2) IS NOT DISTINCT FROM line.amount_paid_now
                ))
       ) THEN
      RAISE EXCEPTION
        'stored cancellation receipt for tournament % no longer has exact terminal, refund, or fee evidence',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.rake_records fee_row
        LEFT JOIN LATERAL (
          SELECT round(COALESCE(sum(r.rake_amount), 0), 2) AS fee_refunded,
                 count(*)::integer AS refund_rows
            FROM public.rake_records r
           WHERE r.tournament_id = p_tournament_id
             AND r.is_tournament
             AND r.source = 'atomic_cancel_tournament'
             AND r.metadata->>'kind' = 'spin_rake_refund'
             AND r.metadata->>'original_rake_record_id' = fee_row.id::text
        ) fee_refund ON true
       WHERE fee_row.tournament_id = p_tournament_id
         AND fee_row.is_tournament
         AND fee_row.source IN ('fn_spin_book_entry','fn_spin_settle_game')
         AND fee_row.rake_amount > 0
         AND NULLIF(fee_row.metadata->>'user_id', '') IS NULL
         AND (fee_refund.refund_rows IS DISTINCT FROM 1
           OR round(fee_row.rake_amount + COALESCE(fee_refund.fee_refunded, 0), 2)
                IS DISTINCT FROM 0)
    ) THEN
      RAISE EXCEPTION
        'stored cancellation receipt for tournament % no longer has exact terminal, refund, or fee evidence',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id
         AND r.is_tournament
         AND r.source = 'atomic_cancel_tournament'
         AND (
           (r.metadata->>'kind' = 'tournament_fee_refund'
            AND NOT EXISTS (
              SELECT 1
                FROM jsonb_to_recordset(v_stored.receipt->'refunds') AS line(user_id uuid)
               WHERE line.user_id::text = r.metadata->>'user_id'))
           OR
           (r.metadata->>'kind' = 'spin_rake_refund'
            AND NOT EXISTS (
              SELECT 1 FROM public.rake_records original
               WHERE original.id::text = r.metadata->>'original_rake_record_id'
                 AND original.tournament_id = p_tournament_id
                 AND original.is_tournament
                 AND original.source IN ('fn_spin_book_entry','fn_spin_settle_game')
                 AND original.rake_amount > 0
                 AND NULLIF(original.metadata->>'user_id', '') IS NULL))
         )
    ) THEN
      RAISE EXCEPTION
        'stored cancellation receipt for tournament % contains orphan fee evidence',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
    RETURN v_stored.receipt;
  END IF;

  -- Preserve the terminal-status safeguard. CANCELLED is accepted only above,
  -- when this authority can return the receipt that made it terminal.
  IF upper(COALESCE(v_t.status, '')) IN
       ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
    RAISE EXCEPTION 'Tournament is already %', v_t.status;
  END IF;

  UPDATE public.tournaments
     SET status = 'CANCELLED',
         ended_at = now(),
         updated_at = now(),
         prize_pool = 0,
         bounty_pool = 0
   WHERE id = p_tournament_id
  RETURNING ended_at INTO v_cancelled_at;

  -- Lock the complete roster before selecting refund candidates. Preserve the
  -- engine safeguard: only still-open registrations with no recorded prize can
  -- receive a cancellation refund. Money is never inferred from the buy-in
  -- configuration: gross entitlement comes only from this user's recorded
  -- entry, rebuy and add-on debits (plus the existing satellite transfer rule).
  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;
  FOR v_player IN
    SELECT DISTINCT ON (tp.user_id)
           tp.id, tp.user_id,
           COALESCE(tp.is_satellite_qualifier, false) AS is_q,
           tp.source_satellite_id
     FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id IS NOT NULL
       AND tp.status IN ('registered', 'playing')
       AND COALESCE(tp.prize, 0) <= 0
     ORDER BY tp.user_id, tp.id
  LOOP
    SELECT round(COALESCE(sum(
             CASE
               WHEN w.type = 'debit'
                AND w.category IN ('tournament_buyin','rebuy','addon')
               THEN w.amount
               ELSE 0
             END), 0), 2)
      INTO v_gross
      FROM public.wallet_transactions w
     WHERE w.user_id = v_player.user_id
       AND w.related_entity_id = p_tournament_id;

    IF v_gross IS NULL OR v_gross::text IN ('NaN','Infinity','-Infinity')
       OR v_gross < 0 THEN
      RAISE EXCEPTION 'invalid entry-payment evidence for player % in tournament %',
        v_player.user_id, p_tournament_id USING ERRCODE = '22003';
    END IF;

    -- Existing satellite cancellation safeguard, retained byte-for-byte in
    -- meaning: a target refunds the seat value actually transferred into it.
    IF v_gross = 0 AND v_player.is_q
       AND v_player.source_satellite_id IS NOT NULL THEN
      SELECT round(COALESCE(sum(l.amount), 0), 2)
        INTO v_gross
        FROM public.chip_ledger l
       WHERE l.to_entity_id = p_tournament_id
         AND l.to_type = 'prize_liability'
         AND l.idempotency_key =
           'tourney:' || v_player.source_satellite_id::text ||
           ':seat:' || v_player.user_id::text || ':pool_transfer';
    END IF;

    IF v_gross > 0 THEN
      v_settle := public.fn_settle_tournament_obligation(
        p_tournament_id,
        'refund',
        NULL,
        v_player.user_id,
        v_gross,
        'atomic_cancel_tournament',
        'Tournament cancellation refund: ' || COALESCE(v_t.name, 'Unknown'));

      v_amount_refunded := COALESCE((v_settle->>'amount_paid')::numeric, -1);
      v_amount_paid_before := COALESCE((v_settle->>'already_paid')::numeric, -1);
      v_amount_paid_now := COALESCE((v_settle->>'paid')::numeric, -1);
      v_obligation_id := NULLIF(v_settle->>'obligation_id', '')::uuid;
      v_idempotency_key := NULLIF(v_settle->>'idempotency_key', '');
      IF COALESCE((v_settle->>'ok')::boolean, false) IS NOT TRUE
         OR COALESCE((v_settle->>'fully_settled')::boolean, false) IS NOT TRUE
         OR COALESCE((v_settle->>'remaining')::numeric, -1) <> 0
         OR v_amount_refunded IS DISTINCT FROM v_gross
         OR v_amount_paid_before < 0
         OR v_amount_paid_before <> round(v_amount_paid_before, 2)
         OR v_amount_paid_now < 0
         OR v_amount_paid_now <> round(v_amount_paid_now, 2)
         OR v_amount_paid_before + v_amount_paid_now
              IS DISTINCT FROM v_amount_refunded
         OR v_obligation_id IS NULL THEN
        RAISE EXCEPTION
          'refund obligation for player % in tournament % did not settle gross %: %',
          v_player.user_id, p_tournament_id, v_gross, COALESCE(v_settle::text, '<null>')
          USING ERRCODE = '55000';
      END IF;
      IF v_idempotency_key IS DISTINCT FROM (
           CASE WHEN v_amount_paid_now > 0 THEN
             'tourney:' || p_tournament_id::text || ':obl:' ||
             v_obligation_id::text || ':' ||
             (round(v_amount_paid_before * 100))::bigint::text
           ELSE NULL END) THEN
        RAISE EXCEPTION
          'refund obligation for player % in tournament % returned an invalid settlement key',
          v_player.user_id, p_tournament_id USING ERRCODE = '55000';
      END IF;

      v_refunds := v_refunds || jsonb_build_array(jsonb_build_object(
        'user_id', v_player.user_id,
        'gross_paid', v_gross,
        'amount_refunded', v_amount_refunded,
        'amount_paid_before', v_amount_paid_before,
        'amount_paid_now', v_amount_paid_now,
        'obligation_id', v_obligation_id,
        'idempotency_key', v_idempotency_key));
      v_refunded_count := v_refunded_count + 1;
      v_total_refunded := round(v_total_refunded + v_amount_refunded, 2);
    END IF;

    -- Reverse the remainder of this entrant's per-player fee attribution. A
    -- prior partial reversal is included in the sum, so only the difference is
    -- inserted. Any INSERT failure aborts the whole function transaction.
    IF v_t.club_id IS NOT NULL THEN
      SELECT round(COALESCE(sum(r.rake_amount), 0), 2)
        INTO v_fee_net
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id
         AND r.is_tournament
         AND r.metadata->>'user_id' = v_player.user_id::text;
      IF v_fee_net IS NULL OR v_fee_net::text IN ('NaN','Infinity','-Infinity')
         OR v_fee_net < 0 THEN
        RAISE EXCEPTION 'invalid fee evidence for player % in tournament %',
          v_player.user_id, p_tournament_id USING ERRCODE = '22003';
      END IF;
      IF v_fee_net > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_t.club_id, -v_fee_net, v_fee_net, 1,
           0, true, p_tournament_id, 'atomic_cancel_tournament',
           jsonb_build_object(
             'kind', 'tournament_fee_refund',
             'user_id', v_player.user_id));
        v_fees_reversed := round(v_fees_reversed + v_fee_net, 2);
      END IF;
    END IF;
  END LOOP;

  -- Preserve both active aggregate Spin fee writers. These rows deliberately
  -- have no metadata.user_id, so they cannot be handled by the entrant loop.
  IF v_t.variant = 'spin' AND v_t.club_id IS NOT NULL THEN
    FOR v_fee_row IN
      SELECT r.*
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id
         AND r.is_tournament
         AND r.source IN ('fn_spin_book_entry','fn_spin_settle_game')
         AND r.rake_amount > 0
         AND NULLIF(r.metadata->>'user_id', '') IS NULL
       ORDER BY r.id
       FOR UPDATE
    LOOP
      SELECT round(v_fee_row.rake_amount + COALESCE(sum(r.rake_amount), 0), 2)
        INTO v_fee_net
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id
         AND r.is_tournament
         AND r.source = 'atomic_cancel_tournament'
         AND r.metadata->>'kind' = 'spin_rake_refund'
         AND r.metadata->>'original_rake_record_id' = v_fee_row.id::text;
      IF v_fee_net IS NULL OR v_fee_net::text IN ('NaN','Infinity','-Infinity')
         OR v_fee_net < 0 THEN
        RAISE EXCEPTION 'invalid fee evidence for Spin fee row % in tournament %',
          v_fee_row.id, p_tournament_id USING ERRCODE = '22003';
      END IF;
      IF v_fee_net > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source,
           player_contributions, metadata)
        VALUES
          (NULL, NULL, v_fee_row.club_id, -v_fee_net, v_fee_row.pot_size,
           v_fee_row.num_players, 0, true, p_tournament_id,
           'atomic_cancel_tournament', v_fee_row.player_contributions,
           jsonb_build_object(
             'kind', 'spin_rake_refund',
             'original_source', v_fee_row.source,
             'original_rake_record_id', v_fee_row.id));
        v_fees_reversed := round(v_fees_reversed + v_fee_net, 2);
      END IF;
    END LOOP;
  END IF;

  IF v_fees_reversed > v_total_refunded THEN
    RAISE EXCEPTION
      'fee reversals % exceed evidence-derived refunds % for tournament %',
      v_fees_reversed, v_total_refunded, p_tournament_id USING ERRCODE = '23514';
  END IF;

  IF v_fees_reversed > 0 THEN
    UPDATE public.tournaments
       SET total_rake = GREATEST(0, COALESCE(total_rake, 0) - v_fees_reversed)
     WHERE id = p_tournament_id;
  END IF;

  UPDATE public.tournament_players
     SET status = 'eliminated', eliminated_at = now()
   WHERE tournament_id = p_tournament_id
     AND status IN ('registered', 'playing');

  UPDATE public.tables
     SET status = 'closed', current_players = 0
   WHERE tournament_id = p_tournament_id;

  IF EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status IN ('registered', 'playing')
     ) OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (COALESCE(tb.status, '') <> 'closed'
            OR COALESCE(tb.current_players, 0) <> 0)
     ) THEN
    RAISE EXCEPTION 'tournament % closeout left nonterminal player or table rows',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_player_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_table_count
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;

  v_receipt := jsonb_build_object(
    'ok', true,
    'success', true,
    'fully_settled', true,
    'receipt_version', 1,
    'tournament_id', p_tournament_id,
    'actor_id', v_actor,
    'status', 'CANCELLED',
    'refunded_count', v_refunded_count,
    'total_refunded', v_total_refunded,
    'fees_reversed', v_fees_reversed,
    'player_count', v_player_count,
    'table_count', v_table_count,
    'refunds', v_refunds,
    'settled_at', v_cancelled_at);

  INSERT INTO public.tournament_cancellation_receipts
    (tournament_id, actor_id, receipt_version, refunded_count,
     total_refunded, fees_reversed, player_count, table_count,
     receipt, settled_at)
  VALUES
    (p_tournament_id, v_actor, 1, v_refunded_count,
     v_total_refunded, v_fees_reversed, v_player_count, v_table_count,
     v_receipt, v_cancelled_at);

  RETURN v_receipt;
END;
$cancel$;

-- Rolling cutover: this is the same legacy signature and ACL. The old engine
-- may continue calling it while the database lands first; no obligation or
-- cancellation door is retired in this stage.
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  TO service_role;

DO $settle_source_proof$
BEGIN
  IF (SELECT count(*)
        FROM public.ca_settle_sources s
       WHERE s.source = 'atomic_cancel_tournament'
         AND s.note = '20260908034440: atomic cancellation receipt authority') <> 1 THEN
    RAISE EXCEPTION
      'atomic cancellation source ownership proof failed after function publish'
      USING ERRCODE = 'P0404';
  END IF;
END;
$settle_source_proof$;

COMMIT;
