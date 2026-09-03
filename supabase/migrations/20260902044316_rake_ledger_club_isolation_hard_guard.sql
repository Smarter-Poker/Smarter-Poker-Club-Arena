-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902044316; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- RAKE LEDGER CLUB ISOLATION — HARD GUARD (Dan 2026-09-02, verbatim: "NO
-- OTHER CLUBS DATA CAN EVER EVER EVER CREEP IN OR BE ENTERED INTO ANY OTHER
-- CLUBS LEDGERS! THIS IS A HARD RULE ... LAYERS OF PROTECTION").
--
-- AUDIT FIRST, so the rule is right and not just strict:
--  - Deep Stack Society (standalone club, no union): 0 rake rows from any
--    table it does not own, 0 of its tables raked to another club. Clean.
--  - The 950,589 platform "mismatches" are the LEGITIMATE union model: the
--    TABLE is owned by Midway Union (a shared union table) and the rake is
--    correctly attributed to the member club whose player earned it (Shark,
--    JAQK). Rejecting those would delete the union product, not protect it.
--
-- THE CORRECT RULE, enforced BEFORE the row lands:
--   * table owned by a CLUB (union_id NULL, e.g. Deep Stack): the rake row's
--     club_id MUST equal that club. No union path, no siblings - total
--     isolation, which is exactly what a standalone club needs.
--   * table owned by a UNION, or by a club that belongs to a union: the rake
--     may attribute to the owning entity OR to any member club of that union.
--     A club can never receive rake from a union it is not a member of.
--   * tournament rake: the row's club_id must be the tournament's club, or,
--     for a union/XMTT tournament, that union or a member club of it.
-- A violation raises check_violation and the write dies before the ledger.

CREATE OR REPLACE FUNCTION public.fn_guard_rake_belongs_to_club()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_owner       uuid;   -- the club/union that owns the table or tournament
  v_owner_union uuid;   -- if the owner is a club in a union, that union
  v_is_union    boolean;
BEGIN
  IF NEW.club_id IS NULL THEN
    RETURN NEW;  -- a null club_id cannot enter another club's ledger
  END IF;

  IF NEW.table_id IS NOT NULL THEN
    SELECT club_id INTO v_owner FROM public.tables WHERE id = NEW.table_id;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'rake references table % which does not exist', NEW.table_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.tournament_id IS NOT NULL THEN
    SELECT club_id INTO v_owner FROM public.tournaments WHERE id = NEW.tournament_id;
    IF v_owner IS NULL THEN
      RETURN NEW;  -- clubless tournament: nothing to scope against
    END IF;
  ELSE
    RETURN NEW;    -- neither table nor tournament: nothing to check
  END IF;

  -- The fast path: rake attributed to the owning entity itself.
  IF NEW.club_id = v_owner THEN
    RETURN NEW;
  END IF;

  -- Is the owner a UNION? Then member clubs may earn from its shared table.
  SELECT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_owner) INTO v_is_union;
  IF v_is_union THEN
    IF EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = NEW.club_id
         AND (c.union_id = v_owner
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = v_owner))
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'rake club isolation: club_id % is not a member of union % that owns this game',
      NEW.club_id, v_owner USING ERRCODE = 'check_violation';
  END IF;

  -- The owner is a CLUB. It may still legitimately attribute to a SIBLING in
  -- its own union (a union whose shared table is recorded under the hosting
  -- club rather than the union id). But NEVER outside that union - and a
  -- STANDALONE club (union_id NULL) has no siblings at all, so its ledger is
  -- sealed to itself.
  SELECT union_id INTO v_owner_union FROM public.clubs WHERE id = v_owner;
  IF v_owner_union IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id = NEW.club_id
       AND (c.union_id = v_owner_union OR c.id = v_owner_union
            OR EXISTS (SELECT 1 FROM public.union_clubs uc
                        WHERE uc.club_id = c.id AND uc.union_id = v_owner_union))
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'rake club isolation: club_id % may not receive rake from a game owned by club % (no shared union)',
    NEW.club_id, v_owner USING ERRCODE = 'check_violation';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_rake_belongs_to_club ON public.rake_records;
CREATE TRIGGER trg_guard_rake_belongs_to_club
  BEFORE INSERT OR UPDATE ON public.rake_records
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_rake_belongs_to_club();

-- LAYER 2: the standing audit (zero rows = healthy), for the case the trigger
-- is ever bypassed (a disabled-trigger maintenance window, a future writer).
CREATE OR REPLACE FUNCTION public.fn_rake_club_isolation_violations()
RETURNS TABLE(rake_id uuid, row_club uuid, owner uuid, kind text, amount numeric, created_at timestamptz)
LANGUAGE sql STABLE AS $fn$
  WITH scoped AS (
    SELECT rr.id, rr.club_id AS row_club, rr.rake_amount, rr.created_at,
           COALESCE(t.club_id, tt.club_id) AS owner,
           CASE WHEN rr.table_id IS NOT NULL THEN 'table' ELSE 'tournament' END AS kind
      FROM public.rake_records rr
      LEFT JOIN public.tables t ON t.id = rr.table_id
      LEFT JOIN public.tournaments tt ON tt.id = rr.tournament_id
     WHERE rr.club_id IS NOT NULL
       AND COALESCE(t.club_id, tt.club_id) IS NOT NULL
  )
  SELECT s.id, s.row_club, s.owner, s.kind, s.rake_amount, s.created_at
    FROM scoped s
   WHERE s.row_club <> s.owner
     -- owner is a union and row_club is a member club: ok
     AND NOT (
       EXISTS (SELECT 1 FROM public.unions u WHERE u.id = s.owner)
       AND EXISTS (SELECT 1 FROM public.clubs c
                    WHERE c.id = s.row_club
                      AND (c.union_id = s.owner
                           OR EXISTS (SELECT 1 FROM public.union_clubs uc
                                       WHERE uc.club_id = c.id AND uc.union_id = s.owner)))
     )
     -- owner is a club in a union and row_club is a sibling in that union: ok
     AND NOT EXISTS (
       SELECT 1 FROM public.clubs oc
        JOIN public.clubs rc ON rc.id = s.row_club
       WHERE oc.id = s.owner AND oc.union_id IS NOT NULL
         AND (rc.union_id = oc.union_id OR rc.id = oc.union_id)
     );
$fn$;

REVOKE ALL ON FUNCTION public.fn_rake_club_isolation_violations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_club_isolation_violations() TO service_role;

DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.fn_rake_club_isolation_violations();
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'real rake contamination exists: % row(s) - inspect fn_rake_club_isolation_violations() before trusting the guard', v_bad;
  END IF;
  RAISE NOTICE 'rake club isolation guard + audit installed; real violations: 0';
END $$;
