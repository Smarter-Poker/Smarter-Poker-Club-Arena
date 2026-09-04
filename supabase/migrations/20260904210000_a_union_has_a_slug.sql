-- ═══════════════════════════════════════════════════════════════════════════════
--  A UNION HAS A SLUG (Dan, 2026-09-04)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Every club route reads /clubs/<slug>; every union route still read
-- /unions/<uuid> (Midway Union lived at /unions/fade0000-0000-0000-0000-
-- 000000000001/...). Clubs got a `slug` column in the clubs table; unions never
-- did. Midway's slug exists only because the union has a companion club row
-- with the same id (is_union = true, slug = 'midway-union') - a union created
-- through manage-union.js gets no such row, so it could never have had one.
--
-- This puts the slug on the union itself:
--   * `unions.slug`  - unique, lower-case, [a-z0-9-], never a UUID, never a
--                      reserved route word ('create').
--   * fn_union_slugify(name)  - the deterministic derivation.
--   * fn_unions_set_slug()    - BEFORE INSERT OR UPDATE: fills a missing slug
--                      from the name, normalises a supplied one, and suffixes
--                      -2, -3, ... on collision.
--   * backfill: a union whose house club row already carries a slug keeps THAT
--     slug (so Midway stays 'midway-union' and its two URL namespaces agree);
--     everything else is derived from the name.
--
-- One transaction: every DDL statement here is one pgrst_ddl_watch reload
-- (~28s each on this database) unless they are coalesced (CLAUDE.md §2).

BEGIN;

ALTER TABLE public.unions ADD COLUMN IF NOT EXISTS slug text;

CREATE OR REPLACE FUNCTION public.fn_union_slugify(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    trim(BOTH '-' FROM regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_unions_set_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_base text;
  v_slug text;
  v_n    integer := 1;
BEGIN
  v_base := public.fn_union_slugify(COALESCE(NULLIF(NEW.slug, ''), NEW.name));
  IF v_base IS NULL THEN
    v_base := 'union';
  END IF;
  -- A slug that parses as a UUID, or that is a route word, would be
  -- indistinguishable from the thing it stands beside.
  IF v_base ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_base IN ('create') THEN
    v_base := v_base || '-union';
  END IF;
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM public.unions u WHERE u.slug = v_slug AND u.id <> NEW.id) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;
  NEW.slug := v_slug;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_unions_set_slug ON public.unions;
CREATE TRIGGER trg_unions_set_slug
  BEFORE INSERT OR UPDATE OF slug, name ON public.unions
  FOR EACH ROW EXECUTE FUNCTION public.fn_unions_set_slug();

-- Backfill 1: keep the house club row's slug where one exists.
UPDATE public.unions u
   SET slug = c.slug
  FROM public.clubs c
 WHERE c.id = u.id
   AND c.is_union IS TRUE
   AND c.slug IS NOT NULL
   AND u.slug IS NULL;

-- Backfill 2: everything else derives from its name (the trigger fills it).
UPDATE public.unions SET slug = NULL WHERE slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unions_slug_key ON public.unions (slug);
ALTER TABLE public.unions ALTER COLUMN slug SET NOT NULL;

COMMENT ON COLUMN public.unions.slug IS
  'Route identity: /unions/<slug>. Unique, lower-case [a-z0-9-], never a UUID. Filled by trg_unions_set_slug from the name when not supplied.';

COMMIT;
