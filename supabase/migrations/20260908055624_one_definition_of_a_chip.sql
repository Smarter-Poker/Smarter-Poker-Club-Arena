DO $mig$
/* ==========================================================================
   ONE DEFINITION OF A CHIP  (roadmap 9.1, phase 9 of 9)
   ==========================================================================

   A CHIP IS TWO DECIMAL PLACES. Everywhere, in every column, on every table.
   Measured 2026-09-08 across 236 money columns: 137 declared numeric(_,2), 11
   declared numeric(_,4), and 86 were unconstrained numeric able to hold any
   scale. chip_ledger.amount is numeric(15,2), so a balance that can hold a
   third decimal place, against a journal that cannot record one, is a fraction
   that lives in the balance and can never appear in a leg - invisible to every
   conservation check, because both sides round the same way.

   IT HAD ALREADY OPENED THREE TIMES AND CLOSED ITSELF:
     union_rake_paid_daily_user.rake_amount  6,881 / 8,244    +0.2799
     rakeback_period_payouts.payout_amount     933 / 2,704    -0.2385
     wallet_transactions.balance_after         243 / 2,899,837 0.000000
   8,057 rows, net +0.0414 chips, none in a week. Declaring the unit while the
   drift is four hundredths of a chip costs nothing; declaring it after an
   epoch reset means declaring it against balances that have already moved.

   A CHECK, not ALTER COLUMN TYPE: the latter rewrites the whole table under
   ACCESS EXCLUSIVE, which on chip_ledger (2.36M rows) is minutes of frozen
   felt for a rule a CHECK enforces just as completely. NOT VALID first (18ms,
   catalogue only) so it binds every new write immediately; the VALIDATE that
   proves history follows in the same transaction for the thirty columns
   measured clean. The three with residue stay NOT VALID and say why in the
   catalogue - rounding settled rows is what CLAUDE.md 10.9 forbids, and the
   policy that governs it is docs/CHIP-RESTATEMENT-POLICY.md.

   Applied inside the :55 freeze: probed twice under live play and deadlocked
   both times, the second time even with all 28 locks taken in one statement.

   ROLLBACK: DROP each constraint by name. No data is written or altered.
   ========================================================================== */
DECLARE
  v_added  integer := 0;
  v_valid  integer := 0;
  v_t0     timestamptz;
  v_ms     numeric;
  v_cols   text[][] := ARRAY[
    ['chip_ledger','pre_from_balance','t'],
    ['chip_ledger','pre_to_balance','t'],
    ['chip_ledger','post_from_balance','t'],
    ['chip_ledger','post_to_balance','t'],
    ['unions','chip_balance','t'],
    ['unions','rake_wallet','t'],
    ['agents','player_wallet_balance','t'],
    ['club_members','held_chips','t'],
    ['club_wallet_transactions','amount','t'],
    ['union_wallet_transactions','amount','t'],
    ['chip_escrow_holds','amount','t'],
    ['audit_trail','amount','t'],
    ['wallet_transactions','balance_after','f'],
    ['spin_reserve_ledger','amount','t'],
    ['ca_hand_transfers','amount','t'],
    ['rake_distribution_legs','amount','t'],
    ['ca_bbj_bucket_moves','amount','t'],
    ['union_presettlements','amount','t'],
    ['ca_seat_stack_exits','stack','t'],
    ['ca_seat_stack_rebases','amount','t'],
    ['agent_commissions','amount','t'],
    ['agent_commission_settlements','amount','t'],
    ['rakeback_period_payouts','payout_amount','f'],
    ['rake_records','rake_amount','t'],
    ['rake_attributions','rake_amount','t'],
    ['union_rake_paid_daily_user','rake_amount','f'],
    ['ca_club_commission_daily','amount','t'],
    ['ca_hand_financial_facts','rake_amount','t'],
    ['ca_hand_financial_facts','bbj_amount','t'],
    ['bbj_pools','alloc_cum_amount','t'],
    ['tournament_payouts','prize_pool','t'],
    ['ca_account_snapshots','balance','t'],
    ['ca_ledger_day_manifests','net_amount','t']
  ];
  i integer;
  v_tab text; v_col text; v_do_validate boolean; v_name text;
BEGIN
  SET LOCAL lock_timeout = '20s';

  /* EVERY LOCK UP FRONT, IN ONE STATEMENT. ADD CONSTRAINT takes ACCESS
     EXCLUSIVE; taking those locks one table at a time deadlocked a probe on
     club_members after eight constraints (40P01) - the same shape that killed
     the phase 8 migration at 02:19 and the hand re-drive at 04:03. Inside the
     freeze nothing else holds them, so this is instant. */
  LOCK TABLE
    public.chip_ledger, public.unions, public.agents, public.club_members,
    public.club_wallet_transactions, public.union_wallet_transactions,
    public.chip_escrow_holds, public.audit_trail, public.wallet_transactions,
    public.spin_reserve_ledger, public.ca_hand_transfers,
    public.rake_distribution_legs, public.ca_bbj_bucket_moves,
    public.union_presettlements, public.ca_seat_stack_exits,
    public.ca_seat_stack_rebases, public.agent_commissions,
    public.agent_commission_settlements, public.rakeback_period_payouts,
    public.rake_records, public.rake_attributions,
    public.union_rake_paid_daily_user, public.ca_club_commission_daily,
    public.ca_hand_financial_facts, public.bbj_pools, public.tournament_payouts,
    public.ca_account_snapshots, public.ca_ledger_day_manifests
  IN ACCESS EXCLUSIVE MODE;

  FOR i IN 1 .. array_length(v_cols, 1) LOOP
    v_tab := v_cols[i][1];
    v_col := v_cols[i][2];
    v_do_validate := v_cols[i][3] = 't';
    v_name := 'chk_' || v_col || '_is_two_decimal_places';

    IF to_regclass('public.' || quote_ident(v_tab)) IS NULL THEN
      RAISE EXCEPTION 'table public.% does not exist - the scope of this migration must be re-read', v_tab;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = ('public.' || quote_ident(v_tab))::regclass
         AND a.attname = v_col AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'column %.% does not exist - the scope of this migration must be re-read', v_tab, v_col;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = ('public.' || quote_ident(v_tab))::regclass
         AND c.conname = v_name
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I = round(%I, 2)) NOT VALID',
      v_tab, v_name, v_col, v_col, v_col);
    v_added := v_added + 1;

    IF v_do_validate THEN
      v_t0 := clock_timestamp();
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', v_tab, v_name);
      v_ms := round(extract(epoch FROM clock_timestamp() - v_t0) * 1000);
      v_valid := v_valid + 1;
      IF v_ms > 3000 THEN
        RAISE NOTICE 'validated %.% in % ms', v_tab, v_col, v_ms;
      END IF;
    END IF;
  END LOOP;

  EXECUTE $c$
    COMMENT ON CONSTRAINT chk_payout_amount_is_two_decimal_places ON public.rakeback_period_payouts IS
      'NOT VALID deliberately. 933 of 2,704 rows written 2026-07-22..2026-08-17 carry sub-cent values (fractions sum -0.2385 chips); they are settled `paid` records and CLAUDE.md 10.9 forbids rewriting a settled record to tidy a number. The constraint still refuses every NEW sub-cent value. Validate it only if those rows are ever restated under docs/CHIP-RESTATEMENT-POLICY.md.'
  $c$;
  EXECUTE $c$
    COMMENT ON CONSTRAINT chk_balance_after_is_two_decimal_places ON public.wallet_transactions IS
      'NOT VALID deliberately. 243 of 2,899,837 rows written 2026-04-17..2026-07-21 carry sub-cent values; their fractions cancel exactly (sum 0.000000 chips), so nothing is owed to anyone. Found only by attempting the validation - a three-day sample of this column read clean, which is why the probe runs before the migration. None since 07-21. The constraint still refuses every NEW sub-cent value.'
  $c$;
  EXECUTE $c$
    COMMENT ON CONSTRAINT chk_rake_amount_is_two_decimal_places ON public.union_rake_paid_daily_user IS
      'NOT VALID deliberately. 6,881 of 8,244 rows written 2026-08-10..2026-09-01 carry sub-cent values (drift +0.2799 chips on 1,855,063.77). Historic attribution rows; the writer above them was rebuilt and has produced none since 09-01. The constraint still refuses every NEW sub-cent value.'
  $c$;

  IF v_added = 0 THEN
    RAISE NOTICE 'one-definition-of-a-chip: already applied, nothing to do';
  ELSE
    RAISE NOTICE 'one-definition-of-a-chip: % constraints added, % validated', v_added, v_valid;
  END IF;
END $mig$;