-- 20261001160611_a_balance_never_moves_without_its_ledger_row
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-01 16:06:11 UTC.
--
-- ============================================================================
-- A BALANCE NEVER MOVES WITHOUT ITS LEDGER ROW
-- ============================================================================
--
-- Dan, 2026-10-01: "fix any and all issues with the chip drift, and why hasn't
-- this been made atomic yet? chip drifts should not be possible and should
-- never happen when EVERY SINGLE TRANSACTION is logged, and on the same
-- ledger...?"
--
-- WHAT MADE DRIFT POSSIBLE, read from the catalog on 2026-10-01
--
-- Every balance column on this platform is written directly by its door
-- (230 functions UPDATE one of club_members, clubs, table_seats, union_wallets,
-- bbj_pools, ...) and the journal leg is written AFTER the fact by a trigger:
-- fn_club_members_ledger_writer on club_members.chip_balance and fn_ca_autoledger
-- on clubs, union_wallets, bbj_pools, spin_bonus_pools, agents and club_wallets.
-- By construction those legs equal the delta, so a door that lets the trigger
-- journal is ledger-atomic. The hole is the clause both triggers carry:
--
--     IF current_setting('app.ledger_autoskip_<table>', true) = '1' THEN RETURN NEW;
--
-- Forty-five functions set that setting and promise to write the leg themselves,
-- with the period, the key and the counterparty only they know. NOTHING CHECKED
-- THE PROMISE. A stand-down whose own leg is missing, is the wrong amount, or
-- names the wrong account commits silently (the 2026-09-14 rakeback close moved
-- 84,041.00 under anonymous legs; the 2026-09-09 commission round wrote 40,754.98
-- of legs for 20,377.49 of movement). And two stores had no journal trigger at
-- all: table_seats.stack (the felt) and the pending add-on float - a stack that
-- moves with no leg is a chip that appears or vanishes, which is exactly what the
-- 2026-08-25 probe did to 48 chips.
--
-- Every detector that exists (fn_ca_trial_balance_watch, fn_ca_ledger_replay,
-- reconcile_ledger_nightly) compares the balance to the journal AFTER commit,
-- hours later, by snapshot. They are nets. This migration is the constraint.
--
-- THE INVARIANT, enforced at commit of every transaction
--
--   For every covered account touched in a transaction:
--     sum(balance column deltas)  =  sum(ledger legs into it) - sum(legs out of it)
--   to the cent, or the transaction is REFUSED by name:
--
--     REFUSED: balance_moved_without_its_ledger_row
--
-- A balance that moved with no leg, a leg with no balance movement, a stand-down
-- whose leg is the wrong amount or names the wrong wallet - all four are the same
-- refusal. The failure mode is refusal, never a compensating write, never a
-- silent correction (CLAUDE.md 10.11, 10.12).
--
-- HOW: one transaction-scoped tally, checked at commit
--
--   zy_ca_tally_balance_move   AFTER INSERT/UPDATE/DELETE row triggers on every
--                              covered balance table add the row's delta to the
--                              account's tally (setting ca.ledger_tally, a jsonb
--                              {account_key: {b: balance_delta, l: ledger_net}},
--                              transaction-local, O(1) per write).
--   zy_ca_tally_ledger_leg     AFTER INSERT on chip_ledger adds +amount to the
--                              to-account and -amount to the from-account.
--   zz_ca_balance_has_its_ledger_row / zz_ca_ledger_row_has_its_balance
--                              CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY
--                              DEFERRED: fires at COMMIT, reads the tally once per
--                              change (a version counter makes every later event
--                              in the same quiet phase O(1)), and refuses if any
--                              account's b <> l. Because it is deferred, a door
--                              may write the balance first and the leg later, or
--                              the reverse, in as many statements as it likes.
--
-- THE COVERED ACCOUNTS (this migration)
--
--   player_wallet:<user>:<club>  club_members.chip_balance
--   club_treasury:<club>         clubs.chip_treasury + clubs.chip_pool
--   table_stack                  the whole cash felt as ONE account, exactly as
--                                fn_ca_account_balance and fn_ca_supply_snapshot
--                                define it: table_seats.stack where left_at IS
--                                NULL on a chip club's non-tournament table, plus
--                                table_pending_addons.amount while unresolved. A
--                                pot moving between seats, a seat moving between
--                                cash tables and a pending add-on landing on its
--                                seat are not chip movements and need no leg; a
--                                buy-in, cash-out, rake, jackpot drop, horse
--                                funding or vacated stack is and does.
--   union_bank:<union>           union_wallets.chip_balance
--   union_wallet:<union>         union_wallets.rake_wallet + bbj_wallet +
--                                promo_wallet + insurance_wallet + spin_reserve_wallet
--   bbj_pool:<pool>              bbj_pools.main_balance + backup_balance + promo_balance
--
--   Measured over the seven days to 2026-10-01 15:05 UTC these six carry every
--   buy-in, cash-out, rake, jackpot and prize leg on the platform; the ledger
--   conventions they must meet (player_wallet legs name user and club, union
--   legs name the wallet row or the union, bbj legs name the pool row,
--   table_stack legs name a cash chip table) held on 100.00% of the 1,946,078
--   legs written in that window, so no live writer needs to change to pass.
--
--   NOT yet covered, by name so nobody reads silence as coverage: promo wallets
--   (club_members.promo_balance, clubs.promo_balance, agents.promo_wallet_balance),
--   agents.agent_wallet_balance, club_wallets.chip_balance, clubs.insurance_balance,
--   spin_bonus_pools.balance, and the tournament escrow (prize_liability /
--   bounty_liability, whose balance is partly driven FROM the ledger by the
--   zz_ca_escrow_*_leg triggers and needs its own model). They keep their
--   existing autoledger and detectors; they are the next migration.
--
-- WHAT IS DELIBERATELY OUTSIDE THE TALLY
--
--   - A fn_ca_post_correction leg (category 'correction', metadata.posted_via =
--     'fn_ca_post_correction') is a journal-only restatement made under
--     CLAUDE.md 10.9 rule 3 when the ledger was wrong and the wallet right. It
--     never moves a balance by design, every meter on the platform excludes it
--     (fn_ca_trial_balance, fn_ca_supply_snapshot), and so does this one.
--   - Tournament felt: tournament chips are play chips carried by
--     tournament_liability, not by table_stack (ca_chip_store_coverage).
--   - Diamond Arena tables and clubs (clubs.asset = 'diamonds'): Diamonds move
--     through their own custody doors and no chip_ledger row (fn_poker_reject_
--     diamond_chip_money refuses one).
--   - public.wallets: a dead pool, frozen since 2026-08-21, nothing reads it.
--
-- STAGED: OBSERVE FIRST, THEN REFUSE
--
--   ca_ledger_invariant_mode holds one row. This migration installs it as
--   'observe': the full code path runs on every live transaction and a would-be
--   refusal is written to ca_ledger_invariant_findings (one row per transaction
--   and account, with the actor, role and the statement that was running) and
--   raised as a WARNING instead of an exception. A trigger on the two hottest
--   tables of a live real-money room (table_seats takes a write on every seat of
--   every hand; club_members on every buy-in, cash-out, prize and fee) cannot be
--   probed on production before it exists, and a refusal nobody foresaw on the
--   hand-commit path would stop every table on the platform. One hour of real
--   traffic with zero findings is the proof the next migration reads before it
--   flips the row to 'refuse'. The flip is a one-row UPDATE in its own
--   migration; the law test pins that the final state on main is 'refuse'.
--   'observe' is a measurement window with a named end, not a detector offered
--   as the fix (CLAUDE.md 10.86).
--
-- PERFORMANCE
--
--   One jsonb read-modify-write per balance write and per leg; one jsonb read
--   per transaction at commit. The largest transaction in the 48 hours to
--   2026-10-01 16:00 UTC wrote 9 legs (fn_settle_satellite_tournament). The
--   cost is O(accounts touched) per write, so a weekly close that pays 420
--   wallets in one transaction does about 420 x 420 jsonb key visits, well
--   under a second; no table is created, no catalog row is written, nothing
--   is locked.
--
-- CLAUDE.md section 2: one migration, one transaction; lock_timeout set because
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on hot tables; applied outside the
-- :50-:03 break window through apply-merged-migration.yml only.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. The mode and the findings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ca_ledger_invariant_mode (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode       text NOT NULL CHECK (mode IN ('observe', 'refuse')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason     text NOT NULL
);
COMMENT ON TABLE public.ca_ledger_invariant_mode IS
  'One row. observe: a balance/ledger disagreement at commit is recorded in ca_ledger_invariant_findings and warned. refuse: it aborts the transaction (REFUSED: balance_moved_without_its_ledger_row). Changed only by a migration.';

INSERT INTO public.ca_ledger_invariant_mode (mode, reason)
VALUES ('observe',
        '20261001160611: stage 1, measure one hour of live traffic on every covered account before the next migration flips this row to refuse')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ca_ledger_invariant_findings (
  txid           xid8 NOT NULL,
  account_key    text NOT NULL,
  found_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  balance_delta  numeric NOT NULL,
  ledger_net     numeric NOT NULL,
  mode           text NOT NULL,
  actor_service  text,
  db_role        text,
  statement      text,
  PRIMARY KEY (txid, account_key)
);
COMMENT ON TABLE public.ca_ledger_invariant_findings IS
  'Every transaction in which a covered balance and the chip_ledger disagreed at commit while ca_ledger_invariant_mode was observe. Empty is the proof the flip to refuse reads. In refuse mode nothing is written here because the transaction does not commit.';

REVOKE ALL ON public.ca_ledger_invariant_mode FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ca_ledger_invariant_findings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_ledger_invariant_mode TO service_role;
GRANT SELECT ON public.ca_ledger_invariant_findings TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The tally
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_add(p_key text, p_side text, p_delta numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  t jsonb;
  e jsonb;
  v numeric;
BEGIN
  /* The tally lives in a transaction-local setting, so it is undone with the
     transaction and with any subtransaction (a plpgsql EXCEPTION block) that
     rolls back the write it counted. A SET clause on a function restores only
     the variables it names at exit (measured on production 2026-10-01: a
     set_config(..., true) made inside a SET search_path function was still
     set after it returned), so pinning search_path here does not lose the
     tally. Every object is named by schema regardless. */
  IF p_key IS NULL OR p_delta IS NULL OR round(p_delta, 2) = 0 THEN
    RETURN;
  END IF;
  t := COALESCE(NULLIF(current_setting('ca.ledger_tally', true), '')::jsonb, '{}'::jsonb);
  e := COALESCE(t -> p_key, '{"b":0,"l":0}'::jsonb);
  IF NOT (e ? 'q') THEN
    -- The top-level statement that first touched this account in this
    -- transaction: the name of the door, for the refusal and the finding
    -- (CLAUDE.md 10.86: a refusal names its writer).
    e := e || jsonb_build_object('q', left(COALESCE(current_query(), ''), 300));
  END IF;
  v := round(COALESCE((e ->> p_side)::numeric, 0) + p_delta, 2);
  e := jsonb_set(e, ARRAY[p_side], to_jsonb(v), true);
  t := t || jsonb_build_object(p_key, e);
  PERFORM set_config('ca.ledger_tally', t::text, true);
  PERFORM set_config('ca.ledger_tally_ver',
                     (COALESCE(NULLIF(current_setting('ca.ledger_tally_ver', true), ''), '0')::bigint + 1)::text,
                     true);
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_ledger_tally_add(text, text, numeric) IS
  'Adds a balance delta (side b) or a ledger leg (side l) to the transaction-scoped account tally that zz_ca_balance_has_its_ledger_row compares at commit.';

CREATE OR REPLACE FUNCTION public.fn_ca_felt_counts_table(p_table uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  /* The felt account is the cash chip felt: a table with no tournament whose
     club is not the Diamond Arena. Exactly fn_ca_supply_snapshot's definition. */
  SELECT EXISTS (
    SELECT 1
      FROM public.tables t
      LEFT JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_table
       AND t.tournament_id IS NULL
       AND COALESCE(c.asset, 'chips') <> 'diamonds');
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_key(p_type text, p_entity uuid, p_club uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_union uuid;
BEGIN
  /* The account a ledger side belongs to, in the covered set, or NULL when the
     store is not covered by this invariant. The conventions are the ones every
     live writer already meets (measured 2026-10-01, seven days, 1,946,078
     legs): a player_wallet leg names the user and the club; a union leg names
     the wallet row (fn_ca_autoledger) or the union (a declaring payer); a
     bbj_pool leg names the pool row; a table_stack leg names the table. */
  CASE p_type
    WHEN 'player_wallet' THEN
      RETURN 'player_wallet:' || COALESCE(p_entity::text, 'null') || ':' || COALESCE(p_club::text, 'null');
    WHEN 'club_treasury' THEN
      RETURN 'club_treasury:' || COALESCE(p_entity::text, 'null');
    WHEN 'table_stack' THEN
      IF p_entity IS NULL OR public.fn_ca_felt_counts_table(p_entity) THEN
        RETURN 'table_stack';
      END IF;
      RETURN NULL;  -- a tournament or Diamond table is not on the cash felt
    WHEN 'union_bank', 'union_wallet' THEN
      SELECT w.union_id INTO v_union FROM public.union_wallets w WHERE w.id = p_entity;
      RETURN p_type || ':' || COALESCE(v_union, p_entity)::text;
    WHEN 'bbj_pool' THEN
      RETURN 'bbj_pool:' || COALESCE(p_entity::text, 'null');
    ELSE
      RETURN NULL;
  END CASE;
END;
$function$;

-- Engine plumbing, not a surface: nothing a browser role can call. The
-- triggers below run them as their owner regardless of these grants.
REVOKE ALL ON FUNCTION public.fn_ca_ledger_tally_add(text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_tally_key(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_felt_counts_table(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_felt_counts_table(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The balance side: one trigger function for every covered table
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_tally_balance_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  k_old text; k_new text;
  v_old numeric := 0; v_new numeric := 0;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'club_members' THEN
      IF o IS NOT NULL THEN
        k_old := 'player_wallet:' || COALESCE(o ->> 'user_id', 'null') || ':' || COALESCE(o ->> 'club_id', 'null');
        v_old := COALESCE((o ->> 'chip_balance')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        k_new := 'player_wallet:' || COALESCE(n ->> 'user_id', 'null') || ':' || COALESCE(n ->> 'club_id', 'null');
        v_new := COALESCE((n ->> 'chip_balance')::numeric, 0);
      END IF;
    WHEN 'clubs' THEN
      IF o IS NOT NULL THEN
        k_old := 'club_treasury:' || (o ->> 'id');
        v_old := COALESCE((o ->> 'chip_treasury')::numeric, 0) + COALESCE((o ->> 'chip_pool')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        k_new := 'club_treasury:' || (n ->> 'id');
        v_new := COALESCE((n ->> 'chip_treasury')::numeric, 0) + COALESCE((n ->> 'chip_pool')::numeric, 0);
      END IF;
    WHEN 'table_seats' THEN
      /* A seat is on the felt while it is occupied (left_at IS NULL) and its
         table is a cash chip table. A vacated seat's stack has left the felt
         whether or not the row zeroes it, which is exactly what
         fn_log_seat_stack_exit records and what a cash-out leg explains. */
      k_old := 'table_stack'; k_new := 'table_stack';
      IF o IS NOT NULL AND (o ->> 'left_at') IS NULL
         AND public.fn_ca_felt_counts_table((o ->> 'table_id')::uuid) THEN
        v_old := COALESCE((o ->> 'stack')::numeric, 0);
      END IF;
      IF n IS NOT NULL AND (n ->> 'left_at') IS NULL
         AND public.fn_ca_felt_counts_table((n ->> 'table_id')::uuid) THEN
        v_new := COALESCE((n ->> 'stack')::numeric, 0);
      END IF;
    WHEN 'table_pending_addons' THEN
      /* The add-on's leg lands at request time; the chips wait here until the
         hand ends. They are on the felt the whole time (fn_ca_supply_snapshot
         pending_addons, 2026-09-12), so resolving one is not a movement. */
      k_old := 'table_stack'; k_new := 'table_stack';
      IF o IS NOT NULL AND (o ->> 'resolved_at') IS NULL
         AND public.fn_ca_felt_counts_table((o ->> 'table_id')::uuid) THEN
        v_old := COALESCE((o ->> 'amount')::numeric, 0);
      END IF;
      IF n IS NOT NULL AND (n ->> 'resolved_at') IS NULL
         AND public.fn_ca_felt_counts_table((n ->> 'table_id')::uuid) THEN
        v_new := COALESCE((n ->> 'amount')::numeric, 0);
      END IF;
    WHEN 'union_wallets' THEN
      /* Two accounts on one row: the bank (chip_balance) and the five
         operating wallets, both keyed by the union. */
      IF o IS NOT NULL THEN
        PERFORM public.fn_ca_ledger_tally_add('union_bank:' || (o ->> 'union_id'), 'b',
                  -COALESCE((o ->> 'chip_balance')::numeric, 0));
        k_old := 'union_wallet:' || (o ->> 'union_id');
        v_old := COALESCE((o ->> 'rake_wallet')::numeric, 0) + COALESCE((o ->> 'bbj_wallet')::numeric, 0)
               + COALESCE((o ->> 'promo_wallet')::numeric, 0) + COALESCE((o ->> 'insurance_wallet')::numeric, 0)
               + COALESCE((o ->> 'spin_reserve_wallet')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        PERFORM public.fn_ca_ledger_tally_add('union_bank:' || (n ->> 'union_id'), 'b',
                  COALESCE((n ->> 'chip_balance')::numeric, 0));
        k_new := 'union_wallet:' || (n ->> 'union_id');
        v_new := COALESCE((n ->> 'rake_wallet')::numeric, 0) + COALESCE((n ->> 'bbj_wallet')::numeric, 0)
               + COALESCE((n ->> 'promo_wallet')::numeric, 0) + COALESCE((n ->> 'insurance_wallet')::numeric, 0)
               + COALESCE((n ->> 'spin_reserve_wallet')::numeric, 0);
      END IF;
    WHEN 'bbj_pools' THEN
      IF o IS NOT NULL THEN
        k_old := 'bbj_pool:' || (o ->> 'id');
        v_old := COALESCE((o ->> 'main_balance')::numeric, 0) + COALESCE((o ->> 'backup_balance')::numeric, 0)
               + COALESCE((o ->> 'promo_balance')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        k_new := 'bbj_pool:' || (n ->> 'id');
        v_new := COALESCE((n ->> 'main_balance')::numeric, 0) + COALESCE((n ->> 'backup_balance')::numeric, 0)
               + COALESCE((n ->> 'promo_balance')::numeric, 0);
      END IF;
    ELSE
      RAISE EXCEPTION 'fn_ca_tally_balance_move is not configured for %', TG_TABLE_NAME;
  END CASE;

  /* A row that changes account (a seat changing table, a membership changing
     club) leaves one account and arrives in another; both sides are counted. */
  IF k_old IS NOT NULL AND k_new IS NOT NULL AND k_old = k_new THEN
    PERFORM public.fn_ca_ledger_tally_add(k_new, 'b', v_new - v_old);
  ELSE
    IF k_old IS NOT NULL THEN PERFORM public.fn_ca_ledger_tally_add(k_old, 'b', -v_old); END IF;
    IF k_new IS NOT NULL THEN PERFORM public.fn_ca_ledger_tally_add(k_new, 'b', v_new); END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The ledger side
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_tally_ledger_leg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  /* A journal-only restatement (CLAUDE.md 10.9 rule 3, fn_ca_post_correction)
     moves no balance by design and is outside every meter, including this one. */
  IF NEW.category = 'correction' AND NEW.metadata ->> 'posted_via' = 'fn_ca_post_correction' THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_ledger_tally_add(
    public.fn_ca_ledger_tally_key(NEW.to_type, NEW.to_entity_id, NEW.club_id), 'l', NEW.amount);
  PERFORM public.fn_ca_ledger_tally_add(
    public.fn_ca_ledger_tally_key(NEW.from_type, NEW.from_entity_id, NEW.club_id), 'l', -NEW.amount);
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The check, at commit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_balance_has_its_ledger_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_ver text := NULLIF(current_setting('ca.ledger_tally_ver', true), '');
  v_checked text := NULLIF(current_setting('ca.ledger_tally_checked', true), '');
  v_mode text;
  t jsonb;
  r record;
  v_b numeric; v_l numeric;
BEGIN
  /* Deferred to commit. Every queued event re-enters here, so the tally is
     verified once per version: when nothing has been added since the last
     verification this is one setting read and out. A deferred trigger that
     writes money after us bumps the version and queues its own event, which
     verifies again, so the last word is always on the complete tally. */
  IF v_ver IS NULL OR v_ver = v_checked THEN
    RETURN NULL;
  END IF;

  t := COALESCE(NULLIF(current_setting('ca.ledger_tally', true), '')::jsonb, '{}'::jsonb);

  FOR r IN SELECT key, value FROM jsonb_each(t) LOOP
    v_b := round(COALESCE((r.value ->> 'b')::numeric, 0), 2);
    v_l := round(COALESCE((r.value ->> 'l')::numeric, 0), 2);
    IF v_b = v_l THEN
      CONTINUE;
    END IF;

    v_mode := COALESCE(v_mode, (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1), 'refuse');

    IF v_mode = 'refuse' THEN
      RAISE EXCEPTION 'REFUSED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=%',
        r.key, v_b, v_l
        USING ERRCODE = '23514',
              DETAIL  = CASE
                          WHEN v_l = 0 THEN 'the balance column moved and no chip_ledger leg in this transaction accounts for it'
                          WHEN v_b = 0 THEN 'a chip_ledger leg names this account and its balance column did not move in this transaction'
                          ELSE 'the balance column and the chip_ledger legs in this transaction disagree on how much moved'
                        END || '; first written in this transaction by: ' || COALESCE(r.value ->> 'q', '(unknown statement)'),
              HINT    = 'Every chip movement is written by its door as balance + leg in one transaction. If the door stood the autoledger down (app.ledger_autoskip_<table>), its own leg must equal the delta and name the same user, club, union, pool or cash table. Nothing is corrected here; the transaction is refused whole.';
    END IF;

    INSERT INTO public.ca_ledger_invariant_findings
      (txid, account_key, balance_delta, ledger_net, mode, actor_service, db_role, statement)
    VALUES
      (pg_current_xact_id(), r.key, v_b, v_l, v_mode,
       current_setting('application_name', true), current_user,
       COALESCE(r.value ->> 'q', left(current_query(), 300)))
    ON CONFLICT (txid, account_key) DO UPDATE
      SET balance_delta = EXCLUDED.balance_delta,
          ledger_net    = EXCLUDED.ledger_net,
          found_at      = EXCLUDED.found_at,
          statement     = EXCLUDED.statement;
    RAISE WARNING 'OBSERVED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=% (ca_ledger_invariant_mode=observe; this transaction would be refused)',
      r.key, v_b, v_l;
  END LOOP;

  PERFORM set_config('ca.ledger_tally_checked', v_ver, true);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_tally_balance_move() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_tally_ledger_leg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_balance_has_its_ledger_row() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The triggers
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS zy_ca_tally_balance_move ON public.club_members;
CREATE TRIGGER zy_ca_tally_balance_move
  AFTER INSERT OR UPDATE OF chip_balance, user_id, club_id OR DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_balance_move();
DROP TRIGGER IF EXISTS zz_ca_balance_has_its_ledger_row ON public.club_members;
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row
  AFTER INSERT OR UPDATE OF chip_balance, user_id, club_id OR DELETE ON public.club_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

DROP TRIGGER IF EXISTS zy_ca_tally_balance_move ON public.clubs;
CREATE TRIGGER zy_ca_tally_balance_move
  AFTER INSERT OR UPDATE OF chip_treasury, chip_pool OR DELETE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_balance_move();
DROP TRIGGER IF EXISTS zz_ca_balance_has_its_ledger_row ON public.clubs;
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row
  AFTER INSERT OR UPDATE OF chip_treasury, chip_pool OR DELETE ON public.clubs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

DROP TRIGGER IF EXISTS zy_ca_tally_balance_move ON public.table_seats;
CREATE TRIGGER zy_ca_tally_balance_move
  AFTER INSERT OR UPDATE OF stack, left_at, table_id OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_balance_move();
DROP TRIGGER IF EXISTS zz_ca_balance_has_its_ledger_row ON public.table_seats;
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row
  AFTER INSERT OR UPDATE OF stack, left_at, table_id OR DELETE ON public.table_seats
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

DROP TRIGGER IF EXISTS zy_ca_tally_balance_move ON public.table_pending_addons;
CREATE TRIGGER zy_ca_tally_balance_move
  AFTER INSERT OR UPDATE OF amount, resolved_at, table_id OR DELETE ON public.table_pending_addons
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_balance_move();
DROP TRIGGER IF EXISTS zz_ca_balance_has_its_ledger_row ON public.table_pending_addons;
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row
  AFTER INSERT OR UPDATE OF amount, resolved_at, table_id OR DELETE ON public.table_pending_addons
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

DROP TRIGGER IF EXISTS zy_ca_tally_balance_move ON public.union_wallets;
CREATE TRIGGER zy_ca_tally_balance_move
  AFTER INSERT OR UPDATE OF chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, spin_reserve_wallet, union_id OR DELETE
  ON public.union_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_balance_move();
DROP TRIGGER IF EXISTS zz_ca_balance_has_its_ledger_row ON public.union_wallets;
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row
  AFTER INSERT OR UPDATE OF chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, spin_reserve_wallet, union_id OR DELETE
  ON public.union_wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

DROP TRIGGER IF EXISTS zy_ca_tally_balance_move ON public.bbj_pools;
CREATE TRIGGER zy_ca_tally_balance_move
  AFTER INSERT OR UPDATE OF main_balance, backup_balance, promo_balance OR DELETE ON public.bbj_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_balance_move();
DROP TRIGGER IF EXISTS zz_ca_balance_has_its_ledger_row ON public.bbj_pools;
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row
  AFTER INSERT OR UPDATE OF main_balance, backup_balance, promo_balance OR DELETE ON public.bbj_pools
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

DROP TRIGGER IF EXISTS zy_ca_tally_ledger_leg ON public.chip_ledger;
CREATE TRIGGER zy_ca_tally_ledger_leg
  AFTER INSERT ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_ledger_leg();
DROP TRIGGER IF EXISTS zz_ca_ledger_row_has_its_balance ON public.chip_ledger;
CREATE CONSTRAINT TRIGGER zz_ca_ledger_row_has_its_balance
  AFTER INSERT ON public.chip_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

-- ---------------------------------------------------------------------------
-- 6b. The writers, enumerated from the catalog rather than from memory
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_ca_chip_balance_writers AS
WITH f AS (
  SELECT p.proname, p.prosrc AS s, p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'smarter_private') AND p.prokind = 'f'
),
w AS (
  SELECT proname, prosecdef,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN s ~* 'update\s+(public\.)?club_members\M' AND s ~* '\mchip_balance\M' THEN 'player_wallet' END,
      CASE WHEN s ~* '(update|delete\s+from)\s+(public\.)?table_seats\M' AND s ~* '\mstack\M' THEN 'table_stack' END,
      CASE WHEN s ~* '(insert\s+into|update)\s+(public\.)?table_pending_addons\M' THEN 'table_stack' END,
      CASE WHEN s ~* 'update\s+(public\.)?clubs\M' AND s ~* '\m(chip_treasury|chip_pool)\M' THEN 'club_treasury' END,
      CASE WHEN s ~* '(update|insert\s+into)\s+(public\.)?union_wallets\M' THEN 'union_wallet' END,
      CASE WHEN s ~* '(update|insert\s+into)\s+(public\.)?bbj_pools\M' THEN 'bbj_pool' END,
      CASE WHEN s ~* 'update\s+(public\.)?club_wallets\M' AND s ~* '\mchip_balance\M' THEN 'club_wallet (uncovered)' END,
      CASE WHEN s ~* 'update\s+(public\.)?agents\M' AND s ~* '\mwallet_balance\M' THEN 'agent_wallet (uncovered)' END,
      CASE WHEN s ~* '(update|insert\s+into)\s+(public\.)?spin_bonus_pools\M' THEN 'spin_reserve (uncovered)' END,
      CASE WHEN s ~* '(update|insert\s+into)\s+(public\.)?tournament_escrow\M' THEN 'prize_liability (uncovered)' END,
      CASE WHEN s ~* 'update\s+(public\.)?(club_members|clubs)\M' AND s ~* '\mpromo_balance\M' THEN 'promo_wallet (uncovered)' END
    ], NULL) AS stores,
    s ~* 'ledger_autoskip_' AS stands_down,
    s ~* 'insert\s+into\s+(public\.)?chip_ledger\M' AS writes_own_leg,
    s ~* '\m(fn_ca_post_leg|fn_credit_and_log|log_wallet_transaction|atomic_credit_wallet_and_log|atomic_deduct_wallet_and_log|atomic_distribute_rake|fn_ca_post_correction)\M' AS calls_a_door
  FROM f
)
SELECT proname, prosecdef, stores, stands_down, writes_own_leg, calls_a_door,
  CASE
    WHEN cardinality(stores) = 0 THEN 'journal writer only'
    WHEN NOT (stores && ARRAY['player_wallet','table_stack','club_treasury','union_wallet','bbj_pool']) THEN 'uncovered store (next migration)'
    WHEN stands_down THEN 'stand-down: writes its own leg; the promise is verified at commit'
    WHEN stores @> ARRAY['table_stack'] AND NOT (stores && ARRAY['player_wallet','club_treasury','union_wallet','bbj_pool']) THEN 'felt writer: no journal trigger; the felt account is checked at commit'
    ELSE 'ledger-atomic: the autoledger writes the leg; checked at commit'
  END AS class
FROM w
WHERE cardinality(stores) > 0 OR writes_own_leg;

COMMENT ON VIEW public.v_ca_chip_balance_writers IS
  'Every function in public/smarter_private whose body writes a chip balance column or a chip_ledger row, read from pg_proc at query time, with the store(s) it writes, whether it stands the autoledger down, and how it is covered by the commit-time invariant. docs/evidence/chip-balance-writers-2026-10-01.md is a snapshot.';

REVOKE ALL ON public.v_ca_chip_balance_writers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_ca_chip_balance_writers TO service_role;

-- ---------------------------------------------------------------------------
-- 6c. The one split-write the catalog read found, fixed at its line
-- ---------------------------------------------------------------------------
--
-- promo_apply_playthrough releases a met promo into chip_balance under
-- app.ledger_autoskip_club_members = '1'. Both club_members journal triggers
-- honour that setting (fn_club_members_ledger_writer for chip_balance and
-- fn_ca_autoledger for promo_balance), so the release wrote NO leg at all: the
-- wallet grew by the promo and the journal did not know. Dormant (0 releases in
-- the 30 days to 2026-10-01, 0.00 promo outstanding), which is why no detector
-- ever saw it, and exactly the shape the invariant refuses. The fix writes the
-- one leg the movement is - promo_wallet -> player_wallet, released amount -
-- inside the same stand-down, so the promo zeroing does not journal a second
-- anonymous leg. Pinned to the live body so a changed function is not
-- overwritten blind.

DO $m$
DECLARE v_live text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'promo_apply_playthrough';
  IF v_live IS DISTINCT FROM 'ee9bcdf31b5f212b67e0ff536033f20c' THEN
    RAISE EXCEPTION 'promo_apply_playthrough is not the body read on 2026-10-01 (md5 %); re-read it before redefining it', v_live;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(p_club_id uuid, p_user_id uuid, p_wagered numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_promo    numeric;
  v_required numeric;
  v_wagered  numeric;
  v_released numeric := 0;
  v_caller   text := COALESCE(auth.role(), '');
BEGIN
  /* ZERO-DRIFT (2026-08-31): the wager figure is engine truth. Only the
     engine (service_role) or trusted admin context may apply playthrough -
     an authenticated user could previously release ANY member's locked promo
     by claiming an arbitrary wager. Fail closed. */
  IF NOT (v_caller = 'service_role'
          OR (v_caller = '' AND current_user IN ('postgres', 'supabase_admin'))) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'engine_only');
  END IF;

  IF p_wagered IS NULL OR p_wagered <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_wager');
  END IF;

  BEGIN
    INSERT INTO player_stats (id, user_id, club_id, total_losses, updated_at)
    VALUES (gen_random_uuid(), p_user_id, p_club_id, p_wagered, now())
    ON CONFLICT (user_id, club_id) DO UPDATE
       SET total_losses = player_stats.total_losses + EXCLUDED.total_losses,
           updated_at   = now();
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT COALESCE(promo_balance, 0), COALESCE(promo_playthrough_required, 0), COALESCE(promo_wagered, 0)
    INTO v_promo, v_required, v_wagered
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
   FOR UPDATE;

  IF v_promo IS NULL OR v_promo <= 0 OR v_required <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_outstanding_promo');
  END IF;

  v_wagered := v_wagered + p_wagered;

  IF v_wagered >= v_required THEN
    /* Exact release - the old v_promo::integer truncated fractions into
       nothing while promo_balance was zeroed in full. */
    v_released := round(v_promo, 2);

    /* ONE MOVEMENT, ONE LEG (2026-10-01). Both club_members journal triggers
       stand down for this write, so the leg is written here: the promo float
       becomes cashable chips in the same wallet. Before today this block set
       the stand-down and wrote no leg, so the release moved chip_balance with
       nothing in the journal - the shape zz_ca_balance_has_its_ledger_row
       refuses at commit. */
    PERFORM set_config('app.ledger_category', 'promo_release', true);
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description, idempotency_key)
    VALUES
      (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
       'promo_wallet', p_user_id, 'player_wallet', p_user_id,
       v_released, 'promo_release', p_club_id,
       'Promo bonus released to cashable balance after playthrough met',
       'promo_release:' || p_club_id::text || ':' || p_user_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
    UPDATE club_members
       SET chip_balance               = COALESCE(chip_balance, 0) + v_released,
           promo_balance              = 0,
           promo_playthrough_required = 0,
           promo_wagered              = 0,
           updated_at                 = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
    PERFORM set_config('app.ledger_autoskip_club_members', '0', true);

    INSERT INTO chip_transactions (id, club_id, to_user_id, amount, transaction_type, notes, created_at)
    VALUES (gen_random_uuid(), p_club_id, p_user_id, v_released, 'promo_released',
            'Promo bonus released to cashable balance after playthrough met', NOW());
  ELSE
    UPDATE club_members
       SET promo_wagered = v_wagered, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'released', v_released,
                            'wagered', v_wagered, 'required', v_required);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Declarations: a trigger on a money table declares itself; a guard is watched
-- ---------------------------------------------------------------------------

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT x.t, x.g, x.n
  FROM (VALUES
    ('club_members',  'zy_ca_tally_balance_move',
     'a_balance_never_moves_without_its_ledger_row: adds the chip_balance delta to the transaction tally (setting ca.ledger_tally). Reads nothing, writes nothing, never refuses.'),
    ('club_members',  'zz_ca_balance_has_its_ledger_row',
     'a_balance_never_moves_without_its_ledger_row: deferred to commit; refuses REFUSED: balance_moved_without_its_ledger_row when a player wallet moved by a different amount than its chip_ledger legs in the same transaction (observe mode records to ca_ledger_invariant_findings instead).'),
    ('table_seats',   'zy_ca_tally_balance_move',
     'a_balance_never_moves_without_its_ledger_row: adds the cash-felt delta (stack while seated on a chip cash table) to the transaction tally. Reads tables and clubs by primary key; writes nothing; never refuses.'),
    ('table_seats',   'zz_ca_balance_has_its_ledger_row',
     'a_balance_never_moves_without_its_ledger_row: deferred to commit; refuses REFUSED: balance_moved_without_its_ledger_row when the cash felt moved by a different amount than the table_stack legs in the same transaction.'),
    ('union_wallets', 'zy_ca_tally_balance_move',
     'a_balance_never_moves_without_its_ledger_row: adds the union bank and union wallet deltas to the transaction tally. Writes nothing; never refuses.'),
    ('union_wallets', 'zz_ca_balance_has_its_ledger_row',
     'a_balance_never_moves_without_its_ledger_row: deferred to commit; refuses REFUSED: balance_moved_without_its_ledger_row when a union bank or wallet moved by a different amount than its legs in the same transaction.'),
    ('chip_ledger',   'zy_ca_tally_ledger_leg',
     'a_balance_never_moves_without_its_ledger_row: adds +amount to the leg''s to-account and -amount to its from-account in the transaction tally. Writes nothing; never refuses.'),
    ('chip_ledger',   'zz_ca_ledger_row_has_its_balance',
     'a_balance_never_moves_without_its_ledger_row: deferred to commit; refuses REFUSED: balance_moved_without_its_ledger_row when a leg names a covered account whose balance did not move by that amount in the same transaction.')
  ) AS x(t, g, n)
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
RETURNS text[]
LANGUAGE sql
STABLE
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- The Diamond satellite seat door (Phase 9, 2026-09-21): a satellite
      -- seat moved custody to custody, out of one prize bank into an entry.
      'fn_poker_diamond_tournament_seat_transfer',
      -- A balance never moves without its ledger row (2026-10-01): the tally,
      -- its two sides, the account key and the commit-time check.
      'fn_ca_ledger_tally_add','fn_ca_ledger_tally_key','fn_ca_felt_counts_table',
      'fn_ca_tally_balance_move','fn_ca_tally_ledger_leg','fn_ca_balance_has_its_ledger_row',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_guard_watchlist', 'migration 20261001160611_a_balance_never_moves_without_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_ledger_tally_add', 'migration 20261001160611_a_balance_never_moves_without_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_ledger_tally_key', 'migration 20261001160611_a_balance_never_moves_without_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_felt_counts_table', 'migration 20261001160611_a_balance_never_moves_without_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_balance_move', 'migration 20261001160611_a_balance_never_moves_without_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_ledger_leg', 'migration 20261001160611_a_balance_never_moves_without_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_balance_has_its_ledger_row', 'migration 20261001160611_a_balance_never_moves_without_its_ledger_row');

-- ---------------------------------------------------------------------------
-- 8. The migration refuses to commit unless the invariant is installed whole
-- ---------------------------------------------------------------------------

DO $m$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(x.t || '.' || x.g, ', ') INTO v_missing
    FROM (VALUES
      ('club_members','zy_ca_tally_balance_move'), ('club_members','zz_ca_balance_has_its_ledger_row'),
      ('clubs','zy_ca_tally_balance_move'), ('clubs','zz_ca_balance_has_its_ledger_row'),
      ('table_seats','zy_ca_tally_balance_move'), ('table_seats','zz_ca_balance_has_its_ledger_row'),
      ('table_pending_addons','zy_ca_tally_balance_move'), ('table_pending_addons','zz_ca_balance_has_its_ledger_row'),
      ('union_wallets','zy_ca_tally_balance_move'), ('union_wallets','zz_ca_balance_has_its_ledger_row'),
      ('bbj_pools','zy_ca_tally_balance_move'), ('bbj_pools','zz_ca_balance_has_its_ledger_row'),
      ('chip_ledger','zy_ca_tally_ledger_leg'), ('chip_ledger','zz_ca_ledger_row_has_its_balance')
    ) AS x(t, g)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = x.t AND tg.tgname = x.g
        AND tg.tgenabled <> 'D'
        AND (x.g NOT LIKE 'zz_%' OR (tg.tgdeferrable AND tg.tginitdeferred)));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger invariant is not installed whole: %', v_missing;
  END IF;
  IF (SELECT count(*) FROM public.ca_ledger_invariant_mode) <> 1 THEN
    RAISE EXCEPTION 'ca_ledger_invariant_mode must hold exactly one row';
  END IF;
  RAISE NOTICE 'a balance never moves without its ledger row: tally and commit-time check installed on club_members, clubs, table_seats, table_pending_addons, union_wallets, bbj_pools and chip_ledger; mode = %',
    (SELECT mode FROM public.ca_ledger_invariant_mode);
END $m$;

COMMIT;
