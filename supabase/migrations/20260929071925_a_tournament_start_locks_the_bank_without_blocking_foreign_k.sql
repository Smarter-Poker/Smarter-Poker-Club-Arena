-- 20260929071925_a_tournament_start_locks_the_bank_without_blocking_foreign_k.sql
--
-- A TOURNAMENT START LOCKS THE BANK WITHOUT BLOCKING FOREIGN KEYS (2026-09-29).
--
-- Every tournament start (fn_complete_tournament_launch_atomic, ~350 an hour
-- in Deep Stack Society alone) passes the BEFORE UPDATE OF status trigger
-- trg_tournaments_start_readiness, which locked the bank row the overlay
-- trigger may debit:
--     PERFORM 1 FROM public.clubs c WHERE c.id = NEW.club_id FOR UPDATE;
-- FOR UPDATE is the one row lock that also conflicts with FOR KEY SHARE, the
-- lock every foreign-key check takes on the row it references. public.clubs
-- is referenced by agent_commissions (252,623 inserts), game_management_events,
-- accounting_cash_rake_sources, rake_records, club_wallet_transactions,
-- table_seats, tournament_players, tables, tournaments and more. So every
-- start waited until every open transaction that had inserted any such row
-- for the club committed, and every later insert and every finish queued
-- behind the start's tuple lock.
--
-- Measured on production 2026-09-29 07:09-07:15 UTC (pg_locks x
-- pg_stat_activity every 2-3 s, read-only):
--  * in 47 of 80 samples a fn_complete_tournament_launch_atomic held or
--    requested FOR UPDATE on the Deep Stack Society clubs row (tuple lock
--    mode AccessExclusiveLock), in 28 with another launch queued behind it,
--    one launch waiting 21.7 s, blocked on fn_credit_agent_commissions_batch, whose
--    ~31-item transaction (mean 4.2 s, max 131 s) inserts agent_commissions
--    rows referencing the club;
--  * fn_complete_tournament_terminal, holding the platform finish lane
--    ca:tournament-finish-lane:v1 exclusively and its club_wallets row,
--    waited behind those launches for the clubs row (FOR NO KEY UPDATE), so
--    every other finish on the platform (the lane is global) and every raked
--    hand's post-commit obligations for the club (club_wallets) waited too:
--    finish mean 2.8 s, max 43 s; 145 post-commit statement timeouts in 10
--    minutes; tournament elimination sweeps 10-20 s, 508 queued, oldest
--    655 s.
--
-- A read-only production probe (one DO block, NOWAIT in savepoints, ending
-- in RAISE EXCEPTION) tried both modes on that row 20 times, 0.1 s apart:
-- FOR NO KEY UPDATE was free 20 of 20 times, FOR UPDATE 0 of 20. Some
-- foreign-key holder always has the row, so FOR UPDATE is only ever granted
-- by waiting for a gap in the stream of writers.
--
-- The fix is the lock mode, nothing else. FOR NO KEY UPDATE conflicts with
-- FOR NO KEY UPDATE, FOR UPDATE, FOR SHARE and every UPDATE of the row, so a
-- competing start, the overlay and every treasury debit or credit are still
-- serialized against this start exactly as before; the one thing it no
-- longer excludes is a foreign-key check, which never changes the row. The
-- overlay trigger (zz_ca_fund_overlay_on_lock, same transaction, after the
-- guard) takes the same mode on the same rows, so it never upgrades the
-- guard's lock mid-transaction; its UPDATE of chip_treasury or chip_balance
-- is a non-key update and needs no more. No balance, readiness rule, payout
-- or ledger row changes; the two bodies are otherwise byte-identical (five
-- lock clauses and two comments).
--
-- Proof: scripts/dev/probe-start-readiness-lock.py loads the captured
-- production pre-image (scripts/dev/fixtures/start-readiness-lock/
-- preimage.sql) into disposable PostgreSQL 17, reproduces the drain (a start
-- blocked by an open agent_commissions insert, and the insert blocked by an
-- open start), applies this file twice, and shows both no longer wait while
-- start-vs-start, start-vs-treasury-write and the union bank still serialize
-- and an overlay still debits exactly once.
--
-- Pre-image: pg_get_functiondef md5 f2ee43657b769c37527ae2974101bb06 and 93f3e46a957abb7a42d4a2cfaff42fcb (read back from
-- production 2026-09-29). Replay-safe: the post-image is accepted as well.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE
  v_guard text := md5(pg_get_functiondef('public.fn_guard_tournament_start_readiness()'::regprocedure));
  v_overlay text := md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure));
BEGIN
  IF v_guard NOT IN ('f2ee43657b769c37527ae2974101bb06', '82a9626b0fd5a6f93ed297b397ded144') THEN
    RAISE EXCEPTION 'preimage mismatch: fn_guard_tournament_start_readiness is %', v_guard USING ERRCODE = '55000';
  END IF;
  IF v_overlay NOT IN ('93f3e46a957abb7a42d4a2cfaff42fcb', 'cd94241aefdfe43635720c9d8de4eb50') THEN
    RAISE EXCEPTION 'preimage mismatch: fn_ca_fund_overlay_on_lock is %', v_overlay USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN ('public.fn_guard_tournament_start_readiness()'::regprocedure,
                       'public.fn_ca_fund_overlay_on_lock()'::regprocedure)
         AND p.proowner = 'postgres'::regrole
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') <> 2 THEN
    RAISE EXCEPTION 'preimage mismatch: owner, security definer, search_path or grants moved' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_trigger tg
       WHERE tg.tgrelid = 'public.tournaments'::regclass AND NOT tg.tgisinternal AND tg.tgenabled = 'O'
         AND ((tg.tgname = 'trg_tournaments_start_readiness'
               AND tg.tgfoid = 'public.fn_guard_tournament_start_readiness()'::regprocedure)
           OR (tg.tgname = 'zz_ca_fund_overlay_on_lock'
               AND tg.tgfoid = 'public.fn_ca_fund_overlay_on_lock()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION 'preimage mismatch: the start guard and overlay triggers are not both installed' USING ERRCODE = '55000';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_start_readiness()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_readiness jsonb;
  v_enforce boolean;
BEGIN
  IF upper(COALESCE(OLD.status::text, '')) IN ('ANNOUNCED', 'REGISTERING')
     AND upper(COALESCE(NEW.status::text, '')) IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
    SELECT COALESCE(c.guarantee_enforcement_enabled, true)
      INTO v_enforce
      FROM public.clubs c
     WHERE c.id = NEW.club_id;

    -- Serialize every enforced commitment against the exact account the
    -- overlay trigger will debit. After this lock is acquired, a competing
    -- start has either fully committed or rolled back before readiness reads.
    --
    -- NO KEY UPDATE, NOT UPDATE (2026-09-29). Every other writer of this bank
    -- takes a row lock that conflicts with NO KEY UPDATE: a competing start,
    -- the overlay below, every treasury debit and credit. So the sentence
    -- above holds exactly as before. What FOR UPDATE added was a conflict
    -- with FOR KEY SHARE, the lock an INSERT takes on the club row it
    -- references: agent_commissions, rake_records, table_seats,
    -- tournament_players and the rest. A start waited for every open
    -- transaction that had written such a row for the club (a commission
    -- batch runs 4.2 s on average), and every such insert and every finish
    -- then queued behind the start: a club-wide drain on every start.
    IF COALESCE(v_enforce, true) THEN
      IF COALESCE(NEW.is_private, false) OR NEW.union_id IS NULL THEN
        PERFORM 1 FROM public.clubs c WHERE c.id = NEW.club_id FOR NO KEY UPDATE;
      ELSE
        PERFORM 1 FROM public.union_wallets uw WHERE uw.union_id = NEW.union_id FOR NO KEY UPDATE;
      END IF;
    END IF;

    v_readiness := public.fn_tournament_management_readiness_for_row(to_jsonb(NEW));

    IF NOT COALESCE((v_readiness ->> 'can_start')::boolean, false) THEN
      IF v_readiness ->> 'state' = 'funding_blocked' THEN
        RAISE EXCEPTION 'Tournament cannot start because its guarantee is short by % chips',
          v_readiness ->> 'short_by' USING ERRCODE = '55000';
      END IF;
      RAISE EXCEPTION 'Tournament cannot start because its published contract is incomplete'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_fallback numeric;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. payout table, from the field that actually entered ─────────────
     Only when nobody has registered yet. With registrations present,
     fn_guard_managed_game_lifecycle protects payout_structure and this
     trigger currently runs BEFORE it, so writing here refuses the whole
     start. Re-enabled once the trigger is renamed to sort after the guard.

     NOT FOR A SPIN (2026-09-02). A Spin's ladder comes from the tier the
     wheel drew - 10x is 80/20 - and this rule is "pay the top N% of the
     field", which on three seats rounds to one place and silently replaced
     every high multiplier with winner-take-all. 32 games, 1,592 chips. */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  -- A recovered RUNNING transition is not a new payout contract. The row
  -- is locked by its owning UPDATE; prepared/paid terms cannot be refitted
  -- to today's field. Keep the existing overlay transaction below intact.
  IF public.fn_tournament_payout_terms_committed_v1(OLD.id) THEN
    IF OLD.prize_pool_finalized IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Committed tournament payout terms have no finalized pool'
        USING ERRCODE='55000';
    END IF;
  ELSIF lower(COALESCE(NEW.variant,''))<>'spin'
        AND upper(COALESCE(NEW.tournament_type,''))<>'SPIN' THEN
    IF v_entrants > 0 AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = 'public.tournaments'::regclass
            AND tg.tgname = 'zz_ca_fund_overlay_on_lock')
    THEN
      NULL;  -- stand down: the guard would refuse the start
    ELSIF v_entrants > 0 THEN
      v_places := GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));
      BEGIN
        v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
      EXCEPTION WHEN OTHERS THEN v_existing := NULL; END;

      IF v_existing IS NULL
         OR jsonb_typeof(v_existing) <> 'array'
         OR jsonb_array_length(v_existing) = 0
         OR v_existing = '[{"place":1,"percentage":100}]'::jsonb
         OR jsonb_array_length(v_existing) <> v_places
      THEN
        NEW.payout_structure := public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text;
      END IF;
    END IF;
  END IF;

  /* ── 2. the guarantee overlay, from the main bank ─────────────────────── */
  v_pool_before := round(COALESCE(NEW.prize_pool,0),2);
  v_guarantee   := round(COALESCE(NEW.guaranteed_prize,0),2);

  /* A GUARANTEED SEAT IS A GUARANTEE (2026-09-02). A satellite's advertised
     seats are worth target buy-in + fee each; the engine awards every one of
     them, so the bank funds the shortfall here, like any other guarantee. */
  IF COALESCE(NEW.satellite_seats, 0) > 0
     AND (NEW.variant = 'satellite'
          OR UPPER(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
          OR NEW.satellite_target_id IS NOT NULL) THEN
    v_target := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
    IF v_target IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount,0) + COALESCE(t2.buy_in_fee,0)) * NEW.satellite_seats, 2)
        INTO v_seat_guarantee
        FROM public.tournaments t2 WHERE t2.id = v_target;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_short := GREATEST(0, v_guarantee - v_pool_before);
  IF v_short <= 0 THEN RETURN NEW; END IF;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  -- The bank rows below are locked FOR NO KEY UPDATE (2026-09-29), the mode
  -- fn_guard_tournament_start_readiness already holds on the same row in this
  -- transaction: the same exclusion against every other bank writer, no
  -- conflict with the FOR KEY SHARE a foreign-key check takes, and no upgrade
  -- of the start guard's lock mid-transaction.
  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR NO KEY UPDATE;
    v_from := 'union_bank';
    v_store := 'union_wallets.chip_balance';
    IF COALESCE(v_bank,0) < v_short THEN
      /* THE MAIN BANK IS SHORT - FALL BACK TO THE CLUB TREASURY.
         Dan 2026-09-04. Refusing here meant advertising a guarantee and then
         not paying it. */
      SELECT chip_treasury INTO v_fallback
        FROM public.clubs WHERE id = NEW.club_id FOR NO KEY UPDATE;

      IF COALESCE(v_fallback,0) >= v_short THEN
        v_from  := 'club_treasury';
        v_store := 'clubs.chip_treasury';
        PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
        UPDATE public.clubs
           SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
         WHERE id = NEW.club_id;
        PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
        PERFORM public.fn_raise_server_financial_alert(
          'warning', 'fn_ca_fund_overlay_on_lock',
          format('%s took its %s chip overlay from the club treasury: the union bank held only %s. The guarantee WAS met. Refill the union bank.',
                 COALESCE(NEW.name, NEW.id::text), v_short, COALESCE(v_bank,0)),
          jsonb_build_object('kind','overlay_funded_from_fallback','tournament_id',NEW.id,
            'shortfall',v_short,'union_bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        v_union := NULL;  -- the ledger row names the account that actually moved
      ELSE
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_ca_fund_overlay_on_lock',
          format('%s needs %s chips of overlay to meet its %s guarantee. The union bank holds %s and the club treasury holds %s. BOTH are short and the pool was NOT topped up.',
                 COALESCE(NEW.name, NEW.id::text), v_short, v_guarantee,
                 COALESCE(v_bank,0), COALESCE(v_fallback,0)),
          jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
            'shortfall',v_short,'bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        RETURN NEW;
      END IF;
    ELSE
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets
         SET chip_balance = chip_balance - v_short, updated_at = now()
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    END IF;
  ELSE
    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR NO KEY UPDATE;
    v_from := 'club_treasury';
    v_store := 'clubs.chip_treasury';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the club treasury holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;

  NEW.prize_pool := round(v_pool_before + v_short, 2);

  -- Funding and its escrow/journal leg are one transaction. A failed
  -- journal insert must undo the bank debit and the advertised pool change.
  -- Retry only transient deadlocks; every final error propagates to the
  -- original status update, whose existing lifecycle can retry safely.
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
        v_short, 'overlay', NEW.club_id, NEW.id,
        format('Guarantee overlay from the main bank: %s (%s) was %s short of its %s guarantee - field made %s, bank paid %s',
               COALESCE(NEW.name, 'tournament'), NEW.id::text,
               v_short, v_guarantee,
               v_pool_before, v_short));
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_attempt = 3 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_guard_tournament_start_readiness()'::regprocedure)) <> '82a9626b0fd5a6f93ed297b397ded144'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_guard_tournament_start_readiness()'::regprocedure) <> 'be4e6366a422a2da8624c01985e5f9d4' THEN
    RAISE EXCEPTION 'postimage mismatch: fn_guard_tournament_start_readiness' USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure)) <> 'cd94241aefdfe43635720c9d8de4eb50'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_ca_fund_overlay_on_lock()'::regprocedure) <> 'd0b5dbcd80e9abd09ba3ad64a4411557' THEN
    RAISE EXCEPTION 'postimage mismatch: fn_ca_fund_overlay_on_lock' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN ('public.fn_guard_tournament_start_readiness()'::regprocedure,
                       'public.fn_ca_fund_overlay_on_lock()'::regprocedure)
         AND p.proowner = 'postgres'::regrole
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
         AND position('FOR UPDATE;' in p.prosrc) = 0) <> 2 THEN
    RAISE EXCEPTION 'postimage mismatch: attributes moved or a FOR UPDATE survived' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
