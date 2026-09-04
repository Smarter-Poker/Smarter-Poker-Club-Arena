-- ═══════════════════════════════════════════════════════════════════════════
--  UNION CREATION IS AN ALLOWLIST (Dan, 2026-09-04)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan: "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL ACCOUNTS EXCEPT
-- FOR MINE."
--
-- Hiding a page is decoration. /unions/create was a URL any signed-in account
-- could type, and the endpoint behind the form
-- (World Hub pages/api/club-arena/manage-union.js, action 'create') runs as
-- the SERVICE ROLE, which bypasses RLS entirely - so no policy on `unions`
-- would have stopped it either. The lock therefore lives on the table, as a
-- BEFORE INSERT trigger every caller meets: the API, a script, a stray insert
-- from a future surface nobody has written yet.
--
-- An allowlist TABLE rather than an identity compiled into the app or named in
-- a migration: adding or removing someone is a row, reviewable and reversible,
-- and no file in any repo carries a person's address (the World Hub's
-- a-script-never-wears-a-persons-face law is the same principle).
--
-- THE SEED grandfathers whoever already owns a union on the day this ran - one
-- account, the founder's. A database with no unions seeds nobody, which is the
-- correct closed default.
--
-- One transaction: each DDL statement is its own ~28s PostgREST schema reload
-- unless they are coalesced (CLAUDE.md section 2).

BEGIN;

SET LOCAL lock_timeout = '8s';

CREATE TABLE IF NOT EXISTS public.union_creators (
  user_id  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note     text,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES auth.users(id)
);

COMMENT ON TABLE public.union_creators IS
  'Who may create a union. Enforced by trg_union_creation_is_allowlisted on public.unions; read by fn_can_create_union. Empty means nobody.';

ALTER TABLE public.union_creators ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS union_creators_svc ON public.union_creators;
CREATE POLICY union_creators_svc ON public.union_creators
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- A person may learn whether THEY hold it, and nothing else. Who else is on
-- the list is not theirs to read.
DROP POLICY IF EXISTS union_creators_read_self ON public.union_creators;
CREATE POLICY union_creators_read_self ON public.union_creators
  FOR SELECT TO authenticated USING (user_id = (select auth.uid()));

INSERT INTO public.union_creators (user_id, note)
SELECT DISTINCT u.owner_id,
       'Grandfathered: already owned a union when creation was closed (2026-09-04).'
  FROM public.unions u
 WHERE u.owner_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_can_create_union(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.union_creators c WHERE c.user_id = p_user_id);
$$;

COMMENT ON FUNCTION public.fn_can_create_union(uuid) IS
  'May this account create a union? The UI asks before offering the page; the trigger on public.unions asks again and is the one that decides.';

GRANT EXECUTE ON FUNCTION public.fn_can_create_union(uuid) TO authenticated;

-- The lock itself. INSERT only: transferring an existing union is a separate
-- decision and is deliberately untouched.
CREATE OR REPLACE FUNCTION public.fn_guard_union_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.fn_can_create_union(NEW.owner_id) THEN
    RAISE EXCEPTION 'Union creation is not open on this account.'
      USING ERRCODE = 'check_violation',
            HINT = 'public.union_creators is the allowlist.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_union_creation_is_allowlisted ON public.unions;
CREATE TRIGGER trg_union_creation_is_allowlisted
  BEFORE INSERT ON public.unions
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_union_creation();

COMMIT;
