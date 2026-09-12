-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906123105; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906123105   (the stamp IS the apply time, UTC: 2026-09-06 12:31:05)
--   name        no_two_horses_share_a_name
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3659 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906123105 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- No two horses share a name.
--
-- Dan, 2026-09-06, seeing the feed: "WTF ARE THESE 'REAL NAMES'. THEY AREN'T
-- REAL AT ALL."
--
-- Measured: all 1,000 horses display `full_name`, and 132 of them shared that
-- name with another horse - 60 names used twice or three times. "Isolde
-- Beauchamp" appeared three times, "Andrew Colombo" three times. The
-- usernames show how it happened: `andrew colombo`, `andrew colombo 2`,
-- `andrew colombo 3` - horses were copied and the suffix went on the username
-- while the displayed name stayed identical.
--
-- Three accounts with one name is the tell that gives the whole fleet away,
-- and no amount of good writing survives it.
--
-- THE NEW NAMES ARE NOT INVENTED. They are recombinations of first and last
-- names already in the fleet - 486 firsts against 449 lasts, 196,340 pairings
-- that do not already exist - so the cultural mix is unchanged and no name
-- style arrives that was not already here. The oldest horse in each group
-- keeps the original name; only the copies are renamed.
--
-- Rehearsed in a rolled-back transaction first: 132 sharing before, 72
-- renamed, 0 sharing after.
--
-- Dan chose this over switching the feed to the poker aliases (each horse has
-- a unique one). Recorded so nobody "fixes" it back.

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT id, username, full_name AS old_name, row_number() OVER (ORDER BY id) AS rn FROM (
  SELECT id, username, full_name,
         row_number() OVER (PARTITION BY full_name ORDER BY created_at, id) AS seat
  FROM profiles WHERE is_horse
) s WHERE seat > 1;

CREATE TEMP TABLE t_pool ON COMMIT DROP AS
SELECT f, l, row_number() OVER (ORDER BY md5(f || l)) AS rn FROM (
  SELECT DISTINCT f.f, l.l
  FROM (SELECT DISTINCT btrim(split_part(full_name,' ',1)) f FROM profiles
        WHERE is_horse AND full_name ~ '^[A-Z][a-z]+ [A-Z][a-z]+') f
  CROSS JOIN
       (SELECT DISTINCT btrim(split_part(full_name,' ',2)) l FROM profiles
        WHERE is_horse AND full_name ~ '^[A-Z][a-z]+ [A-Z][a-z]+') l
  WHERE length(f.f) >= 3 AND length(l.l) >= 3
    AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.full_name = f.f || ' ' || l.l)
) c;

UPDATE profiles p
SET first_name = pl.f,
    last_name  = pl.l,
    full_name  = pl.f || ' ' || pl.l,
    -- A username like "andrew colombo 2" is the same defect wearing a
    -- different hat, so it is rebuilt from the new name. A username that is a
    -- real handle - krypto, vegasgrinder85, flint - is left alone: those are
    -- good, and they are what a poker player would actually pick.
    username = CASE
      WHEN p.username ~* ('^' || regexp_replace(fx.old_name, '([^a-zA-Z0-9 ])', '\\\\\1', 'g') || '( [0-9]+)?$')
        THEN lower(pl.f) || lower(left(pl.l, 3)) || substr(md5(p.id::text), 1, 3)
      ELSE p.username
    END
FROM t_fix fx JOIN t_pool pl ON pl.rn = fx.rn
WHERE p.id = fx.id;

DO $$
DECLARE v_sharing int; v_dupuser int; v_suffix int;
BEGIN
  SELECT count(*) INTO v_sharing FROM profiles d WHERE d.is_horse
    AND EXISTS (SELECT 1 FROM profiles e WHERE e.is_horse AND e.full_name = d.full_name AND e.id <> d.id);
  SELECT count(*) INTO v_dupuser FROM (
    SELECT username FROM profiles WHERE is_horse GROUP BY 1 HAVING count(*) > 1) x;
  SELECT count(*) INTO v_suffix FROM profiles WHERE is_horse AND username ~ '^[a-z]+ [a-z]+ [0-9]+$';

  IF v_sharing <> 0 THEN
    RAISE EXCEPTION 'profiles: % horses still share a display name', v_sharing;
  END IF;
  IF v_dupuser <> 0 THEN
    RAISE EXCEPTION 'profiles: % duplicate horse usernames', v_dupuser;
  END IF;

  RAISE NOTICE 'every horse has its own name. copy-suffixed usernames remaining: %', v_suffix;
END $$;
