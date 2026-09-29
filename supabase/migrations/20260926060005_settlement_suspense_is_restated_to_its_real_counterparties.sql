-- 20260926060005_settlement_suspense_is_restated_to_its_real_counterparties.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- OWNER AUTHORIZATION (Dan, the owner, 2026-09-26, verbatim): "Post correction
-- legs to zero it". settlement_suspense is declared must_be_zero in
-- ca_ledger_accounts and stands at +4,170,904.48 on the journal. Post audited
-- correction entries naming the real counterparty for each unpaired
-- observation, following the correction precedent already in the journal.
-- No chips move; the account reads zero; the critical incident closes.
--
-- WHAT THE 4,170,904.48 IS (read 2026-09-26 from production, every leg).
-- fn_ca_autoledger watches balance columns; a writer that does not declare
-- app.ledger_counterparty gets settlement_suspense as the other side. 12,419
-- legs touch suspense. Pairing them by exact instant and amount, 5,750 pair off
-- (17,310,078.63 each way: A->suspense and suspense->B in one transaction is a
-- transfer A->B routed through the corridor, and needs nothing). Eight more
-- legs are four cross-instant pairs already cancelled by earlier corrections
-- (the two bubble-protection twins of 2026-09-09, the 100.00 spin prize of
-- 2026-09-07, and the 8.00 draw of cancelled spin 98e4b933 that came back to
-- the reserve as its surplus_return). The remaining 6,661 legs are the whole
-- balance, and each is the journal of a real balance change whose OTHER side
-- was written somewhere else. By finding:
--
--  L01  416 legs  +4,160,000.00  agent_wallet -> suspense, 2026-09-01 14:02-14:23.
--       Each has a same-instant, same-amount twin table_stack(NULL) ->
--       player_wallet written by the club_members watcher: one agent -> member
--       distribution, observed once per side. The member credit was journaled
--       against the unattributed felt position table_stack(NULL), so that is
--       the side that owes the suspense leg.
--  L02 3,791 legs  +214,665.00  spin_prize draws, 2026-09-01 19:14 -> 09-02 22:05.
--       Every draw maps to its spin_reserve_ledger jackpot_draw row and its
--       tournament; 3,755 winners were paid exactly the draw (36 more than the
--       draw), all through table_stack(NULL) -> player_wallet. prize_liability
--       cannot take the leg: all 3,791 events are COMPLETED and
--       fn_terminal_tournament_evidence_is_immutable refuses new journal
--       evidence on a terminal tournament; their prize_liability journal is
--       left exactly as it is.
--  L03  626 legs  -41,342.04   suspense -> spin_reserve 2d968239 contributions
--  L04  626 legs  +39,874.00   spin_reserve 2d968239 -> suspense draws
--       (2026-08-31 14:41 -> 09-06 12:50, before the spin writer declared its
--       categories): the buy-ins and payouts of those spins are journaled
--       player_wallet <-> table_stack(NULL), the same unattributed position.
--  L05   12 legs  +1,269.00    union_bank -> suspense: guarantee overlays of
--       twelve completed tournaments (terminal, so not prize_liability).
--  L06    1 leg      +246.82   club treasury -> suspense, fn_charge_place_overpays:
--       duplicate-place overpays already paid to players through table_stack(NULL).
--  L07    4 legs     +108.00   tournament buy-ins "counterparty prize_liability
--       rejected"; the four events are COMPLETED (terminal evidence).
--  L08    1 leg       +10.00   ca_ledger_write_failures 825 compensation, a
--       10.00 tournament buy-in whose event the failure never named.
--  L09 1,023 legs  -5,162.49   suspense -> union rake wallet, rake off the felt
--  L10   27 legs     -70.75    suspense -> club_wallet rake mirror (same hands)
--  L11  115 legs     -19.55    suspense -> bbj_pool contributions off the felt
--  L12    2 legs    -119.53    suspense -> player_wallet table cash-outs
--       (L09-L12: the table the chips left is not recorded on the leg).
--  L13   13 legs  +3,423.12    owner-ordered pool/bank resets of 2026-09-01
--       (migrations deep_stack_*_clean_slate and ..._opening_baseline): chips
--       removed by fiat, i.e. retired.
--  L14    2 legs  -1,977.10    the same opening baseline SET the BBJ to 1,000
--       (main 977.10 and the legacy pool_amount seed 1,000.00 that
--       fn_bbj_conservation_check itself records as a 1,000.00 opening seed
--       with no inflow row): chips created by fiat, i.e. issued.
--  L15    2 legs -200,000.00   certification clubs b87a0572 / 9edb6de2 were
--       created with a 100,000.00 treasury by direct write on 2026-08-31 19:53
--       and retired through chip_retirement (cert-retire keys) on 09-03: the
--       opening grant was issuance that the journal never named.
--  Total 6,661 legs, +4,170,904.48.
--
-- HOW, AND WHY NO CHIP MOVES. Every correction goes through the existing
-- correction authority, fn_ca_post_correction, unchanged: one leg per linked
-- incident, full request intent retained in ca_correction_request_intents_v1,
-- metadata posted_via = 'fn_ca_post_correction'. That writer INSERTs one
-- chip_ledger row and touches no balance column; the platform already reads
-- that exact marker as "journal only" (fn_ca_trial_balance, the supply meter,
-- the mint register). Because the writer takes ONE leg per incident by design,
-- each finding files its own info incident (the linkage the writer requires),
-- posts its one leg, and is resolved in the same transaction. The operation
-- fingerprints every balance-bearing table before and after inside one
-- REPEATABLE READ snapshot and refuses to commit unless they are identical.
--
-- WHY FOUR DETECTOR READS CHANGE (the minimal guarded extension). The flow
-- readers of suspense - the flow arm of fn_ca_suspense_regression_check,
-- fn_ca_quick_reconcile 3g, fn_ca_undeclared_leg_check and
-- fn_ca_chip_store_coverage_gaps - count every leg that touches suspense as
-- UNDECLARED flow. A correction is the opposite: it names its counterparty and
-- moves nothing. They now exclude exactly what fn_ca_trial_balance and
-- fn_ca_supply_snapshot already exclude (category 'correction' posted via
-- fn_ca_post_correction). The balance arm still counts every leg.
-- And the balance arm's own closure branch could never have closed: it wrote
-- closure_basis 'condition_no_longer_holds', which ca_drift_incidents'
-- CHECK does not allow, and no correction_ref, which
-- fn_ca_resolution_needs_a_cause refuses. It now closes with the vocabulary
-- the table has for a re-measured all-clear: closure_basis
-- 'verified_remeasured' and correction_ref 'verified: ...'.
--
-- BOUNDED AND ONE-OFF. fn_ca_restate_settlement_suspense_20260926 accepts one
-- operation id, recomputes the unpaired set from the live journal, and refuses
-- unless every finding's leg count, amount and id-list md5 equal the audited
-- figures above. A replay returns the receipt and posts nothing. No cron,
-- watcher, reconciler or loop is added.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

DO $precondition$
DECLARE v_md5 text; r record;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'install as postgres';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)', '4492ef51ddb64edfac10a0535efb40b5'),
      ('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)', 'a6df5f2eef07aa3f606db79d93944590'),
      ('public.fn_ca_suspense_regression_check()', 'd55850b430002d4292079a2dff72c99a'),
      ('public.fn_ca_quick_reconcile()', '1fa22b57be6709733e7b851aa1fb4005'),
      ('public.fn_ca_undeclared_leg_check(integer)', '60f7054727b0c73fac21e68468fb71fd'),
      ('public.fn_ca_chip_store_coverage_gaps()', 'a7f4a0cefa56955937376a810cb13d60'),
      ('public.fn_ca_declare_guard_redefinition(text,text)', '3a3746dc6e0a5b7a1db97805588c0eb8'),
      ('public.fn_ca_resolution_needs_a_cause()', '48547879bc49d84f5898e8cb44fe1951')
    ) v(sig, want)
  LOOP
    SELECT md5(pg_get_functiondef(to_regprocedure(r.sig))) INTO v_md5;
    IF v_md5 IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '% is not the reviewed definition (md5 %); re-review before applying',
        r.sig, COALESCE(v_md5, 'absent');
    END IF;
  END LOOP;
  IF to_regclass('public.ca_journal_restatements') IS NOT NULL
     OR to_regclass('public.ca_journal_restatement_legs') IS NOT NULL
     OR to_regprocedure('public.fn_ca_restate_must_be_zero_account(uuid,text,jsonb,jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_restate_settlement_suspense_20260926(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'journal restatement objects already exist; this migration is never replayed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_ledger_accounts
                  WHERE account_type = 'settlement_suspense' AND must_be_zero) THEN
    RAISE EXCEPTION 'settlement_suspense is not declared must_be_zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_must_be_zero_state WHERE account_type = 'settlement_suspense') THEN
    RAISE EXCEPTION 'the must_be_zero balance arm has no state row for settlement_suspense';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.ca_drift_incidents'::regclass
                    AND conname = 'ca_drift_incidents_closure_basis_check'
                    AND pg_get_constraintdef(oid) LIKE '%verified_remeasured%'
                    AND pg_get_constraintdef(oid) LIKE '%repair%') THEN
    RAISE EXCEPTION 'ca_drift_incidents closure_basis vocabulary is not the reviewed one';
  END IF;
END $precondition$;

-- ---------------------------------------------------------------------------
-- 1. THE FLOW READERS STOP COUNTING A DECLARED CORRECTION AS UNDECLARED FLOW,
--    AND THE BALANCE ARM CAN CLOSE WHAT IT OPENS. Each definition is edited in
--    place from its exact installed text: the precondition above pinned the
--    text, each snippet must occur exactly the stated number of times, and the
--    result must hash to the reviewed successor.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  r record; v_def text; v_new text; v_n int; v_md5 text;
  c_marker constant text :=
    'category = ''correction'' AND metadata ->> ''posted_via'' = ''fn_ca_post_correction''';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    (1, 'public.fn_ca_suspense_regression_check()',
     E'       AND created_at > v_since;\n', 1,
     E'       AND created_at > v_since\n'
     || E'       -- A leg posted through fn_ca_post_correction names its counterparty and\n'
     || E'       -- moves no balance (the rule fn_ca_trial_balance and fn_ca_supply_snapshot\n'
     || E'       -- already apply). It is not undeclared flow; the balance arm counts it.\n'
     || E'       AND NOT (category = ''correction''\n'
     || E'                AND metadata ->> ''posted_via'' = ''fn_ca_post_correction'');\n'),
    (2, 'public.fn_ca_suspense_regression_check()',
     E'               closure_basis = ''condition_no_longer_holds''\n', 1,
     E'               /* The CHECK on ca_drift_incidents knows a re-measured all-clear as\n'
     || E'                  verified_remeasured, and fn_ca_resolution_needs_a_cause wants\n'
     || E'                  the evidence written down: the balance this run just read. */\n'
     || E'               closure_basis = ''verified_remeasured'',\n'
     || E'               correction_ref = COALESCE(NULLIF(btrim(correction_ref), ''''),\n'
     || E'                 format(''verified: balance arm re-measured %s at %s, within %s of zero'',\n'
     || E'                        v_acct.account_type, v_balance, v_tolerance)),\n'
     || E'               root_cause = CASE WHEN length(btrim(COALESCE(root_cause, ''''))) >= 40\n'
     || E'                 THEN root_cause\n'
     || E'                 ELSE format(''%s stood away from zero on the journal until the balance arm re-measured it at %s'',\n'
     || E'                             v_acct.account_type, v_balance) END\n'),
    (3, 'public.fn_ca_quick_reconcile()',
     'created_at > GREATEST(CURRENT_DATE::timestamptz, ''2026-09-01 00:17:00+00''::timestamptz)', 2,
     'created_at > GREATEST(CURRENT_DATE::timestamptz, ''2026-09-01 00:17:00+00''::timestamptz)'
     || ' AND NOT (category = ''correction'' AND metadata ->> ''posted_via'' = ''fn_ca_post_correction'')'),
    (4, 'public.fn_ca_undeclared_leg_check(integer)',
     E'       AND ''settlement_suspense'' IN (from_type, to_type)\n', 1,
     E'       AND ''settlement_suspense'' IN (from_type, to_type)\n'
     || E'       -- a correction posted through fn_ca_post_correction IS the name\n'
     || E'       AND NOT (category = ''correction''\n'
     || E'                AND metadata ->> ''posted_via'' = ''fn_ca_post_correction'')\n'),
    (5, 'public.fn_ca_chip_store_coverage_gaps()',
     E'       WHERE l.created_at > now() - interval ''24 hours''\n', 1,
     E'       WHERE l.created_at > now() - interval ''24 hours''\n'
     || E'         -- the supply basis excludes exactly these legs (fn_ca_supply_snapshot)\n'
     || E'         AND NOT (l.category = ''correction''\n'
     || E'                  AND l.metadata ->> ''posted_via'' = ''fn_ca_post_correction'')\n')
  ) v(step, sig, old_text, occurrences, new_text) ORDER BY step
  LOOP
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    v_n := (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text);
    IF v_n <> r.occurrences THEN
      RAISE EXCEPTION 'step %: % holds the reviewed snippet % time(s), expected %',
        r.step, r.sig, v_n, r.occurrences;
    END IF;
    v_new := replace(v_def, r.old_text, r.new_text);
    EXECUTE v_new;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
      ('public.fn_ca_suspense_regression_check()', '7315bea1dd3819c9cc2935668e108d8c'),
      ('public.fn_ca_quick_reconcile()', '89691752a5e2272cf53e0f55773eca30'),
      ('public.fn_ca_undeclared_leg_check(integer)', '953497d9b5fc13e131dab34956f9310b'),
      ('public.fn_ca_chip_store_coverage_gaps()', '9f44a12318e13f1ef9942ed2a2758d1a')
    ) v(sig, want)
  LOOP
    SELECT md5(pg_get_functiondef(to_regprocedure(r.sig))) INTO v_md5;
    IF v_md5 IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '% successor is not the reviewed definition (md5 %)', r.sig, v_md5;
    END IF;
  END LOOP;
END $patch$;

-- Both watched guards declare the redefinition in this transaction, so
-- fn_ca_guard_defs_watch records it rather than raising a notice.
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_suspense_regression_check',
  'migration 20260926060005_settlement_suspense_is_restated_to_its_real_counterparties');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_quick_reconcile',
  'migration 20260926060005_settlement_suspense_is_restated_to_its_real_counterparties');

-- ---------------------------------------------------------------------------
-- 2. THE RECEIPT. One row per operation, one row per restated journal leg.
--    A journal leg can be restated once, ever (primary key).
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_journal_restatements (
  operation_id        uuid PRIMARY KEY,
  account_type        text NOT NULL,
  owner_authorization jsonb NOT NULL,
  balance_before      numeric NOT NULL,
  balance_after       numeric NOT NULL,
  findings            jsonb NOT NULL,
  legs_restated       integer NOT NULL,
  corrections_posted  integer NOT NULL,
  fingerprint_before  jsonb NOT NULL,
  fingerprint_after   jsonb NOT NULL,
  posted_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (balance_after = 0),
  CHECK (fingerprint_before = fingerprint_after)
);
COMMENT ON TABLE public.ca_journal_restatements IS
  'Owner-authorized journal-only restatements of a must_be_zero account (fn_ca_restate_must_be_zero_account). One row per operation id; a replay returns this row and posts nothing. No chip moves: fingerprint_before = fingerprint_after is the balance-table proof taken inside the posting transaction.';

CREATE TABLE public.ca_journal_restatement_legs (
  corrected_leg_id      uuid PRIMARY KEY,
  operation_id          uuid NOT NULL REFERENCES public.ca_journal_restatements (operation_id) DEFERRABLE INITIALLY DEFERRED,
  finding               text NOT NULL,
  correction_ledger_id  uuid NOT NULL,
  incident_id           uuid NOT NULL
);
CREATE INDEX ca_journal_restatement_legs_correction ON public.ca_journal_restatement_legs (correction_ledger_id);
COMMENT ON TABLE public.ca_journal_restatement_legs IS
  'Which correction leg restates which original journal leg. No foreign key to chip_ledger on purpose (a scan table never locks a hot relation, CLAUDE.md production DDL rule 7).';

CREATE FUNCTION public.ca_journal_restatement_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $fn$;
CREATE TRIGGER ca_journal_restatements_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.ca_journal_restatements
  FOR EACH STATEMENT EXECUTE FUNCTION public.ca_journal_restatement_append_only();
CREATE TRIGGER ca_journal_restatement_legs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.ca_journal_restatement_legs
  FOR EACH STATEMENT EXECUTE FUNCTION public.ca_journal_restatement_append_only();

ALTER TABLE public.ca_journal_restatements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_journal_restatement_legs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_journal_restatements, public.ca_journal_restatement_legs
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_journal_restatements, public.ca_journal_restatement_legs TO service_role;
REVOKE ALL ON FUNCTION public.ca_journal_restatement_append_only() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE ENGINE. Journal only: its one money-journal write is
--    fn_ca_post_correction. postgres only; reached through the one-off below.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_balance_table_fingerprint() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  /* Order-independent content hash of every balance-bearing row. Compared
     inside ONE repeatable-read snapshot, equality means this transaction wrote
     no balance anywhere. */
  SELECT jsonb_build_object(
    'club_members',        (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.club_members t),
    'clubs',               (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.clubs t),
    'club_wallets',        (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.club_wallets t),
    'union_wallets',       (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.union_wallets t),
    'agents',              (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.agents t),
    'bbj_pools',           (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.bbj_pools t),
    'spin_bonus_pools',    (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.spin_bonus_pools t),
    'tournaments',         (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.tournaments t),
    'tournament_escrow',   (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.tournament_escrow t),
    'table_seats',         (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.table_seats t),
    'chip_escrow',         (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.chip_escrow t),
    'chip_escrow_holds',   (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.chip_escrow_holds t),
    'wallets',             (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.wallets t),
    'tournament_tickets',  (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.tournament_tickets t),
    'club_opening_setups', (SELECT jsonb_build_array(count(*), sum(hashtextextended(t::text, 0)::numeric)) FROM public.club_opening_setups t))
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_balance_table_fingerprint() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_ca_restate_must_be_zero_account(
  p_operation_id uuid, p_account text, p_plan jsonb, p_authorization jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_receipt jsonb; v_before numeric; v_after numeric; v_plan_total numeric := 0;
  v_fp_before jsonb; v_fp_after jsonb; f jsonb; v_legs uuid[]; v_amount numeric;
  v_dir text; v_cp_type text; v_cp_entity uuid; v_n int; v_sum numeric; v_inc uuid;
  v_res jsonb; v_ledger uuid; v_reason text; v_posted int := 0; v_restated int := 0;
  v_findings jsonb := '[]'::jsonb; v_parent uuid; v_meta jsonb;
BEGIN
  IF p_operation_id IS NULL OR COALESCE(p_account, '') = '' THEN
    RAISE EXCEPTION 'operation id and account are required';
  END IF;
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca-journal-restatement:' || p_account, 0));

  -- A replay is answered from the receipt and posts nothing.
  SELECT to_jsonb(r) INTO v_receipt FROM public.ca_journal_restatements r
   WHERE r.operation_id = p_operation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'corrections_posted', 0,
                              'receipt', v_receipt);
  END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'repeatable_read_required: the no-chips-move proof compares one snapshot with itself'
      USING ERRCODE = '25001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ca_ledger_accounts a
                  WHERE a.account_type = p_account AND a.must_be_zero) THEN
    RAISE EXCEPTION '% is not a must_be_zero account', p_account;
  END IF;
  IF COALESCE(p_authorization ->> 'by', '') = '' OR COALESCE(p_authorization ->> 'text', '') = ''
     OR COALESCE(p_authorization ->> 'on', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'an owner authorization {by, on, text} is required';
  END IF;
  IF jsonb_typeof(p_plan) <> 'array' OR jsonb_array_length(p_plan) = 0 THEN
    RAISE EXCEPTION 'the plan must be a non-empty array of findings';
  END IF;

  SELECT COALESCE(round(sum(CASE WHEN l.to_type = p_account THEN l.amount ELSE -l.amount END), 2), 0)
    INTO v_before
    FROM public.chip_ledger l
   WHERE (l.from_type = p_account) <> (l.to_type = p_account);
  v_fp_before := public.fn_ca_balance_table_fingerprint();

  FOR f IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
    v_dir := f ->> 'direction';
    v_cp_type := f ->> 'counterparty_type';
    v_cp_entity := NULLIF(f ->> 'counterparty_entity', '')::uuid;
    v_amount := (f ->> 'amount')::numeric;
    v_reason := f ->> 'reason';
    SELECT array_agg(value::uuid) INTO v_legs FROM jsonb_array_elements_text(f -> 'legs');
    IF v_dir NOT IN ('out_of_account', 'into_account') OR v_amount IS NULL OR v_amount <= 0
       OR v_amount <> round(v_amount, 2) OR COALESCE(cardinality(v_legs), 0) = 0
       OR COALESCE(f ->> 'finding', '') = '' OR length(COALESCE(v_reason, '')) < 40 THEN
      RAISE EXCEPTION 'finding % is malformed', COALESCE(f ->> 'finding', '?');
    END IF;
    IF v_cp_type IS NULL OR v_cp_type = p_account
       OR NOT EXISTS (SELECT 1 FROM public.ca_chip_store_coverage g WHERE g.store = v_cp_type) THEN
      RAISE EXCEPTION 'finding %: counterparty % is not a declared chip store', f ->> 'finding', v_cp_type;
    END IF;
    -- Every named leg is a live leg on exactly one side of the account, named
    -- once, never restated before, and together they are the finding's amount.
    SELECT count(*), COALESCE(round(sum(CASE WHEN l.to_type = p_account THEN l.amount ELSE -l.amount END), 2), 0)
      INTO v_n, v_sum
      FROM public.chip_ledger l
     WHERE l.id = ANY (v_legs) AND (l.from_type = p_account) <> (l.to_type = p_account)
       AND l.status = 'posted';
    IF v_n <> cardinality(v_legs) OR v_n <> (SELECT count(DISTINCT x) FROM unnest(v_legs) x) THEN
      RAISE EXCEPTION 'finding %: % of % named legs are live % legs', f ->> 'finding', v_n, cardinality(v_legs), p_account;
    END IF;
    IF v_sum <> (CASE WHEN v_dir = 'out_of_account' THEN v_amount ELSE -v_amount END) THEN
      RAISE EXCEPTION 'finding %: legs net % into %, the finding says % %', f ->> 'finding', v_sum, p_account, v_dir, v_amount;
    END IF;
    IF EXISTS (SELECT 1 FROM public.ca_journal_restatement_legs k WHERE k.corrected_leg_id = ANY (v_legs)) THEN
      RAISE EXCEPTION 'finding %: a named leg was already restated', f ->> 'finding';
    END IF;

    v_meta := jsonb_build_object(
      'operation_id', p_operation_id, 'finding', f ->> 'finding',
      'restates_account', p_account, 'legs_restated', v_n,
      'legs_md5', (SELECT md5(string_agg(x::text, ',' ORDER BY x::text)) FROM unnest(v_legs) x),
      'real_counterparty', f ->> 'real_counterparty',
      'evidence', f ->> 'evidence',
      'owner_authorization', p_authorization,
      'leg_map', 'ca_journal_restatement_legs');

    -- The writer's linkage rule: one correction, one live incident.
    v_inc := public.fn_ca_raise_drift_incident(
      'fn_ca_restate_must_be_zero_account', 'historical_migration', 'info',
      'journal-restatement:' || p_operation_id::text || ':' || (f ->> 'finding'),
      v_amount, NULL, NULL, 'ledger', p_account,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_reason, true, v_meta);
    IF v_inc IS NULL THEN
      RAISE EXCEPTION 'finding %: the incident filer did not file the linkage incident', f ->> 'finding';
    END IF;

    v_res := public.fn_ca_post_correction(
      CASE WHEN v_dir = 'out_of_account' THEN p_account ELSE v_cp_type END,
      CASE WHEN v_dir = 'out_of_account' THEN NULL ELSE v_cp_entity END,
      CASE WHEN v_dir = 'out_of_account' THEN v_cp_type ELSE p_account END,
      CASE WHEN v_dir = 'out_of_account' THEN v_cp_entity ELSE NULL END,
      v_amount, v_reason, v_inc, NULL, NULL, NULL, v_meta);
    IF COALESCE((v_res ->> 'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_res ->> 'replayed')::boolean, true) THEN
      RAISE EXCEPTION 'finding %: the correction writer refused: %', f ->> 'finding', v_res;
    END IF;
    v_ledger := (v_res ->> 'ledger_id')::uuid;

    INSERT INTO public.ca_journal_restatement_legs (corrected_leg_id, operation_id, finding, correction_ledger_id, incident_id)
    SELECT x, p_operation_id, f ->> 'finding', v_ledger, v_inc FROM unnest(v_legs) x;

    UPDATE public.ca_drift_incidents
       SET status = 'resolved', resolved_at = now(), closure_basis = 'repair',
           root_cause = v_reason,
           resolution = format('Journal-only restatement posted by operation %s under the owner authorization of %s: chip_ledger %s restates %s leg(s) of %s against %s. No balance moved.',
                               p_operation_id, p_authorization ->> 'on', v_ledger, v_n, p_account, v_cp_type)
     WHERE id = v_inc AND status <> 'resolved';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finding %: the linkage incident could not be closed', f ->> 'finding';
    END IF;

    v_plan_total := v_plan_total + CASE WHEN v_dir = 'out_of_account' THEN v_amount ELSE -v_amount END;
    v_posted := v_posted + 1;
    v_restated := v_restated + v_n;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'finding', f ->> 'finding', 'direction', v_dir, 'counterparty_type', v_cp_type,
      'counterparty_entity', v_cp_entity, 'amount', v_amount, 'legs', v_n,
      'correction_ledger_id', v_ledger, 'incident_id', v_inc));
  END LOOP;

  IF v_plan_total <> v_before THEN
    RAISE EXCEPTION 'the plan restates % but % stands at %', v_plan_total, p_account, v_before;
  END IF;
  SELECT COALESCE(round(sum(CASE WHEN l.to_type = p_account THEN l.amount ELSE -l.amount END), 2), 0)
    INTO v_after
    FROM public.chip_ledger l
   WHERE (l.from_type = p_account) <> (l.to_type = p_account);
  IF v_after <> 0 THEN
    RAISE EXCEPTION '% reads % after the restatement, not 0.00', p_account, v_after;
  END IF;
  v_fp_after := public.fn_ca_balance_table_fingerprint();
  IF v_fp_after IS DISTINCT FROM v_fp_before THEN
    RAISE EXCEPTION 'a balance table changed inside the restatement; nothing is committed';
  END IF;

  -- The standing position was the owner's to decide; it is decided. The
  -- audited baseline is now zero, so any future movement is growth.
  UPDATE public.ca_must_be_zero_state
     SET baseline_balance = 0, baseline_at = now(), updated_at = now(),
         baseline_note = format('re-baselined to 0.00 by journal restatement %s (owner authorization %s, %s); the account stood at %s',
                                p_operation_id, p_authorization ->> 'by', p_authorization ->> 'on', v_before)
   WHERE account_type = p_account;

  SELECT id INTO v_parent FROM public.ca_drift_incidents
   WHERE dedupe_key = 'must-be-zero-balance:' || p_account AND status <> 'resolved';
  IF v_parent IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_parent, 'repair_action', jsonb_build_object(
      'journal_restatement', p_operation_id, 'balance_before', v_before,
      'balance_after', v_after, 'corrections_posted', v_posted, 'legs_restated', v_restated,
      'note', 'the balance arm closes this on its next run by re-measuring the account'));
  END IF;

  INSERT INTO public.ca_journal_restatements
    (operation_id, account_type, owner_authorization, balance_before, balance_after, findings,
     legs_restated, corrections_posted, fingerprint_before, fingerprint_after)
  VALUES (p_operation_id, p_account, p_authorization, v_before, v_after, v_findings,
          v_restated, v_posted, v_fp_before, v_fp_after);

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'operation_id', p_operation_id,
    'balance_before', v_before, 'balance_after', v_after, 'corrections_posted', v_posted,
    'legs_restated', v_restated, 'findings', v_findings,
    'balance_tables_identical', v_fp_after = v_fp_before, 'parent_incident', v_parent);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_restate_must_be_zero_account(uuid,text,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. THE ONE-OFF. One operation id, the audited findings, service_role only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_restate_settlement_suspense_20260926(p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  c_operation constant uuid := 'f4a2c6d0-5e1b-4c7a-9d3e-26092026a0b1';
  v_plan jsonb := '[]'::jsonb; r record; v_expected jsonb; v_seen int := 0;
BEGIN
  IF p_operation_id IS DISTINCT FROM c_operation THEN
    RAISE EXCEPTION 'this restatement runs under operation % only', c_operation USING ERRCODE = '22023';
  END IF;
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_journal_restatements WHERE operation_id = p_operation_id) THEN
    RETURN public.fn_ca_restate_must_be_zero_account(p_operation_id, 'settlement_suspense', '[{}]'::jsonb, '{}'::jsonb);
  END IF;

  -- The audited findings, read 2026-09-26 from production: legs, net into
  -- suspense, md5 of the comma-joined sorted leg ids. The live journal must
  -- reproduce every one of them exactly or nothing is posted.
  v_expected := '{
    "L01": [416, "4160000.00", "f2892af3679ca77ab4bb35c665cfd5bc"],
    "L02": [3791, "214665.00", "04200e41728d0bb10b09528e180d4a19"],
    "L03": [626, "-41342.04", "ba0ef8859c39e1922be77eb9006f68f1"],
    "L04": [626, "39874.00", "f6e11176137473a47a16cf9ef8e5726d"],
    "L05": [12, "1269.00", "f974432ad6f5983e626c6f26fb194a1b"],
    "L06": [1, "246.82", "4a6d8db36315eb1663ff4acab9f81cbb"],
    "L07": [4, "108.00", "709e20c3c6e80265eb9513043d77a6c9"],
    "L08": [1, "10.00", "800f8343596b4fb5fb6e6648fe452969"],
    "L09": [1023, "-5162.49", "dd59c8017928fe706baca3e54c3564f5"],
    "L10": [27, "-70.75", "f5b308305df9642049a1a167ee3bd859"],
    "L11": [115, "-19.55", "1b1d1b7a89bc8120fccbb0d32e60fca3"],
    "L12": [2, "-119.53", "b8da231396f3af8dfef20a27b4ee176a"],
    "L13": [13, "3423.12", "862e51f3bca52d99ff14c21db751cff9"],
    "L14": [2, "-1977.10", "a15aa6bd42759d7bb67d81db95601a5e"],
    "L15": [2, "-200000.00", "6b1d929db4375ec31d6e0d3032946e9b"],
    "P0":  [8, "0.00", "275611753db15ae1a47bbb238fe4cbea"]
  }'::jsonb;

  FOR r IN
    WITH s AS (
      SELECT l.id, l.created_at, l.amount, l.category, l.from_type, l.to_type,
             l.from_entity_id, l.to_entity_id, l.actor_service,
             CASE WHEN l.to_type = 'settlement_suspense' THEN 1 ELSE -1 END AS dir
        FROM public.chip_ledger l
       WHERE (l.from_type = 'settlement_suspense') <> (l.to_type = 'settlement_suspense')
    ), rn AS (
      SELECT s.*, row_number() OVER (PARTITION BY s.created_at, s.amount, s.dir ORDER BY s.id) AS k FROM s
    ), u AS (
      -- A leg into suspense and a leg out of it at the same instant for the
      -- same amount are one transfer routed through the corridor.
      SELECT a.* FROM rn a
       WHERE NOT EXISTS (SELECT 1 FROM rn b WHERE b.created_at = a.created_at AND b.amount = a.amount
                                              AND b.dir = -a.dir AND b.k = a.k)
    ), c AS (
      SELECT u.*, CASE
        WHEN u.id IN ('a6292d04-16f1-4d75-abe0-aa6a07c68a49','fbe2551d-5cd8-48ae-9a15-1d0712b635a0',
                      'aa5f255d-c54d-4901-acc9-fb1516833edf','c043127d-1fd5-4970-8395-5663a7f760c6',
                      'ffefca1d-830e-45ae-b8fd-9dd35b732367','e7e41bf1-82bc-4bc0-8d08-36db24eda58d',
                      '6eb8b82e-363f-42cf-90cb-0bd324e9c3eb','8d576003-088a-4dc4-8ad8-682da73e4a54') THEN 'P0'
        WHEN u.category = 'adjustment' AND u.actor_service = 'mgmt-api'
         AND u.created_at IN ('2026-09-01 14:59:00.697293+00','2026-09-01 15:08:16.769253+00','2026-09-01 17:06:38.612054+00')
         AND u.dir = 1 THEN 'L13'
        WHEN u.category = 'adjustment' AND u.actor_service = 'mgmt-api'
         AND u.created_at IN ('2026-09-01 14:59:00.697293+00','2026-09-01 15:08:16.769253+00','2026-09-01 17:06:38.612054+00')
         AND u.dir = -1 THEN 'L14'
        WHEN u.category = 'adjustment' AND u.from_type = 'agent_wallet' AND u.dir = 1
         AND EXISTS (SELECT 1 FROM public.chip_ledger t
                      WHERE t.created_at = u.created_at AND t.category = 'adjustment'
                        AND t.from_type = 'table_stack' AND t.from_entity_id IS NULL
                        AND t.to_type = 'player_wallet' AND t.amount = u.amount) THEN 'L01'
        WHEN u.category = 'spin_prize' AND u.from_type = 'spin_reserve' AND u.dir = 1 THEN 'L02'
        WHEN u.category = 'adjustment' AND u.to_type = 'spin_reserve'
         AND u.to_entity_id = '2d968239-acdd-4a2c-99f2-a369ff37ae31' THEN 'L03'
        WHEN u.category = 'adjustment' AND u.from_type = 'spin_reserve'
         AND u.from_entity_id = '2d968239-acdd-4a2c-99f2-a369ff37ae31' THEN 'L04'
        WHEN u.category = 'adjustment' AND u.from_type = 'union_bank' AND u.dir = 1 THEN 'L05'
        WHEN u.id = '68be02a5-4080-47e7-b764-5ed66aeabca9' THEN 'L06'
        WHEN u.category = 'adjustment' AND u.from_type = 'player_wallet' AND u.dir = 1 THEN 'L07'
        WHEN u.id = 'f6130820-de88-4556-a702-4d123306981a' THEN 'L08'
        WHEN u.category = 'adjustment' AND u.to_type = 'union_wallet' AND u.dir = -1 THEN 'L09'
        WHEN u.category = 'adjustment' AND u.to_type = 'club_wallet' AND u.dir = -1 THEN 'L10'
        WHEN u.category = 'adjustment' AND u.to_type = 'bbj_pool' AND u.dir = -1 THEN 'L11'
        WHEN u.category = 'adjustment' AND u.to_type = 'player_wallet' AND u.dir = -1 THEN 'L12'
        WHEN u.id IN ('da015b72-7435-41eb-a0ad-ad47f584e584','e0ef00c2-6a90-4426-9e6a-ffcb17554e88') THEN 'L15'
      END AS finding
      FROM u
    )
    SELECT COALESCE(c.finding, 'UNCLASSIFIED') AS finding, count(*) AS legs,
           round(sum(c.dir * c.amount), 2) AS net,
           md5(string_agg(c.id::text, ',' ORDER BY c.id)) AS ids_md5,
           jsonb_agg(c.id ORDER BY c.id) AS ids
      FROM c GROUP BY 1 ORDER BY 1
  LOOP
    IF NOT (v_expected ? r.finding)
       OR (v_expected -> r.finding ->> 0)::int <> r.legs
       OR (v_expected -> r.finding ->> 1)::numeric <> r.net
       OR (v_expected -> r.finding ->> 2) <> r.ids_md5 THEN
      RAISE EXCEPTION 'the live journal no longer matches the audited finding %: % legs, net %, md5 %',
        r.finding, r.legs, r.net, r.ids_md5;
    END IF;
    v_seen := v_seen + 1;
    CONTINUE WHEN r.finding = 'P0';
    v_plan := v_plan || jsonb_build_array(jsonb_build_object(
      'finding', r.finding,
      'direction', CASE WHEN r.net > 0 THEN 'out_of_account' ELSE 'into_account' END,
      'counterparty_type', CASE r.finding WHEN 'L13' THEN 'chip_retirement'
                                          WHEN 'L14' THEN 'issuance_reserve'
                                          WHEN 'L15' THEN 'issuance_reserve'
                                          ELSE 'table_stack' END,
      'counterparty_entity', NULL,
      'amount', abs(r.net),
      'legs', r.ids,
      'real_counterparty', CASE r.finding
        WHEN 'L01' THEN 'the member wallets credited by 416 agent distributions (each leg''s same-instant table_stack(NULL) -> player_wallet twin)'
        WHEN 'L02' THEN 'the winners of 3,791 completed spins, paid through table_stack(NULL) -> player_wallet; prize_liability of a terminal tournament refuses new evidence'
        WHEN 'L03' THEN 'the buy-ins of pre-declaration spins, journaled player_wallet -> table_stack(NULL)'
        WHEN 'L04' THEN 'the winners of pre-declaration spins, paid through table_stack(NULL) -> player_wallet'
        WHEN 'L05' THEN 'the prize pools of twelve completed tournaments whose flows are journaled at table_stack(NULL)'
        WHEN 'L06' THEN 'duplicate-place overpays of six completed tournaments, already paid through table_stack(NULL)'
        WHEN 'L07' THEN 'the prize pools of four completed tournaments (terminal evidence), held at table_stack(NULL)'
        WHEN 'L08' THEN 'a 10.00 tournament buy-in whose event the write failure never named'
        WHEN 'L09' THEN 'the felt the union rake came off; the leg does not name the table'
        WHEN 'L10' THEN 'the felt the rake mirror counted; the leg does not name the table'
        WHEN 'L11' THEN 'the felt the jackpot contributions came off; the leg does not name the table'
        WHEN 'L12' THEN 'the felt two cash-outs left; the leg does not name the table'
        WHEN 'L13' THEN 'chips retired by the owner-ordered resets of 2026-09-01'
        WHEN 'L14' THEN 'chips issued by the owner-ordered opening baseline of 2026-09-01'
        WHEN 'L15' THEN 'the unjournaled 100,000.00 opening grants of two certification clubs, later retired' END,
      'evidence', 'fn_ca_restate_settlement_suspense_20260926 finding ' || r.finding,
      'reason', 'Journal-only restatement of settlement_suspense (owner authorization 2026-09-26, "Post correction legs to zero it"): '
        || r.legs || ' unpaired leg(s) of finding ' || r.finding || ' netting ' || r.net
        || ' into suspense are restated against their real counterparty. No chip moves.'));
  END LOOP;
  IF v_seen <> 16 THEN
    RAISE EXCEPTION 'expected 16 audited findings, the live journal shows %', v_seen;
  END IF;

  RETURN public.fn_ca_restate_must_be_zero_account(
    p_operation_id, 'settlement_suspense', v_plan,
    jsonb_build_object('by', 'Dan (owner)', 'on', '2026-09-26',
                       'text', 'Post correction legs to zero it',
                       'policy', 'owner policy 2.9'));
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_restate_settlement_suspense_20260926(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_restate_settlement_suspense_20260926(uuid) TO service_role;

COMMIT;
