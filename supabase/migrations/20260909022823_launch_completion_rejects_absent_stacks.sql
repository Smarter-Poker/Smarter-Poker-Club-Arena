-- 20260909022823_launch_completion_rejects_absent_stacks.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The preceding forward migration correctly stopped treating every zero stack
-- as an uncredited launch, but its `COALESCE(value, 0) < 0` replacement also
-- made an absent value look like a legitimate zero. Its field-total floor was
-- not enough to distinguish a real bust from one uncredited player either: a
-- bonus or rebuy held by another player could hide the missing stack.
--
-- This is a forward-only correction. It edits the exact live core definition
-- in place, failing unless each old anchor occurs once. The completed launch
-- now proves all of these facts in the same status transaction:
--
--   * roster chips are present and non-negative;
--   * every live seat stack is finite, whole, and in the supported domain;
--   * every seat stack exactly equals its pointed roster stack; and
--   * a zero stack has an accepted-hand knockout candidate for the exact
--     tournament, player, table, physical seat generation, and hand receipt.
--
-- The existing function owner, ACL, SECURITY DEFINER bit, and pinned
-- `public, pg_temp` search path are captured before CREATE OR REPLACE and must
-- come back byte-for-byte equal. All prior launch refusal proofs must survive.
--
-- ROLLBACK:
-- Create another forward migration that performs the three reverse literal
-- replacements. Do not edit either already-applied migration.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  v_function_oid oid :=
    'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure;
  v_src text;
  v_new text;
  v_applied text;
  v_old_acl aclitem[];
  v_new_acl aclitem[];
  v_old_config text[];
  v_new_config text[];
  v_old_owner oid;
  v_new_owner oid;
  v_old_security_definer boolean;
  v_new_security_definer boolean;
  v_old_roster CONSTANT text := 'OR COALESCE(p.chips, 0) < 0';
  v_new_roster CONSTANT text := 'OR p.chips IS NULL
              OR p.chips < 0';
  v_old_seat CONSTANT text := 'OR COALESCE(s.stack, 0) < 0';
  v_new_seat CONSTANT text := 'OR s.stack IS NULL
              OR lower(s.stack::text) IN (''nan'', ''infinity'', ''-infinity'')
              OR s.stack < 0
              OR s.stack <> trunc(s.stack)
              OR s.stack > 9999999999999';
  v_old_match CONSTANT text :=
$old$JOIN public.table_seats s
      ON s.user_id = p.user_id
     AND s.table_id = p.table_id
     AND s.seat_number = p.seat_number
     AND s.left_at IS NULL
    JOIN public.tables t$old$;
  v_new_match CONSTANT text :=
$new$JOIN public.table_seats s
      ON s.user_id = p.user_id
     AND s.table_id = p.table_id
     AND s.seat_number = p.seat_number
     AND s.left_at IS NULL
     AND s.stack = p.chips
     AND (
       s.stack <> 0
       OR EXISTS (
         SELECT 1
           FROM public.tournament_knockout_candidates k
           JOIN public.hand_atomic_commits h
             ON h.table_id = k.table_id
            AND h.hand_id = k.hand_id
            AND h.hand_number = k.hand_number
          WHERE k.tournament_id = p_tournament_id
            AND k.eliminated_user_id = p.user_id
            AND k.table_id = s.table_id
            AND k.seat_id = s.id
            AND k.seat_joined_at = s.joined_at
            AND k.stack_before > 0
            AND k.stack_after = 0
            AND k.hand_id IS NOT NULL
            AND k.hand_number >= 1000000
       )
     )
    JOIN public.tables t$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl, p.proconfig, p.proowner, p.prosecdef
    INTO STRICT v_src, v_old_acl, v_old_config, v_old_owner,
                v_old_security_definer
    FROM pg_proc p
   WHERE p.oid = v_function_oid;

  IF NOT v_old_security_definer
     OR v_old_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION
      'the launch completion core did not enter this migration with its security boundary intact';
  END IF;

  IF (length(v_src) - length(replace(v_src, v_old_roster, '')))
       / length(v_old_roster) <> 1
     OR (length(v_src) - length(replace(v_src, v_old_seat, '')))
       / length(v_old_seat) <> 1
     OR (length(v_src) - length(replace(v_src, v_old_match, '')))
       / length(v_old_match) <> 1 THEN
    RAISE EXCEPTION
      'the live definition is not the exact once-only shape this correction expects; read it before re-running';
  END IF;

  v_new := replace(v_src, v_old_roster, v_new_roster);
  v_new := replace(v_new, v_old_seat, v_new_seat);
  v_new := replace(v_new, v_old_match, v_new_match);

  IF position(v_old_roster in v_new) <> 0
     OR position(v_old_seat in v_new) <> 0
     OR position(v_old_match in v_new) <> 0
     OR position('p.chips IS NULL' in v_new) = 0
     OR position('lower(s.stack::text) IN (''nan'', ''infinity'', ''-infinity'')' in v_new) = 0
     OR position('s.stack <> trunc(s.stack)' in v_new) = 0
     OR position('s.stack > 9999999999999' in v_new) = 0
     OR position('s.stack = p.chips' in v_new) = 0
     OR position('public.tournament_knockout_candidates' in v_new) = 0
     OR position('public.hand_atomic_commits' in v_new) = 0
     OR position('k.tournament_id = p_tournament_id' in v_new) = 0
     OR position('k.eliminated_user_id = p.user_id' in v_new) = 0
     OR position('k.table_id = s.table_id' in v_new) = 0
     OR position('k.seat_id = s.id' in v_new) = 0
     OR position('k.seat_joined_at = s.joined_at' in v_new) = 0
     OR position('k.stack_before > 0' in v_new) = 0
     OR position('k.stack_after = 0' in v_new) = 0
     OR position('k.hand_id IS NOT NULL' in v_new) = 0
     OR position('k.hand_number >= 1000000' in v_new) = 0 THEN
    RAISE EXCEPTION 'the exact stack and accepted-bust replacement did not take';
  END IF;

  -- A surgical edit is allowed to change only these three predicates. Every
  -- independently named launch proof must remain in the resulting definition.
  IF position('launch_receipt_state_mismatch' in v_new) = 0
     OR position('launch_stacks_uncredited' in v_new) = 0
     OR position('launch_roster_unproven' in v_new) = 0
     OR position('launch_seats_unproven' in v_new) = 0
     OR position('launch_tables_unproven' in v_new) = 0
     OR position('launch_spin_settlement_unproven' in v_new) = 0
     OR position('tournament launch status changed inside its completion transaction' in v_new) = 0 THEN
    RAISE EXCEPTION 'an existing launch proof went missing in the correction';
  END IF;

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid), p.proacl, p.proconfig, p.proowner, p.prosecdef
    INTO STRICT v_applied, v_new_acl, v_new_config, v_new_owner,
                v_new_security_definer
    FROM pg_proc p
   WHERE p.oid = v_function_oid;

  IF v_new_acl IS DISTINCT FROM v_old_acl
     OR v_new_config IS DISTINCT FROM v_old_config
     OR v_new_owner IS DISTINCT FROM v_old_owner
     OR v_new_security_definer IS DISTINCT FROM v_old_security_definer THEN
    RAISE EXCEPTION
      'CREATE OR REPLACE changed the launch completion owner, ACL, search path, or security mode';
  END IF;

  IF position(v_old_roster in v_applied) <> 0
     OR position(v_old_seat in v_applied) <> 0
     OR position('p.chips IS NULL' in v_applied) = 0
     OR position('s.stack = p.chips' in v_applied) = 0
     OR position('k.seat_joined_at = s.joined_at' in v_applied) = 0
     OR position('h.hand_id = k.hand_id' in v_applied) = 0 THEN
    RAISE EXCEPTION 'the stored launch completion definition failed its postcondition';
  END IF;
END;
$migration$;

-- Restate the existing owner-only boundary. CREATE OR REPLACE preserves the
-- ACL; these are deliberately no-op revocations and there is no compensating
-- grant to any browser or engine role.
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $assert_launch_completion_correction$
DECLARE
  v_source text;
  v_search_path text[];
BEGIN
  SELECT p.prosrc, p.proconfig
    INTO STRICT v_source, v_search_path
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure
     AND p.prosecdef;

  IF v_search_path IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR position('p.chips IS NULL' in v_source) = 0
     OR position('p.chips < 0' in v_source) = 0
     OR position('s.stack IS NULL' in v_source) = 0
     OR position('lower(s.stack::text) IN (''nan'', ''infinity'', ''-infinity'')' in v_source) = 0
     OR position('s.stack < 0' in v_source) = 0
     OR position('s.stack <> trunc(s.stack)' in v_source) = 0
     OR position('s.stack > 9999999999999' in v_source) = 0
     OR position('s.stack = p.chips' in v_source) = 0
     OR position('k.tournament_id = p_tournament_id' in v_source) = 0
     OR position('k.eliminated_user_id = p.user_id' in v_source) = 0
     OR position('k.table_id = s.table_id' in v_source) = 0
     OR position('k.seat_id = s.id' in v_source) = 0
     OR position('k.seat_joined_at = s.joined_at' in v_source) = 0
     OR position('k.stack_before > 0' in v_source) = 0
     OR position('k.stack_after = 0' in v_source) = 0
     OR position('k.hand_id IS NOT NULL' in v_source) = 0
     OR position('k.hand_number >= 1000000' in v_source) = 0
     OR position('h.table_id = k.table_id' in v_source) = 0
     OR position('h.hand_id = k.hand_id' in v_source) = 0
     OR position('h.hand_number = k.hand_number' in v_source) = 0 THEN
    RAISE EXCEPTION
      'launch completion lost its exact-stack, accepted-bust, or search-path proof';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl, acldefault('f', p.proowner))
         ) acl
        WHERE p.oid =
          'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure
          AND acl.grantee <> p.proowner
     ) THEN
    RAISE EXCEPTION 'launch completion core is executable by a non-owner role';
  END IF;
END;
$assert_launch_completion_correction$;

COMMIT;
