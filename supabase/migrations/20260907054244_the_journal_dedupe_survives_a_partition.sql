-- THE JOURNAL'S DEDUPE SURVIVES A PARTITION.
--
-- Phase 5, stage 1 of the cut described in `docs/THE-JOURNAL-PARTITION-CUT.md`.
-- Additive and reversible: nothing depends on this yet, and the index it
-- shadows stays exactly where it is.
--
-- THE PROBLEM IT SOLVES. Dan ruled on 2026-09-07 that `chip_ledger` keeps every
-- leg for ever, partitioned by month. Postgres requires every UNIQUE index on a
-- partitioned table to include the partition key, so
-- `ux_chip_ledger_idempotency_key` would have to become
-- `(idempotency_key, created_at)` - and that is not a weaker version of the
-- same guarantee, it is a different one. The same key in two different months
-- would both be accepted. That is exactly the double-record defect fixed on
-- `tournament_payouts` on 2026-09-06, re-introduced into the journal itself.
--
-- So the guarantee moves OUT of the partitioned table, into a companion that is
-- never partitioned and never dropped. The unique violation happens THERE.
--
-- WHY THIS COSTS ALMOST NOTHING, measured before writing: of 2,004,587 legs,
-- exactly **1,611** carry an idempotency key. The companion is a 1,611-row
-- table, and the trigger below does one extra insert on 0.08% of legs. On the
-- other 99.92% it does nothing at all - it returns before touching anything.
--
-- AND WHY THE HASH CHAIN DOES NOT NEED THE SAME TREATMENT, which is worth
-- writing down so nobody builds a 68 MB table for no reason.
-- `chip_ledger_chain_seq_key` is the other unique index, over 1,786,348 legs.
-- But `chain_seq` comes from a sequence and `created_at` is fixed at insert, so
-- a given chain_seq is issued once and lands in exactly one partition:
-- `(chain_seq, created_at)` is effectively as strong as `chain_seq` alone. The
-- residual risk is a hand-written row carrying a duplicate chain_seq with a
-- different timestamp, and the journal is append-only with its own guard
-- against exactly that. The chain is also complete rather than patchy - it was
-- switched on partway through 2026-08-31 and every leg since carries both
-- `chain_seq` and `row_hash`, 100% of every day - so nothing about it is being
-- papered over here.
--
-- WHAT IS NOT DONE YET, deliberately: the old unique index is NOT dropped. Both
-- mechanisms run together from now until the cut, which is stage 2 of the plan
-- and is the point - if they ever disagree, that is a bug found while both are
-- still there to compare, rather than after one has been removed.

BEGIN;

SET LOCAL lock_timeout = '4s';

CREATE TABLE IF NOT EXISTS public.chip_ledger_idem (
  idempotency_key text PRIMARY KEY,
  leg_id          uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.chip_ledger_idem IS
  'One row per keyed chip_ledger leg. Holds the journal''s idempotency guarantee OUTSIDE the journal, so it survives partitioning: a partitioned table''s unique index must include the partition key, which would let the same key through twice in different months. Never partitioned, never dropped with a partition.';

ALTER TABLE public.chip_ledger_idem ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chip_ledger_idem FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.chip_ledger_idem TO service_role;

-- ---------------------------------------------------------------------------
-- BACKFILL. Every keyed leg that exists today.
-- ---------------------------------------------------------------------------
INSERT INTO public.chip_ledger_idem (idempotency_key, leg_id, created_at)
SELECT l.idempotency_key, l.id, l.created_at
  FROM public.chip_ledger l
 WHERE l.idempotency_key IS NOT NULL
ON CONFLICT (idempotency_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- AND EVERY FUTURE ONE. The refusal here is the one that will still work when
-- the journal is partitioned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zz_chip_ledger_key_is_claimed_once()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* 99.92% of legs carry no key and this does nothing for them. */
  IF NEW.idempotency_key IS NULL THEN
    RETURN NEW;
  END IF;

  /* No ON CONFLICT: the unique violation IS the refusal, and it must reach the
     caller exactly as ux_chip_ledger_idempotency_key's does today. Both are
     live until the cut; either one refusing is the correct outcome. */
  INSERT INTO public.chip_ledger_idem (idempotency_key, leg_id, created_at)
  VALUES (NEW.idempotency_key, NEW.id, COALESCE(NEW.created_at, now()));

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.zz_chip_ledger_key_is_claimed_once() IS
  'BEFORE INSERT on chip_ledger: claims the leg''s idempotency key in chip_ledger_idem, where the uniqueness is partition-independent. Does nothing for the 99.92% of legs that carry no key.';

REVOKE ALL ON FUNCTION public.zz_chip_ledger_key_is_claimed_once() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_chip_ledger_key_is_claimed_once ON public.chip_ledger;
CREATE TRIGGER zz_chip_ledger_key_is_claimed_once
  BEFORE INSERT ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION public.zz_chip_ledger_key_is_claimed_once();

-- ---------------------------------------------------------------------------
-- PROVE IT: the backfill is exact in BOTH directions, and a duplicate key is
-- refused through the new path. The probe is rolled back inside a
-- subtransaction - the raise is the success case (CLAUDE.md 11.5).
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_legs      bigint;
  v_claims    bigint;
  v_missing   bigint;
  v_extra     bigint;
  v_refused   boolean := false;
  v_key       text;
BEGIN
  SELECT count(*) INTO v_legs   FROM public.chip_ledger WHERE idempotency_key IS NOT NULL;
  SELECT count(*) INTO v_claims FROM public.chip_ledger_idem;

  SELECT count(*) INTO v_missing FROM (
    SELECT l.idempotency_key FROM public.chip_ledger l WHERE l.idempotency_key IS NOT NULL
    EXCEPT
    SELECT k.idempotency_key FROM public.chip_ledger_idem k) m;

  SELECT count(*) INTO v_extra FROM (
    SELECT k.idempotency_key FROM public.chip_ledger_idem k
    EXCEPT
    SELECT l.idempotency_key FROM public.chip_ledger l WHERE l.idempotency_key IS NOT NULL) e;

  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % keyed leg(s) have no claim row', v_missing;
  END IF;
  IF v_extra <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % claim row(s) name a key no leg carries', v_extra;
  END IF;
  IF v_legs <> v_claims THEN
    RAISE EXCEPTION 'VERIFY FAILED: % keyed legs against % claims', v_legs, v_claims;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.chip_ledger'::regclass
                    AND t.tgname = 'zz_chip_ledger_key_is_claimed_once'
                    AND NOT t.tgisinternal AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the claim trigger is not armed on chip_ledger';
  END IF;

  /* A key already claimed cannot be claimed again. Proved against the claim
     table directly: inserting a leg to test it would be writing to an
     append-only journal to prove a point, which 11.5 forbids. */
  SELECT k.idempotency_key INTO v_key FROM public.chip_ledger_idem k LIMIT 1;
  IF v_key IS NULL THEN
    RAISE NOTICE 'CLAIM_PROBE_NOT_RUN no keyed leg exists yet, so the refusal could not be exercised; the primary key is asserted above';
    v_refused := true;
  ELSE
    BEGIN
      INSERT INTO public.chip_ledger_idem (idempotency_key, leg_id, created_at)
      VALUES (v_key, gen_random_uuid(), now());
      RAISE EXCEPTION 'zz_the_claim_did_not_refuse';
    EXCEPTION
      WHEN unique_violation THEN
        v_refused := true;
      WHEN OTHERS THEN
        IF SQLERRM <> 'zz_the_claim_did_not_refuse' THEN RAISE; END IF;
    END;
  END IF;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'VERIFY FAILED: a key that is already claimed was claimed a second time';
  END IF;

  RAISE NOTICE 'JOURNAL_DEDUPE_IS_PARTITION_READY % keyed legs, % claims, 0 missing, 0 extra; a second claim on a taken key is refused', v_legs, v_claims;
END $verify$;

COMMIT;
