-- 20260919145853_a_banned_character_must_not_reach_the_database
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 14:58:53 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- Dan banned the m bar on 2026-08-20 and repeated it on 2026-08-31: "remove
-- any and all m bars as they are banned from use." Migration 20260831202752
-- rewrote the 120 public functions that were serving one and left
-- fn_ca_banned_copy_characters() behind so CI could ask production the
-- question directly. scripts/ci/check-db-copy.mjs reads that function, Cron
-- Health runs the script, and the run fails on a finding.
--
-- Cron Health has been failing since 2026-09-10 on exactly one finding:
--
--   fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)
--     line 308 of its body, a comment reading
--     "and would be refused there <banned> a separate, rare (0.01%) defect"
--
-- It arrived with 20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_
-- stamps_the_row.sql and nothing stopped it, because the two gates for this
-- rule read SOURCE and walk src/, public/ and server/src, and NOTHING walks
-- supabase/migrations. A migration is the one way copy reaches a function
-- body, so it was the one door with no lock on it.
--
-- WHAT IT COST, stated plainly: nothing a player saw. The character sits in a
-- comment, not in a RAISE message or a jsonb 'message', so no copy served to
-- anybody carried it. What it cost was nine days of a red gate, and a gate
-- that is chronically red is the same blind spot as no gate, which is the
-- lesson this estate has already paid for twice.
--
-- WHAT THIS DOES
--
-- check-db-copy.mjs's own failure text states the remedy: "re-run the
-- translate in 20260831202752_the_em_dash_ban_reaches_the_database as a new
-- migration." That is what this is, and it deliberately does not name the
-- offending function. It finds every public function whose body carries one of
-- the four characters and rewrites exactly those, so it stays correct if
-- another one arrived between the measurement above and the moment this runs,
-- and it is a no-op on a database that is already clean.
--
-- THE CAP, and why a blunt tool gets one. This rewrites live function bodies
-- with a textual translate. 20260831202752 aimed that at 120 functions on
-- purpose, in a migration written for it. Today the answer is one. A run that
-- suddenly matches dozens means something upstream changed that nobody looked
-- at, and rewriting them unattended is how a repair becomes an incident, so
-- this refuses past five instead.
--
-- THE GATE IS THE ARBITER, not this file's idea of the gate. The rewrite is
-- driven by a predicate over pg_proc, because casting the checker's rendered
-- signatures back to oids depends on search_path and is a needless place to be
-- wrong. But the last thing this transaction does is ask
-- fn_ca_banned_copy_characters() itself, and refuse if it still reports a dash
-- finding. If the predicate and the gate ever disagree, nothing is committed.
--
-- THIS FILE CARRIES NO BANNED CHARACTER. A migration that holds the character
-- it bans cannot be covered by the rule it installs. The four are written as
-- chr(8210), chr(8211), chr(8212) and chr(8213): figure dash, en dash, m bar,
-- horizontal bar, the same four fn_ca_banned_copy_characters() looks for, and
-- the same four 20260831202752 translated. From now on
-- tests/a-banned-character-must-not-reach-the-database.law.test.ts fails any
-- migration dated 20260911 or later that carries one, which is the lock the
-- door never had. 609 of the 3,169 migrations before that date carry one, so
-- the law binds forward: a rule that fails on history gets switched off.
--
-- @live-proof: (SELECT count(*) FROM public.fn_ca_banned_copy_characters() f WHERE f.kind = 'dash') = 0
-- @live-proof: (SELECT strpos(p.prosrc, 'refused there - a separate') > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_spin_draw_and_settle_atomic')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog, public;

DO $ban$
DECLARE
  -- Figure dash, en dash, m bar, horizontal bar. Never written literally: see
  -- the header. This is the same set fn_ca_banned_copy_characters() matches.
  v_banned  CONSTANT text := chr(8210) || chr(8211) || chr(8212) || chr(8213);
  v_targets oid[];
  v_oid     oid;
  v_name    text;
  v_def     text;
  v_fixed   text;
  v_n       integer;
  v_left    text;
BEGIN
  SELECT coalesce(array_agg(p.oid ORDER BY p.oid), ARRAY[]::oid[])
    INTO v_targets
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     -- The checker holds the characters it checks for, on purpose. Translating
     -- its own character class turns it into a valid, meaningless range and
     -- the gate silently disables itself. 20260831202752 carries this same
     -- exemption three times for the same reason.
     AND p.proname <> 'fn_ca_banned_copy_characters'
     AND p.prosrc ~ ('[' || v_banned || ']');

  v_n := coalesce(array_length(v_targets, 1), 0);

  IF v_n = 0 THEN
    RAISE NOTICE 'no public function carries a banned dash character; nothing to rewrite';
  ELSIF v_n > 5 THEN
    RAISE EXCEPTION 'refused: % public functions carry a banned dash character, which is more than this migration will rewrite unattended (5). Something upstream changed. Read select * from public.fn_ca_banned_copy_characters() and write a migration for it.', v_n;
  ELSE
    FOREACH v_oid IN ARRAY v_targets LOOP
      v_name  := v_oid::regprocedure::text;
      v_def   := pg_get_functiondef(v_oid);
      v_fixed := translate(v_def, v_banned, '----');
      IF v_fixed = v_def THEN
        RAISE EXCEPTION
          'refused: % matched on its body but its definition translates to itself', v_name;
      END IF;
      EXECUTE v_fixed;
      RAISE NOTICE 'rewrote %', v_name;
    END LOOP;
  END IF;

  -- The gate decides, not the predicate above. Scoped to 'dash' because that
  -- is what this migration is about: an emoji finding is a different rule with
  -- a different exemption list, and refusing on one here would make a fresh
  -- rebuild of this database fail for a reason this file never addressed.
  SELECT string_agg(f.object_name, ', ') INTO v_left
    FROM public.fn_ca_banned_copy_characters() f
   WHERE f.kind = 'dash';

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'failed: a public function still carries a banned dash character: %', v_left;
  END IF;
END
$ban$;

COMMIT;
