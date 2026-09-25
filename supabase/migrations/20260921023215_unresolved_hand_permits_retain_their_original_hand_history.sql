-- A hand's own history is not disposable while that hand is still unresolved.
--
-- public.sp_prune_hand_history(integer) chooses its victims by age and
-- classification alone, and then deletes FOUR tables for every chosen hand:
-- public.rake_attributions, public.ca_hand_player_idx,
-- public.hand_atomic_commits and public.hand_history itself. pg_cron job 117
-- (`3,13,23,33,43,53 * * * *`, `public.sp_prune_hand_history(5000)`) runs it
-- every ten minutes against an 8-day boundary.
--
-- Both retained-original disposition paths -
-- smarter_private.f06_retired_origin_snapshot and
-- smarter_private.f06_retained_mtt_abort_snapshot - read public.hand_history
-- AND public.hand_atomic_commits. A hand whose F06 permit is still 'reserved'
-- has not had its disposition decided, so those rows are the originals the
-- disposition is owed. The prune already exempts bbj_payouts,
-- hand_projection_outbox, pending tournament_knockout_candidates and a Spin
-- whose canonical terminal state has not committed - but it has never asked
-- whether the hand itself is still unresolved.
--
-- This is the same hazard, on the same evidence, that destroyed Noon table
-- 2c621856-e728-4e8b-bf08-4c56746a8649 hand 12942021's hole cards through
-- public.cleanup_old_hole_cards(); migration 20260920232341 fixed that one and
-- introduced the shared unresolved test. Migration 20260918230713 had fixed it
-- earlier for hand_state_snapshots. Neither covered this prune.
--
-- This changes only the existing retention predicate, and REUSES migration
-- 20260920232341's helper unchanged so the three cleanups cannot disagree
-- about what is unresolved. The 8-day deletion is untouched for every other
-- row; retention ends when the permit leaves 'reserved', so it is bounded and
-- never permanent. No schedule, permit, roster, snapshot, payout or engine
-- behaviour changes, and the cron job is left exactly as it is.
--
-- WHERE THE EXEMPTION GOES, AND WHY THAT IS THE WHOLE FIX
--
-- All four DELETEs key off one array, v_doomed, built from the ids chosen by
-- the `candidates` CTE. Of the four tables only public.hand_atomic_commits
-- also carries its own (table_id, hand_number) - it is the table's PRIMARY KEY
-- there - but the prune never deletes it by that key; it deletes
-- `WHERE hand_id=ANY(v_doomed)`. public.rake_attributions and
-- public.ca_hand_player_idx are keyed by hand_id alone and carry no hand
-- number at all. So a single exemption in the `candidates` CTE retains all
-- four tables' rows together, and no per-table predicate is possible for the
-- two that have no hand number, nor needed for the one that does.
--
-- Excluding the hand from the CANDIDATE SET rather than from each DELETE also
-- keeps it out of v_keepers, so the prune does not write has_human=true on it.
-- That distinction is the difference between a bounded retention and a
-- permanent one: a has_human flag would retain the hand for ever, long after
-- its permit resolved. Scenario 050 of the probe is the proof.
--
-- WHY THE LOOKUP IS A SEPARATE SECURITY DEFINER HELPER
--
-- public.sp_prune_hand_state_snapshots is SECURITY DEFINER, so it reads
-- smarter_private.f06_hand_permits inline. public.sp_prune_hand_history is
-- SECURITY INVOKER (prosecdef = false) and its search_path is
-- `public, pg_temp`, which does not include smarter_private, while the permit
-- table is readable by postgres alone (relacl {postgres=arwdDxtm/postgres},
-- RLS enabled with no policies). Its ACL is {postgres=X/postgres} today, so an
-- inline read would happen to work for job 117's postgres caller - and would
-- start returning zero rows, deleting the evidence anyway, the day that ACL is
-- widened to service_role. Preserving this function's security mode exactly,
-- as required, means putting the read behind the definer helper that already
-- exists: smarter_private.f06_hand_cards_unresolved(uuid, bigint), created by
-- migration 20260920232341 and reused here byte-for-byte rather than forked.
-- public.hand_history.hand_number is integer where the permit's is bigint, so
-- the call casts explicitly rather than leaning on implicit widening.
--
-- Nothing in this migration writes a row. The proof below is read-only and
-- bounded - a full scan of public.hand_history would exceed the statement
-- timeout - and the deleting proof runs on a disposable cluster in
-- scripts/dev/probe-unresolved-hand-history-retention-pg17.sh.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $hand_history_preimage$
DECLARE target oid := to_regprocedure('public.sp_prune_hand_history(integer)');
        helper oid := to_regprocedure('smarter_private.f06_hand_cards_unresolved(uuid,bigint)');
BEGIN
 -- PRE-IMAGE. The live identity of the function this repair edits, captured
 -- from kuklfnapbkmacvwxktbh on 2026-09-21: body md5, definition md5, owner,
 -- ACL, proconfig, security mode and volatility. Anything else is refused.
 -- The second definition md5 is this migration's own result, so re-applying it
 -- is a clean no-op rather than a refusal.
 IF current_user <> 'postgres' OR target IS NULL THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF md5(pg_get_functiondef(target)) IS DISTINCT FROM '0838c5ee8e0d57a26371a2fdfa22671c'
 AND (md5(pg_get_functiondef(target)) IS DISTINCT FROM 'c43d29f674703b496fa31a9645216df7'
   OR md5((SELECT prosrc FROM pg_proc WHERE oid=target)) IS DISTINCT FROM '52a56eefd5555bf016e5cbd7167f923e') THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
   AND NOT prosecdef AND provolatile='v'
   AND proacl::text='{postgres=X/postgres}'
   AND proconfig=ARRAY['search_path=public, pg_temp']::text[]) THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 -- A helper of this name that is not migration 20260920232341's is somebody
 -- else's object; replacing it blind would change their behaviour, and the
 -- whole point of reusing it is that all three cleanups share one definition.
 IF helper IS NOT NULL
 AND md5(pg_get_functiondef(helper)) IS DISTINCT FROM '2a0ae05eeef418193cefc4ef5881b289' THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_HELPER_CHANGED' USING ERRCODE='55000';
 END IF;

 -- The permit table this retention now depends on, in the shape it is read in.
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('smarter_private.f06_hand_permits')
   AND relkind='r' AND relowner='postgres'::regrole)
 OR EXISTS(SELECT 1 FROM (VALUES('table_id','uuid'),('hand_number','bigint'),('state','text')) required(name,kind)
   WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('smarter_private.f06_hand_permits')
      AND attname=required.name AND atttypid=to_regtype(required.kind) AND NOT attisdropped))
 -- 'reserved' is the only non-terminal state this enum admits. Each of the
 -- other three is written together with the evidence_id of the receipt that
 -- resolved the hand, so a permit leaves 'reserved' exactly when its
 -- disposition has been decided. If the enum changes, re-reason this retention.
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('smarter_private.f06_hand_permits')
   AND conname='f06_hand_permits_state_check'
   AND pg_get_constraintdef(oid)=
   'CHECK ((state = ANY (ARRAY[''reserved''::text, ''accepted''::text, ''never_started''::text, ''aborted_unsettled''::text])))')
 -- One permit per hand is what makes "only terminal permits" a decidable
 -- question for an exact (table_id, hand_number).
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('smarter_private.f06_hand_permits')
   AND conname='f06_hand_permits_table_id_hand_number_key'
   AND pg_get_constraintdef(oid)='UNIQUE (table_id, hand_number)')
 -- The four tables the prune deletes from, and the key each is deleted by.
 -- hand_atomic_commits is the only one that also carries a hand number; if
 -- rake_attributions or ca_hand_player_idx ever gained one, or hand_id stopped
 -- being the delete key, this single-point exemption must be re-reasoned.
 OR EXISTS(SELECT 1 FROM (VALUES
      ('public.hand_history','id'),
      ('public.hand_atomic_commits','hand_id'),
      ('public.rake_attributions','hand_id'),
      ('public.ca_hand_player_idx','hand_id')) required(rel,key)
   WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(required.rel)
      AND attname=required.key AND atttypid='uuid'::regtype AND NOT attisdropped))
 OR EXISTS(SELECT 1 FROM (VALUES('public.rake_attributions'),('public.ca_hand_player_idx')) forbidden(rel)
   WHERE EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(forbidden.rel)
      AND attname='hand_number' AND NOT attisdropped)) THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_DEPENDENCY_CHANGED' USING ERRCODE='55000';
 END IF;
END $hand_history_preimage$;

-- Migration 20260920232341's helper, byte-for-byte. Stated here so this
-- migration is self-contained on a database that has not taken that one; the
-- pre-image guard above has already refused any other definition of this name.
CREATE OR REPLACE FUNCTION smarter_private.f06_hand_cards_unresolved(p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  -- The one unresolved test, shared with public.sp_prune_hand_state_snapshots:
  -- an exact (table_id, hand_number) whose F06 permit is still 'reserved'.
  -- 'accepted', 'never_started' and 'aborted_unsettled' are the other three
  -- states admitted by f06_hand_permits_state_check, and each is written
  -- together with the evidence_id of the receipt that resolved the hand, so a
  -- permit leaves 'reserved' exactly when its disposition has been decided.
  -- Reads permit state only; never card data.
  SELECT EXISTS (
    SELECT 1 FROM smarter_private.f06_hand_permits p
     WHERE p.table_id = p_table_id AND p.hand_number = p_hand_number
       AND p.state = 'reserved');
$function$;
ALTER FUNCTION smarter_private.f06_hand_cards_unresolved(uuid, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_hand_cards_unresolved(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_hand_cards_unresolved(uuid, bigint) TO service_role;

DO $hand_history_retention$
DECLARE target oid := to_regprocedure('public.sp_prune_hand_history(integer)');
        helper oid := to_regprocedure('smarter_private.f06_hand_cards_unresolved(uuid,bigint)');
        before_metadata jsonb;
        after_metadata jsonb;
        original text;
        replacement text;
BEGIN
 IF md5(pg_get_functiondef(target)) = '0838c5ee8e0d57a26371a2fdfa22671c' THEN
  RAISE NOTICE 'sp_prune_hand_history already retains unresolved hands; body unchanged';
 ELSE
  SELECT to_jsonb(p)-'prosrc' INTO before_metadata FROM pg_proc p WHERE oid=target;
  original := pg_get_functiondef(target);
  replacement := replace(original,
$before$         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')$before$,
$after$         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- A hand whose F06 permit is still 'reserved' is unresolved, and this
         -- row is original evidence for it:
         -- smarter_private.f06_retired_origin_snapshot and
         -- smarter_private.f06_retained_mtt_abort_snapshot both read
         -- public.hand_history and public.hand_atomic_commits. All four DELETEs
         -- below key off the ids chosen here, so excluding the hand at this one
         -- point retains its history, atomic commit, rake attribution and
         -- player-index rows together. Excluding it from the candidate set
         -- rather than from each DELETE also keeps it out of v_keepers, so no
         -- has_human=true is written that would retain it past its permit, and
         -- it never consumes a p_batch slot. Retention ends when the permit
         -- leaves 'reserved'; every other row prunes on the same boundary as
         -- before. The lookup goes through the SECURITY DEFINER helper added by
         -- migration 20260920232341, because this function is SECURITY INVOKER
         -- and its search_path does not include smarter_private.
         AND NOT smarter_private.f06_hand_cards_unresolved(hh.table_id,hh.hand_number::bigint)$after$);
  IF replacement=original OR md5(replacement) IS DISTINCT FROM '0838c5ee8e0d57a26371a2fdfa22671c' THEN
   RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_COMPOSITION_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE replacement;
  SELECT to_jsonb(p)-'prosrc' INTO after_metadata FROM pg_proc p WHERE oid=target;
  -- POST-IMAGE. Owner, ACL, search_path, volatility and security mode must be
  -- byte-identical to the pre-image; only the body may have moved.
  IF after_metadata IS DISTINCT FROM before_metadata
  OR pg_get_functiondef(target) IS DISTINCT FROM replacement THEN
   RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
 END IF;

 -- POST-IMAGE, both objects, including the helper's own definer identity.
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
   AND NOT prosecdef AND provolatile='v'
   AND proacl::text='{postgres=X/postgres}'
   AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
 OR md5(pg_get_functiondef(target)) IS DISTINCT FROM '0838c5ee8e0d57a26371a2fdfa22671c' THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF helper IS NULL OR md5(pg_get_functiondef(helper)) IS DISTINCT FROM '2a0ae05eeef418193cefc4ef5881b289'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=helper AND proowner='postgres'::regrole
   AND prosecdef AND provolatile='s'
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
   AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_HELPER_CHANGED' USING ERRCODE='55000';
 END IF;
END $hand_history_retention$;

DO $hand_history_proof$
DECLARE n bigint; states bigint; reserved bigint; retained bigint; sampled bigint;
        v_days integer;
BEGIN
 -- EXECUTABLE PROOF, read-only, in this same transaction. Every query is
 -- bounded: driven from the permit side, or capped at one p_batch of the
 -- oldest history rows - the very rows the next fire of job 117 will consider.

 -- (1) A hand with no permit at all is resolved, so it stays deletable. This
 --     is the direction that must never regress into unbounded retention.
 IF smarter_private.f06_hand_cards_unresolved(
      '00000000-0000-0000-0000-000000000000'::uuid, 9223372036854775807) IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_PROOF_NO_PERMIT_RETAINED' USING ERRCODE='55000';
 END IF;

 -- (2) Both directions on real permits, one representative of every state the
 --     enum admits: reserved is unresolved, and each of the three terminal
 --     states is resolved. This is what makes retention end rather than last.
 WITH one_per_state AS (
   SELECT DISTINCT ON (p.state) p.table_id, p.hand_number, p.state
     FROM smarter_private.f06_hand_permits p
    ORDER BY p.state, p.permit_id
 )
 SELECT count(*) FILTER (WHERE smarter_private.f06_hand_cards_unresolved(s.table_id, s.hand_number)
                               IS DISTINCT FROM (s.state = 'reserved')),
        count(*)
   INTO n, states
   FROM one_per_state s;
 IF n <> 0 THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_PROOF_STATE_DISAGREES: % of % state(s)', n, states
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'hand-history retention proof: both directions hold for % permit state(s)', states;

 -- (3) The helper answers true for every reserved permit there is, so nothing
 --     unresolved is left unprotected. Bounded by the reserved set itself.
 SELECT count(*), count(*) FILTER (WHERE smarter_private.f06_hand_cards_unresolved(p.table_id, p.hand_number))
   INTO reserved, n
   FROM smarter_private.f06_hand_permits p WHERE p.state='reserved';
 IF n <> reserved THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_PROOF_RESERVED_UNPROTECTED: % of %', reserved-n, reserved
   USING ERRCODE='55000';
 END IF;

 -- (4) Over one batch of the oldest history past the live boundary, the rows
 --     this retention keeps are exactly the rows whose hand still holds a
 --     reserved permit - not one row wider.
 SELECT greatest(coalesce(horse_retention_days,8),1) INTO v_days
   FROM public.hand_history_retention_policy LIMIT 1;
 IF v_days IS NULL THEN v_days := 8; END IF;
 WITH batch AS (
   SELECT hh.table_id, hh.hand_number
     FROM public.hand_history hh
    WHERE hh.created_at < now() - make_interval(days=>v_days)
    ORDER BY hh.created_at
    LIMIT 5000
 )
 SELECT count(*),
        count(*) FILTER (WHERE smarter_private.f06_hand_cards_unresolved(b.table_id, b.hand_number::bigint)),
        count(*) FILTER (WHERE smarter_private.f06_hand_cards_unresolved(b.table_id, b.hand_number::bigint)
                               IS DISTINCT FROM EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                                                         WHERE p.table_id = b.table_id
                                                           AND p.hand_number = b.hand_number::bigint
                                                           AND p.state = 'reserved'))
   INTO sampled, retained, n
   FROM batch b;
 IF n <> 0 THEN
  RAISE EXCEPTION 'F06_HAND_HISTORY_RETENTION_PROOF_WIDENED: % of % row(s)', n, sampled USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'hand-history retention proof: % reserved permit(s); of the oldest % row(s) past the %-day boundary, % are retained',
   reserved, sampled, v_days, retained;
END $hand_history_proof$;

COMMENT ON FUNCTION public.sp_prune_hand_history(integer) IS
 'Existing 8-day horse hand-history prune - hand_history plus its hand_atomic_commits, rake_attributions and ca_hand_player_idx rows - except an exact table/hand whose F06 permit is still reserved. Retain original evidence until its owning transition resolves; the schedule, the age boundary, the batch and the deletion of every resolved hand are unchanged.';
COMMENT ON FUNCTION smarter_private.f06_hand_cards_unresolved(uuid, bigint) IS
 'True while an exact table/hand still holds a reserved F06 hand permit. The same unresolved test public.sp_prune_hand_state_snapshots, public.cleanup_old_hole_cards and public.sp_prune_hand_history retain on. Reads permit state only, never card data.';
COMMIT;
