-- A hole card is not disposable while its own hand is still unresolved.
--
-- public.cleanup_old_hole_cards() deleted public.table_hole_cards by age alone.
-- On 2026-09-20 00:00 UTC, pg_cron job 9 run 540885 destroyed the hole cards of
-- Noon table 2c621856-e728-4e8b-bf08-4c56746a8649 hand 12942021 while
-- smarter_private.f06_hand_permits still held permit
-- 098c0945-54f9-4c48-a600-3b8845da267b for that hand in state 'reserved'. The
-- loss is permanent and it blocked a retained-original disposition, because
-- smarter_private.f06_retired_origin_snapshot and
-- smarter_private.f06_retained_mtt_abort_snapshot both require the hole-card
-- rows to match the roster and raise F06_RETAINED_CARDS_CHANGED otherwise.
-- Migration 20260918230713 fixed the same hazard for hand_state_snapshots via
-- public.sp_prune_hand_state_snapshots; it never covered table_hole_cards.
--
-- This changes only the existing retention predicate, and reuses that
-- migration's exact unresolved test so the two cleanups cannot disagree about
-- what is unresolved. The ordinary 24-hour deletion is untouched for every
-- other row; retention ends when the permit leaves 'reserved', so it is
-- bounded and never permanent. No schedule, permit, roster, snapshot, payout or
-- engine behaviour changes, and the cron job is left exactly as it is.
--
-- WHY THE LOOKUP IS A SEPARATE SECURITY DEFINER HELPER
--
-- public.sp_prune_hand_state_snapshots is SECURITY DEFINER, so it reads
-- smarter_private.f06_hand_permits inline. public.cleanup_old_hole_cards() is
-- SECURITY INVOKER and its ACL lets service_role execute it, while the permit
-- table is readable by postgres alone (relacl {postgres=arwdDxtm/postgres},
-- RLS enabled with no policies). An inline read would therefore either raise
-- 'permission denied for table f06_hand_permits' for a service_role caller, or
-- - had that grant ever been added - see zero rows under RLS and delete the
-- evidence anyway. Preserving this function's security mode exactly, as
-- required, means putting the read behind a definer helper: the shape migration
-- 20260919024039 used for smarter_private.f06_lease_has_pending_custody.
--
-- Nothing in this migration writes a row. smarter_private.f06_hand_permits is
-- immutability-guarded (f06_hand_permits_immutable) and public.table_hole_cards
-- is writer-guarded (a00_f06_cancelled_preparation), so the both-directions
-- proof below is executable but read-only; the deleting proof runs on a
-- disposable cluster in
-- scripts/dev/probe-unresolved-hole-card-retention-pg17.sh.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $hole_card_preimage$
DECLARE target oid := to_regprocedure('public.cleanup_old_hole_cards()');
        helper oid := to_regprocedure('smarter_private.f06_hand_cards_unresolved(uuid,bigint)');
BEGIN
 -- PRE-IMAGE. The live identity of the function this repair edits, captured
 -- from kuklfnapbkmacvwxktbh on 2026-09-20: body md5, definition md5, owner,
 -- ACL, proconfig, security mode and volatility. Anything else is refused.
 -- The second definition md5 is this migration's own result, so re-applying it
 -- is a clean no-op rather than a refusal.
 IF current_user <> 'postgres' OR target IS NULL THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF md5(pg_get_functiondef(target)) IS DISTINCT FROM 'ba3ce182b251f06e3e838ad03105fbf0'
 AND (md5(pg_get_functiondef(target)) IS DISTINCT FROM '4cf22b42f8a4ac111ae63b77d7f37849'
   OR md5((SELECT prosrc FROM pg_proc WHERE oid=target)) IS DISTINCT FROM 'cb98131946a9b0ee87250935d06835a3') THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
   AND NOT prosecdef AND provolatile='v'
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
   AND proconfig=ARRAY['search_path=public']::text[]) THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 -- A helper of this name that is not the one written below is somebody else's
 -- object; replacing it blind would change their behaviour, so refuse instead.
 IF helper IS NOT NULL
 AND md5(pg_get_functiondef(helper)) IS DISTINCT FROM '2a0ae05eeef418193cefc4ef5881b289' THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_HELPER_CHANGED' USING ERRCODE='55000';
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
   AND pg_get_constraintdef(oid)='UNIQUE (table_id, hand_number)') THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_DEPENDENCY_CHANGED' USING ERRCODE='55000';
 END IF;
END $hole_card_preimage$;

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

DO $hole_card_retention$
DECLARE target oid := to_regprocedure('public.cleanup_old_hole_cards()');
        helper oid := to_regprocedure('smarter_private.f06_hand_cards_unresolved(uuid,bigint)');
        before_metadata jsonb;
        after_metadata jsonb;
        original text;
        replacement text;
BEGIN
 IF md5(pg_get_functiondef(target)) = 'ba3ce182b251f06e3e838ad03105fbf0' THEN
  RAISE NOTICE 'cleanup_old_hole_cards already retains unresolved hands; body unchanged';
 ELSE
  SELECT to_jsonb(p)-'prosrc' INTO before_metadata FROM pg_proc p WHERE oid=target;
  original := pg_get_functiondef(target);
  replacement := replace(original,
$before$    DELETE FROM public.table_hole_cards WHERE created_at < NOW() - INTERVAL '24 hours';$before$,
$after$    -- A hole card can still be the only original witness for an interrupted
    -- hand: smarter_private.f06_retired_origin_snapshot and
    -- smarter_private.f06_retained_mtt_abort_snapshot both require these rows
    -- to match the roster and raise F06_RETAINED_CARDS_CHANGED otherwise. The
    -- hand's permit, not the age, proves whether the owning transition has
    -- resolved that custody. This is the predicate
    -- public.sp_prune_hand_state_snapshots already retains on, so the two
    -- cleanups cannot disagree about what is unresolved. Retention ends when
    -- the permit leaves 'reserved'; the ordinary 24-hour deletion is unchanged
    -- for every other row. The lookup goes through a SECURITY DEFINER helper
    -- because this function is SECURITY INVOKER and service_role can execute
    -- it but cannot read smarter_private.f06_hand_permits.
    DELETE FROM public.table_hole_cards c WHERE c.created_at < NOW() - INTERVAL '24 hours'
      AND NOT smarter_private.f06_hand_cards_unresolved(c.table_id, c.hand_number);$after$);
  IF replacement=original OR md5(replacement) IS DISTINCT FROM 'ba3ce182b251f06e3e838ad03105fbf0' THEN
   RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_COMPOSITION_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE replacement;
  SELECT to_jsonb(p)-'prosrc' INTO after_metadata FROM pg_proc p WHERE oid=target;
  -- POST-IMAGE. Owner, ACL, search_path, volatility and security mode must be
  -- byte-identical to the pre-image; only the body may have moved.
  IF after_metadata IS DISTINCT FROM before_metadata
  OR pg_get_functiondef(target) IS DISTINCT FROM replacement THEN
   RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
 END IF;

 -- POST-IMAGE, both objects, including the helper's own definer identity.
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole
   AND NOT prosecdef AND provolatile='v'
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
   AND proconfig=ARRAY['search_path=public']::text[])
 OR md5(pg_get_functiondef(target)) IS DISTINCT FROM 'ba3ce182b251f06e3e838ad03105fbf0' THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF helper IS NULL OR md5(pg_get_functiondef(helper)) IS DISTINCT FROM '2a0ae05eeef418193cefc4ef5881b289'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=helper AND proowner='postgres'::regrole
   AND prosecdef AND provolatile='s'
   AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
   AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_HELPER_CHANGED' USING ERRCODE='55000';
 END IF;
END $hole_card_retention$;

DO $hole_card_proof$
DECLARE n bigint; states bigint;
BEGIN
 -- EXECUTABLE PROOF, read-only, in this same transaction.

 -- (1) A hand with no permit at all is resolved, so it stays deletable. This
 --     is the direction that must never regress into unbounded retention.
 IF smarter_private.f06_hand_cards_unresolved(
      '00000000-0000-0000-0000-000000000000'::uuid, 9223372036854775807) IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_PROOF_NO_PERMIT_RETAINED' USING ERRCODE='55000';
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
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_PROOF_STATE_DISAGREES: % of % state(s)', n, states
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'hole-card retention proof: both directions hold for % permit state(s)', states;

 -- (3) The two cleanups cannot disagree: over every hole-card row, the helper
 --     answers exactly what public.sp_prune_hand_state_snapshots retains on.
 SELECT count(*) INTO n FROM public.table_hole_cards c
  WHERE smarter_private.f06_hand_cards_unresolved(c.table_id, c.hand_number)
        IS DISTINCT FROM EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                                  WHERE p.table_id = c.table_id AND p.hand_number = c.hand_number
                                    AND p.state = 'reserved');
 IF n <> 0 THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_PROOF_PREDICATE_DIVERGED: % row(s)', n USING ERRCODE='55000';
 END IF;

 -- (4) Past the age boundary, the rows this retention keeps are exactly the
 --     rows whose hand still holds a reserved permit - not one row wider.
 SELECT count(*) INTO n FROM public.table_hole_cards c
  WHERE c.created_at < now() - interval '24 hours'
    AND smarter_private.f06_hand_cards_unresolved(c.table_id, c.hand_number)
        IS DISTINCT FROM EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                                  WHERE p.table_id = c.table_id AND p.hand_number = c.hand_number
                                    AND p.state = 'reserved');
 IF n <> 0 THEN
  RAISE EXCEPTION 'F06_HOLE_CARD_RETENTION_PROOF_WIDENED: % row(s)', n USING ERRCODE='55000';
 END IF;
END $hole_card_proof$;

COMMENT ON FUNCTION public.cleanup_old_hole_cards() IS
 'Existing 24-hour hole-card retention, except an exact table/hand whose F06 permit is still reserved. Retain original evidence until its owning transition resolves; the schedule, the age boundary and the deletion of every resolved hand are unchanged.';
COMMENT ON FUNCTION smarter_private.f06_hand_cards_unresolved(uuid, bigint) IS
 'True while an exact table/hand still holds a reserved F06 hand permit. The same unresolved test public.sp_prune_hand_state_snapshots retains on. Reads permit state only, never card data.';
COMMIT;
