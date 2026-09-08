DO $mig$
/* ==========================================================================
   ONE DEFINITION OF A CHIP  (roadmap 9.1, phase 9 of 9)
   ==========================================================================

   A CHIP IS TWO DECIMAL PLACES. Everywhere, in every column, on every table.
   Until now that was a convention rather than a rule, and the schema disagreed
   with itself: measured on 2026-09-08 across 236 money columns, 137 declared
   `numeric(_,2)`, 11 declared `numeric(_,4)`, and 86 were unconstrained
   `numeric` able to hold any scale at all.

   WHY THAT IS A LEAK BY CONSTRUCTION. `chip_ledger.amount` is `numeric(15,2)`.
   A balance that can hold a third decimal place, against a journal that cannot
   record one, is a fraction that lives in the balance and can never appear in
   a leg. Nothing detects it, because every conservation check on this platform
   compares balances to legs and both sides round the same way.

   IT IS NO LONGER HYPOTHETICAL - IT OPENED, TWICE, AND CLOSED ITSELF:

     rakeback_period_payouts.payout_amount   933 of 2,704 rows
                                             2026-07-22 .. 2026-08-17
                                             46,314.2215 exact vs 46,314.46
                                             rounded; fractions sum -0.2385

     union_rake_paid_daily_user.rake_amount  6,881 of 8,244 rows
                                             2026-08-10 .. 2026-09-01
                                             1,855,063.7699 exact vs
                                             1,855,063.49; drift +0.2799

   Both stopped on their own when the writers above them were rebuilt, and
   neither has produced a row in the last two days. Total residue on the whole
   platform: 0.5184 chips. THAT IS THE WHOLE POINT OF DOING THIS NOW. Declaring
   the unit while the drift is half a chip costs nothing; declaring it after an
   epoch reset means declaring it against balances that have already moved.

   ---------------------------------------------------------------------------
   WHAT THIS DOES
   ---------------------------------------------------------------------------
   A CHECK on every chip-carrying column whose declared type does not already
   pin two decimal places. NOT a type change: `ALTER COLUMN TYPE` rewrites the
   whole table under ACCESS EXCLUSIVE, and on chip_ledger (2.36M rows) or
   agent_commissions (4.00M) that is minutes of frozen felt for a constraint
   that a CHECK enforces just as completely.

   Every constraint is added NOT VALID first - a catalogue-only change, 18ms on
   the largest table - so it binds every NEW write the instant it commits. The
   VALIDATE that proves history follows in the same transaction for the thirty
   columns measured clean; it takes SHARE UPDATE EXCLUSIVE, not ACCESS
   EXCLUSIVE, so it blocks no reader and no writer. Measured on production in a
   rolled-back probe: agent_commissions 6.28s, chip_ledger 4.43s,
   rake_distribution_legs 2.38s.

   THE TWO COLUMNS WITH RESIDUE ARE ADDED **NOT VALID AND LEFT THAT WAY**. They
   still refuse every new sub-cent value; they simply do not assert a history
   that is already imperfect. Rounding those 7,814 settled rows would be
   rewriting a settled record to make a number look tidy, which CLAUDE.md 10.9
   forbids in as many words - and there is no player owed a fraction of a chip
   that could be paid. This is the write-off case, and the policy that governs
   it is written down in the same PR (docs/CHIP-RESTATEMENT-POLICY.md).

   Applied inside the :55 maintenance break: it is DDL, DDL makes PostgREST
   reload its schema cache, and a reload during live play is what cost eighteen
   hands on 2026-09-08.

   ROLLBACK: DROP each constraint by name. No data is written or altered.
   ========================================================================== */
DECLARE
  r        record;
  v_added  integer := 0;
  v_valid  integer := 0;
  v_t0     timestamptz;
  v_ms     numeric;
  /* (table, column, validate?) - explicit, not discovered, so the scope of
     this migration is stated rather than inferred. `validate := false` means
     the column carries measured historic residue; see the header. */
  v_cols   text[][] := ARRAY[
    -- the journal's own balance columns (amount is already numeric(15,2))
    ['chip_ledger','pre_from_balance','t'],
    ['chip_ledger','pre_to_balance','t'],
    ['chip_ledger','post_from_balance','t'],
    ['chip_ledger','post_to_balance','t'],
    -- live balances
    ['unions','chip_balance','t'],
    ['unions','rake_wallet','t'],
    ['agents','player_wallet_balance','t'],
    ['club_members','held_chips','t'],
    -- money movement records
    ['club_wallet_transactions','amount','t'],
    ['union_wallet_transactions','amount','t'],
    ['chip_escrow_holds','amount','t'],
    ['audit_trail','amount','t'],
    ['wallet_transactions','balance_after','f'],   -- 243 residue rows
    ['spin_reserve_ledger','amount','t'],
    ['ca_hand_transfers','amount','t'],
    ['rake_distribution_legs','amount','t'],
    ['ca_bbj_bucket_moves','amount','t'],
    ['union_presettlements','amount','t'],
    ['ca_seat_stack_exits','stack','t'],
    ['ca_seat_stack_rebases','amount','t'],
    -- the other currencies (phase 8's scope)
    ['agent_commissions','amount','t'],
    ['agent_commission_settlements','amount','t'],
    ['rakeback_period_payouts','payout_amount','f'],   -- 933 residue rows
    -- rake attribution
    ['rake_records','rake_amount','t'],
    ['rake_attributions','rake_amount','t'],
    ['union_rake_paid_daily_user','rake_amount','f'],  -- 6,881 residue rows
    ['ca_club_commission_daily','amount','t'],
    ['ca_hand_financial_facts','rake_amount','t'],
    ['ca_hand_financial_facts','bbj_amount','t'],
    -- pools, payouts, meters
    ['bbj_pools','alloc_cum_amount','t'],
    ['tournament_payouts','prize_pool','t'],
    ['ca_account_snapshots','balance','t'],
    ['ca_ledger_day_manifests','net_amount','t']
  ];
  i integer;
  v_tab text; v_col text; v_do_validate boolean; v_name text;
BEGIN
  SET LOCAL lock_timeout = '20s';

  /* EVERY LOCK UP FRONT, IN ONE STATEMENT (phase 8's lesson, measured again
     here). `ADD CONSTRAINT` takes ACCESS EXCLUSIVE; taking those locks one
     table at a time, in the order this list happens to be written, deadlocks
     against live play. A rolled-back probe of exactly this migration on
     2026-09-08 got eight constraints in and then died on `club_members` with
     40P01 - the same shape that killed the phase 8 migration at 02:19 and the
     hand re-drive at 04:03. One statement means Postgres takes them together
     and there is no window for another writer to interleave.

     Inside the :55 freeze nothing else holds them, so this is instant. The
     lock_timeout above is what stops it waiting if that is ever untrue. */
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

    -- Idempotent: a re-run adds nothing and validates nothing twice.
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

  /* THE TWO UNVALIDATED CONSTRAINTS SAY WHY, IN THE CATALOGUE, where the next
     person to run `\d+` will read it - not only in a changelog. */
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
