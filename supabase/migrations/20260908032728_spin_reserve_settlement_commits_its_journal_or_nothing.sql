-- 20260908032728_spin_reserve_settlement_commits_its_journal_or_nothing.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A live Spin (781cc0ee-6a1d-4e31-acaf-4e737661bba1) moved its 3.00 draw
-- out of spin_bonus_pools and wrote the authoritative jackpot_draw row, but
-- fn_ca_autoledger timed out while inserting the matching chip_ledger leg.
-- The trigger caught that exception and allowed the bank update to commit.
-- The escrow therefore never received reserve_in, the winner could not be
-- paid, and a later back-pay sweep was expected to repair the split state.
--
-- The platform-wide strict auto-ledger migration removes that failure mode at
-- the root for every balance store. This migration consumes, but never
-- redefines, that global authority:
--   1. the installed strict fn_ca_autoledger makes every reserve bank write,
--      journal leg and escrow side effect commit together or all roll back;
--   2. every new contribution/jackpot_draw reserve row must already have its
--      exact journal leg in the same transaction;
--   3. the public engine door draws and settles while retaining one reserve
--      lock. It never double-counts the current game's contribution and it
--      returns only after the reserve row, journal leg and escrow agree;
--   4. the two lower-level money functions become owner-only primitives.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $preflight$
BEGIN
  IF to_regclass('public.spin_bonus_pools') IS NULL
     OR to_regclass('public.spin_reserve_ledger') IS NULL
     OR to_regclass('public.chip_ledger') IS NULL
     OR to_regclass('public.tournament_escrow') IS NULL
     OR to_regclass('public.tournament_obligations') IS NULL
     OR to_regclass('public.tournament_payouts') IS NULL
     OR to_regclass('public.wallet_transactions') IS NULL
     OR to_regclass('public.club_members') IS NULL
     OR to_regclass('public.financial_alerts') IS NULL
     OR to_regclass('public.ca_drift_incidents') IS NULL
     OR to_regprocedure('public.fn_ca_autoledger()') IS NULL
     OR to_regprocedure('public.fn_spin_book_entry(uuid)') IS NULL
     OR to_regprocedure('public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)') IS NULL
     OR to_regprocedure('public.fn_spin_rake_rate(numeric)') IS NULL
     OR to_regprocedure('public.fn_spin_reserve_pool(uuid)') IS NULL
     OR to_regprocedure('public.fn_tournament_primary_table(uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])') IS NULL
     OR to_regprocedure('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)') IS NULL
     OR to_regprocedure('public.fn_sync_seat_first_player_count(uuid)') IS NULL THEN
    RAISE EXCEPTION 'atomic Spin cutover dependencies are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'spin_reserve_ledger'
       AND indexname = 'uq_spin_ledger_one_booking_per_game'
  ) THEN
    RAISE EXCEPTION 'one contribution/draw per Spin unique index is missing';
  END IF;

  -- There is no safe automatic interpretation for an in-flight legacy draw
  -- that moved the reserve without its exact leg. Completed damage is handled
  -- by the asserted correction below; an active event must stop this deploy.
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.spin_reserve_ledger r
        ON r.tournament_id = t.id AND r.kind = 'jackpot_draw'
      JOIN public.spin_bonus_pools bp ON bp.club_id = r.club_id
     WHERE upper(COALESCE(t.status::text,'')) NOT IN
             ('COMPLETED','CANCELLED','CANCELED')
       AND NOT EXISTS (
         SELECT 1 FROM public.chip_ledger l
          WHERE l.category = 'spin_prize'
            AND l.from_type = 'spin_reserve'
            AND l.from_entity_id = bp.id
            AND l.to_type = 'prize_liability'
            AND l.to_entity_id = t.id
            AND l.amount = round(-r.amount, 2)
       )
  ) THEN
    RAISE EXCEPTION
      'an active Spin already has a reserve draw without its exact journal leg';
  END IF;
END;
$preflight$;

-- Record whether this is the production cutover before repairing either
-- audited incident. Stage two uses this owner-only row as its durable boundary
-- and will not retire the repair payer in production until a different Spin
-- has produced a complete receipt through the new atomic authority.
CREATE TABLE public.tournament_spin_settlement_cutover (
  authority                  text PRIMARY KEY
                                  CHECK (authority = 'fn_spin_draw_and_settle:v1'),
  migration_version          text NOT NULL
                                  CHECK (migration_version = '20260908032728'),
  installed_at               timestamptz NOT NULL,
  audited_tournament_ids     uuid[] NOT NULL,
  production_requires_receipt boolean GENERATED ALWAYS AS
                                  (cardinality(audited_tournament_ids) > 0) STORED,
  CHECK (audited_tournament_ids <@ ARRAY[
    '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid,
    '6d688095-c3c5-4d40-a5a0-952934667732'::uuid
  ])
);

ALTER TABLE public.tournament_spin_settlement_cutover
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_spin_settlement_cutover
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.tournament_spin_settlement_cutover (
  authority, migration_version, installed_at, audited_tournament_ids)
SELECT
  'fn_spin_draw_and_settle:v1',
  '20260908032728',
  transaction_timestamp(),
  ARRAY(
    SELECT expected.id
      FROM (VALUES
        ('781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid),
        ('6d688095-c3c5-4d40-a5a0-952934667732'::uuid)
      ) AS expected(id)
     WHERE EXISTS (
       SELECT 1 FROM public.tournaments t WHERE t.id = expected.id)
     ORDER BY expected.id
  );

COMMENT ON TABLE public.tournament_spin_settlement_cutover IS
  'Owner-only stage-one boundary. Production stage two requires a complete three-seat atomic receipt from a different Spin after installed_at.';

-- Do not replace fn_ca_autoledger here. The earlier platform migration owns
-- its globally strict body; a later feature migration that restores the old
-- catch-and-continue implementation would reopen unjournaled movement for
-- every bank, not just Spin.

-- The third paid seat is the entry authority. This is still a private helper
-- because fn_sync_seat_first_player_count invokes it inside the transaction
-- that fills that seat. It refuses anything except one exact three-user roster,
-- three live seats and one exact buy-in debit per roster user. It also returns
-- the two immutable evidence ids instead of treating "already booked" as proof.
CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $spin_entry$
DECLARE
  v_t record;
  v_owner uuid;
  v_pool_id uuid;
  v_table_id uuid;
  v_live_seats integer;
  v_seat_users integer;
  v_roster_users integer;
  v_paid_users integer;
  v_buyin_debits integer;
  v_buyin_total numeric;
  v_collected numeric;
  v_rake_rate numeric;
  v_rake numeric;
  v_reserve_in numeric;
  v_balance numeric;
  v_reserve public.spin_reserve_ledger%ROWTYPE;
  v_reserve_count integer;
  v_journal_id uuid;
  v_journal_count integer;
  v_contrib jsonb;
  v_key text := 'spin:' || p_tournament_id::text || ':entry';
BEGIN
  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant,
         t.tournament_type, t.status
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR (lower(COALESCE(v_t.variant,'')) <> 'spin'
         AND upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_a_spin');
  END IF;
  IF v_t.club_id IS NULL OR COALESCE(v_t.buy_in_amount,0) <= 0
     OR COALESCE(v_t.max_players,0) <> 3
     OR upper(COALESCE(v_t.status::text,'')) IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_spin_contract');
  END IF;

  v_table_id := public.fn_tournament_primary_table(p_tournament_id);
  SELECT count(*), count(DISTINCT s.user_id)
    INTO v_live_seats, v_seat_users
    FROM public.table_seats s
   WHERE s.table_id = v_table_id AND s.left_at IS NULL;
  SELECT count(DISTINCT tp.user_id)
    INTO v_roster_users
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_paid_users
    FROM (
      SELECT tp.user_id
        FROM public.tournament_players tp
        JOIN public.wallet_transactions w
          ON w.related_entity_id = tp.tournament_id
         AND w.user_id = tp.user_id
         AND w.type = 'debit'
         AND w.category = 'tournament_buyin'
       WHERE tp.tournament_id = p_tournament_id
       GROUP BY tp.user_id
      HAVING round(sum(w.amount),2) = round(v_t.buy_in_amount,2)
    ) paid;
  SELECT count(*), round(COALESCE(sum(w.amount),0),2)
    INTO v_buyin_debits,v_buyin_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit'
     AND w.category = 'tournament_buyin';
  IF v_table_id IS NULL OR v_live_seats <> 3 OR v_seat_users <> 3
     OR v_roster_users <> 3 OR v_paid_users <> 3
     OR v_buyin_debits <> 3
     OR v_buyin_total <> round(v_t.buy_in_amount * 3,2)
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats s
             WHERE s.table_id = v_table_id AND s.left_at IS NULL
               AND s.user_id = tp.user_id)) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','three_paid_seats_required',
      'seats',v_live_seats,'seat_users',v_seat_users,
      'roster_users',v_roster_users,'paid_users',v_paid_users,
      'buyin_debits',v_buyin_debits,'buyin_total',v_buyin_total);
  END IF;

  -- One lock order for both the seat trigger and the start authority.
  PERFORM 1 FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('spin_entry:' || p_tournament_id::text,0));

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  SELECT p.id, p.balance INTO v_pool_id, v_balance
    FROM public.spin_bonus_pools p
   WHERE p.club_id = v_owner
   FOR UPDATE;
  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','no_pool_row','owner_id',v_owner);
  END IF;

  v_collected := round(v_t.buy_in_amount * 3,2);
  v_rake_rate := public.fn_spin_rake_rate(v_t.buy_in_amount);
  v_rake := round(v_collected * v_rake_rate,2);
  v_reserve_in := round(v_collected - v_rake,2);

  SELECT count(*) INTO v_reserve_count
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id AND r.kind = 'contribution';
  IF v_reserve_count > 0 THEN
    IF v_reserve_count <> 1 THEN
      RAISE EXCEPTION 'Spin % has % contribution rows',
        p_tournament_id,v_reserve_count USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_reserve
      FROM public.spin_reserve_ledger r
     WHERE r.tournament_id = p_tournament_id AND r.kind = 'contribution'
     FOR SHARE;
    IF v_reserve.club_id IS DISTINCT FROM v_owner
       OR v_reserve.amount IS DISTINCT FROM v_reserve_in
       OR v_reserve.buy_in IS DISTINCT FROM v_t.buy_in_amount
       OR v_reserve.seats IS DISTINCT FROM 3
       OR v_reserve.house_rake IS DISTINCT FROM v_rake THEN
      RAISE EXCEPTION 'Spin % existing contribution disagrees with its paid entry',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*) INTO v_journal_count
      FROM public.chip_ledger l
     WHERE l.category = 'spin_entry'
       AND l.from_type = 'prize_liability'
       AND l.from_entity_id = p_tournament_id
       AND l.to_type = 'spin_reserve'
       AND l.to_entity_id = v_pool_id
       AND l.tournament_id = p_tournament_id
       AND l.amount = v_reserve_in;
    IF v_journal_count <> 1 THEN
      RAISE EXCEPTION 'Spin % existing contribution has % exact journals',
        p_tournament_id,v_journal_count USING ERRCODE = 'P0404';
    END IF;
    SELECT l.id INTO v_journal_id
      FROM public.chip_ledger l
     WHERE l.category = 'spin_entry'
       AND l.from_type = 'prize_liability'
       AND l.from_entity_id = p_tournament_id
       AND l.to_type = 'spin_reserve'
       AND l.to_entity_id = v_pool_id
       AND l.tournament_id = p_tournament_id
       AND l.amount = v_reserve_in;
    RETURN jsonb_build_object(
      'ok',true,'reason','already_booked','collected',v_collected,
      'house_rake',v_rake,'reserve_in',v_reserve_in,'balance',v_balance,
      'owner_id',v_owner,'pool_id',v_pool_id,'seats',3,'paid_users',3,
      'entry_reserve_id',v_reserve.id,'entry_journal_id',v_journal_id);
  END IF;

  PERFORM public.fn_ca_declare_ledger(
    'spin_entry','prize_liability',p_tournament_id,NULL,v_key,NULL);
  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake,v_t.buy_in_amount),
         updated_at = now()
   WHERE id = v_pool_id
   RETURNING balance INTO v_balance;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Spin reserve pool % vanished while booking %',
      v_pool_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id,tournament_id,kind,amount,balance_after,multiplier,
     buy_in,seats,house_rake,note)
  VALUES
    (v_owner,p_tournament_id,'contribution',v_reserve_in,v_balance,NULL,
     v_t.buy_in_amount,3,v_rake,
     CASE WHEN v_owner = v_t.club_id
          THEN 'three exact paid buy-ins less fixed rake'
          ELSE format('three exact paid buy-ins less fixed rake (club %s)',v_t.club_id)
      END)
  RETURNING * INTO v_reserve;

  SELECT count(*), (array_agg(l.id ORDER BY l.created_at,l.id))[1]
    INTO v_journal_count,v_journal_id
    FROM public.chip_ledger l
   WHERE l.idempotency_key = v_key
     AND l.category = 'spin_entry'
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'spin_reserve'
     AND l.to_entity_id = v_pool_id
     AND l.tournament_id = p_tournament_id
     AND l.amount = v_reserve_in;
  IF v_journal_count <> 1 THEN
    RAISE EXCEPTION 'Spin % new contribution has % exact keyed journals',
      p_tournament_id,v_journal_count USING ERRCODE = 'P0404';
  END IF;

  SELECT jsonb_object_agg(tp.user_id::text,v_t.buy_in_amount)
    INTO v_contrib
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_rake > 0 THEN
    INSERT INTO public.rake_records
      (hand_id,table_id,club_id,rake_amount,pot_size,num_players,
       bbj_contribution,is_tournament,tournament_id,source,
       player_contributions,metadata)
    VALUES
      (NULL,NULL,v_t.club_id,v_rake,v_collected,3,0,true,p_tournament_id,
       'fn_spin_book_entry',v_contrib,
       jsonb_build_object(
         'kind','spin_rake','buy_in',v_t.buy_in_amount,
         'rake_rate',v_rake_rate,'booked_at','third_paid_seat',
         'reserve_owner',v_owner,'treasury_credited',false,
         'distributed_by','atomic_distribute_rake',
         'rake_per_player',round(v_rake / 3,4),'seats_attributed',3));
  END IF;

  PERFORM set_config('app.ledger_category','',true);
  PERFORM set_config('app.ledger_counterparty','',true);
  PERFORM set_config('app.ledger_counterparty_entity','',true);
  PERFORM set_config('app.ledger_idempotency_key','',true);

  RETURN jsonb_build_object(
    'ok',true,'reason','booked','collected',v_collected,
    'house_rake',v_rake,'reserve_in',v_reserve_in,'balance',v_balance,
    'owner_id',v_owner,'pool_id',v_pool_id,'seats',3,'paid_users',3,
    'entry_reserve_id',v_reserve.id,'entry_journal_id',v_journal_id);
END;
$spin_entry$;

COMMENT ON FUNCTION public.fn_spin_book_entry(uuid) IS
  'Private paid-third-seat primitive. Books one exact three-user Spin entry and returns its immutable reserve+journal evidence. Errors propagate to the seat transaction; no reconciler is part of this path.';

-- The paid third seat and its reserve contribution are one transaction. The
-- previous body caught a refused/failed fn_spin_book_entry call, committed the
-- seat anyway, and asked a sweep to invent the missing booking later. Only the
-- realtime announcement is presentation and remains best-effort; money errors
-- escape this function and roll the seat transaction back.
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(
  p_tournament_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $seat_count$
DECLARE
  v_table      uuid;
  v_seats      integer := 0;
  v_seat_first boolean := false;
  v_is_spin    boolean := false;
  v_cap        integer := 0;
  v_variant    text := '';
  v_attempt    integer := 0;
  v_book       jsonb;
BEGIN
  SELECT (COALESCE(t.variant, '') IN ('spin', 'sng')
          OR COALESCE(t.max_players, 0) <= 2),
         COALESCE(t.variant, '') = 'spin',
         COALESCE(t.max_players, 0),
         COALESCE(t.variant, '')
    INTO v_seat_first, v_is_spin, v_cap, v_variant
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  <<retry>>
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_table := public.fn_tournament_primary_table(p_tournament_id);

      IF v_table IS NULL THEN
        IF COALESCE(v_seat_first, false) THEN
          SELECT count(*) INTO v_seats
            FROM public.table_seats s
            JOIN public.tables tb ON tb.id = s.table_id
           WHERE tb.tournament_id = p_tournament_id
             AND s.left_at IS NULL;
          UPDATE public.tournaments SET current_players = v_seats
           WHERE id = p_tournament_id
             AND current_players IS DISTINCT FROM v_seats;
          RETURN v_seats;
        END IF;
        RETURN NULL;
      END IF;

      SELECT count(*) INTO v_seats
        FROM public.table_seats
       WHERE table_id = v_table AND left_at IS NULL;

      UPDATE public.tables SET current_players = v_seats
       WHERE id = v_table
         AND current_players IS DISTINCT FROM v_seats;

      IF COALESCE(v_seat_first, false) THEN
        UPDATE public.tournaments SET current_players = v_seats
         WHERE id = p_tournament_id
           AND current_players IS DISTINCT FROM v_seats;
      END IF;

      IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
        v_book := public.fn_spin_book_entry(p_tournament_id);
        IF COALESCE((v_book->>'ok')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'paid third seat could not book Spin %: %',
            p_tournament_id,v_book USING ERRCODE = 'P0404';
        END IF;
      END IF;

      IF COALESCE(v_seat_first, false)
         AND v_cap > 0 AND v_seats >= v_cap THEN
        BEGIN
          PERFORM realtime.send(
            jsonb_build_object(
              'tournament_id', p_tournament_id,
              'variant', v_variant,
              'max_players', v_cap,
              'paid_seats', v_seats,
              'filled_at', now()
            ),
            'seat_first_ready',
            'seat_first',
            false
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING
            'fn_sync_seat_first_player_count: realtime.send failed for %: %',
            p_tournament_id, SQLERRM;
        END;
      END IF;

      RETURN v_seats;
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        IF v_attempt >= 3 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.05 * v_attempt);
    END;
  END LOOP;
END;
$seat_count$;

REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid)
  TO service_role;
COMMENT ON FUNCTION public.fn_sync_seat_first_player_count(uuid) IS
  'Seat-first count sync. A paid third Spin seat books its exact reserve contribution in the same transaction; booking refusal propagates. Realtime announcement alone is best-effort.';

-- A second structural assertion sits on the authoritative reserve receipt.
-- The balance trigger writes chip_ledger first; the operational function then
-- writes spin_reserve_ledger. If either side is absent or disagrees, the latter
-- insert aborts and rolls the entire transaction back.
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
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.kind NOT IN ('contribution','jackpot_draw') THEN
    RETURN NEW;
  END IF;

  IF NEW.buy_in IS NULL OR NEW.buy_in <= 0
     OR NEW.seats IS DISTINCT FROM 3
     OR NEW.amount IS NULL
     OR NEW.amount IS DISTINCT FROM round(NEW.amount,2)
     OR (NEW.kind = 'contribution'
         AND (NEW.house_rake IS NULL
              OR NEW.house_rake < 0
              OR NEW.amount IS DISTINCT FROM
                   round(NEW.buy_in * 3 - NEW.house_rake,2)))
     OR (NEW.kind = 'jackpot_draw'
         AND (NEW.multiplier IS NULL
              OR NEW.multiplier <= 0
              OR round(-NEW.amount,2) IS DISTINCT FROM
                   round(NEW.buy_in * NEW.multiplier,2))) THEN
    RAISE EXCEPTION
      'Spin % row for tournament % violates the exact three-seat funded contract',
      NEW.kind,NEW.tournament_id USING ERRCODE = '23514';
  END IF;

  SELECT p.id INTO v_pool_id
    FROM public.spin_bonus_pools p
   WHERE p.club_id = NEW.club_id;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'Spin reserve row has no pool for owner %', NEW.club_id
      USING ERRCODE = 'P0404';
  END IF;

  v_key := 'spin:' || NEW.tournament_id::text
           || CASE WHEN NEW.kind = 'contribution' THEN ':entry' ELSE ':draw' END;

  SELECT count(*) INTO v_count
    FROM public.chip_ledger l
   WHERE l.category = CASE WHEN NEW.kind = 'contribution'
                           THEN 'spin_entry' ELSE 'spin_prize' END
     AND l.from_type = CASE WHEN NEW.kind = 'contribution'
                            THEN 'prize_liability' ELSE 'spin_reserve' END
     AND l.from_entity_id = CASE WHEN NEW.kind = 'contribution'
                                 THEN NEW.tournament_id ELSE v_pool_id END
     AND l.to_type = CASE WHEN NEW.kind = 'contribution'
                          THEN 'spin_reserve' ELSE 'prize_liability' END
     AND l.to_entity_id = CASE WHEN NEW.kind = 'contribution'
                               THEN v_pool_id ELSE NEW.tournament_id END
     AND l.tournament_id = NEW.tournament_id
     -- Stage 1 is database-first: the still-live old engine does not set the
     -- draw key before calling fn_spin_settle_game. Accept only NULL as its
     -- narrow compatibility shape; any non-NULL key must be the deterministic
     -- key. Stage 2 tightens this after the combined-RPC engine is verified.
     AND (l.idempotency_key = v_key OR l.idempotency_key IS NULL)
     AND l.amount = round(abs(NEW.amount), 2)
     AND CASE WHEN NEW.kind = 'contribution'
              THEN l.post_to_balance IS NOT DISTINCT FROM NEW.balance_after
              ELSE l.post_from_balance IS NOT DISTINCT FROM NEW.balance_after
          END;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Spin % row for tournament % requires one exact journal leg; found %',
      NEW.kind, NEW.tournament_id, v_count USING ERRCODE = 'P0404';
  END IF;
  RETURN NEW;
END;
$reserve_evidence$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_row_requires_exact_journal()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS spin_reserve_row_requires_exact_journal
  ON public.spin_reserve_ledger;
CREATE TRIGGER spin_reserve_row_requires_exact_journal
  BEFORE INSERT ON public.spin_reserve_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_spin_reserve_row_requires_exact_journal();

-- A contribution or draw is a receipt, not mutable state. Cancellation keeps
-- its product lifecycle by appending surplus_return/reversal evidence; it does
-- not rewrite the original draw.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_receipt_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $immutable_reserve$
BEGIN
  IF OLD.kind IN ('contribution','jackpot_draw') THEN
    RAISE EXCEPTION 'Spin reserve receipt % (%) is immutable',OLD.id,OLD.kind
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$immutable_reserve$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_receipt_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS spin_reserve_receipt_is_immutable
  ON public.spin_reserve_ledger;
CREATE TRIGGER spin_reserve_receipt_is_immutable
  BEFORE UPDATE OR DELETE ON public.spin_reserve_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_spin_reserve_receipt_is_immutable();

-- The reserve draw is the immutable money fact; the tournament columns are
-- its published contract. Stage 1 still permits the live old engine's one
-- post-settlement stamp, but only when it makes the row exactly equal to the
-- single draw. Once all three fields are present and coherent, they freeze.
CREATE OR REPLACE FUNCTION public.fn_spin_tournament_contract_is_draw()
RETURNS trigger
LANGUAGE plpgsql
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

  SELECT count(*),min(r.multiplier),min(round(-r.amount,2))
    INTO v_count,v_multiplier,v_prize
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = NEW.id AND r.kind = 'jackpot_draw';
  IF v_count <> 1
     OR NEW.spin_multiplier IS DISTINCT FROM v_multiplier
     OR NEW.prize_pool IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION
      'Spin % tournament contract must equal its one immutable reserve draw',
      NEW.id USING ERRCODE = 'P0404';
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
DROP TRIGGER IF EXISTS spin_tournament_contract_is_draw ON public.tournaments;
CREATE TRIGGER spin_tournament_contract_is_draw
  BEFORE UPDATE OF spin_multiplier,prize_pool,spin_locked_tiers
  ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_spin_tournament_contract_is_draw();

-- One public money authority. It books the paid entry, retains the reserve row
-- lock while drawing, settles that draw, and proves both durable records before
-- returning. The old two-RPC window allowed another Spin to consume the pool
-- between draw and settle and counted the current entry twice when entry had
-- already been booked at the third seat.
CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle(
  p_tournament_id uuid,
  p_tiers jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
SET statement_timeout TO '30s'
AS $spin_authority$
DECLARE
  v_t record;
  v_table_id uuid;
  v_paid_seats integer;
  v_seat_users integer;
  v_paid_users integer;
  v_roster_users integer;
  v_buyin_debits integer;
  v_buyin_total numeric;
  v_book jsonb;
  v_settle jsonb;
  v_owner uuid;
  v_pool_id uuid;
  v_available numeric;
  v_highest_stake numeric;
  v_rake_rate numeric;
  v_reserve_in numeric;
  v_tier jsonb;
  v_multiplier numeric;
  v_frequency numeric;
  v_threshold numeric;
  v_prize numeric;
  v_total numeric := 0;
  v_roll numeric;
  v_acc numeric := 0;
  v_pick numeric := NULL;
  v_eligible jsonb := '[]'::jsonb;
  v_locked jsonb := '[]'::jsonb;
  v_seen numeric[] := ARRAY[]::numeric[];
  v_booked_multiplier numeric;
  v_booked_draw numeric;
  v_leg_count integer;
  v_draw_existed boolean := false;
  v_entry_reserve_id uuid;
  v_entry_journal_id uuid;
  v_draw_reserve_id uuid;
  v_draw_journal_id uuid;
  v_escrow_reserve_out numeric;
  v_escrow_reserve_in numeric;
  v_escrow_prize_balance numeric;
  v_row_count integer;
  v_draw_key text := 'spin:' || p_tournament_id::text || ':draw';
BEGIN
  IF p_tournament_id IS NULL
     OR p_tiers IS NULL
     OR jsonb_typeof(p_tiers) <> 'array'
     OR jsonb_array_length(p_tiers) = 0 THEN
    RAISE EXCEPTION 'Spin draw-and-settle requires a tournament and tier array'
      USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant,
         t.tournament_type, t.status, t.spin_multiplier, t.prize_pool,
         t.spin_locked_tiers
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Spin tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) <> 'spin'
     AND upper(COALESCE(v_t.tournament_type,'')) <> 'SPIN' THEN
    RAISE EXCEPTION 'tournament % is not a Spin', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_t.club_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = '00000000-0000-0000-0000-000000000000'::uuid
     OR COALESCE(v_t.buy_in_amount,0) <= 0
     OR COALESCE(v_t.max_players,0) <> 3 THEN
    RAISE EXCEPTION 'Spin % has invalid club, buy-in or seat contract',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    RAISE EXCEPTION 'Spin % cannot draw from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;

  v_table_id := public.fn_tournament_primary_table(p_tournament_id);
  SELECT count(*), count(DISTINCT s.user_id)
    INTO v_paid_seats, v_seat_users
    FROM public.table_seats s
   WHERE s.table_id = v_table_id AND s.left_at IS NULL;
  SELECT count(DISTINCT tp.user_id) INTO v_roster_users
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_paid_users
    FROM (
      SELECT tp.user_id
        FROM public.tournament_players tp
        JOIN public.wallet_transactions w
          ON w.related_entity_id = tp.tournament_id
         AND w.user_id = tp.user_id
         AND w.type = 'debit'
         AND w.category = 'tournament_buyin'
       WHERE tp.tournament_id = p_tournament_id
       GROUP BY tp.user_id
      HAVING round(sum(w.amount),2) = round(v_t.buy_in_amount,2)
    ) paid;
  SELECT count(*), round(COALESCE(sum(w.amount),0),2)
    INTO v_buyin_debits,v_buyin_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit'
     AND w.category = 'tournament_buyin';
  IF v_table_id IS NULL OR v_paid_seats <> 3 OR v_seat_users <> 3
     OR v_roster_users <> 3
     OR v_paid_users <> 3
     OR v_buyin_debits <> 3
     OR v_buyin_total <> round(v_t.buy_in_amount * 3,2)
     OR EXISTS (
       SELECT 1
         FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats s
             WHERE s.table_id = v_table_id
               AND s.left_at IS NULL
               AND s.user_id = tp.user_id
          )
     ) THEN
    RAISE EXCEPTION
      'Spin % is not exactly three paid rostered seats (% seats, % seat users, % roster users, % paid users, % debits, % total)',
      p_tournament_id, v_paid_seats, v_seat_users, v_roster_users, v_paid_users,
      v_buyin_debits,v_buyin_total
      USING ERRCODE = '55000';
  END IF;

  -- fn_spin_book_entry owns the escrow -> advisory -> reserve lock order. The
  -- outer transaction retains every lock it takes through the draw below.
  v_book := public.fn_spin_book_entry(p_tournament_id);
  IF COALESCE((v_book->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Spin % entry booking refused: %', p_tournament_id, v_book
      USING ERRCODE = 'P0404';
  END IF;
  BEGIN
    v_entry_reserve_id := (v_book->>'entry_reserve_id')::uuid;
    v_entry_journal_id := (v_book->>'entry_journal_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Spin % entry returned no immutable evidence ids: %',
      p_tournament_id,v_book USING ERRCODE = 'P0404';
  END;

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  SELECT p.id, p.balance, GREATEST(p.highest_stake, v_t.buy_in_amount)
    INTO v_pool_id, v_available, v_highest_stake
    FROM public.spin_bonus_pools p
   WHERE p.club_id = v_owner
   FOR UPDATE;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'Spin % reserve pool is missing', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  v_rake_rate := public.fn_spin_rake_rate(v_t.buy_in_amount);
  v_reserve_in := round(v_t.buy_in_amount * 3 * (1 - v_rake_rate), 2);
  IF NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.tournament_id = p_tournament_id
          AND r.kind = 'contribution'
          AND r.club_id = v_owner
          AND r.amount = v_reserve_in
     )
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.category = 'spin_entry'
            AND l.from_type = 'prize_liability'
            AND l.from_entity_id = p_tournament_id
            AND l.to_type = 'spin_reserve'
            AND l.to_entity_id = v_pool_id
            AND l.amount = v_reserve_in) <> 1 THEN
    RAISE EXCEPTION 'Spin % entry did not produce exact reserve evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT r.multiplier, round(-r.amount,2)
    INTO v_booked_multiplier, v_booked_draw
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id AND r.kind = 'jackpot_draw'
   ORDER BY r.created_at, r.id
   LIMIT 1;
  v_draw_existed := v_booked_multiplier IS NOT NULL;

  IF v_booked_multiplier IS NULL THEN
    IF COALESCE(v_t.spin_multiplier,0) > 0 THEN
      RAISE EXCEPTION
        'Spin % row carries multiplier % without an authoritative reserve draw',
        p_tournament_id, v_t.spin_multiplier USING ERRCODE = 'P0404';
    END IF;

    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) LOOP
      BEGIN
        v_multiplier := (v_tier->>'multiplier')::numeric;
        v_frequency := (v_tier->>'freq')::numeric;
        v_threshold := COALESCE((v_tier->>'reserveThresholdX')::numeric,0);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Spin % tier is not numeric: %',
          p_tournament_id, v_tier USING ERRCODE = '22023';
      END;
      IF v_multiplier IS NULL OR v_multiplier <= 0
         OR v_frequency IS NULL OR v_frequency < 0
         OR v_threshold < 0
         OR v_multiplier = ANY(v_seen) THEN
        RAISE EXCEPTION 'Spin % tier is invalid or duplicated: %',
          p_tournament_id, v_tier USING ERRCODE = '23514';
      END IF;
      v_seen := array_append(v_seen, v_multiplier);
      v_prize := round(v_t.buy_in_amount * v_multiplier, 2);

      -- v_available already includes this event's contribution. The retired
      -- draw RPC added v_reserve_in a second time whenever entry was booked.
      IF v_available < v_prize THEN
        v_locked := v_locked || jsonb_build_object(
          'multiplier',v_multiplier,'reason','unaffordable',
          'unlocksAt',round(v_prize,2));
      ELSIF v_threshold > 0
            AND v_available < v_multiplier * v_highest_stake * v_threshold THEN
        v_locked := v_locked || jsonb_build_object(
          'multiplier',v_multiplier,'reason','threshold',
          'unlocksAt',round(v_multiplier * v_highest_stake * v_threshold,2));
      ELSE
        v_eligible := v_eligible || v_tier;
        v_total := v_total + v_frequency;
      END IF;
    END LOOP;

    IF v_total <= 0 OR jsonb_array_length(v_eligible) = 0 THEN
      RAISE EXCEPTION 'Spin % has no eligible funded tier at reserve %',
        p_tournament_id, v_available USING ERRCODE = '55000';
    END IF;

    v_roll := (('x' || encode(extensions.gen_random_bytes(6),'hex'))::bit(48)::bigint)::numeric
              / 281474976710656::numeric * v_total;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(v_eligible) LOOP
      v_acc := v_acc + (v_tier->>'freq')::numeric;
      IF v_roll < v_acc THEN
        v_pick := (v_tier->>'multiplier')::numeric;
        EXIT;
      END IF;
    END LOOP;
    IF v_pick IS NULL THEN
      v_pick := (v_eligible -> (jsonb_array_length(v_eligible)-1)
                            ->> 'multiplier')::numeric;
    END IF;

    PERFORM set_config('app.ledger_idempotency_key',v_draw_key,true);
    v_settle := public.fn_spin_settle_game(
      p_tournament_id, v_t.club_id, v_t.buy_in_amount, 3,
      v_pick, v_rake_rate);
    PERFORM set_config('app.ledger_idempotency_key','',true);
    v_booked_multiplier := v_pick;
    v_booked_draw := round(v_t.buy_in_amount * v_pick,2);
  ELSE
    -- The lower-level primitive returns and verifies the immutable booked
    -- truth; it never draws again on a retry.
    PERFORM set_config('app.ledger_idempotency_key',v_draw_key,true);
    v_settle := public.fn_spin_settle_game(
      p_tournament_id, v_t.club_id, v_t.buy_in_amount, 3,
      v_booked_multiplier, v_rake_rate);
    PERFORM set_config('app.ledger_idempotency_key','',true);
    v_locked := COALESCE(v_t.spin_locked_tiers,'[]'::jsonb);
  END IF;

  IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
     OR (v_settle->>'multiplier') IS NOT NULL
        AND (v_settle->>'multiplier')::numeric <> v_booked_multiplier
     OR COALESCE((v_settle->>'pool_covered')::numeric,0) <> v_booked_draw
     OR COALESCE((v_settle->>'operator_shortfall')::numeric,0) <> 0 THEN
    RAISE EXCEPTION 'Spin % did not settle its exact funded draw: %',
      p_tournament_id, v_settle USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), (array_agg(r.id ORDER BY r.created_at,r.id))[1]
    INTO v_row_count,v_draw_reserve_id
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id = p_tournament_id
     AND r.kind = 'jackpot_draw'
     AND r.club_id = v_owner
     AND r.multiplier = v_booked_multiplier
     AND r.buy_in = v_t.buy_in_amount
     AND r.seats = 3
     AND round(-r.amount,2) = v_booked_draw;
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'Spin % draw evidence is not exact after settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), (array_agg(l.id ORDER BY l.created_at,l.id))[1]
    INTO v_leg_count,v_draw_journal_id
    FROM public.chip_ledger l
    JOIN public.spin_reserve_ledger r ON r.id = v_draw_reserve_id
   WHERE l.category = 'spin_prize'
     AND l.from_type = 'spin_reserve'
     AND l.from_entity_id = v_pool_id
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.tournament_id = p_tournament_id
     AND l.amount = v_booked_draw
     AND l.post_from_balance IS NOT DISTINCT FROM r.balance_after
     AND (v_draw_existed OR l.idempotency_key = v_draw_key);
  IF v_leg_count <> 1 THEN
    RAISE EXCEPTION 'Spin % draw has % exact journal legs',
      p_tournament_id,v_leg_count USING ERRCODE = 'P0404';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.id = v_entry_reserve_id
          AND r.tournament_id = p_tournament_id
          AND r.kind = 'contribution'
          AND r.club_id = v_owner
          AND r.amount = v_reserve_in)
     OR NOT EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.id = v_entry_journal_id
          AND l.tournament_id = p_tournament_id
          AND l.category = 'spin_entry'
          AND l.amount = v_reserve_in) THEN
    RAISE EXCEPTION 'Spin % entry receipt ids do not resolve to exact evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT e.reserve_out,e.reserve_in,e.prize_balance
    INTO v_escrow_reserve_out,v_escrow_reserve_in,v_escrow_prize_balance
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_escrow_reserve_out IS DISTINCT FROM v_reserve_in
     OR v_escrow_reserve_in IS DISTINCT FROM v_booked_draw
     OR v_escrow_prize_balance IS DISTINCT FROM v_booked_draw THEN
    RAISE EXCEPTION
      'Spin % escrow does not equal entry %, draw % (out %, in %, prize %)',
      p_tournament_id,v_reserve_in,v_booked_draw,
      v_escrow_reserve_out,v_escrow_reserve_in,v_escrow_prize_balance
      USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.spin_multiplier,0) > 0
     AND v_t.spin_multiplier IS DISTINCT FROM v_booked_multiplier THEN
    RAISE EXCEPTION 'Spin % row multiplier % disagrees with immutable draw %',
      p_tournament_id,v_t.spin_multiplier,v_booked_multiplier
      USING ERRCODE = 'P0404';
  END IF;
  IF COALESCE(v_t.spin_multiplier,0) > 0
     AND v_t.prize_pool IS DISTINCT FROM v_booked_draw THEN
    RAISE EXCEPTION 'Spin % row prize pool % disagrees with immutable draw %',
      p_tournament_id,v_t.prize_pool,v_booked_draw USING ERRCODE = 'P0404';
  END IF;

  -- Stage 2 keys the immutable tournament-contract trigger to this authority.
  -- Stage 1 does not require the marker yet because the still-live old engine
  -- must be able to finish its database-first rolling cutover.
  PERFORM set_config(
    'app.spin_settlement_authority',p_tournament_id::text,true);
  UPDATE public.tournaments
     SET spin_multiplier = v_booked_multiplier,
         prize_pool = v_booked_draw,
         spin_locked_tiers = v_locked
   WHERE id = p_tournament_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  PERFORM set_config('app.spin_settlement_authority','',true);
  IF v_row_count <> 1 THEN
    RAISE EXCEPTION 'Spin % tournament contract could not be stamped',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT p.balance INTO v_available
    FROM public.spin_bonus_pools p WHERE p.id = v_pool_id;

  RETURN v_settle || jsonb_build_object(
    'ok',true,
    'money_path','fn_spin_draw_and_settle',
    'tournament_id',p_tournament_id,
    'seats',3,
    'paid_users',v_paid_users,
    'multiplier',v_booked_multiplier,
    'prize_pool',v_booked_draw,
    'pool_covered',v_booked_draw,
    'operator_shortfall',0,
    'draw_amount',v_booked_draw,
    'entry_amount',v_reserve_in,
    'reserve_in',v_reserve_in,
    'house_rake',round(v_t.buy_in_amount * 3 * v_rake_rate,2),
    'reserve_balance',v_available,
    'pool_id',v_pool_id,
    'entry_reserve_id',v_entry_reserve_id,
    'entry_journal_id',v_entry_journal_id,
    'draw_reserve_id',v_draw_reserve_id,
    'draw_journal_id',v_draw_journal_id,
    'escrow_reserve_out',v_escrow_reserve_out,
    'escrow_reserve_in',v_escrow_reserve_in,
    'escrow_prize_balance',v_escrow_prize_balance,
    'tournament_multiplier',v_booked_multiplier,
    'tournament_prize_pool',v_booked_draw,
    'locked',v_locked,
    'eligible_count',jsonb_array_length(v_eligible),
    'owner_id',v_owner);
END;
$spin_authority$;

REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb)
  TO service_role;

-- Exact historical correction: this completed 3x Spin debited the reserve and
-- wrote its immutable draw row, but the strict journal leg never landed. Put
-- that already-moved 3.00 into this event's escrow, then pay the already-owed
-- winner only through the owner-only raw cash authority. Every observed fact
-- is asserted first; an unexpected or partially repaired shape aborts.
DO $repair_781cc0ee$
DECLARE
  v_tid constant uuid := '781cc0ee-6a1d-4e31-acaf-4e737661bba1';
  v_winner constant uuid := 'c402b38e-7ba6-40bf-a2d3-d65376d28ccf';
  v_entry_id constant uuid := 'f5e018ab-d15d-4d6c-bda0-270e97daf8eb';
  v_draw_id constant uuid := 'd6eba15c-04b2-47f2-a168-731d4f433696';
  v_obligation_id constant uuid := 'd367f526-d950-4b4a-af4d-07793000d7c6';
  v_expected_pool constant uuid := '2d968239-acdd-4a2c-99f2-a369ff37ae31';
  v_club uuid;
  v_owner uuid;
  v_pool_id uuid;
  v_balance_after numeric;
  v_journals integer;
  v_suspense integer;
  v_paid numeric;
  v_wallet_before numeric;
  v_wallet_after numeric;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_tid) THEN
    RETURN; -- clean replay has no production incident row
  END IF;

  PERFORM 1 FROM public.tournaments WHERE id = v_tid FOR UPDATE;
  IF (SELECT count(*) FROM public.tournaments t
       WHERE t.id = v_tid
         AND lower(COALESCE(t.variant,'')) = 'spin'
         AND upper(COALESCE(t.status::text,'')) = 'COMPLETED'
         AND t.buy_in_amount = 1
         AND t.max_players = 3
         AND t.spin_multiplier = 3
         AND t.prize_pool = 3) <> 1
     OR (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = v_tid) <> 3
     OR (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id = v_tid AND tp.user_id = v_winner
            AND tp.position = 1 AND tp.prize = 3) <> 1
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'debit'
            AND w.category = 'tournament_buyin') <> 3
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'debit'
            AND w.category = 'tournament_buyin') <> 3 THEN
    RAISE EXCEPTION 'Spin % no longer has the asserted three-seat 3x contract',v_tid;
  END IF;

  SELECT t.club_id,r.club_id,p.id,r.balance_after
    INTO v_club,v_owner,v_pool_id,v_balance_after
    FROM public.tournaments t
    JOIN public.spin_reserve_ledger r ON r.id = v_draw_id
    JOIN public.spin_bonus_pools p ON p.club_id = r.club_id
   WHERE t.id = v_tid
     AND r.tournament_id = v_tid
     AND r.kind = 'jackpot_draw'
     AND r.amount = -3
     AND r.multiplier = 3
     AND r.buy_in = 1
     AND r.seats = 3;
  IF NOT FOUND OR v_pool_id IS DISTINCT FROM v_expected_pool
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.tournament_id = v_tid AND r.kind = 'jackpot_draw') <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.id = v_entry_id AND r.tournament_id = v_tid
            AND r.kind = 'contribution' AND r.club_id = v_owner
            AND r.amount = 2.76 AND r.buy_in = 1 AND r.seats = 3
            AND r.house_rake = 0.24) <> 1 THEN
    RAISE EXCEPTION 'Spin % reserve evidence moved since the incident probe',v_tid;
  END IF;

  SELECT count(*) INTO v_journals
    FROM public.chip_ledger l
   WHERE l.category = 'spin_prize'
     AND l.from_type = 'spin_reserve' AND l.from_entity_id = v_pool_id
     AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tid
     AND l.tournament_id = v_tid AND l.amount = 3;
  SELECT count(*) INTO v_suspense
    FROM public.chip_ledger l
   WHERE l.category = 'adjustment'
     AND l.from_type = 'spin_reserve' AND l.from_entity_id = v_pool_id
     AND l.to_type = 'settlement_suspense' AND l.amount = 3
     AND l.post_from_balance IS NOT DISTINCT FROM v_balance_after;
  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_paid
    FROM public.tournament_payouts p WHERE p.tournament_id = v_tid;

  IF v_journals = 0 THEN
    IF v_suspense <> 0 OR v_paid <> 0
       OR (SELECT count(*) FROM public.tournament_obligations o
            WHERE o.id = v_obligation_id AND o.tournament_id = v_tid
              AND o.kind = 'place' AND o.place = 1 AND o.user_id = v_winner
              AND o.amount_owed = 3 AND o.amount_paid = 0) <> 1
       OR (SELECT count(*) FROM public.tournament_escrow e
            WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
              AND e.reserve_in = 0 AND e.prize_out = 0
              AND e.prize_balance = 0) <> 1 THEN
      RAISE EXCEPTION 'Spin % is not in the exact unpaid/missing-journal state',v_tid;
    END IF;

    SELECT cm.chip_balance INTO v_wallet_before
      FROM public.club_members cm
     WHERE cm.club_id = v_club AND cm.user_id = v_winner
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % winner wallet is missing',v_tid;
    END IF;

    INSERT INTO public.chip_ledger
      (performed_by,from_type,from_entity_id,from_label,
       to_type,to_entity_id,to_label,amount,category,club_id,
       description,pre_from_balance,post_from_balance,tournament_id,
       idempotency_key,metadata)
    VALUES
      ('2d1cd6c3-5700-4af9-a271-d4863fdab20d',
       'spin_reserve',v_pool_id,'spin_bonus_pools.balance',
       'prize_liability',v_tid,'tournaments.prize_pool',3,'spin_prize',v_club,
       'Authoritative missing Spin draw journal for 781cc0ee; reserve row d6eba15c already moved exactly 3.00 and no suspense leg or payout existed.',
       v_balance_after + 3,v_balance_after,v_tid,
       'spin:' || v_tid::text || ':draw',
       jsonb_build_object('migration','20260908032728',
                          'reserve_draw_id',v_draw_id,
                          'historical_correction',true));

    IF (SELECT count(*) FROM public.chip_ledger l
         WHERE l.idempotency_key = 'spin:' || v_tid::text || ':draw'
           AND l.category = 'spin_prize' AND l.amount = 3
           AND l.from_entity_id = v_pool_id AND l.to_entity_id = v_tid) <> 1
       OR (SELECT count(*) FROM public.tournament_escrow e
            WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
              AND e.reserve_in = 3 AND e.prize_out = 0
              AND e.prize_balance = 3) <> 1 THEN
      RAISE EXCEPTION 'Spin % journal did not fund its escrow atomically',v_tid;
    END IF;

    v_result := public.fn_ca_settle_tournament_place_raw(v_tid,1,v_winner,3);
    IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Spin % winner did not settle in full: %',v_tid,v_result;
    END IF;
    SELECT cm.chip_balance INTO v_wallet_after
      FROM public.club_members cm
     WHERE cm.club_id = v_club AND cm.user_id = v_winner;
    IF v_wallet_after - v_wallet_before <> 3 THEN
      RAISE EXCEPTION 'Spin % winner received %, expected 3',
        v_tid,v_wallet_after-v_wallet_before;
    END IF;
  ELSIF v_journals <> 1 OR v_suspense <> 0 OR v_paid <> 3 THEN
    RAISE EXCEPTION 'Spin % has an unexpected partial/duplicate correction',v_tid;
  END IF;

  IF (SELECT count(*) FROM public.tournament_payouts p
       WHERE p.tournament_id = v_tid AND p.user_id = v_winner
         AND p."position" = 1 AND p.amount = 3) <> 1
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.id = v_obligation_id AND o.tournament_id = v_tid
            AND o.user_id = v_winner AND o.kind = 'place' AND o.place = 1
            AND o.amount_owed = 3 AND o.amount_paid = 3
            AND o.settled_at IS NOT NULL) <> 1
     OR (SELECT count(*) FROM public.tournament_escrow e
          WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
            AND e.reserve_in = 3 AND e.prize_out = 3
            AND e.prize_balance = 0) <> 1 THEN
    RAISE EXCEPTION 'Spin % did not finish with one exact paid receipt',v_tid;
  END IF;
END;
$repair_781cc0ee$;

-- Exact historical acceptance: this legacy 10x event paid 10.00 in total
-- against an immutable 10.00 reserve draw while tournaments.prize_pool still
-- said 3.00. The 9.40 winner payment and 0.60 runner-up payment are accepted;
-- no clawback and no additional 0.60 payment. Normalize only the stale winner
-- obligation and close every alert/incident for this known shape.
DO $accept_6d688095$
DECLARE
  v_tid constant uuid := '6d688095-c3c5-4d40-a5a0-952934667732';
  v_actual_winner uuid;
  v_actual_runner uuid;
  v_total_before numeric;
  v_wallet_before numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_tid) THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.tournaments WHERE id = v_tid FOR UPDATE;
  SELECT tp.user_id INTO v_actual_winner FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tid AND tp.position = 1;
  SELECT tp.user_id INTO v_actual_runner FROM public.tournament_players tp
   WHERE tp.tournament_id = v_tid AND tp.position = 2;
  -- Full ids are intentionally read from the immutable finish rows; the
  -- incident handoff carried their prefixes only. Refuse any different payout
  -- shape rather than inventing the suffixes in a data migration.
  IF v_actual_winner::text NOT LIKE 'a70a0d4c-%'
     OR v_actual_runner::text NOT LIKE 'bbcaaed4-%'
     OR (SELECT count(*) FROM public.tournaments t
          WHERE t.id = v_tid AND lower(COALESCE(t.variant,'')) = 'spin'
            AND upper(COALESCE(t.status::text,'')) = 'COMPLETED'
            AND t.buy_in_amount = 1 AND t.max_players = 3
            AND t.spin_multiplier = 10 AND t.prize_pool = 3) <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.tournament_id = v_tid AND r.kind = 'contribution'
            AND r.amount = 2.76 AND r.buy_in = 1 AND r.seats = 3
            AND r.house_rake = 0.24) <> 1
     OR (SELECT count(*) FROM public.spin_reserve_ledger r
          WHERE r.tournament_id = v_tid AND r.kind = 'jackpot_draw'
            AND r.amount = -10 AND r.multiplier = 10
            AND r.buy_in = 1 AND r.seats = 3) <> 1
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.tournament_id = v_tid AND l.category = 'spin_prize'
            AND l.from_type = 'spin_reserve'
            AND l.to_type = 'prize_liability' AND l.to_entity_id = v_tid
            AND l.amount = 10) <> 1
     OR (SELECT count(*) FROM public.tournament_escrow e
          WHERE e.tournament_id = v_tid AND e.reserve_out = 2.76
            AND e.reserve_in = 10 AND e.prize_out = 10
            AND e.prize_balance = 0) <> 1 THEN
    RAISE EXCEPTION 'Spin % no longer matches the accepted legacy 10x evidence',v_tid;
  END IF;

  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_total_before
    FROM public.tournament_payouts p WHERE p.tournament_id = v_tid;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = v_tid AND w.type = 'credit'
     AND w.category = 'prize';
  IF v_total_before <> 10 OR v_wallet_before <> 10
     OR (SELECT round(COALESCE(sum(p.amount),0),2)
           FROM public.tournament_payouts p
          WHERE p.tournament_id = v_tid AND p.user_id = v_actual_winner) <> 9.40
     OR (SELECT round(COALESCE(sum(p.amount),0),2)
           FROM public.tournament_payouts p
          WHERE p.tournament_id = v_tid AND p.user_id = v_actual_runner) <> 0.60
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 1
            AND o.user_id = v_actual_winner AND o.amount_paid = 9.40
            AND o.amount_owed IN (9.40,10.00)) <> 1
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 2
            AND o.user_id = v_actual_runner AND o.amount_paid = 0.60
            AND o.amount_owed = 0.60) <> 1 THEN
    RAISE EXCEPTION 'Spin % payout/obligation evidence moved; no automatic action is safe',v_tid;
  END IF;

  UPDATE public.tournament_obligations o
     SET amount_owed = 9.40,
         amount_paid = 9.40,
         source = 'accepted_historical_spin_overpayment_no_clawback',
         settled_at = COALESCE(o.settled_at,now()),
         updated_at = now()
   WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 1
     AND o.user_id = v_actual_winner AND o.amount_paid = 9.40
     AND o.amount_owed IN (9.40,10.00);

  UPDATE public.financial_alerts f
     SET resolved = true,
         resolved_at = COALESCE(f.resolved_at,now()),
         resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','')
           || 'Accepted historical Spin payout: immutable reserve draw and total payout are both 10.00. Legacy prize_pool remained 3.00; winner 9.40 plus runner-up 0.60 is final. No clawback and no further 0.60 payment. Root fixed by fn_spin_draw_and_settle (20260908032728).'
   WHERE f.context->>'tournament_id' = v_tid::text
      OR f.context#>>'{rows,0,tournament_id}' = v_tid::text
      OR f.message ILIKE '%' || v_tid::text || '%'
      OR f.message ILIKE '%6d688095%';

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved',
         resolved_at = COALESCE(i.resolved_at,now()),
         auto_repair_status = 'not_applicable',
         root_cause = 'Legacy Spin row retained prize_pool 3.00 after an exact 10.00 reserve draw and 10.00 total payout.',
         correction_ref = '20260908032728:accepted-no-clawback-no-further-payment',
         resolution = 'Accepted historical payout; no chips moved. Winner obligation normalized from 10.00 owed / 9.40 paid to its final 9.40 receipt; runner-up remains paid 0.60.'
   WHERE i.tournament_id = v_tid
      OR i.metadata->>'tournament_id' = v_tid::text;

  IF (SELECT round(COALESCE(sum(p.amount),0),2)
        FROM public.tournament_payouts p WHERE p.tournament_id = v_tid)
       IS DISTINCT FROM v_total_before
     OR (SELECT round(COALESCE(sum(w.amount),0),2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tid AND w.type = 'credit'
            AND w.category = 'prize') IS DISTINCT FROM v_wallet_before
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.place = 1
            AND o.user_id = v_actual_winner AND o.amount_owed = 9.40
            AND o.amount_paid = 9.40 AND o.settled_at IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'Spin % acceptance moved chips or left a stale obligation',v_tid;
  END IF;
END;
$accept_6d688095$;

-- ROLLING CUTOVER, STAGE 1. The database migration lands before the new
-- server. Keep the old engine's three service-role RPC grants intact until
-- that server has published, called the combined authority successfully and
-- been independently verified. The separable stage-2 migration owns every
-- revocation, function drop and cron retirement. Browser roles remain barred.
REVOKE ALL ON FUNCTION public.fn_spin_draw_multiplier(
  uuid,numeric,jsonb,numeric,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(
  uuid,uuid,numeric,integer,numeric,numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_book_entry(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_multiplier(
  uuid,numeric,jsonb,numeric,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(
  uuid,uuid,numeric,integer,numeric,numeric)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_spin_book_entry(uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_spin_draw_and_settle(uuid,jsonb) IS
  'Sole service-role Spin draw/settlement authority. Verifies three paid seats, books entry, draws against the locked real reserve, settles, and proves reserve+journal evidence in one transaction.';
COMMENT ON FUNCTION public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer) IS
  'Stage-1 rolling compatibility door for the live old engine. Retired and dropped only by the post-publish stage-2 Spin cleanup.';
COMMENT ON FUNCTION public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric) IS
  'Stage-1 rolling compatibility door and raw primitive beneath fn_spin_draw_and_settle. Becomes owner-only in post-publish stage 2.';
COMMENT ON FUNCTION public.fn_spin_book_entry(uuid) IS
  'Stage-1 rolling compatibility door and paid-third-seat primitive. Becomes owner-only in post-publish stage 2.';

INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
  ('fn_spin_draw_and_settle','approved',
   'Sole service-role Spin draw and reserve settlement authority; one locked transaction and exact receipt.'),
  ('fn_spin_draw_multiplier','legacy',
   'Stage-1 rolling compatibility only; stage 2 drops it after combined-RPC engine verification.'),
  ('fn_spin_settle_game','approved',
   'Stage-1 compatibility plus raw primitive beneath fn_spin_draw_and_settle; stage 2 makes it owner-only.'),
  ('fn_spin_book_entry','approved',
   'Stage-1 compatibility plus raw entry primitive beneath the database full-seat hook and fn_spin_draw_and_settle; stage 2 makes it owner-only.')
ON CONFLICT (proname) DO UPDATE
  SET status = EXCLUDED.status, notes = EXCLUDED.notes;

DO $verify_authority$
DECLARE
  v_source text;
BEGIN
  IF (SELECT count(*)
        FROM public.tournament_spin_settlement_cutover c
       WHERE c.authority = 'fn_spin_draw_and_settle:v1'
         AND c.migration_version = '20260908032728'
         AND c.installed_at = transaction_timestamp()
         AND c.audited_tournament_ids <@ ARRAY[
           '781cc0ee-6a1d-4e31-acaf-4e737661bba1'::uuid,
           '6d688095-c3c5-4d40-a5a0-952934667732'::uuid
         ]) <> 1
     OR has_table_privilege(
          'service_role','public.tournament_spin_settlement_cutover','SELECT') THEN
    RAISE EXCEPTION 'atomic Spin cutover watermark is missing or exposed';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_spin_draw_and_settle(uuid,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_spin_draw_and_settle(uuid,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_spin_draw_and_settle(uuid,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'atomic Spin authority has unsafe ACLs';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_spin_book_entry(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'stage-1 rolling compatibility was revoked before server publish';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.fn_spin_draw_and_settle(uuid,jsonb)'::regprocedure;
  IF v_source NOT LIKE '%fn_spin_book_entry%'
     OR v_source NOT LIKE '%FOR UPDATE%'
     OR v_source NOT LIKE '%fn_spin_settle_game%'
     OR v_source NOT LIKE '%operator_shortfall%'
     OR v_source ~* 'EXCEPTION[[:space:]]+WHEN[[:space:]]+OTHERS[[:space:]]+THEN[[:space:]]+NULL([[:space:]]|;)'
     OR v_source LIKE '%v_available + v_reserve_in%' THEN
    RAISE EXCEPTION 'atomic Spin authority lost a required invariant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
     WHERE tr.tgrelid = 'public.spin_reserve_ledger'::regclass
       AND tr.tgname = 'spin_reserve_row_requires_exact_journal'
       AND NOT tr.tgisinternal AND tr.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Spin reserve exact-journal trigger is not armed';
  END IF;
  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.fn_sync_seat_first_player_count(uuid)'::regprocedure;
  IF v_source NOT LIKE '%v_book := public.fn_spin_book_entry%'
     OR v_source NOT LIKE '%paid third seat could not book Spin%'
     OR v_source LIKE '%spin_entry_refused:%'
     OR v_source LIKE '%spin_entry_threw:%' THEN
    RAISE EXCEPTION 'paid-third-seat booking still catches and continues';
  END IF;
END;
$verify_authority$;

COMMIT;
