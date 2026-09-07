-- THE MINT LEDGER'S REFERENCE INTO THE JOURNAL GETS ITS CONSTRAINT BACK.
--
-- Phase 5. Roadmap 8.4 says `chip_ledger` partitioning is "blocked on the
-- `ca_mint_ledger.chip_ledger_id` foreign key". Measured 2026-09-07:
--
--   foreign keys referencing public.chip_ledger      0
--   foreign keys on public.ca_mint_ledger of any kind 0
--   ca_mint_ledger rows holding a chip_ledger_id     361
--   of those, orphaned today                         0
--
-- The blocker does not exist, and that is worse than if it did. The COLUMN is
-- still there and still in use - 361 mint-ledger rows name a journal leg - but
-- nothing enforces that the leg is real. The constraint was lost at some point
-- and the reference outlived it, so the mint register can point at a leg that
-- is not there and no error will ever be raised.
--
-- Today nothing is wrong: all 361 resolve. This puts the guard back while that
-- is still true, which is the only cheap moment to do it.
--
-- WHY IT MATTERS MORE NOW, not less. Dan ruled on 2026-09-07 that the journal
-- keeps every leg for ever and that partitioning is for cheap reads and
-- archiving, never for dropping. Under that ruling no leg is ever removed, so
-- this can never fire - which is exactly the point. A constraint that cannot
-- fire is a rule the database enforces for free, and it is what turns "we
-- decided not to drop legs" into "a leg with a reference cannot be dropped".
-- If a later agent ever writes a DROP PARTITION, this refuses it rather than
-- letting the mint register quietly start lying.
--
-- ON DELETE RESTRICT, deliberately, and NOT CASCADE: a mint-register row is
-- evidence that chips were issued or retired, and deleting it because a journal
-- leg went away would destroy the record of the thing rather than the pointer
-- to it. RESTRICT refuses the delete and makes somebody look.
--
-- LOCKING. Adding a foreign key takes SHARE ROW EXCLUSIVE on the referenced
-- table, which conflicts with INSERT, so this briefly blocks writes to
-- `chip_ledger` - a table taking about 285,000 legs a day. It is brief:
-- `ca_mint_ledger` holds 7,321 rows, 361 of which are validated by index
-- lookup against `chip_ledger_pkey`, and an index on the referencing column
-- already exists so the check is not a scan. `lock_timeout` is 4 seconds, so
-- if the journal is busy this aborts cleanly with nothing applied rather than
-- queueing in front of live play.

BEGIN;

SET LOCAL lock_timeout = '4s';

DO $precheck$
DECLARE v_orphans int;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM public.ca_mint_ledger m
   WHERE m.chip_ledger_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.id = m.chip_ledger_id);

  IF v_orphans <> 0 THEN
    RAISE EXCEPTION 'ABORT: % mint-ledger row(s) already point at a journal leg that is not there - settle those before adding the constraint, do not let it fail on apply', v_orphans;
  END IF;
END $precheck$;

ALTER TABLE public.ca_mint_ledger
  ADD CONSTRAINT ca_mint_ledger_chip_ledger_id_fkey
  FOREIGN KEY (chip_ledger_id) REFERENCES public.chip_ledger (id)
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- PROVE IT, from the catalogue, and say plainly what is NOT proved here.
--
-- The refusal itself is deliberately not exercised. Two probes were written and
-- both were refused by the platform, each for a good reason:
--
--   INSERT a copied row  ->  "cannot insert a non-DEFAULT value into column
--                            origin" - ca_mint_ledger has a GENERATED ALWAYS
--                            column.
--   UPDATE the reference ->  "UPDATE on ca_mint_ledger is forbidden: the mint
--                            register is append-only. A retirement offsets an
--                            issuance; neither is ever edited or removed."
--
-- The second refusal is the register working exactly as designed, and it offers
-- a maintenance hatch (app.ledger_maintenance with an incident reference) that
-- would be an abuse to use for a test. Deleting a referenced leg to test the
-- RESTRICT half would prove nothing either: chip_ledger is append-only too, so
-- its own guard would refuse first and the probe would pass without the
-- constraint existing at all - a green light that means nothing (CLAUDE.md
-- 10.86).
--
-- So this asserts what can be asserted honestly: the constraint exists, it is
-- VALIDATED - which is what makes it cover the 361 rows already there rather
-- than only future ones - it points at chip_ledger(id), and it RESTRICTs. The
-- enforcement itself is Postgres's, not something this migration needs to
-- demonstrate (CLAUDE.md 11.5 rule 5: if it cannot be probed safely, say so
-- rather than pretending).
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE c record;
BEGIN
  SELECT con.convalidated, con.confdeltype, con.confrelid::regclass::text AS refs,
         (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS col,
         (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = con.confrelid AND a.attnum = con.confkey[1]) AS refcol
    INTO c
    FROM pg_constraint con
   WHERE con.conrelid = 'public.ca_mint_ledger'::regclass
     AND con.conname = 'ca_mint_ledger_chip_ledger_id_fkey'
     AND con.contype = 'f';

  IF c IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: the constraint was not created';
  END IF;
  IF NOT c.convalidated THEN
    RAISE EXCEPTION 'VERIFY FAILED: the constraint exists but was never validated, so it does not cover the 361 rows already there';
  END IF;
  IF c.refs <> 'chip_ledger' OR c.col <> 'chip_ledger_id' OR c.refcol <> 'id' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the constraint points at %.% from %, not chip_ledger.id from chip_ledger_id', c.refs, c.refcol, c.col;
  END IF;
  IF c.confdeltype <> 'r' THEN
    RAISE EXCEPTION 'VERIFY FAILED: ON DELETE is %, not RESTRICT - a deleted leg would change or erase the mint register instead of refusing', c.confdeltype;
  END IF;

  RAISE NOTICE 'MINT_REFERENCE_CONSTRAINED validated over 361 references, ON DELETE RESTRICT: a leg with a mint-register reference can no longer be dropped, and a reference to a leg that is not there can no longer be written';
END $verify$;

COMMIT;
