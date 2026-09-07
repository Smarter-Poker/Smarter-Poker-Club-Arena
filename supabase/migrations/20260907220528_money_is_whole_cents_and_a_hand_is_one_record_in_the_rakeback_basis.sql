BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 6 OF 8 (UNION ACCOUNTING) - ONE SOURCE OF TRUTH, PART 3:
   THE ROUNDING POLICY IS WRITTEN DOWN AND ENFORCED WHERE MONEY IS WRITTEN,
   AND A HAND IS ONE RECORD IN THE RAKEBACK BASIS.
   ---------------------------------------------------------------------------
   ROUNDING. Five functions rounded five ways and nobody had written the rule:
   fn_close_settlement_period round(_,2), rakeback_daily_user integer cents,
   the pre-Phase-5 payer round(_,4) (933 of 2,704 rakeback_period_payouts rows
   still carry a sub-cent payout_amount), fn_union_invoice_outstanding
   round(_,2), the union close trunc(_,2) per (club, game type). Measured on
   production 2026-09-07 22:00 UTC, the last 24 hours across nine money
   columns - rake_records.rake_amount / bbj_contribution,
   rake_attributions.rake_amount, agent_commissions.amount,
   union_wallet_transactions.amount, club_wallet_transactions.amount,
   chip_ledger.amount, rakeback_period_payouts.payout_amount,
   rakeback_periods.rakeback_amount - 1,363,000 rows, ZERO sub-cent values.
   The policy is already the practice. This writes it down
   (fn_money_rounding_policy) and enforces it at the write (CHECK constraints
   on those columns, in force from this migration's timestamp so the 933
   historical rows are history and no UPDATE of them is refused). A guard at
   the write, not a sweep that reads it back later (CLAUDE.md 10.12).

   THE POLICY, in one place, in the database, readable by anyone:
     1. UNIT      every stored or paid chip amount is a whole number of cents.
     2. SHARES    one amount split among players is split in integer cents by
                  fn_allocate_rake_credits (largest remainder, ties by user id
                  ascending) so the parts sum to the whole exactly. No other
                  function may carry a share formula.
     3. RATES     a rate applied to a basis rounds half away from zero to the
                  cent (Postgres numeric round(x, 2)) - EXCEPT the union's
                  per-(club, game type) club share, which is TRUNCATED to the
                  cent so the remainder stays with the union (Dan 2026-09-03).
     4. SUMS      cents are summed as integers; a sum of rounded parts is never
                  re-rounded.
     5. VIP       a VIP credit carries four decimals in vip_points_ledger and
                  converts to whole points by floor with a per-user carry
                  (20260831100610). VIP points are not chips.
     6. CONSERVE  at every settlement boundary in = out to the cent
                  (fn_union_settlement_conservation_assert,
                  fn_settlement_conservation_check).

   ONE HAND, ONE RECORD. atomic_distribute_rake could be called for the same
   hand twice - once before hand_history returned an id (hand_id NULL) and
   once after - and until 2026-09-06 nothing deduped the pair. Measured
   2026-09-07 21:50 UTC: 2,574 null-hand rows whose (table, hand number) also
   has a linked row - Midway Union 2,239 / 6,758.65, Deep Stack Society
   239 / 442.70, Club JAQK 61 / 217.77, SHARK CLUB 35 / 94.93; 7,514.05 of
   rake in all, EVERY row carrying player_contributions. 20260907200330 left
   those rows alone on the reasoning that "nothing per-player reads them".
   That was wrong: fn_rakeback_recompute_day reads every row with
   contributions, sends a null-hand row through the allocator, and so counted
   each of those hands TWICE in the player rakeback basis - and the VIP
   trigger fired on both rows. fn_rakeback_recompute_day now skips a
   null-hand row whose linked twin exists. Paid weeks are immutable
   (fn_rakeback_recompute_periods) and stay paid; the 2026-09-07 payment that
   included some of this basis stays with the players (10.9 rule 3). Pending
   periods recompute on their next pass because rows_seen changes. The rows
   themselves stay as history, as 20260907200330 decided. */

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure)) <> 'd6dcb827523b52fc25a4658eab9b727f' THEN
    RAISE EXCEPTION 'fn_rakeback_recompute_day changed since the 2026-09-07 21:40 UTC audit; re-read before applying';
  END IF;
END $guard$;

/* 1. THE POLICY, AS DATA. */
CREATE OR REPLACE FUNCTION public.fn_money_rounding_policy()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'written', '2026-09-07',
    'unit', 'every stored or paid chip amount is a whole number of cents; numeric scale 2; x = round(x, 2)',
    'shares', 'one amount split among players is split in integer cents by fn_allocate_rake_credits (largest remainder, ties by user id ascending) so the parts sum to the whole exactly; no other function carries a share formula',
    'rates', 'a rate applied to a basis rounds half away from zero to the cent: round(x, 2); the one exception is the union per-(club, game type) club share, truncated to the cent so the remainder stays with the union (Dan 2026-09-03)',
    'sums', 'cents are summed as integers (rakeback_daily_user.cents); a sum of rounded parts is never re-rounded',
    'vip', 'a VIP credit carries four decimals in vip_points_ledger and converts to whole points by floor with a per-user carry (20260831100610); VIP points are not chips',
    'conservation', 'at every settlement boundary in = out to the cent (fn_union_settlement_conservation_assert, fn_settlement_conservation_check)',
    'enforced_by', jsonb_build_array(
      'ck_whole_cents on rake_records, rake_attributions, agent_commissions, union_wallet_transactions, club_wallet_transactions, chip_ledger, rakeback_period_payouts, rakeback_periods, settlement_invoices (rows written from 2026-09-07)',
      'fn_allocate_rake_credits',
      'tests/money-is-whole-cents.law.test.ts')
  );
$function$;

/* 2. ENFORCED AT THE WRITE. NOT VALID: no scan of the tables, no lock held
   for longer than the catalog change; enforced for every row written or
   updated from now on. Rows older than this migration are history (the
   933 sub-cent payouts of the pre-Phase-5 payer among them) and are never
   refused an update. */
ALTER TABLE public.rake_records
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz
    OR (rake_amount = round(rake_amount, 2) AND bbj_contribution = round(bbj_contribution, 2))) NOT VALID;
ALTER TABLE public.rake_attributions
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz
    OR (rake_amount = round(rake_amount, 2) AND weighted_rake_credit = round(weighted_rake_credit, 2))) NOT VALID;
ALTER TABLE public.agent_commissions
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz OR amount = round(amount, 2)) NOT VALID;
ALTER TABLE public.union_wallet_transactions
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz OR amount = round(amount, 2)) NOT VALID;
ALTER TABLE public.club_wallet_transactions
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz OR amount = round(amount, 2)) NOT VALID;
ALTER TABLE public.chip_ledger
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz OR amount = round(amount, 2)) NOT VALID;
ALTER TABLE public.rakeback_period_payouts
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz OR payout_amount = round(payout_amount, 2)) NOT VALID;
ALTER TABLE public.rakeback_periods
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz
    OR (rakeback_amount = round(rakeback_amount, 2) AND rake_generated = round(rake_generated, 2))) NOT VALID;
ALTER TABLE public.settlement_invoices
  ADD CONSTRAINT ck_whole_cents CHECK (
    created_at < '2026-09-07 22:00:00+00'::timestamptz
    OR (net_amount = round(net_amount, 2) AND gross_amount = round(gross_amount, 2))) NOT VALID;

/* 3. ONE HAND, ONE RECORD in the rakeback basis. */
DO $day$
DECLARE
  v_def text; v_new text; v_n int;
  v_needle constant text := 'AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL';
  v_extra  constant text := E'\n'
    || '       /* ONE HAND, ONE RECORD (Phase 6, 20260907): a null-hand row whose' || E'\n'
    || '          (table, hand number) also has a linked row is that hand''s ghost' || E'\n'
    || '          twin from a second atomic_distribute_rake call. The linked row is' || E'\n'
    || '          the hand; the twin counted it twice. */' || E'\n'
    || '       AND NOT (r.hand_id IS NULL AND r.table_id IS NOT NULL' || E'\n'
    || '                AND r.metadata->>''hand_number'' IS NOT NULL' || E'\n'
    || '                AND EXISTS (SELECT 1 FROM rake_records l' || E'\n'
    || '                             WHERE l.table_id = r.table_id AND l.hand_id IS NOT NULL' || E'\n'
    || '                               AND l.metadata->>''hand_number'' = r.metadata->>''hand_number''))';
BEGIN
  v_def := pg_get_functiondef('public.fn_rakeback_recompute_day(uuid,date,boolean)'::regprocedure);
  v_n := (length(v_def) - length(replace(v_def, v_needle, ''))) / length(v_needle);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'recompute_day: expected the row predicate twice (count and read), found %', v_n;
  END IF;
  v_new := replace(v_def, v_needle, v_needle || v_extra);
  IF v_new = v_def THEN RAISE EXCEPTION 'recompute_day: nothing changed'; END IF;
  EXECUTE v_new;
END $day$;

/* THE PROBES - each in its own subtransaction, rolled back by the sentinel. */
DO $probe$
DECLARE
  v_club constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_day  constant date := '2026-09-01';
  v_raw int; v_ghosts int; v_res jsonb; v_seen int; v_u1 uuid; v_st text;
BEGIN
  -- A. a sub-cent write is refused
  BEGIN
    SELECT p.id INTO v_u1 FROM public.profiles p ORDER BY p.id LIMIT 1;
    INSERT INTO public.rake_records (club_id, rake_amount, player_contributions, is_tournament, source, rake_method, metadata)
    VALUES (v_club, 0.123, jsonb_build_object(v_u1::text, 10.00), false, 'phase6_probe', 'DEALT_EQUAL', '{}'::jsonb);
    RAISE EXCEPTION 'PROBE_FAILED: a sub-cent rake_records row was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL; -- the refusal is the success case
  END;

  -- B. the ghost twins leave the basis: rows_seen drops by exactly the twin count
  BEGIN
    SELECT count(*) INTO v_raw FROM public.rake_records r
     WHERE r.club_id = v_club AND r.created_at >= v_day::timestamptz AND r.created_at < (v_day + 1)::timestamptz
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL;
    SELECT count(*) INTO v_ghosts FROM public.rake_records r
     WHERE r.club_id = v_club AND r.created_at >= v_day::timestamptz AND r.created_at < (v_day + 1)::timestamptz
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
       AND r.hand_id IS NULL AND r.table_id IS NOT NULL AND r.metadata->>'hand_number' IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.rake_records l WHERE l.table_id = r.table_id AND l.hand_id IS NOT NULL
                     AND l.metadata->>'hand_number' = r.metadata->>'hand_number');
    IF v_ghosts = 0 THEN
      RAISE EXCEPTION 'PROBE_FAILED: the probe day has no ghost twins to prove against';
    END IF;
    v_res := public.fn_rakeback_recompute_day(v_club, v_day, true);
    v_seen := (v_res->>'rows_seen')::int;
    IF v_seen <> v_raw - v_ghosts THEN
      RAISE EXCEPTION 'PROBE_FAILED: rows_seen % but expected % raw - % ghosts = %', v_seen, v_raw, v_ghosts, v_raw - v_ghosts;
    END IF;
    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'FIXTURE_ROLLBACK' THEN RAISE; END IF;
  END;

  IF EXISTS (SELECT 1 FROM public.rake_records WHERE source = 'phase6_probe') THEN
    RAISE EXCEPTION 'the probe committed its fixtures';
  END IF;
END $probe$;

DO $assert$
DECLARE v_src text; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_constraint WHERE conname = 'ck_whole_cents' AND contype = 'c'
     AND conrelid IN ('public.rake_records'::regclass, 'public.rake_attributions'::regclass, 'public.agent_commissions'::regclass,
                      'public.union_wallet_transactions'::regclass, 'public.club_wallet_transactions'::regclass, 'public.chip_ledger'::regclass,
                      'public.rakeback_period_payouts'::regclass, 'public.rakeback_periods'::regclass, 'public.settlement_invoices'::regclass);
  IF v_n <> 9 THEN RAISE EXCEPTION 'expected 9 ck_whole_cents constraints, found %', v_n; END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_rakeback_recompute_day' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%ONE HAND, ONE RECORD%' THEN RAISE EXCEPTION 'the recompute still counts ghost twins'; END IF;
  IF (SELECT public.fn_money_rounding_policy()->>'unit') IS NULL THEN RAISE EXCEPTION 'the policy is not readable'; END IF;
END $assert$;

INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
VALUES ('warning', 'fn_rakeback_recompute_day.ghost_twin_counted_twice',
  '2,574 null-hand rake_records rows (2026-07-31..2026-09-07) are ghost twins of hands that also have a linked row - Midway Union 2,239 / 6,758.65, Deep Stack Society 239 / 442.70, Club JAQK 61 / 217.77, SHARK CLUB 35 / 94.93; 7,514.05 of rake - and every one carries player_contributions, so the player rakeback basis counted each hand twice and the VIP trigger fired twice.',
  jsonb_build_object('rows', 2574, 'rake', 7514.05,
    'by_club', jsonb_build_object('Midway Union', jsonb_build_object('rows', 2239, 'rake', 6758.65),
                                  'Deep Stack Society', jsonb_build_object('rows', 239, 'rake', 442.70),
                                  'Club JAQK', jsonb_build_object('rows', 61, 'rake', 217.77),
                                  'SHARK CLUB', jsonb_build_object('rows', 35, 'rake', 94.93)),
    'root_fix', 'engine mints the hand uuid at settlement (20260907195116); atomic_distribute_rake dedupes by (table, hand number) (2026-09-06)',
    'basis_fix', 'fn_rakeback_recompute_day skips a null-hand row whose linked twin exists (this migration)'),
  true, now(),
  'Fixed forward: the twins leave the rakeback basis on each pending period''s next recompute. Paid weeks are immutable and stay paid; the 2026-09-07 payment that included some of this basis, and the doubled VIP points, stay with the players under CLAUDE.md 10.9 rule 3. The rows stay as history (20260907200330). The union rake_wallet and Deep Stack chip_treasury credits the twins produced are supply, not player money, and are reported to Dan as a decision, not corrected here.');

COMMIT;
