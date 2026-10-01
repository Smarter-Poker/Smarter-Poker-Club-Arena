-- 20260930164146_the_register_is_a_supply_ledger_and_says_so_per_wallet.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work. The
-- reserved version was 20260930163141; the file carries 20260930164146 because
-- that is the version the management API actually recorded when it applied,
-- and a file whose name disagrees with the recorded version is a gap that
-- check-applied-migrations-are-recorded.mjs would report for ever.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE 1,068 WALLETS WHERE "THE REGISTER DISAGREES WITH HOLDINGS" ARE NOT A
-- MONEY DEFECT. Nobody is short a diamond and nothing is owed. This migration
-- moves no money, writes no register row and writes no journal row. It gives
-- the per-wallet question an answer that can be read in one call, and replaces
-- an expectation that was never true with the check that can actually break.
--
-- 20260930055147 (the_journal_explains_the_balance) closed a real defect and
-- left this note behind for whoever picked it up:
--
--   "Separately, and out of scope here: the register does not agree with
--    holdings wallet-by-wallet. 1,068 wallets differ, netting to zero
--    globally. That is a different defect from this one and is untouched."
--
-- Measured on production 2026-09-30, that reads as follows.
--
--  * The global identity is EXACT. fn_ca_mint_supply('diamonds') = 6,853,624
--    and SUM(profiles.diamonds) = 6,853,624; fn_ca_diamond_register_vs_supply()
--    reports difference 0.00 with the house at 0 and the arena float at 0.
--
--  * Per wallet, SUM(mint) - SUM(burn) over the player's own register rows is
--    short on 1,068 of the 1,427 live profiles, by 1,021,092 in total. Every
--    one of the 1,068 leans the SAME WAY: the wallet holds more than its own
--    register rows add up to. Gross difference equals net difference exactly
--    (1,021,092 = 1,021,092), so not one wallet is short. A per-wallet money
--    defect produces both directions. A missing opening balance produces one.
--    The earlier note's "netting to zero globally" is corrected here: the
--    1,068 do not offset each other at all.
--
--  * The shortfall is the opening stock, and the register says so in its own
--    rows. On 2026-09-03 the whole pre-standard supply was acknowledged as a
--    SINGLE row against the `circulation` holder, op_id
--    'baseline:diamonds:2026-09-03:v2', holder_label "all player wallets
--    (pre-standard circulation acknowledged as baseline)", plus two later
--    'register-opening-baseline-correction:diamonds:%' rows. Net to the
--    circulation holder: 1,623,417. docs/DIAMOND-ACCOUNTING-STANDARD.md lane B
--    specifies exactly that and specifies "backfill NOTHING". Attributing that
--    lump per holder now would contradict a written standard and would rewrite
--    1,231 rows of a money ledger for no money.
--
--    1,623,417 (circulation) - 602,325 (the residual the deletion door left on
--    667 holders whose profiles are gone) = 1,021,092, the live gap exactly.
--
--  * The distribution is a signup ledger, not noise: 581 wallets differ by
--    exactly 300 (profiles born 2026-01-13 to 2026-03-11, the 300 grant era),
--    436 by exactly 500 (2026-03-06 to 2026-09-01, the 500 grant era), 10 by
--    exactly 10,000 (one seeded fleet created in the same second).
--
--  * The per-wallet truth the register DOES carry is balance_after, and it is
--    exact. For all 1,252 live wallets the register has ever tracked, a
--    register row at the wallet's latest register instant carries
--    balance_after equal to what that wallet holds today. Zero drift.
--    Independently, diamond_transactions sums to holdings for 1,413 of the
--    1,415 wallets with a journal; the two exceptions are a NULL balance_after
--    and a March 2026 legacy row, and both wallets' journals still sum to
--    their holdings to the diamond.
--
-- SO: the register's per-wallet NET is not a wallet balance and never was. Its
-- balance_after IS. This migration names both, in SQL, so the next agent does
-- not re-derive it from twenty queries, and so a real divergence has a check.
--
-- HORSES. Nothing here selects on is_horse and nothing here treats a horse
-- differently. The cohort above is defined by the register and the balance and
-- by nothing else (CLAUDE.md 10.5).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- THREE OUTCOMES, NEVER TWO (CLAUDE.md 10.86 rule 1). A wallet the register has
-- never tracked is not "balanced"; it is a wallet nothing can be concluded
-- about, and it says so by name.
CREATE OR REPLACE FUNCTION public.fn_ca_mint_wallet_attribution(p_user_id uuid DEFAULT NULL)
RETURNS TABLE(
  user_id                          uuid,
  held                             numeric,
  register_net                     numeric,
  unattributed_opening_stock       numeric,
  register_chain_end               numeric,
  journal_rows_since_last_register bigint,
  verdict                          text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH scope AS (
    SELECT p.id, COALESCE(p.diamonds, 0)::numeric AS held
      FROM public.profiles p
     WHERE p_user_id IS NULL OR p.id = p_user_id
  ),
  last_reg AS (
    SELECT m.holder_id, max(m.created_at) AS at
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id
  ),
  net AS (
    SELECT m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS n
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id
  ),
  base AS (
    SELECT s.id, s.held, COALESCE(n.n, 0) AS register_net,
           (lr.holder_id IS NOT NULL) AS tracked, lr.at AS last_reg_at,
           -- The reading at the wallet's latest register instant that AGREES
           -- with holdings, if there is one. Several rows can share one
           -- created_at (one transaction claiming many rewards), so
           -- ORDER BY created_at DESC LIMIT 1 picks arbitrarily among them,
           -- and that is what made an earlier reading of this report 38 false
           -- drifts. Read the chain by value.
           (SELECT m.balance_after FROM public.ca_mint_ledger m
             WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND m.holder_id = s.id
               AND m.created_at = lr.at AND m.balance_after = s.held LIMIT 1) AS agreeing_end
      FROM scope s
      LEFT JOIN last_reg lr ON lr.holder_id = s.id
      LEFT JOIN net n ON n.holder_id = s.id
  )
  SELECT b.id,
         b.held,
         b.register_net,
         b.held - b.register_net,
         CASE WHEN NOT b.tracked THEN NULL
              ELSE COALESCE(b.agreeing_end,
                     (SELECT max(m.balance_after) FROM public.ca_mint_ledger m
                       WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
                         AND m.holder_id = b.id AND m.created_at = b.last_reg_at)) END,
         -- Counted ONLY where it is diagnostic, which is a drifting wallet.
         -- Counting it for all 1,427 cost 5.1 of this read's 5.6 seconds and
         -- told nobody anything: a wallet whose chain already ends at its
         -- holdings has no unfollowed movement to find. NULL means not
         -- counted, not zero.
         CASE WHEN b.tracked AND b.agreeing_end IS NULL
              THEN (SELECT count(*) FROM public.diamond_transactions t
                     WHERE t.user_id = b.id AND t.created_at > b.last_reg_at) END,
         CASE WHEN NOT b.tracked THEN 'opening_stock_only'
              WHEN b.agreeing_end IS NOT NULL THEN 'register_agrees'
              ELSE 'register_drifts' END
    FROM base b;
$fn$;

COMMENT ON FUNCTION public.fn_ca_mint_wallet_attribution(uuid) IS
$c$What the Mint register can and cannot say about ONE wallet. Read only.

register_net is SUM(mint) - SUM(burn) over that wallet's own register rows. It
is NOT the wallet balance and was never meant to be: the pre-2026-09-03 supply
was acknowledged as one lump against the `circulation` holder
(baseline:diamonds:2026-09-03:v2) and deliberately never attributed per holder
(docs/DIAMOND-ACCOUNTING-STANDARD.md lane B, "backfill NOTHING"). The
difference held - register_net is therefore that wallet's opening stock, which
is why on 2026-09-30 all 1,068 differing wallets held MORE than their register
net and not one held less.

register_chain_end is the per-wallet truth the register does carry, and it is
exact.

verdict is one of three, never two:
  register_agrees     the register tracks this wallet and its balance chain
                      ends exactly at what the wallet holds.
  register_drifts     the register tracks this wallet and its chain does NOT
                      end at holdings. This is the real fault: something moved
                      profiles.diamonds that the register did not follow. Read
                      journal_rows_since_last_register to see whether the
                      journal followed it either. That count is computed only
                      for a drifting wallet, because counting it for every
                      wallet cost 5.1 of this read's 5.6 seconds and told
                      nobody anything; NULL there means not counted, not
                      zero.
  opening_stock_only  the register has never tracked this wallet. Its whole
                      balance predates the baseline. NOTHING IS CONCLUDED, and
                      this is not "balanced".$c$;

CREATE OR REPLACE FUNCTION public.fn_ca_mint_register_attribution()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH w AS (SELECT * FROM public.fn_ca_mint_wallet_attribution(NULL))
  SELECT jsonb_build_object(
    'live_wallets',               (SELECT count(*) FROM w),
    'register_agrees',            (SELECT count(*) FROM w WHERE verdict = 'register_agrees'),
    'register_drifts',            (SELECT count(*) FROM w WHERE verdict = 'register_drifts'),
    'opening_stock_only',         (SELECT count(*) FROM w WHERE verdict = 'opening_stock_only'),
    'wallets_net_differs',        (SELECT count(*) FROM w WHERE held <> register_net),
    'unattributed_opening_stock', (SELECT COALESCE(sum(unattributed_opening_stock), 0) FROM w),
    'baseline_circulation_net',   (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
                                     FROM public.ca_mint_ledger
                                    WHERE asset = 'diamonds' AND holder_type IN ('circulation', 'house')),
    'deleted_holder_residual',    (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
                                     FROM public.ca_mint_ledger m
                                    WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
                                      AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = m.holder_id)),
    'global_identity_difference', (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()),
    'read_at',                    now()
  );
$fn$;

COMMENT ON FUNCTION public.fn_ca_mint_register_attribution() IS
$c$The per-wallet standing of the diamond register, in one read. Read only.

register_drifts is the number that matters and it is expected to be 0. It
counts wallets the register tracks whose balance chain does not end at what
the wallet holds, which is the only shape a genuine per-wallet fault can take.

wallets_net_differs is NOT a fault count. It counts wallets whose register NET
is short by their unattributed opening stock, which is by design. On
2026-09-30 it read 1,068 with register_drifts 0, and
unattributed_opening_stock (1,021,092) equalled baseline_circulation_net
(1,623,417) plus deleted_holder_residual (-602,325) to the diamond.

This function repairs nothing, pays nothing and is not scheduled. It is a read
(CLAUDE.md 10.11, 10.12).$c$;

COMMENT ON COLUMN public.ca_mint_ledger.balance_after IS
'The holder''s balance immediately after this movement. THIS is the per-wallet
truth in the register: for every live wallet the register tracks, a row at the
wallet''s latest register instant carries the balance that wallet holds today.
Several rows can share one created_at (one transaction claiming many rewards),
so read the chain by value and not by ORDER BY created_at DESC LIMIT 1. The
per-wallet SUM(mint)-SUM(burn) is a different quantity and is short by the
wallet''s unattributed opening stock; see fn_ca_mint_wallet_attribution.';

-- Shape assertions. The COUNTS are deliberately not asserted: this migration
-- moves no money and must not fail because a wallet moved while it applied.
DO $assert$
DECLARE v jsonb; v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM public.fn_ca_mint_wallet_attribution(NULL)
   WHERE verdict IS NULL OR verdict NOT IN ('register_agrees', 'register_drifts', 'opening_stock_only');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'fn_ca_mint_wallet_attribution left % wallets without one of the three verdicts', v_bad;
  END IF;
  v := public.fn_ca_mint_register_attribution();
  IF NOT (v ? 'register_drifts') OR NOT (v ? 'opening_stock_only') OR NOT (v ? 'register_agrees') THEN
    RAISE EXCEPTION 'fn_ca_mint_register_attribution lost a verdict count';
  END IF;
  RAISE NOTICE 'register attribution at install: %', v::text;
END $assert$;

-- OPERATOR TELEMETRY, CLOSED TO EVERY PRE-LOGIN ROLE. Both are SECURITY
-- DEFINER, so they run as the owner past RLS, and neither asks who is calling.
-- PUBLIC is named alongside anon and authenticated on purpose: anon inherits
-- whatever PUBLIC holds, so revoking anon alone reads as a fix and does
-- nothing. Neither function backs an RLS policy (checked against pg_policy),
-- so revoking them denies no SELECT anywhere.
REVOKE ALL ON FUNCTION public.fn_ca_mint_wallet_attribution(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_mint_register_attribution() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_wallet_attribution(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_register_attribution() TO service_role;

COMMIT;
