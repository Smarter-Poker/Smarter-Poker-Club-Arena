-- 20260905081408_the_register_closes_the_definitional_era.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard, 2026-09-05, after the 09:05 read):
--
-- The supply meter changed definition three times between 02:56 and 07:55 UTC
-- (Phase 5.1: tournament liability from counters to the escrow banks; part
-- four: spins back to counters; Phase 5.2: spins from the reserve-aware
-- escrow). Each step was recorded on the Mint register as a labelled baseline
-- correction, but each was sized at the instant it was applied, not at the
-- hourly snapshot the meter frames its drift against, and between part four
-- and Phase 5.2 the spin counters oscillated against the journal by several
-- hundred an hour in both directions. What that era left behind is one
-- number: the register and the meter disagree by a fixed amount that no chip
-- movement explains and no future hour will change. Measured: the meter read
-- 502.18 above the register at 08:05, the first hour under the final
-- definition, while the only real disagreement in that hour was the felt's
-- boundary noise (in-flight settlements at the snapshot instant, sign
-- alternating, largest 28.25 in nine hours, cumulative -17.5).
--
-- This records ONE labelled correction equal to the disagreement at the
-- latest snapshot, dated to that snapshot's instant so the as-of-meter
-- register carries it, asserted in band and asserted only after the meter has
-- proven flat (the latest hour's unexplained within the felt's noise). It
-- rewrites nothing: every earlier correction stands with its reason, and
-- this row says what it closes. From this row on, `difference` on the Mint
-- card is real drift and nothing else.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $$
DECLARE v record; v_last record; v_supply numeric;
BEGIN
  SELECT * INTO v_last FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF v_last.taken_at < '2026-09-05 09:04+00' THEN
    RAISE EXCEPTION 'the 09:05 snapshot has not been taken (latest %)', v_last.taken_at;
  END IF;
  IF abs(v_last.unexplained) > 50 THEN
    RAISE EXCEPTION 'the latest hour is not flat (unexplained %); the era is not closed', v_last.unexplained;
  END IF;
  SELECT * INTO v FROM public.fn_ca_mint_register_vs_supply();
  IF v.meter_taken_at <> v_last.taken_at THEN
    RAISE EXCEPTION 'register and snapshot disagree on the instant';
  END IF;
  IF abs(v.difference) < 200 OR abs(v.difference) > 900 THEN
    RAISE EXCEPTION 'the residue reads %, outside the 502.18 measured at 08:05 by more than the felt noise', v.difference;
  END IF;
  -- difference = meter - register. A positive difference means the register
  -- must come UP to the meter: a mint-signed correction.
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + v.difference INTO v_supply
    FROM public.ca_mint_ledger WHERE asset = 'chips';
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason, performed_by_label, created_at)
  VALUES
    ('register-opening-baseline-correction:supply-meter-redefinition:2026-09-05-era-close', CASE WHEN v.difference >= 0 THEN 'mint' ELSE 'burn' END, 'chips', 'circulation',
     '00000000-0000-0000-0000-00000000c1c0', 'circulation', abs(v.difference), abs(v.difference), 0, v_supply,
     format('OPENING BASELINE CORRECTION, not issuance: closes the definitional era of 2026-09-05 (02:56 to 07:55 UTC), in which the supply meter''s tournament liability changed definition three times and each step was sized at its own instant rather than at an hourly snapshot, while the spin counters oscillated against the journal in between. The meter read %s against the register at %s UTC, the first hour under the final definition, with that hour''s own unexplained at %s. Dated to that snapshot. From this row on the difference is real drift. No chip moved.',
            v.difference, to_char(v.meter_taken_at, 'YYYY-MM-DD HH24:MI'), v_last.unexplained),
     'chip standard Phase 5.2 close', v.meter_taken_at);
  RAISE NOTICE 'era closed: correction % at %', v.difference, v.meter_taken_at;
END $$;

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM public.fn_ca_mint_register_vs_supply();
  IF abs(v.difference) > 0.01 THEN
    RAISE EXCEPTION 'the register does not equal the meter after the correction (%)', v.difference;
  END IF;
END $$;

COMMIT;
