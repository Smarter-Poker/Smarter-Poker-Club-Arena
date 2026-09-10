-- 20260909014457_four_full_pool_events_retire_only_their_stale_obligation_meta.sql
-- Four completed tournaments already distributed every chip in their locked
-- prize pools. Legacy repair arithmetic nevertheless left four place
-- obligations above the amount each finisher actually received: three
-- historical rounding tails and one final-table deal that superseded the
-- normal ladder.
--
-- Paying any of these rows would mint a second prize or debit a house bank.
-- This migration proves the immutable payout and wallet evidence first,
-- records exactly what metadata was retired, and then closes only alerts that
-- name one of these four obligation ids. It never writes a wallet, payout,
-- escrow, chip-ledger, rake, or bank row.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- Retirement is metadata-only, but its proof reads and locks live tournament
-- money evidence before changing the named obligation and incident rows. Join
-- the same terminal and entry-maintenance roots as every stage-one settlement
-- cutover before creating the receipt relation or reading historical state.
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);

-- The freeze predicate is executable cutover authority, not a name to trust.
-- Authenticate its exact body and the statement trigger that serializes every
-- maintenance-row writer before using either the live or pristine branch.
DO $authenticate_entry_freeze_authority$
DECLARE
  v_break_relation oid := to_regclass('public.engine_maintenance_break');
  v_predicate oid := to_regprocedure('public.fn_entry_purchases_frozen()');
  v_writer oid :=
    to_regprocedure('public.fn_serialize_engine_maintenance_break_write()');
  v_relation_owner oid;
BEGIN
  IF v_break_relation IS NULL OR v_predicate IS NULL OR v_writer IS NULL THEN
    RAISE EXCEPTION 'canonical maintenance entry-freeze authority is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relowner INTO STRICT v_relation_owner
    FROM pg_class c WHERE c.oid = v_break_relation;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_predicate
       AND md5(p.prosrc) = 'a29498531e4b7d3889532e80fafc8d57'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'boolean'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'sql'
  ) THEN
    RAISE EXCEPTION 'maintenance entry-freeze predicate is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_writer
       AND md5(p.prosrc) = '084ed24f99e9d08765bd86ff8b920284'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'trigger'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'maintenance-row serialization function is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid = v_break_relation
       AND tg.tgname = 'aa_serialize_maintenance_break_write'
       AND tg.tgfoid = v_writer
       AND NOT tg.tgisinternal
       AND tg.tgenabled = 'O'
       AND tg.tgtype = 62
       AND tg.tgattr::text = ''
       AND tg.tgqual IS NULL
       AND tg.tgnargs = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'maintenance-row serialization trigger is not canonical and enabled'
      USING ERRCODE = '55000';
  END IF;
END;
$authenticate_entry_freeze_authority$;

-- A source-controlled empty database has no engine that can publish a freeze.
-- Exempt only that exact pristine shape. A database with any account, club,
-- tournament, table, journal leg or ticket is live-shaped and must fail closed
-- unless entry purchases are inside the serialized maintenance freeze.
DO $require_live_obligation_retirement_freeze$
DECLARE
  v_database_is_pristine boolean;
BEGIN
  IF to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL THEN
    RAISE EXCEPTION
      'obligation retirement requires the serialized maintenance predicate first';
  END IF;

  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) INTO v_database_is_pristine;

  IF NOT v_database_is_pristine
     AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'obligation retirement live cutover requires the maintenance entry freeze'
      USING ERRCODE = '55006';
  END IF;
END;
$require_live_obligation_retirement_freeze$;

CREATE TABLE IF NOT EXISTS public.tournament_obligation_retirements (
  obligation_id              uuid PRIMARY KEY
                                  REFERENCES public.tournament_obligations(id)
                                  ON DELETE RESTRICT,
  tournament_id              uuid NOT NULL
                                  REFERENCES public.tournaments(id)
                                  ON DELETE RESTRICT,
  user_id                    uuid NOT NULL,
  kind                       text NOT NULL,
  place                      integer,
  original_amount_owed       numeric(15,2) NOT NULL,
  original_amount_paid       numeric(15,2) NOT NULL,
  retired_unfunded_amount    numeric(15,2) NOT NULL
                                  CHECK (retired_unfunded_amount > 0),
  locked_pool                numeric(15,2) NOT NULL,
  payout_total_before        numeric(15,2) NOT NULL,
  wallet_prize_total_before  numeric(15,2) NOT NULL,
  user_payout_total_before   numeric(15,2) NOT NULL,
  reason                     text NOT NULL CHECK (length(btrim(reason)) > 0),
  migration                  text NOT NULL DEFAULT
                                  'four_full_pool_events_retire_only_their_stale_obligation_metadata',
  retired_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (original_amount_owed > original_amount_paid),
  CHECK (retired_unfunded_amount = original_amount_owed - original_amount_paid),
  CHECK (locked_pool = payout_total_before),
  CHECK (locked_pool = wallet_prize_total_before)
);

ALTER TABLE public.tournament_obligation_retirements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_obligation_retirements
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_obligation_retirements_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $obligation_retirements_append_only$
BEGIN
  RAISE EXCEPTION
    'tournament obligation retirement evidence is immutable; % refused for obligation %',
    TG_OP, OLD.obligation_id USING ERRCODE = '55000';
END;
$obligation_retirements_append_only$;

REVOKE ALL ON FUNCTION public.fn_tournament_obligation_retirements_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tournament_obligation_retirements_append_only
  ON public.tournament_obligation_retirements;
CREATE TRIGGER tournament_obligation_retirements_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_obligation_retirements
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_tournament_obligation_retirements_append_only();

COMMENT ON TABLE public.tournament_obligation_retirements IS
  'Append-only proof that a named historical obligation tail was metadata, not unpaid money. Every row requires payout total = wallet prize credits = locked pool before retirement.';

DO $retire_four_stale_obligations$
DECLARE
  v_expected record;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_event_payout_total numeric;
  v_event_wallet_total numeric;
  v_user_payout_total numeric;
  v_escrow_prize_balance numeric;
  v_rows integer;
  v_reason constant text :=
    'The completed event already paid its entire locked prize pool. This legacy obligation tail was superseded allocation metadata; no chips moved and no house bank was charged.';
BEGIN
  FOR v_expected IN
    SELECT *
      FROM (VALUES
        -- Three cent-level tails created by old percentage/reconcile rounding.
        ('a74ef21e-7e58-4426-ac9f-e60570ee2530'::uuid,
         '856620cc-2b60-4db3-b14d-21ed8eb1900b'::uuid,
         'c3195f0b-2da2-40d1-b1fd-42ab69e55edf'::uuid,
         'place'::text, 2, 400.00::numeric, 399.91::numeric,
         1500.00::numeric, 399.91::numeric),
        ('9040884d-771f-4a32-9adc-b9fdf1f50c75'::uuid,
         'fc8dd584-b212-4868-b3a3-4d981c250375'::uuid,
         '00000000-0000-0000-0000-000000000005'::uuid,
         'place'::text, 1, 90.36::numeric, 90.25::numeric,
         250.00::numeric, 90.25::numeric),
        ('62d6a5b9-5c97-41ab-bea2-abc8ba6c0577'::uuid,
         'fc8dd584-b212-4868-b3a3-4d981c250375'::uuid,
         'baf4b2c4-c335-47bd-be52-a992d71e35d8'::uuid,
         'place'::text, 4, 30.12::numeric, 30.00::numeric,
         250.00::numeric, 30.00::numeric),
        -- A chip-proportional final-table deal paid 47.50 + 23.75. The old
        -- normal-ladder first-place obligation was never the winning contract.
        ('9a1c73fb-a6d5-4be0-b94d-89bf4aa0686f'::uuid,
         '3e281f5c-2479-42dc-bf6e-afb007d9988f'::uuid,
         '2e26ae7c-0d4a-42da-b8ee-90a498eb25dd'::uuid,
         'place'::text, 1, 71.25::numeric, 0.00::numeric,
         71.25::numeric, 47.50::numeric)
      ) AS expected(
        obligation_id, tournament_id, user_id, kind, place,
        amount_owed, amount_paid, locked_pool, user_payout_total)
  LOOP
    -- Fresh databases do not contain production incidents. A partial match is
    -- unsafe: if the tournament exists, its exact obligation or its immutable
    -- retirement receipt must exist too.
    IF NOT EXISTS (
      SELECT 1 FROM public.tournaments t
       WHERE t.id = v_expected.tournament_id
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.id = v_expected.obligation_id
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligation_retirements r
         WHERE r.obligation_id = v_expected.obligation_id
      ) THEN
        RAISE EXCEPTION
          'historical obligation % exists without tournament %',
          v_expected.obligation_id, v_expected.tournament_id;
      END IF;
      CONTINUE;
    END IF;

    PERFORM 1 FROM public.tournaments t
     WHERE t.id = v_expected.tournament_id
       AND upper(COALESCE(t.status::text, '')) = 'COMPLETED'
       AND round(t.prize_pool, 2) = v_expected.locked_pool
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'historical tournament % no longer has its exact completed pool %',
        v_expected.tournament_id, v_expected.locked_pool;
    END IF;

    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_event_payout_total
      FROM public.tournament_payouts p
     WHERE p.tournament_id = v_expected.tournament_id;
    SELECT round(COALESCE(sum(w.amount), 0), 2)
      INTO v_event_wallet_total
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = v_expected.tournament_id
       AND w.type = 'credit'
       AND w.category = 'prize';
    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_user_payout_total
      FROM public.tournament_payouts p
     WHERE p.tournament_id = v_expected.tournament_id
       AND p.user_id = v_expected.user_id;
    SELECT round(COALESCE(sum(e.prize_balance), 0), 2)
      INTO v_escrow_prize_balance
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_expected.tournament_id;

    IF v_event_payout_total IS DISTINCT FROM v_expected.locked_pool
       OR v_event_wallet_total IS DISTINCT FROM v_expected.locked_pool
       OR v_user_payout_total IS DISTINCT FROM v_expected.user_payout_total
       OR v_escrow_prize_balance IS DISTINCT FROM 0.00 THEN
      RAISE EXCEPTION
        'historical tournament % evidence moved: payout %, wallet %, user %, escrow %',
        v_expected.tournament_id, v_event_payout_total,
        v_event_wallet_total, v_user_payout_total, v_escrow_prize_balance;
    END IF;

    SELECT * INTO v_obligation
      FROM public.tournament_obligations o
     WHERE o.id = v_expected.obligation_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'historical tournament % exists without named obligation %',
        v_expected.tournament_id, v_expected.obligation_id;
    END IF;

    IF v_obligation.tournament_id IS DISTINCT FROM v_expected.tournament_id
       OR v_obligation.user_id IS DISTINCT FROM v_expected.user_id
       OR v_obligation.kind IS DISTINCT FROM v_expected.kind
       OR v_obligation.place IS DISTINCT FROM v_expected.place
       OR v_obligation.amount_paid IS DISTINCT FROM v_expected.amount_paid
       OR v_obligation.amount_owed NOT IN (
            v_expected.amount_owed, v_expected.amount_paid)
    THEN
      RAISE EXCEPTION
        'historical obligation % no longer matches its exact accepted shape',
        v_expected.obligation_id;
    END IF;

    INSERT INTO public.tournament_obligation_retirements (
      obligation_id, tournament_id, user_id, kind, place,
      original_amount_owed, original_amount_paid, retired_unfunded_amount,
      locked_pool, payout_total_before, wallet_prize_total_before,
      user_payout_total_before, reason)
    VALUES (
      v_expected.obligation_id, v_expected.tournament_id,
      v_expected.user_id, v_expected.kind, v_expected.place,
      v_expected.amount_owed, v_expected.amount_paid,
      v_expected.amount_owed - v_expected.amount_paid,
      v_expected.locked_pool, v_event_payout_total,
      v_event_wallet_total, v_user_payout_total, v_reason)
    ON CONFLICT (obligation_id) DO NOTHING;

    SELECT count(*) INTO v_rows
      FROM public.tournament_obligation_retirements r
     WHERE r.obligation_id = v_expected.obligation_id
       AND r.tournament_id = v_expected.tournament_id
       AND r.user_id = v_expected.user_id
       AND r.kind = v_expected.kind
       AND r.place IS NOT DISTINCT FROM v_expected.place
       AND r.original_amount_owed = v_expected.amount_owed
       AND r.original_amount_paid = v_expected.amount_paid
       AND r.retired_unfunded_amount =
           v_expected.amount_owed - v_expected.amount_paid
       AND r.locked_pool = v_expected.locked_pool
       AND r.payout_total_before = v_expected.locked_pool
       AND r.wallet_prize_total_before = v_expected.locked_pool
       AND r.user_payout_total_before = v_expected.user_payout_total;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'historical obligation % lacks one exact immutable retirement receipt',
        v_expected.obligation_id;
    END IF;

    UPDATE public.tournament_obligations o
       SET amount_owed = v_expected.amount_paid,
           amount_paid = v_expected.amount_paid,
           source = 'accepted_historical_full_pool_no_second_payment',
           settled_at = COALESCE(o.settled_at, now()),
           updated_at = now()
     WHERE o.id = v_expected.obligation_id
       AND o.amount_owed IN (
             v_expected.amount_owed, v_expected.amount_paid)
       AND o.amount_paid = v_expected.amount_paid;

    SELECT count(*) INTO v_rows
      FROM public.tournament_obligations o
     WHERE o.id = v_expected.obligation_id
       AND o.amount_owed = v_expected.amount_paid
       AND o.amount_paid = v_expected.amount_paid
       AND o.source = 'accepted_historical_full_pool_no_second_payment'
       AND o.settled_at IS NOT NULL;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'historical obligation % did not become one exact settled metadata row',
        v_expected.obligation_id;
    END IF;

    -- Resolve only evidence that contains this exact obligation UUID. No
    -- tournament-wide wildcard is used, so unrelated alerts remain visible.
    UPDATE public.financial_alerts f
       SET resolved = true,
           resolved_at = COALESCE(f.resolved_at, now()),
           resolution = COALESCE(NULLIF(f.resolution, '') || ' | ', '')
             || 'Exact historical full-pool proof accepted. Obligation '
             || v_expected.obligation_id::text
             || ' was metadata-only; no chips moved and no house bank was charged.'
     WHERE f.resolved IS NOT TRUE
       AND f.context::text LIKE '%' || v_expected.obligation_id::text || '%';

    UPDATE public.ca_drift_incidents i
       SET status = 'resolved',
           resolved_at = COALESCE(i.resolved_at, now()),
           auto_repair_status = 'not_applicable',
           root_cause =
             'A legacy calculator left an obligation tail after the complete locked pool had already been distributed.',
           correction_ref =
             'migration 20260909014457_four_full_pool_events_retire_only_their_stale_obligation_metadata; obligation '
             || v_expected.obligation_id::text,
           resolution =
             'Exact payout and wallet totals equal the locked pool. The stale obligation metadata was retired; no chips moved and no house bank was charged.'
     WHERE i.status <> 'resolved'
       AND i.metadata::text LIKE '%' || v_expected.obligation_id::text || '%';

    -- Prove this metadata-only operation did not change money evidence.
    IF (SELECT round(COALESCE(sum(p.amount), 0), 2)
          FROM public.tournament_payouts p
         WHERE p.tournament_id = v_expected.tournament_id)
         IS DISTINCT FROM v_event_payout_total
       OR (SELECT round(COALESCE(sum(w.amount), 0), 2)
             FROM public.wallet_transactions w
            WHERE w.related_entity_id = v_expected.tournament_id
              AND w.type = 'credit' AND w.category = 'prize')
         IS DISTINCT FROM v_event_wallet_total
       OR (SELECT round(COALESCE(sum(e.prize_balance), 0), 2)
             FROM public.tournament_escrow e
            WHERE e.tournament_id = v_expected.tournament_id)
         IS DISTINCT FROM v_escrow_prize_balance THEN
      RAISE EXCEPTION
        'historical obligation % retirement changed money evidence',
        v_expected.obligation_id;
    END IF;
  END LOOP;
END;
$retire_four_stale_obligations$;

-- The PLO final-table incident already names the duplicate evidence rows that
-- were removed and the two canonical payout rows that remain. Its resolution
-- text was written but its status was accidentally left open. Close only this
-- exact incident after re-proving the 71.25 pool and wallet totals.
DO $close_exact_final_table_evidence_incident$
DECLARE
  v_tournament_id constant uuid := '3e281f5c-2479-42dc-bf6e-afb007d9988f';
  v_incident_id constant uuid := '9113b1a4-3a61-4131-808b-e794650ada02';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_tournament_id) THEN
    RETURN;
  END IF;

  IF (SELECT round(COALESCE(sum(p.amount), 0), 2)
        FROM public.tournament_payouts p
       WHERE p.tournament_id = v_tournament_id) IS DISTINCT FROM 71.25
     OR (SELECT round(COALESCE(sum(w.amount), 0), 2)
           FROM public.wallet_transactions w
          WHERE w.related_entity_id = v_tournament_id
            AND w.type = 'credit' AND w.category = 'prize')
        IS DISTINCT FROM 71.25
     OR (SELECT count(*) FROM public.ca_drift_incidents i
          WHERE i.id = v_incident_id
            AND i.tournament_id = v_tournament_id
            AND i.source = 'one_payment_is_one_payout_row'
            AND i.metadata->>'money_moved_once' = 'true'
            AND i.metadata->>'recorded_after' = '71.25') <> 1 THEN
    RAISE EXCEPTION
      'final-table evidence incident % no longer has its exact accepted shape',
      v_incident_id;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved',
         resolved_at = COALESCE(i.resolved_at, now()),
         auto_repair_status = 'not_applicable',
         correction_ref = COALESCE(
           i.correction_ref,
           'migration 20260909014457_four_full_pool_events_retire_only_their_stale_obligation_metadata; canonical final-table payout evidence'),
         root_cause = COALESCE(
           i.root_cause,
           'A historical repair inserted duplicate payout evidence after the platform credit path had already written the canonical rows.')
   WHERE i.id = v_incident_id;

  IF (SELECT count(*) FROM public.ca_drift_incidents i
       WHERE i.id = v_incident_id AND i.status = 'resolved'
         AND i.resolved_at IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'final-table evidence incident % remained open', v_incident_id;
  END IF;
END;
$close_exact_final_table_evidence_incident$;

DO $verify_obligation_retirements$
DECLARE
  v_source text;
BEGIN
  SELECT pg_get_functiondef(to_regprocedure(
           'public.fn_tournament_obligation_retirements_append_only()'))
    INTO v_source;
  IF v_source NOT LIKE '%RAISE EXCEPTION%immutable%'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'tournament_obligation_retirements'
          AND tg.tgname = 'tournament_obligation_retirements_append_only'
          AND NOT tg.tgisinternal
          AND tg.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'obligation retirement evidence is not append-only';
  END IF;

  IF has_table_privilege('anon',
       'public.tournament_obligation_retirements', 'SELECT')
     OR has_table_privilege('authenticated',
       'public.tournament_obligation_retirements', 'SELECT')
     OR has_table_privilege('service_role',
       'public.tournament_obligation_retirements', 'SELECT') THEN
    RAISE EXCEPTION 'obligation retirement evidence leaked through an app role';
  END IF;
END;
$verify_obligation_retirements$;

-- The shared advisory root pins the freeze row, not wall clock. Refuse to
-- publish a live retirement if its self-expiring maintenance interval ended
-- while the historical evidence was being proved.
DO $verify_live_obligation_retirement_freeze_still_held$
BEGIN
  IF (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'obligation retirement live cutover freeze expired before commit'
      USING ERRCODE = '55006';
  END IF;
END;
$verify_live_obligation_retirement_freeze_still_held$;

COMMIT;
