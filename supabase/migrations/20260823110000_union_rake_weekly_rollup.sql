-- 20260823110000_union_rake_weekly_rollup.sql
--
-- THE ROLLUP fn_club_money_panel needs.
--
-- That function is the most expensive statement on the instance by 3.7x:
-- 1,238 calls at a mean of 1,454 ms, 1,785 seconds total. Two covering indexes
-- (20260823065000, 20260823100000) removed every wasted row from its two weekly
-- sums and it is STILL ~150 ms each, because the work is real: the union has
-- 699,425 rake rows and ~180,000 of them fall in the current week, growing daily
-- until the week rolls over. No index makes a sum of 180,000 rows cheap.
--
-- Those 699,425 ledger rows collapse to 16 rollup rows. That is the whole fix.
--
-- WHAT IS AND IS NOT AUTHORITATIVE
-- union_wallet_transactions remains the sole source of truth for money. This
-- table is DERIVED DISPLAY DATA only - the same relationship club_hand_daily
-- already has to hand_history, maintained the same way, by an AFTER INSERT
-- trigger. Nothing reads it to make a financial decision; it backs a panel.
-- fn_club_money_panel falls back to summing the ledger if a rollup row is
-- missing, so a gap can only ever cost latency, never correctness.
--
-- WHY THE LOCK. The first attempt at this migration backfilled and then created
-- the trigger, and its own assertion caught the resulting race: under READ
-- COMMITTED each statement takes a fresh snapshot, so rake rows banked between
-- the backfill and the verify were counted by neither, and the migration refused
-- to install a rollup that disagreed with the ledger in 1 group. Taking
-- SHARE ROW EXCLUSIVE for the duration makes backfill and trigger installation
-- atomic with respect to INSERTs. It conflicts with INSERT's ROW EXCLUSIVE, so
-- the engine's rake writes QUEUE for a second or two rather than failing, and
-- proceed the moment this commits.
--
-- APPEND-ONLY ASSUMPTION, STATED. The ledger is insert-only in practice
-- (n_dead_tup has been 0 on every observation, and it carries no UPDATE or
-- DELETE path). The trigger therefore handles INSERT only. If an UPDATE or
-- DELETE path is ever added, this rollup must be extended or it will drift -
-- hence fn_union_rake_weekly_verify(), which proves rollup equals ledger on
-- demand and is asserted at the end of this migration.

CREATE TABLE IF NOT EXISTS public.union_rake_weekly (
  union_id   uuid        NOT NULL,
  club_id    uuid,
  week_start date        NOT NULL,
  rake_total numeric     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_rake_weekly_key
    UNIQUE NULLS NOT DISTINCT (union_id, club_id, week_start)
);

COMMENT ON TABLE public.union_rake_weekly IS
  'Derived weekly rake totals per (union, club). Display data for fn_club_money_panel; union_wallet_transactions remains the source of truth. Maintained by trg_union_rake_weekly on INSERT. Verify with fn_union_rake_weekly_verify().';

CREATE OR REPLACE FUNCTION public.trg_union_rake_weekly()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.union_id IS NOT NULL
     AND NEW.wallet = 'rake_wallet'
     AND NEW.direction = 'credit'
     AND NEW.tx_type = 'rake' THEN
    INSERT INTO public.union_rake_weekly (union_id, club_id, week_start, rake_total, updated_at)
    VALUES (NEW.union_id, NEW.club_id, date_trunc('week', NEW.created_at)::date,
            COALESCE(NEW.amount, 0), now())
    ON CONFLICT ON CONSTRAINT union_rake_weekly_key DO UPDATE
      SET rake_total = public.union_rake_weekly.rake_total + EXCLUDED.rake_total,
          updated_at = now();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never let a display rollup block the engine banking rake. A failure here
  -- costs a stale panel; the function's fallback still reads the ledger.
  RAISE WARNING 'union_rake_weekly maintenance failed for tx %: %', NEW.id, SQLERRM;
  RETURN NULL;
END
$function$;

-- Falsifiable proof that the rollup equals the ledger. Returns offending rows;
-- empty means exact agreement.
CREATE OR REPLACE FUNCTION public.fn_union_rake_weekly_verify()
RETURNS TABLE(union_id uuid, club_id uuid, week_start date, ledger numeric, rollup numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ledger AS (
    SELECT t.union_id, t.club_id, date_trunc('week', t.created_at)::date AS week_start,
           SUM(t.amount) AS amt
      FROM public.union_wallet_transactions t
     WHERE t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
       AND t.union_id IS NOT NULL
     GROUP BY 1,2,3
  )
  SELECT COALESCE(l.union_id, r.union_id),
         COALESCE(l.club_id,  r.club_id),
         COALESCE(l.week_start, r.week_start),
         COALESCE(l.amt, 0), COALESCE(r.rake_total, 0)
    FROM ledger l
    FULL JOIN public.union_rake_weekly r
      ON r.union_id = l.union_id
     AND r.week_start = l.week_start
     AND r.club_id IS NOT DISTINCT FROM l.club_id
   WHERE COALESCE(l.amt, 0) <> COALESCE(r.rake_total, 0);
$function$;

REVOKE ALL ON FUNCTION public.fn_union_rake_weekly_verify() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_union_rake_weekly_verify() FROM anon, authenticated;

ALTER TABLE public.union_rake_weekly ENABLE ROW LEVEL SECURITY;
-- No policies: only definer-rights functions read it. Clients reach it through
-- fn_club_money_panel, which does its own authorisation.

-- Freeze INSERTs, install the trigger, then recompute absolute totals from the
-- ledger in the same critical section, so the two can never disagree.
LOCK TABLE public.union_wallet_transactions IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS union_rake_weekly_maintain ON public.union_wallet_transactions;
CREATE TRIGGER union_rake_weekly_maintain
AFTER INSERT ON public.union_wallet_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_union_rake_weekly();

-- Absolute (SET, not +=) so this is idempotent and self-correcting if re-run.
INSERT INTO public.union_rake_weekly (union_id, club_id, week_start, rake_total)
SELECT t.union_id, t.club_id, date_trunc('week', t.created_at)::date, SUM(t.amount)
  FROM public.union_wallet_transactions t
 WHERE t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
   AND t.union_id IS NOT NULL
 GROUP BY 1, 2, 3
ON CONFLICT ON CONSTRAINT union_rake_weekly_key DO UPDATE
  SET rake_total = EXCLUDED.rake_total, updated_at = now();

DO $assert$
DECLARE
  v_bad  int;
  v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.union_rake_weekly;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'backfill produced no rows';
  END IF;

  SELECT count(*) INTO v_bad FROM public.fn_union_rake_weekly_verify();
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'rollup disagrees with the ledger in % group(s)', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.union_wallet_transactions'::regclass
                    AND tgname='union_rake_weekly_maintain' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'maintenance trigger was not created';
  END IF;

  RAISE NOTICE 'union_rake_weekly: % rows, ledger agreement exact', v_rows;
END $assert$;

-- ROLLBACK
--   DROP TRIGGER IF EXISTS union_rake_weekly_maintain ON public.union_wallet_transactions;
--   DROP FUNCTION IF EXISTS public.trg_union_rake_weekly();
--   DROP FUNCTION IF EXISTS public.fn_union_rake_weekly_verify();
--   DROP TABLE IF EXISTS public.union_rake_weekly;
--   (fn_club_money_panel falls back to the ledger, so it keeps working.)
