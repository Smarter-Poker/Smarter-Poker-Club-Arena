-- ═══════════════════════════════════════════════════════════════════════════
--  THE SEAT-KEYED FEE BECOMES LAW GOING FORWARD (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260831180000_a_tournament_guard_binds_every_writer_not_just_the_rpc.sql
-- enforced the two tournament rules that had zero live casualties and wrote
-- the third down with its count:
--
--     buy_in_fee off the seats rule: 9,357 rows. This is money and it is
--     history; a blocking trigger would refuse creations tomorrow over a rule
--     that was not applied yesterday. Recorded for Dan with the count.
--
-- Dan has now ruled on it: GUARD FORWARD. Do not rewrite history. No chips
-- move. This file is that ruling, and nothing more than that ruling.
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
--
-- src/utils/buyIn.ts (rakeRateFor) is the single source of truth and it keys
-- on SEATS, not on the label, because "a two-handed game is a duel whatever
-- its label says, and a label is exactly the thing that varies between six
-- writers":
--
--     spin (variant 'spin' or tournament_type 'SPIN')   0%
--     max_players 1..2                                  5%   HEADS_UP_RAKE_RATE
--     everything else                                  10%   DEFAULT_RAKE_RATE
--
-- and the fee is FLOORED TO CENTS, never rounded (feeToCents):
--
--     total    = buy_in_amount + buy_in_fee     (what the player pays)
--     fee      = floor(total * rate * 100) / 100
--     prize    = total - fee
--
-- Flooring is not decoration. Rounding a fee up is rounding the house's cut up
-- through its own ceiling, which is the bug fixed on 2026-08-21.
--
-- ── WHAT WAS ALREADY GUARDING THIS, AND WHY IT WAS NOT ENOUGH ──────────────
--
-- Two CHECK constraints exist and both are ceilings, not the derived value:
--
--     tournaments_heads_up_rake_within_5_pct    fee <= 5% + a cent   NOT VALID
--     tournaments_rake_within_10_pct            fee <= 10% + a cent  NOT VALID
--
-- A ceiling catches an overcharge and says nothing about an undercharge. A
-- 100-chip MTT written with a fee of 0.00 satisfies every guard on this table
-- today, and 5,942 of the 9,357 legacy violations are exactly that shape.
--
-- DO NOT RUN `VALIDATE CONSTRAINT` ON EITHER OF THEM. 3,299 legacy rows fail
-- the heads-up ceiling; the validation scan would abort, take an
-- AccessExclusiveLock on `tournaments` on its way out, and achieve nothing.
-- NOT VALID is deliberate on both and stays deliberate.
--
-- ── THE HISTORY THIS DOES NOT TOUCH ────────────────────────────────────────
--
-- Measured on production 2026-08-31, non-spin rows only (fee-bearing Spins are
-- already covered by tournaments_spin_no_extra_rake and counted separately at
-- 7,120):
--
--     9,357  rows whose buy_in_fee is not the value the rule derives
--     3,415  of them OVERCHARGED, every one COMPLETED
--     5,942  of them UNDERCHARGED  (3,232 COMPLETED, 2,710 CANCELLED)
--
--     newest violating row created 2026-08-25
--     live and upcoming rows (REGISTERING / RUNNING / COMPLETING): 174,
--     violations among them: ZERO
--
-- So nothing pays out wrong going forward, and every violation is settled
-- money. Rewriting a settled charge to satisfy a rule written afterwards would
-- destroy the honest record of what was actually taken. This migration moves
-- no chips, refunds nothing, and backfills nothing.
--
-- ── WHY THE DATE GATE ──────────────────────────────────────────────────────
--
-- This is the whole reason a blocking guard was deferred in the first place,
-- and 20260821a is the incident that proves it. A CHECK marked NOT VALID still
-- fires on every UPDATE, so the whole-dollar rule turned 9,814 legacy rows
-- READ-ONLY: level clocks could not persist, two decided SNGs could not be
-- flipped to COMPLETING, and the stalled-winner watchdog span for an hour with
-- the winners uncrowned.
--
-- `fn_enforce_whole_dollar_buyin` is still on this table and an UPDATE
-- re-checks the WHOLE row, so an ungated fee rule would do it again the moment
-- any recovery path touched a legacy price. The gate is therefore on
-- `created_at`, not on status: a row created before the cutover is history and
-- may always be updated; a row created after it must be priced correctly from
-- its first byte. COALESCE(created_at, now()) so a writer that leaves the
-- column NULL is judged as new rather than waved through.
--
-- The cutover is 2026-09-01T00:00:00Z: after the newest violating row
-- (2026-08-25) and after this file lands, so the guard can never be met by a
-- row it was not written for.
--
-- ── SEPARATE TRIGGER, NOT AN EXTENSION OF THE CREATION GUARD ───────────────
--
-- `tournaments_creation_guard` is BEFORE INSERT only, deliberately: "a guard
-- that can refuse an update is a guard that can strand a running tournament."
-- The fee rule needs UPDATE too, because ScheduledTournamentService writes
-- `buy_in_amount` and `buy_in_fee` directly and an update is a repricing. So
-- this is its own trigger, scoped `UPDATE OF buy_in_amount, buy_in_fee` — a
-- status flip, a level clock or a payout write can never reach it.
--
-- ── ATTACHING A TRIGGER TO `tournaments` DEADLOCKS AGAINST REALTIME ────────
--
-- Recorded by the migration above and repeated here because it will happen
-- again: CREATE TRIGGER needs AccessExclusiveLock on `tournaments`, Realtime
-- is subscribed to it and cycles constantly, and the two form a lock cycle.
-- Apply this in two parts if it deadlocks — the function first (it needs no
-- lock on the table at all), then the trigger attach alone under a SHORT
-- lock_timeout so each attempt fails fast instead of sitting in the queue.
-- Do not raise the timeout to try harder; a longer wait widens the overlap.
--
-- ── STATUS ─────────────────────────────────────────────────────────────────
--
-- NOT APPLIED TO PRODUCTION by the session that wrote it. Dan's ruling was to
-- guard forward, and applying schema from this session was out of scope; the
-- predicate below was verified against production with SELECT-only queries
-- (the counts above are its output) and never executed there. Whoever applies
-- it should probe it in a transaction that is ROLLED BACK, per CLAUDE.md 11.5.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_tournament_fee_seat_rule ON public.tournaments;
--   DROP FUNCTION IF EXISTS public.fn_tournament_fee_seat_rule();
--   SELECT cron.unschedule('tournament-fee-law-hourly');
--   DROP FUNCTION IF EXISTS public.fn_tournament_fee_law_check(timestamptz);
--   DROP FUNCTION IF EXISTS public.fn_tournament_fee_violations(timestamptz);
--   -- and re-add ledger_reconcile_log_entity_type_check without
--   -- 'tournament_fee_law' (see section 3 below for the full array).

-- ── 0. The cutover, written once ───────────────────────────────────────────
-- Both the guard and the alarm read the same instant. Two copies of a date is
-- two dates waiting to disagree, so it is an IMMUTABLE function and every
-- reader calls it.
CREATE OR REPLACE FUNCTION public.fn_tournament_fee_rule_cutover()
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$ SELECT timestamptz '2026-09-01 00:00:00+00' $$;

COMMENT ON FUNCTION public.fn_tournament_fee_rule_cutover() IS
  'The instant the seat-keyed fee rule starts binding. Rows created before it are history and are never refused or reported.';

-- ── 1. The rate a row owes, mirrored from rakeRateFor ──────────────────────
-- Spin first, exactly as rakeRateFor tests it, and BOTH columns are read:
-- src/utils/spinReveal.ts checks both on purpose, and the union-reserve audit
-- records that reading only one "is how it quietly returns false for half the
-- Spins in the system".
--
-- A NULL or zero seat count falls through to the DEFAULT rate, never to the
-- cheaper one — the modal sends 0 for "unlimited" on an MTT, and a
-- misconfigured writer must not be able to hand away margin.
CREATE OR REPLACE FUNCTION public.fn_tournament_seat_rake_rate(
  p_max_players    integer,
  p_variant        text,
  p_tournament_type text
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
           WHEN lower(COALESCE(p_variant, '')) = 'spin'
             OR upper(COALESCE(p_tournament_type, '')) = 'SPIN' THEN 0
           WHEN COALESCE(p_max_players, 0) BETWEEN 1 AND 2      THEN 0.05
           ELSE 0.10
         END::numeric;
$$;

COMMENT ON FUNCTION public.fn_tournament_seat_rake_rate(integer, text, text) IS
  'Mirror of rakeRateFor in src/utils/buyIn.ts. Keyed on SEATS, not on the label: spin 0%, 1-2 seats 5%, everything else 10%.';

-- The fee that rate owes on a total. FLOOR to cents, never round — see the
-- header, and feeToCents in src/utils/buyIn.ts.
CREATE OR REPLACE FUNCTION public.fn_tournament_expected_fee(
  p_total numeric,
  p_rate  numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  -- round(..., 2) is scale hygiene, not a second rounding: numeric division
  -- leaves floor(x)/100 with a 20-digit scale, and a fee that prints as
  -- 1.00000000000000000000 in an error message helps nobody. The VALUE is
  -- unchanged, and numeric equality ignores scale either way.
  SELECT round(floor(COALESCE(p_total, 0) * COALESCE(p_rate, 0) * 100) / 100, 2);
$$;

COMMENT ON FUNCTION public.fn_tournament_expected_fee(numeric, numeric) IS
  'floor(total * rate * 100) / 100 — the cent-floored fee from feeToCents in src/utils/buyIn.ts. A freeroll (total 0) owes 0.';

-- ── 2. The guard ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_tournament_fee_seat_rule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_total    numeric;
  v_rate     numeric;
  v_expected numeric;
  v_seats    integer := COALESCE(NEW.max_players, 0);
  v_label    text;
BEGIN
  -- History is history. A row created before the cutover keeps whatever it was
  -- charged and stays updatable forever — see the header for what happened the
  -- last time a money rule on this table was applied without that gate.
  IF COALESCE(NEW.created_at, now()) < public.fn_tournament_fee_rule_cutover() THEN
    RETURN NEW;
  END IF;

  v_total    := COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0);
  v_rate     := public.fn_tournament_seat_rake_rate(NEW.max_players, NEW.variant, NEW.tournament_type);
  v_expected := public.fn_tournament_expected_fee(v_total, v_rate);

  IF COALESCE(NEW.buy_in_fee, 0) <> v_expected THEN
    -- Built as text rather than passed to RAISE, so the percent sign is a
    -- percent sign and not a format placeholder.
    -- rtrim the point: FM990.99 renders 5 as "5.", and "pay 5.% of" reads
    -- like a truncated number rather than a rate.
    v_label := rtrim(trim(to_char(v_rate * 100, 'FM990.99')), '.') || '%';
    RAISE EXCEPTION
      'tournament fee rule: % seats pay % of what the player pays, so a total of % owes a fee of % (got %) - price it with splitBuyIn(total, rakeRateFor(...)), never write buy_in_fee by hand',
      v_seats, v_label, v_total, v_expected, COALESCE(NEW.buy_in_fee, 0)
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_tournament_fee_seat_rule() IS
  'Refuses a tournament priced off the seat-keyed fee rule. Gated on created_at >= fn_tournament_fee_rule_cutover() so the 9,357 legacy rows stay updatable.';

-- CREATE TRIGGER wants AccessExclusiveLock and Realtime is on this table.
-- Fail fast rather than queue behind it; a longer wait deadlocks, it does not
-- succeed. Re-run the migration if this statement times out.
SET lock_timeout = '1500ms';

DROP TRIGGER IF EXISTS trg_tournament_fee_seat_rule ON public.tournaments;
CREATE TRIGGER trg_tournament_fee_seat_rule
  BEFORE INSERT OR UPDATE OF buy_in_amount, buy_in_fee ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_fee_seat_rule();

RESET lock_timeout;

-- ── 3. The entity type the alarm will emit ─────────────────────────────────
-- Same shape as 20260829_bomb_award_ledger_gaps_are_loud.sql: the constraint
-- is re-stated in full with the new value appended, so the file says exactly
-- what the column accepts after it runs.
ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;
ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet'::text, 'club_treasury'::text, 'agent_wallet'::text,
    'frozen_wallets_pool'::text, 'chip_circulation'::text, 'seat_stack_exit'::text,
    'cashout_escrow_stuck'::text, 'negative_balance'::text, 'over_claimed_send'::text,
    'insurance_bank'::text, 'insurance_offer_unresolved'::text,
    'bomb_award_ledger_gap'::text, 'rake_law'::text,
    'tournament_fee_law'::text]));

-- ── 4. The drift alarm ─────────────────────────────────────────────────────
--
-- A trigger only sees the writers that go through Postgres row-by-row. It does
-- not see a COPY, a restore, a superuser session that disabled triggers, or a
-- future migration that rewrites a price in bulk. The alarm is what notices
-- any of those, and it is DB-side for the same reason the rake alarm is: it
-- cannot drift away from an engine build, and it keeps working through a
-- deploy that reports green and ships nothing.
--
-- Scoped to rows created at or after the cutover. The 9,357 legacy rows are
-- not findings — they are the history this ruling deliberately left alone —
-- and an alarm that reports them every hour is an alarm somebody turns off.
CREATE OR REPLACE FUNCTION public.fn_tournament_fee_violations(
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  tournament_id uuid,
  club_id       uuid,
  created_at    timestamptz,
  status        text,
  max_players   integer,
  seat_rate     numeric,
  total         numeric,
  fee           numeric,
  expected      numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH t AS (
    SELECT tr.id, tr.club_id, tr.created_at, tr.status, tr.max_players,
           public.fn_tournament_seat_rake_rate(tr.max_players, tr.variant, tr.tournament_type) AS rate,
           COALESCE(tr.buy_in_amount, 0) + COALESCE(tr.buy_in_fee, 0) AS total,
           COALESCE(tr.buy_in_fee, 0) AS fee
      FROM public.tournaments tr
     WHERE tr.created_at >= COALESCE(p_since, public.fn_tournament_fee_rule_cutover())
  )
  SELECT t.id, t.club_id, t.created_at, t.status, t.max_players,
         t.rate, t.total, t.fee,
         public.fn_tournament_expected_fee(t.total, t.rate)
    FROM t
   WHERE t.fee <> public.fn_tournament_expected_fee(t.total, t.rate);
$$;

COMMENT ON FUNCTION public.fn_tournament_fee_violations(timestamptz) IS
  'Tournaments created at or after the cutover whose buy_in_fee is not the seat-keyed rule value. Legacy rows are out of scope by design.';

-- Writes into ledger_reconcile_log beside the money-integrity checks, so there
-- is ONE place to look. Idempotent by tournament id: a row already filed is
-- never filed twice, which matters because the window overlaps itself and
-- because a corrected row should stop reappearing on its own.
--
-- 'critical', not 'warn': every finding here is a price a player was charged.
CREATE OR REPLACE FUNCTION public.fn_tournament_fee_law_check(
  p_since timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_tournament_fee_violations(p_since)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       drift, severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'tournament_fee_law', v.club_id,
           v.expected, v.fee, round(v.fee - v.expected, 2),
           'critical',
           jsonb_build_object(
             'tournament_id', v.tournament_id,
             'created_at', v.created_at,
             'status', v.status,
             'max_players', v.max_players,
             'seat_rate', v.seat_rate,
             'total', v.total),
           'tournament fee rule: ' || v.max_players::text || ' seats, total '
             || v.total::text || ', charged ' || v.fee::text
             || ' where ' || v.expected::text || ' was owed'
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'tournament_fee_law'
          AND l.metadata->>'tournament_id' = v.tournament_id::text)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.fn_tournament_fee_law_check(timestamptz) IS
  'Files every post-cutover seat-rule violation into ledger_reconcile_log as critical, once per tournament. Read-only with respect to money.';

-- Neither function is a browser surface: they read every club's prices, so
-- nothing holding an anon or authenticated JWT has any business calling them.
-- A trigger function is not an API (20260831d): the system invokes it, so no
-- role needs EXECUTE on it.
REVOKE ALL ON FUNCTION public.fn_tournament_fee_seat_rule()                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_fee_rule_cutover()                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_seat_rake_rate(integer, text, text)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_expected_fee(numeric, numeric)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_fee_violations(timestamptz)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_fee_law_check(timestamptz)                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_fee_rule_cutover()                  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_seat_rake_rate(integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_expected_fee(numeric, numeric)      TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_fee_violations(timestamptz)         TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_fee_law_check(timestamptz)          TO service_role;

-- The trigger runs as whoever writes the row, and that writer must be able to
-- read the three helpers it calls.
GRANT EXECUTE ON FUNCTION public.fn_tournament_fee_rule_cutover()                  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_seat_rake_rate(integer, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_expected_fee(numeric, numeric)      TO anon, authenticated;

-- ── 5. The schedule ────────────────────────────────────────────────────────
-- Hourly at :25, over the whole post-cutover history rather than a window: the
-- tournament table is small next to hand_history, the tournament-id guard
-- makes a re-scan free, and a violation that arrives by a path the trigger
-- cannot see has no reason to arrive inside the last two hours. Off :00, :20,
-- :40 and :55 so it does not queue behind ca-quick-reconcile-5m,
-- bomb-multi-winner-repair-hourly, rake-law-adherence-hourly or
-- reconcile-ledger-integrity-6h.
SELECT cron.unschedule('tournament-fee-law-hourly')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tournament-fee-law-hourly');

SELECT cron.schedule('tournament-fee-law-hourly', '25 * * * *',
                     $cron$SELECT public.fn_tournament_fee_law_check();$cron$);

-- ── 6. Post-apply assertions ───────────────────────────────────────────────
DO $verify$
DECLARE
  v_legacy integer;
  v_live   integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'trg_tournament_fee_seat_rule'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'assertion failed: trg_tournament_fee_seat_rule is not attached';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ledger_reconcile_log_entity_type_check'
       AND pg_get_constraintdef(oid) LIKE '%tournament_fee_law%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: entity_type check does not allow tournament_fee_law';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tournament-fee-law-hourly') THEN
    RAISE EXCEPTION 'assertion failed: tournament-fee-law-hourly is not scheduled';
  END IF;

  -- The guard must refuse nothing that is currently alive. A non-zero count
  -- here means a live tournament is mispriced and the ruling needs revisiting
  -- before this ships, not that the predicate is wrong.
  SELECT count(*) INTO v_live
    FROM public.tournaments tr
   WHERE tr.status NOT IN ('COMPLETED', 'CANCELLED')
     AND COALESCE(tr.buy_in_fee, 0) <> public.fn_tournament_expected_fee(
           COALESCE(tr.buy_in_amount, 0) + COALESCE(tr.buy_in_fee, 0),
           public.fn_tournament_seat_rake_rate(tr.max_players, tr.variant, tr.tournament_type));
  IF v_live > 0 THEN
    RAISE EXCEPTION 'assertion failed: % live or upcoming tournament(s) break the seat-keyed fee rule', v_live;
  END IF;

  -- And the alarm must be quiet on day one: everything it can see is either
  -- compliant or older than the cutover.
  SELECT count(*) INTO v_legacy FROM public.fn_tournament_fee_violations();
  IF v_legacy > 0 THEN
    RAISE EXCEPTION 'assertion failed: % post-cutover row(s) already break the rule', v_legacy;
  END IF;

  RAISE NOTICE 'seat-keyed fee rule armed; legacy rows left untouched by design';
END
$verify$;
