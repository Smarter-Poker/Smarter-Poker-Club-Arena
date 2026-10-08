-- 20261008043038_a_diamond_arena_seat_is_not_an_orphan_stamp.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A DIAMOND ARENA SEAT IS NOT AN ORPHAN STAMP (2026-10-08)
--
-- fn_ca_conservation_sweep raises fn_union_chip_integrity_check and
-- fn_union_law_integrity_breaches as CRITICAL every hour since 2026-10-06
-- 20:52 UTC (ca_drift_incidents open, 35 + 35 alert rows). Measured read-only
-- on production 2026-10-08 04:20 UTC, every offender is in ONE club, the
-- Diamond Arena (002c2d27-9584-4e52-835a-bb2be148fc81, asset diamonds,
-- is_platform true, union_id NULL): 150 open seats and 540 live tournament
-- entries, all created since the arena began spawning the Midway schedule on
-- 2026-10-07 (20261006090619, 20261007000010, 20261007010105). Every one of
-- those players holds a live sign-in and an open profile.
--
-- The check asks for a club_members row. The arena never writes one: every
-- live account is a member of the platform arena by rule
-- (fn_poker_arena_context: asset 'diamonds' and is_platform, member := true;
-- 20260929214500 "Every account with a profile is a Diamond member"), and an
-- arena cash-out lands in the player's Diamond wallet, not in club_members.
-- So "a club the player does not belong to - cash-out cannot land" is false
-- for every arena row, and the two CRITICAL incidents page on a design fact.
-- This is a detector defect, not a stamping defect: no seat or entry is wrong.
--
-- THE FIX: in orphan_stamped_seat and orphan_stamped_entry, a stamp to the
-- platform Diamond arena is an orphan only when its player has no live
-- account (no profile, a deleted sign-in, or a closed profile), which is the
-- arena's own membership rule. Chip clubs are judged exactly as before,
-- negative_club_balance and seat_stamped_outside_union are untouched, and
-- fn_union_law_integrity_breaches (which reads this function) needs no edit.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (35e372f3...), each anchor must
-- occur exactly once, and the result must hash to the derived postimage
-- (057b1188..., derived read-only on production 2026-10-08 with replace() over the
-- same bytes; on production the candidate predicate leaves 0 seats and 0 entries); owner,
-- SECURITY DEFINER, proconfig and grants (postgres, service_role) must not
-- move. A second run refuses on the pinned preimage.
--
-- Regression: scripts/ci/test-union-chip-integrity-arena.py (native
-- PostgreSQL), run by .github/workflows/union-chip-integrity-arena.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_chip_integrity_check()'::regprocedure)) = '057b118890dcd29fccb3aec5b189edf7')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_detector_subst(p_sig text, p_before text, p_after text,
                                          p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_detector_subst(
  'public.fn_union_chip_integrity_check()',
  '35e372f310ce794d10c5201943fd6ddc', '057b118890dcd29fccb3aec5b189edf7',
  ARRAY[$so1$                      WHERE m.user_id = ts.user_id AND m.club_id = ts.club_id)
$so1$,
        $eo1$                      WHERE m.user_id = tp.user_id AND m.club_id = tp.club_id)
$eo1$],
  ARRAY[$sn1$                      WHERE m.user_id = ts.user_id AND m.club_id = ts.club_id)
     -- THE DIAMOND ARENA KEEPS NO club_members ROWS (2026-10-08). Every live
     -- account is a member of the platform arena (fn_poker_arena_context),
     -- and an arena cash-out lands in the Diamond wallet. An arena seat is an
     -- orphan only when its player has no live, open account.
     AND NOT EXISTS (SELECT 1 FROM clubs c
                      WHERE c.id = ts.club_id AND c.asset = 'diamonds' AND c.is_platform
                        AND EXISTS (SELECT 1 FROM profiles pr
                                      JOIN auth.users u ON u.id = pr.id
                                     WHERE pr.id = ts.user_id AND u.deleted_at IS NULL
                                       AND pr.status IS DISTINCT FROM 'deleted'))
$sn1$,
        $en1$                      WHERE m.user_id = tp.user_id AND m.club_id = tp.club_id)
     -- The same arena membership rule for a live arena tournament entry.
     AND NOT EXISTS (SELECT 1 FROM clubs c
                      WHERE c.id = tp.club_id AND c.asset = 'diamonds' AND c.is_platform
                        AND EXISTS (SELECT 1 FROM profiles pr
                                      JOIN auth.users u ON u.id = pr.id
                                     WHERE pr.id = tp.user_id AND u.deleted_at IS NULL
                                       AND pr.status IS DISTINCT FROM 'deleted'))
$en1$]
);

COMMIT;
