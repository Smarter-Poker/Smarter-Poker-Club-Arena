-- ===========================================================================
--  NO BALANCE MOVES AGAINST SETTLEMENT SUSPENSE
-- ===========================================================================
--
-- Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip
-- drifts should not be possible."
--
-- 20261001160611 .. 20261002042417 put all fifteen chip stores under the
-- commit-time ledger check, and all fifteen refuse: a transaction in which a
-- store's balance and its chip_ledger legs disagree does not commit. One hole
-- was left, and it is the oldest one on the platform:
--
-- THE HOLE. A store balances when its balance delta equals the net of the legs
-- that name it. It does not ask where the other end of the leg went. The two
-- journal triggers, fn_ca_autoledger and fn_club_members_ledger_writer, post a
-- balance write's counter-leg to app.ledger_counterparty, and when the writer
-- declared nothing they default it to 'settlement_suspense' - a journal label
-- with no balance column, outside the supply count. So an undeclared write to
-- any covered balance still commits: the store balances (its delta and its
-- auto-written leg agree, by construction) and the chips appear from, or
-- vanish into, suspense. Nothing refused it.
--
-- WHAT THE ROWS SAY (read 2026-10-02 06:50 UTC, chip_ledger, 30 days)
--   * 7,740 legs / 2,827 transactions / 1,722,820.60 moved a covered balance
--     against suspense - every one written by a journal trigger's default
--     counterparty ('auto-ledgered ...' / 'auto-audited ...'), 2026-09-02 to
--     2026-09-14 06:27:40 UTC, and none since.
--   * 16 legs / 2 transactions were journal-only restatements through
--     fn_ca_post_correction (2026-09-06, and the owner-authorised 2026-09-26
--     restatement of suspense); 59 legs / 4 transactions were journal-only
--     correction legs written by settlement migrations (2026-09-07 .. 09-09).
--   * Zero legs of any kind against settlement_suspense since 2026-09-26
--     07:23:52 UTC. Every live door declares its counterparty today.
--   * The writers in pg_proc: the two journal triggers' default (the hole
--     itself), fn_union_credit_wallet_zd3core (an unmapped tx_type declares
--     nothing and falls to the default), and the journal-only restatement
--     fn_ca_restate_settlement_suspense_20260926 via fn_ca_post_correction.
--     The rest of the 25 bodies that name settlement_suspense only read it or
--     carry it in a comment.
--   The open suspense balance (the owner-pending restatement) is not touched,
--   read into or moved by this file.
--
-- THE FIX, in the tally the invariant already keeps:
--   * fn_ca_tally_ledger_leg counts every chip_ledger leg with
--     settlement_suspense on either side, BEFORE the journal-only correction
--     exemption, under the tally key 'settlement_suspense' (side 's', the
--     absolute amount). fn_ca_ledger_tally_key never returns that key, so it
--     can never collide with a store.
--   * fn_ca_balance_has_its_ledger_row, after it has checked every store,
--     refuses a transaction that wrote a suspense leg AND moved any covered
--     balance: REFUSED: balance_moved_against_settlement_suspense. A
--     journal-only suspense correction - no covered balance moved - still
--     commits, and so does every declared door.
--   * The judgement has its own row in ca_ledger_invariant_store_mode,
--     'settlement_suspense', installed here in OBSERVE: a transaction that
--     would be refused records a finding (account_key 'settlement_suspense')
--     and commits. A later migration flips it to refuse once the window
--     shows zero findings under live traffic.
--
-- LOCKS. Two function bodies and one row; nothing is created on or dropped
-- from a hot table. chip_ledger's ShareRowExclusive lock is taken alone,
-- first, under a 250 ms lock_timeout, rolled back and retried after 100 ms, so
-- no transaction straddles the swap (a leg tallied by the old body and judged
-- by the new one) and no live writer waits on this file longer than 250 ms.
--
-- CLAUDE.md section 2: one migration, one transaction. Applied once, by
-- apply-merged-migration.yml, outside :50-:03 UTC.
-- ===========================================================================
-- @live-proof: (SELECT mode FROM public.ca_ledger_invariant_store_mode WHERE store = 'settlement_suspense') = 'observe'

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Preimage: the bodies this file builds on are the ones read on 2026-10-02
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  r record;
  v_live text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('fn_ca_tally_ledger_leg',           '964fe0137d2416f5ce1740de0499f4da'),
      ('fn_ca_balance_has_its_ledger_row', 'bdaa9b8a631850651793f373f9b2f059')) AS x(f, m)
  LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.f;
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the body read on 2026-10-02 (md5 %, expected %); re-read it before redefining it', r.f, v_live, r.m;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE store = 'settlement_suspense') THEN
    RAISE EXCEPTION 'preimage: the settlement_suspense judgement is already installed; read the live row';
  END IF;
  IF (SELECT mode FROM public.ca_ledger_invariant_mode) IS DISTINCT FROM 'refuse' THEN
    RAISE EXCEPTION 'preimage: ca_ledger_invariant_mode must be refuse';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. chip_ledger's lock first, alone, or not at all
-- ---------------------------------------------------------------------------

DO $m$
DECLARE v_tries int := 0;
BEGIN
  PERFORM set_config('lock_timeout', '250ms', true);
  LOOP
    BEGIN
      LOCK TABLE public.chip_ledger IN SHARE ROW EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      v_tries := v_tries + 1;
      IF v_tries >= 240 THEN
        RAISE EXCEPTION 'the chip_ledger ShareRowExclusive lock could not be taken in % tries (about 90 s); nothing was applied - apply once more when the platform is quieter, never in a loop', v_tries;
      END IF;
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '8s', true);
  RAISE NOTICE 'suspense invariant: chip_ledger ShareRowExclusive taken after % failed tries', v_tries;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. The judgement's mode: observe
-- ---------------------------------------------------------------------------

INSERT INTO public.ca_ledger_invariant_store_mode (store, mode, reason)
VALUES ('settlement_suspense', 'observe',
        'NO_BALANCE_AGAINST_SUSPENSE: a transaction that writes a settlement_suspense leg and moves any covered chip balance; observed first, refused once the window reads zero');

-- ---------------------------------------------------------------------------
-- 3. The tally counts every suspense leg
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_tally_ledger_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  /* SETTLEMENT SUSPENSE IS NOT A COUNTERPARTY FOR A BALANCE (2026-10-02).
     Every leg with settlement_suspense on either side is counted, before the
     journal-only exemption below, under a key no store resolves to. The
     commit check refuses a transaction that wrote one and moved any covered
     balance; a journal-only correction moves none and still commits. */
  IF NEW.from_type = 'settlement_suspense' OR NEW.to_type = 'settlement_suspense' THEN
    PERFORM public.fn_ca_ledger_tally_add('settlement_suspense', 's', abs(NEW.amount));
  END IF;
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
REVOKE ALL ON FUNCTION public.fn_ca_tally_ledger_leg() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The commit check judges it
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
  v_s numeric; v_moved text; v_moved_abs numeric;
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

    /* 2026-10-02: each store is judged by its own mode
       (ca_ledger_invariant_store_mode, keyed by the account-key prefix), so a
       store still being measured records a finding while a proven store
       refuses. A store with no row falls back to the one global row. */
    v_mode := COALESCE(
      (SELECT sm.mode FROM public.ca_ledger_invariant_store_mode sm WHERE sm.store = split_part(r.key, ':', 1)),
      (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1),
      'refuse');

    IF v_mode = 'refuse' THEN
      RAISE EXCEPTION 'REFUSED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=%',
        r.key, v_b, v_l
        USING ERRCODE = '23514',
              DETAIL  = CASE
                          WHEN v_l = 0 THEN 'the balance column moved and no chip_ledger leg in this transaction accounts for it'
                          WHEN v_b = 0 THEN 'a chip_ledger leg names this account and its balance column did not move in this transaction'
                          ELSE 'the balance column and the chip_ledger legs in this transaction disagree on how much moved'
                        END || '; first written in this transaction by: ' || COALESCE(r.value ->> 'q', '(unknown statement)'),
              HINT    = 'Every chip movement is written by its door as balance + leg in one transaction. If the door stood the autoledger down (app.ledger_autoskip_<table>), its own leg must equal the delta and name the same user, club, union, pool, table, tournament or ticket float. Nothing is corrected here; the transaction is refused whole.';
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
    RAISE WARNING 'OBSERVED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=% (store mode observe; this transaction would be refused)',
      r.key, v_b, v_l;
  END LOOP;

  /* NO BALANCE MOVES AGAINST SETTLEMENT SUSPENSE (2026-10-02). Every store
     above can balance and the chips still come from nowhere: a journal
     trigger whose writer declared no counterparty posts the store's leg
     against settlement_suspense, which holds no balance and is outside the
     supply count. A transaction that wrote a suspense leg may not move any
     covered balance. A journal-only suspense correction moves none. */
  v_s := round(COALESCE((t -> 'settlement_suspense' ->> 's')::numeric, 0), 2);
  IF v_s <> 0 THEN
    SELECT string_agg(e.key || ' ' || round((e.value ->> 'b')::numeric, 2)::text, ', ' ORDER BY e.key),
           sum(abs(round((e.value ->> 'b')::numeric, 2)))
      INTO v_moved, v_moved_abs
      FROM jsonb_each(t) e
     WHERE e.key <> 'settlement_suspense'
       AND round(COALESCE((e.value ->> 'b')::numeric, 0), 2) <> 0;

    IF v_moved IS NOT NULL THEN
      v_mode := COALESCE(
        (SELECT sm.mode FROM public.ca_ledger_invariant_store_mode sm WHERE sm.store = 'settlement_suspense'),
        (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1),
        'refuse');

      IF v_mode = 'refuse' THEN
        RAISE EXCEPTION 'REFUSED: balance_moved_against_settlement_suspense suspense_legs=% moved=%',
          v_s, v_moved
          USING ERRCODE = '23514',
                DETAIL  = 'this transaction wrote a chip_ledger leg against settlement_suspense, which holds no balance and is outside the supply count, and moved a covered chip balance; the suspense leg was first written by: '
                          || COALESCE(t -> 'settlement_suspense' ->> 'q', '(unknown statement)'),
                HINT    = 'A door names where its chips come from and go to: app.ledger_counterparty (+ app.ledger_counterparty_entity) before the balance write, or app.ledger_autoskip_<table> and its own leg. An undeclared journal trigger falls to settlement_suspense, and that is what is refused here. A journal-only correction that moves no balance is not affected.';
      END IF;

      INSERT INTO public.ca_ledger_invariant_findings
        (txid, account_key, balance_delta, ledger_net, mode, actor_service, db_role, statement)
      VALUES
        (pg_current_xact_id(), 'settlement_suspense', v_moved_abs, v_s, v_mode,
         current_setting('application_name', true), current_user,
         left(COALESCE(t -> 'settlement_suspense' ->> 'q', left(current_query(), 300)) || ' | moved: ' || v_moved, 1000))
      ON CONFLICT (txid, account_key) DO UPDATE
        SET balance_delta = EXCLUDED.balance_delta,
            ledger_net    = EXCLUDED.ledger_net,
            found_at      = EXCLUDED.found_at,
            statement     = EXCLUDED.statement;
      RAISE WARNING 'OBSERVED: balance_moved_against_settlement_suspense suspense_legs=% moved=% (mode observe; this transaction would be refused)',
        v_s, v_moved;
    END IF;
  END IF;

  PERFORM set_config('ca.ledger_tally_checked', v_ver, true);
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_balance_has_its_ledger_row() FROM PUBLIC, anon, authenticated;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_ledger_leg', 'migration 20261002065836_no_balance_moves_against_settlement_suspense');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_balance_has_its_ledger_row', 'migration 20261002065836_no_balance_moves_against_settlement_suspense');

-- ---------------------------------------------------------------------------
-- 5. Read back
-- ---------------------------------------------------------------------------

DO $post$
BEGIN
  IF (SELECT mode FROM public.ca_ledger_invariant_store_mode WHERE store = 'settlement_suspense') IS DISTINCT FROM 'observe' THEN
    RAISE EXCEPTION 'the settlement_suspense judgement did not read back observe';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE store <> 'settlement_suspense' AND mode <> 'refuse') THEN
    RAISE EXCEPTION 'a chip store stopped refusing';
  END IF;
  IF position('settlement_suspense' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_ca_tally_ledger_leg()'::regprocedure)) = 0
     OR position('balance_moved_against_settlement_suspense' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_ca_balance_has_its_ledger_row()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the suspense tally or its judgement did not install';
  END IF;
  RAISE NOTICE 'no balance moves against settlement suspense: installed in observe';
END $post$;

COMMIT;
