#!/usr/bin/env bash
# Lightning Phase 2 REMEDIATION: the hand knows its cluster, its instance and
# its epoch, and the epoch is a row.
#
# Applies 20260920235343 and then 20260921025504 to a throwaway PostgreSQL 17
# cluster carrying the PRE-migration schema -- public.cash_games with its single
# mutable cluster_epoch, and public.cash_cluster_events without one -- and then
# exercises every invariant the remediation encodes against a real backend
# rather than against a reading of the file.
#
# WHY TWO MIGRATIONS AND NOT ONE FIXTURE. The remediation does not run on bare
# ground: it rekeys the seven relations 20260920235343 creates. Transcribing
# those 647 lines into a fixture would put a second copy of that DDL in the
# repository, free to drift. So the harness applies the real phase-2 file and
# the fixture carries only what neither migration creates: cash_games, the
# pre-epoch cash_cluster_events, the three Supabase roles and gen_random_uuid().
#
# WHAT THE REMEDIATION CLAIMS, RESTATED AS THE THING THIS FILE MEASURES. Phase 2
# gave six relations a cluster_epoch column and gave the estate no way to say
# what an epoch IS, which epochs exist, or that a Lightning row's epoch is its
# cluster's. It also wrote two foreign keys in the pool family and none in the
# hand family, so a hand could name an instance in another cluster, a
# participation row could point at ANOTHER PLAYER'S table, and both could name
# parents that did not exist. This file proves each of those doors is shut and
# -- the half that is easy to forget -- that the legitimate traffic still gets
# through: a player at two tables, two players in one hand, and a slot under its
# own session.
#
# Six rules are built into the shape of this file, inherited unchanged from
# scripts/dev/test-lightning-phase2-domain.sh, and every one of them was learned
# from mutation testing rather than from review:
#
#   1. Every comparison is IS DISTINCT FROM, never = or <>. A NULL where a value
#      was expected makes `IF NOT (x = y)` evaluate to NULL, which plpgsql takes
#      as false, so an absent column PASSED a check written that way.
#   2. A refusal is only proved when the NAME of the refusing constraint is
#      checked. This migration adds SEVEN foreign keys over overlapping column
#      tuples; a hand_player row with the wrong epoch can be refused by either
#      of two of them, and "it was refused" would survive deleting the one under
#      test. Every refusal below reads CONSTRAINT_NAME, and every negative case
#      is built so that exactly one key can fire: the other is satisfied on
#      purpose, with a real parent row created for it.
#   3. A guard that is never EXERCISED is not covered. cash_cluster_epoch_current
#      is provoked twice: the second open epoch it must refuse, and the second
#      epoch it must LET THROUGH once the first has ended.
#   4. Every rule that REFUSES something is paired with the thing it must still
#      ACCEPT. lightning_hand_player_sits_in_its_own_slot is the sharp case:
#      keyed too widely it lets a participation sit at another player's table,
#      keyed too narrowly it makes all multi-tabling impossible, and only the
#      two halves together can tell those apart.
#   5. Grants are asserted in BOTH directions. anon, authenticated and PUBLIC
#      must hold nothing on cash_cluster_epoch, and service_role must hold
#      something: a check of the negative half alone stays green when the new
#      epoch authority is unreachable by the API role. The fixture is built so
#      neither half can go vacuous, and both of those fixture properties are
#      asserted below.
#   6. Non-vacuity is proved before every negative. A refusal asserted against a
#      backfill that produced no rows, a table that does not exist, or a parent
#      that was never created is a green line that measures nothing.
#
# LIGHTNING_PHASE2R_MIGRATION overrides the file under test. It exists so that
# mutation testing -- copying the migration to a scratch directory, deleting one
# constraint from the copy and watching this harness go red -- never has to
# touch the migration in the repository.
set -euo pipefail
export LC_ALL=C
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
phase2=$root/supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
migration=${LIGHTNING_PHASE2R_MIGRATION:-$root/supabase/migrations/20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase2r-test.XXXXXX")
started=0
cleanup() {
  # || true: the trap runs under set -e, so a non-zero stop would abort the
  # function before rm -rf and leak the fixture directory -- and make a fully
  # passing run exit 1.
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55544 -h ''" start >/dev/null
started=1

# The two assertion groups live in the throwaway directory with the cluster they
# are written for: ONE psql session, so the pre-re-apply capture can be a TEMP
# table and the migration is applied a second time to the same backend that
# holds it.
cat > "$fixture/assertions.sql" <<'ASSERT'
-- EPOCH AUTHORITY ------------------------------------------------------------
-- The epoch stops being a mutable integer and becomes a row. relkind = 'r'
-- rather than to_regclass, because to_regclass answers yes for an index of the
-- name -- and cash_cluster_epoch_current is an index whose name differs by one
-- word.
DO $$
DECLARE v_bad text; v_n bigint; v_cols text; v_unique boolean; v_pred text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'cash_cluster_epoch'
                    AND c.relkind = 'r') THEN
    RAISE EXCEPTION 'FAIL epoch authority: public.cash_cluster_epoch is not an ordinary table, so cash_games.cluster_epoch still points at nothing';
  END IF;

  -- The primary key is the pair, in that order. (epoch, cluster_id) would read
  -- the same in a count and would make every per-cluster lookup a scan.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO v_cols
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conname = 'cash_cluster_epoch_pkey'
     AND c.conrelid = 'public.cash_cluster_epoch'::regclass
     AND c.contype = 'p';
  IF v_cols IS DISTINCT FROM 'cluster_id,epoch' THEN
    RAISE EXCEPTION 'FAIL epoch authority: cash_cluster_epoch_pkey is over (%), not (cluster_id, epoch)', coalesce(v_cols, '<absent>');
  END IF;

  -- The one-open-epoch rule is an index and it has to be UNIQUE. A plain index
  -- of the same name satisfies to_regclass, serves the same reads, and enforces
  -- nothing.
  SELECT i.indisunique, pg_get_expr(i.indpred, i.indrelid) INTO v_unique, v_pred
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
   WHERE n.nspname = 'public' AND ic.relname = 'cash_cluster_epoch_current';
  IF v_unique IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL epoch authority: cash_cluster_epoch_current is not a UNIQUE index (indisunique = %), so a cluster can run two epochs at once and "the current epoch" has no single answer', coalesce(v_unique::text, '<absent>');
  END IF;
  IF v_pred IS DISTINCT FROM '(ended_at IS NULL)' THEN
    RAISE EXCEPTION 'FAIL epoch authority: cash_cluster_epoch_current has predicate %, not (ended_at IS NULL), so either every historical epoch collides or none of them do', coalesce(v_pred, '<none>');
  END IF;

  IF (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'cash_cluster_epoch') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL epoch authority: ROW LEVEL SECURITY is OFF on cash_cluster_epoch, so any role that reaches the table reads every cluster''s seating history';
  END IF;

  -- NON-VACUITY OF THE NEGATIVE HALF, PART ONE: the table is visible to the
  -- reading session at all. A grant check over a relation the view cannot see
  -- returns no rows and passes for the wrong reason.
  SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'cash_cluster_epoch' AND c.relkind = 'r';
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL epoch grants: cash_cluster_epoch is not visible in pg_class, so every grant check below would be vacuous';
  END IF;

  -- NON-VACUITY, PART TWO: the fixture's default privileges DID fire, so a new
  -- table in this schema really is born open to anon and the migration's REVOKE
  -- is the only thing that closes it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
       AND array_to_string(d.defaclacl, ',') LIKE '%anon=%') THEN
    RAISE EXCEPTION 'FAIL epoch grants: the fixture did not install ALTER DEFAULT PRIVILEGES granting anon on new tables in public, so the REVOKE in the migration is a no-op and the negative half proves nothing';
  END IF;

  -- NON-VACUITY, PART THREE: service_role must NOT be in that default ACL. An
  -- aclitem from ALTER DEFAULT PRIVILEGES is byte-identical to one from an
  -- explicit GRANT, so if the fixture inherited service_role's access the
  -- positive half below would stay green with the GRANT deleted.
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
       AND array_to_string(d.defaclacl, ',') LIKE '%service_role=%') THEN
    RAISE EXCEPTION 'FAIL epoch grants: the fixture grants service_role through ALTER DEFAULT PRIVILEGES, so the positive half cannot tell a stated GRANT from an inherited one and would pass with the GRANT deleted';
  END IF;

  -- NEGATIVE HALF. information_schema, the view the migration's own @live-proof
  -- reads.
  SELECT string_agg(format('%s/%s', g.grantee, g.privilege_type), ', '
                    ORDER BY g.grantee, g.privilege_type) INTO v_bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'public' AND g.table_name = 'cash_cluster_epoch'
     AND g.grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL epoch grants: a browser-facing role holds privileges on cash_cluster_epoch: %', v_bad;
  END IF;

  -- pg_class.relacl, the raw ACL, which does not depend on which roles the
  -- reading session happens to be a member of. grantee = 0 is PUBLIC.
  SELECT string_agg(format('%s/%s', coalesce(pg_get_userbyid(a.grantee), 'PUBLIC'), a.privilege_type), ', '
                    ORDER BY coalesce(pg_get_userbyid(a.grantee), 'PUBLIC'), a.privilege_type) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'public' AND c.relname = 'cash_cluster_epoch'
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL epoch grants: pg_class.relacl still carries a browser-facing grant on cash_cluster_epoch: %', v_bad;
  END IF;

  -- POSITIVE HALF. The negative half alone is satisfied by an epoch authority
  -- NOBODY can reach; that is not the posture, it is an outage, and every
  -- Lightning write would fail its declared-epoch foreign key at runtime.
  SELECT string_agg(x.priv, ', ' ORDER BY x.priv) INTO v_bad
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS x(priv)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.role_table_grants g
      WHERE g.table_schema = 'public' AND g.table_name = 'cash_cluster_epoch'
        AND g.grantee = 'service_role' AND g.privilege_type = x.priv);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL epoch grants: service_role does NOT hold privilege(s) the API needs on cash_cluster_epoch: %. BYPASSRLS bypasses row security and is not a table privilege, so without an explicit GRANT the relation is unreachable', v_bad;
  END IF;
END $$;
\echo '  ok  EPOCH AUTHORITY    cash_cluster_epoch is a real table keyed (cluster_id, epoch), cash_cluster_epoch_current is a UNIQUE partial index on the open epoch, RLS is on, anon/authenticated/PUBLIC hold nothing and service_role holds SELECT/INSERT/UPDATE/DELETE'

-- GENESIS BACKFILL -----------------------------------------------------------
-- "Every cluster that already exists has been running its one and only epoch
-- since it was created, under whatever mode it is in now." Three columns are
-- COPIED out of cash_games by that INSERT ... SELECT, and every one of them is
-- unfalsifiable against a uniform seed: with every cluster at epoch 0 the
-- literal 0 passes, with every cluster in must_move the literal 'must_move'
-- passes, and with one created_at the constant clock_timestamp() passes. The
-- fixture therefore seeds four clusters that differ in all three, and the
-- non-vacuity check below is that they still do.
DO $$
DECLARE v_games bigint; v_epochs bigint; v_modes bigint; v_created bigint;
        v_maxepoch integer; v_bad text; v_mode text; v_epoch integer;
BEGIN
  SELECT count(*), count(DISTINCT cluster_mode), count(DISTINCT created_at), max(cluster_epoch)
    INTO v_games, v_modes, v_created, v_maxepoch
    FROM public.cash_games;
  IF v_games < 3::bigint THEN
    RAISE EXCEPTION 'FAIL genesis: the fixture seeded % cash_games row(s); at least three are needed before "one epoch row per cluster" says anything', v_games;
  END IF;
  IF v_modes < 2::bigint THEN
    RAISE EXCEPTION 'FAIL genesis: every seeded cluster is in the same cluster_mode, so the backfill would pass with g.cluster_mode replaced by a literal';
  END IF;
  IF v_maxepoch IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL genesis: no seeded cluster is at cluster_epoch 2, so the backfill would pass with g.cluster_epoch replaced by the literal 0 (max seen: %)', coalesce(v_maxepoch::text, '<none>');
  END IF;
  IF v_created IS DISTINCT FROM v_games THEN
    RAISE EXCEPTION 'FAIL genesis: the % seeded clusters carry only % distinct created_at, so the backfill would pass with g.created_at replaced by clock_timestamp()', v_games, v_created;
  END IF;

  -- EXACTLY ONE ROW PER CLUSTER, in both directions: no cluster without an
  -- epoch, and no epoch without a cluster.
  SELECT count(*) INTO v_epochs FROM public.cash_cluster_epoch;
  IF v_epochs IS DISTINCT FROM v_games THEN
    RAISE EXCEPTION 'FAIL genesis: % cash_games row(s) produced % cash_cluster_epoch row(s)', v_games, v_epochs;
  END IF;
  SELECT string_agg(g.id::text, ', ' ORDER BY g.id) INTO v_bad
    FROM public.cash_games g
   WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL genesis: cluster(s) % got no epoch row, so every future Lightning write for them is refused by its declared-epoch foreign key', v_bad;
  END IF;

  -- AND EACH ROW IS THAT CLUSTER'S OWN TRUTH, column by column.
  SELECT string_agg(format('%s: epoch %s/%s mode %s/%s by %s started %s/%s ended %s',
                           g.id, e.epoch, g.cluster_epoch, e.mode, g.cluster_mode,
                           e.started_by, e.started_at, g.created_at, coalesce(e.ended_at::text, 'NULL')),
                    ' | ' ORDER BY g.id) INTO v_bad
    FROM public.cash_games g
    JOIN public.cash_cluster_epoch e ON e.cluster_id = g.id
   WHERE e.epoch IS DISTINCT FROM g.cluster_epoch
      OR e.mode IS DISTINCT FROM g.cluster_mode
      OR e.started_by IS DISTINCT FROM 'genesis'
      OR e.started_at IS DISTINCT FROM g.created_at
      OR e.ended_at IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL genesis: the backfill did not copy the cluster''s own epoch, mode, reason and start: %', v_bad;
  END IF;

  -- NAMED, because the two columns most likely to be written as a constant are
  -- the two this estate has a default for. The lightning cluster proves the
  -- mode is read and not assumed; the converted cluster proves the epoch is.
  SELECT e.mode INTO v_mode FROM public.cash_cluster_epoch e
   WHERE e.cluster_id = 'c1a50000-0000-0000-0000-000000000002';
  IF v_mode IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL genesis: the cluster whose cluster_mode is lightning got an epoch row reading mode = %, so the backfill wrote a constant instead of the cluster''s real mode', coalesce(v_mode, '<absent>');
  END IF;
  SELECT e.epoch INTO v_epoch FROM public.cash_cluster_epoch e
   WHERE e.cluster_id = 'c1a50000-0000-0000-0000-000000000003';
  IF v_epoch IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL genesis: the cluster sitting at cluster_epoch 2 got an epoch row reading epoch = %, so the backfill wrote a constant instead of the cluster''s real epoch', coalesce(v_epoch::text, '<absent>');
  END IF;
END $$;
\echo '  ok  GENESIS BACKFILL   exactly one open epoch row per cash_games row, each carrying that cluster''s own epoch, its own mode (the lightning cluster reads lightning, not a constant), started_by genesis and started_at = the cluster''s created_at'

-- ONE OPEN EPOCH -------------------------------------------------------------
-- "A cluster has exactly one epoch running at a time. This is the invariant
-- that makes 'the current epoch' a question with one answer." Provoked twice:
-- the second open epoch it must refuse, and the second epoch it must LET
-- THROUGH once the first has ended. The refusing half alone is satisfied by a
-- unique index over (cluster_id) with no predicate at all, which would make a
-- cluster's SECOND epoch impossible for the rest of its life.
DO $$
DECLARE v_raised boolean := false; v_constraint text; v_open bigint;
BEGIN
  -- NON-VACUITY: there is an open row to collide with. A refusal asserted
  -- against a cluster with no open epoch measures nothing.
  SELECT count(*) INTO v_open FROM public.cash_cluster_epoch
   WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000003' AND ended_at IS NULL;
  IF v_open IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL one open epoch: the cluster under test has % open epoch row(s), not one, so the collision below would not be a collision', v_open;
  END IF;

  BEGIN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
    VALUES ('c1a50000-0000-0000-0000-000000000003', 3, 'must_move', 'converted_to_must_move',
            '2026-09-21T00:00:00Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL one open epoch: a cluster opened a SECOND epoch while the first was still running, so cash_games.cluster_epoch points at two rows and every Lightning row written under either is ambiguous';
  END IF;
  IF v_constraint IS DISTINCT FROM 'cash_cluster_epoch_current' THEN
    RAISE EXCEPTION 'FAIL one open epoch: refused by %, not the named cash_cluster_epoch_current', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF. End the running epoch and the next one starts, which is
  -- exactly what a conversion does: "end the old row and insert the new one in
  -- the same transaction or neither happens".
  UPDATE public.cash_cluster_epoch SET ended_at = '2026-09-21T00:00:00Z'
   WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000003' AND epoch = 2;
  BEGIN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
    VALUES ('c1a50000-0000-0000-0000-000000000003', 3, 'must_move', 'converted_to_must_move',
            '2026-09-21T00:00:00Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL one open epoch: % is not partial on ended_at IS NULL -- a cluster that has ENDED its epoch is refused a second one for the rest of its life, which forbids every conversion the table exists to record', coalesce(v_constraint, '<unnamed>');
  END;
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch
                  WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000003'
                    AND epoch = 3 AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL one open epoch: the successor epoch did not land';
  END IF;

  -- The pointer follows the row it points at. cash_games.cluster_epoch is what
  -- the migration calls "the pointer to the current one", and its own genesis
  -- guard RAISEs for any cluster whose current epoch has no OPEN row -- a guard
  -- the re-apply at the end of this file runs again over exactly this data.
  UPDATE public.cash_games SET cluster_epoch = 3
   WHERE id = 'c1a50000-0000-0000-0000-000000000003';
END $$;
\echo '  ok  ONE OPEN EPOCH     a second OPEN epoch for one cluster collides on cash_cluster_epoch_current; the successor is ACCEPTED once the running epoch has ended'

-- EPOCH RULES ----------------------------------------------------------------
-- The four things an epoch row may not be. Each negative is paired with the
-- well-formed row above it that IS accepted, and each is built so exactly one
-- constraint can fire: ended_at is set on all of them, which puts them outside
-- cash_cluster_epoch_current's predicate, so none can be refused by the
-- open-epoch index by accident.
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  -- THE ACCEPT HALF for all four: a well-formed historical epoch row lands.
  INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at, ended_at)
  VALUES ('c1a50000-0000-0000-0000-000000000001', 9, 'paused', 'fixture_history',
          '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z');
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch
                  WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000001' AND epoch = 9) THEN
    RAISE EXCEPTION 'FAIL epoch rules: a well-formed historical epoch row was not accepted, so every refusal below would be refusing the wrong thing';
  END IF;

  -- An epoch is never negative. cash_games.cluster_epoch starts at 0 and only
  -- ever climbs.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at, ended_at)
    VALUES ('c1a50000-0000-0000-0000-000000000001', -1, 'must_move', 'fixture_history',
            '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL epoch rules: cash_cluster_epoch accepted epoch = -1'; END IF;
  IF v_constraint IS DISTINCT FROM 'cash_cluster_epoch_nonneg' THEN
    RAISE EXCEPTION 'FAIL epoch rules: epoch -1 was refused by %, not the named cash_cluster_epoch_nonneg', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- The mode vocabulary is the Cluster's, repeated rather than joined so the
  -- mode of a FINISHED epoch cannot change when the cluster's current mode does.
  -- Repeated means it can drift, which is why it is asserted.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at, ended_at)
    VALUES ('c1a50000-0000-0000-0000-000000000001', 11, 'banana', 'fixture_history',
            '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL epoch rules: cash_cluster_epoch accepted mode = ''banana'', a seating regime the Cluster has never heard of'; END IF;
  IF v_constraint IS DISTINCT FROM 'cash_cluster_epoch_mode_check' THEN
    RAISE EXCEPTION 'FAIL epoch rules: mode ''banana'' was refused by %, not the named cash_cluster_epoch_mode_check', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- An epoch cannot end before it starts. This is the one that makes a duration
  -- computable from the row.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at, ended_at)
    VALUES ('c1a50000-0000-0000-0000-000000000001', 12, 'must_move', 'fixture_history',
            '2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL epoch rules: cash_cluster_epoch accepted an epoch that ended before it started'; END IF;
  IF v_constraint IS DISTINCT FROM 'cash_cluster_epoch_ends_after_it_starts' THEN
    RAISE EXCEPTION 'FAIL epoch rules: the backwards epoch was refused by %, not the named cash_cluster_epoch_ends_after_it_starts', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- And an epoch belongs to a cluster that exists. This is the one foreign key
  -- in the migration that points OUT of the Lightning family, and it is what
  -- makes cash_games.cluster_epoch a pointer rather than a coincidence.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at, ended_at)
    VALUES ('c1a50000-0000-0000-0000-0000000000ff', 0, 'must_move', 'fixture_history',
            '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL epoch rules: cash_cluster_epoch accepted a seating history for a cluster that does not exist'; END IF;
  IF v_constraint IS DISTINCT FROM 'cash_cluster_epoch_belongs_to_a_cluster' THEN
    RAISE EXCEPTION 'FAIL epoch rules: the orphan epoch was refused by %, not the named cash_cluster_epoch_belongs_to_a_cluster', coalesce(v_constraint, '<unnamed>');
  END IF;
END $$;
\echo '  ok  EPOCH RULES        a well-formed historical epoch is accepted; -1 raises cash_cluster_epoch_nonneg, ''banana'' raises cash_cluster_epoch_mode_check, a backwards end raises cash_cluster_epoch_ends_after_it_starts and an orphan raises cash_cluster_epoch_belongs_to_a_cluster'

-- THE EVENT TAKES ITS CLUSTER'S EPOCH ----------------------------------------
-- "A DEFAULT cannot read another row, so the fill happens in a BEFORE INSERT
-- trigger instead, and it is deliberately narrow: it only supplies the
-- cluster's current epoch when the row arrives carrying 0 and the cluster is
-- NOT at 0. An author who names an epoch explicitly is obeyed."
--
-- Four behaviours, and all four are needed. Only the second proves the trigger
-- fires at all; only the third proves it is narrow; only the fourth proves it
-- tolerates the event ledger's un-keyed game_id, which is exactly the shape
-- 33 insert sites across the estate use.
DO $$
DECLARE v_read integer; v_raised boolean := false; v_msg text;
BEGIN
  -- NON-VACUITY: the trigger exists by name, is not an internal RI trigger, and
  -- the cluster under test really is still at epoch 0.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.cash_cluster_events'::regclass
                    AND tgname = 'trg_cash_cluster_events_take_the_clusters_epoch'
                    AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL event epoch: trg_cash_cluster_events_take_the_clusters_epoch is not installed on cash_cluster_events, so every event written by the 33 sites that name no epoch is filed under the genesis epoch forever';
  END IF;
  IF (SELECT cluster_epoch FROM public.cash_games WHERE id = 'c1a50000-0000-0000-0000-000000000004')
     IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL event epoch: the cluster under test is not at epoch 0 before the bump, so "stays 0" and "reads 2" cannot be told apart';
  END IF;

  -- ONE. A cluster still at 0 files its events at 0. The trigger must not
  -- invent an epoch where the DEFAULT was already right.
  INSERT INTO public.cash_cluster_events (game_id, kind)
  VALUES ('c1a50000-0000-0000-0000-000000000004', 'fixture_event_before_bump');
  SELECT cluster_epoch INTO v_read FROM public.cash_cluster_events
   WHERE kind = 'fixture_event_before_bump';
  IF v_read IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL event epoch: an event on a cluster still at epoch 0 was filed under epoch %', coalesce(v_read::text, '<null>');
  END IF;

  -- THE BUMP. A conversion, written the way the migration says one must be: the
  -- running epoch ends, the successor opens, and the pointer follows.
  UPDATE public.cash_cluster_epoch SET ended_at = '2026-09-21T01:00:00Z'
   WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000004' AND epoch = 0;
  INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
  VALUES ('c1a50000-0000-0000-0000-000000000004', 2, 'lightning', 'converted_to_lightning',
          '2026-09-21T01:00:00Z');
  UPDATE public.cash_games SET cluster_epoch = 2
   WHERE id = 'c1a50000-0000-0000-0000-000000000004';

  -- TWO. The same insert shape, after the bump, reads the cluster's epoch. This
  -- is the whole point of the trigger and the only assertion that dies when it
  -- is deleted.
  INSERT INTO public.cash_cluster_events (game_id, kind)
  VALUES ('c1a50000-0000-0000-0000-000000000004', 'fixture_event_after_bump');
  SELECT cluster_epoch INTO v_read FROM public.cash_cluster_events
   WHERE kind = 'fixture_event_after_bump';
  IF v_read IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL event epoch: an event written with no epoch on a cluster at epoch 2 was filed under %, so the event ledger silently misfiles under a genesis epoch the cluster has left', coalesce(v_read::text, '<null>');
  END IF;

  -- THREE. AN AUTHOR WHO NAMES AN EPOCH IS OBEYED. This is the narrowness, and
  -- it is not decoration: a trigger that overwrites an explicit value makes the
  -- conversion writer -- which must record epoch_before alongside epoch_after --
  -- unable to say anything but "now".
  INSERT INTO public.cash_cluster_events (game_id, kind, cluster_epoch)
  VALUES ('c1a50000-0000-0000-0000-000000000004', 'fixture_event_explicit', 5);
  SELECT cluster_epoch INTO v_read FROM public.cash_cluster_events
   WHERE kind = 'fixture_event_explicit';
  IF v_read IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL event epoch: an event that NAMED cluster_epoch = 5 was rewritten to %, so an author cannot file an event under any epoch but the cluster''s current one', coalesce(v_read::text, '<null>');
  END IF;

  -- FOUR. cash_cluster_events.game_id carries no foreign key, here and in
  -- production, so the trigger's lookup can miss. It must tolerate the miss:
  -- one un-resolvable game_id must not take down the insert that carries it.
  BEGIN
    INSERT INTO public.cash_cluster_events (game_id, kind)
    VALUES ('c1a50000-0000-0000-0000-0000000000ff', 'fixture_event_unknown_cluster');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; v_raised := true;
  END;
  IF v_raised THEN
    RAISE EXCEPTION 'FAIL event epoch: an event for a game_id that is not a cash_games row was REFUSED (%), but game_id carries no foreign key and the trigger must tolerate a miss', v_msg;
  END IF;
  SELECT cluster_epoch INTO v_read FROM public.cash_cluster_events
   WHERE kind = 'fixture_event_unknown_cluster';
  IF v_read IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL event epoch: an event for an unknown cluster was filed under epoch %, not the column default of 0', coalesce(v_read::text, '<null>');
  END IF;

  -- And the three rows the fixture wrote BEFORE either migration ran still read
  -- 0. The trigger is BEFORE INSERT; an existing row is not an insert.
  IF (SELECT count(*) FROM public.cash_cluster_events
       WHERE kind LIKE 'fixture_pre_migration_%' AND cluster_epoch IS DISTINCT FROM 0)
     IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL event epoch: a pre-migration event row no longer reads epoch 0, so the remediation rewrote history';
  END IF;
END $$;
\echo '  ok  EVENT EPOCH        an event on a cluster at 0 stays 0, the same shape reads 2 once the cluster is bumped, an explicitly named 5 is left alone, an unknown game_id is tolerated and the pre-migration rows are untouched'

-- THE POOL IDENTITIES CARRY THE EPOCH ----------------------------------------
-- 20260920235343 stated the principle -- each level exposes its identity as a
-- unique key and the level below references the whole tuple -- and stopped the
-- tuple at (id, player_id, cluster_id). A slot under a session from a DIFFERENT
-- EPOCH satisfied every one of those keys. The column names are read out of
-- pg_attribute rather than counted, because a four-column key over
-- (id, player_id, cluster_id, slot) counts the same and means something else.
DO $$
DECLARE r record; v_cols text; v_n integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('lightning_pool_session', 'lightning_pool_session_identity'),
      ('lightning_pool_slot',    'lightning_pool_slot_identity')) AS t(rel, con)
  LOOP
    SELECT array_length(c.conkey, 1),
           string_agg(a.attname, ',' ORDER BY k.ord)
      INTO v_n, v_cols
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conname = r.con
       AND c.conrelid = format('public.%I', r.rel)::regclass
       AND c.contype = 'u'
     GROUP BY c.conkey;
    IF v_n IS DISTINCT FROM 4 THEN
      RAISE EXCEPTION 'FAIL identities: % is not a four-column UNIQUE constraint on public.% (columns found: %)', r.con, r.rel, coalesce(v_n::text, '<absent>');
    END IF;
    IF v_cols IS DISTINCT FROM 'id,player_id,cluster_id,cluster_epoch' THEN
      RAISE EXCEPTION 'FAIL identities: % is over (%), not (id, player_id, cluster_id, cluster_epoch) -- a four-column key over the wrong four columns counts the same and lets a child name a parent from another seating regime', r.con, coalesce(v_cols, '<absent>');
    END IF;
  END LOOP;
END $$;
\echo '  ok  POOL IDENTITIES    lightning_pool_session_identity and lightning_pool_slot_identity are UNIQUE over exactly (id, player_id, cluster_id, cluster_epoch), read column by column out of pg_attribute'

-- A SLOT CANNOT BELONG TO A SESSION IN ANOTHER EPOCH -------------------------
-- The defect this widening closes. Before it, a table opened under a
-- participation period from the previous seating regime satisfied every key in
-- the family, and lightning_pool_slot_oldest_bb -- which the BB candidate
-- ordering reads -- would offer that table to a Cluster it no longer plays in.
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  -- A REAL SESSION AT EPOCH 0, which is also the non-vacuity of what follows:
  -- a slot refused against a parent that does not exist proves nothing.
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000001', '5e550000-0000-0000-0000-000000000001', 'active');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session
                  WHERE id = 'b0010000-0000-0000-0000-000000000001' AND cluster_epoch IS NOT DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'FAIL slot epoch: the parent pool session at epoch 0 did not land, so the refusal below would be refusing an orphan rather than an epoch mismatch';
  END IF;

  BEGIN
    INSERT INTO public.lightning_pool_slot
      (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
    VALUES ('51070000-0000-0000-0000-0000000000f1', 'b0010000-0000-0000-0000-000000000001',
            'c1a50000-0000-0000-0000-000000000001', 1,
            '70000000-0000-0000-0000-000000000001', 1);
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL slot epoch: a table opened at epoch 1 under a participation period running at epoch 0 was ACCEPTED, so a slot can outlive the seating regime it belongs to and still be offered a big blind in it';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_belongs_to_its_session' THEN
    RAISE EXCEPTION 'FAIL slot epoch: refused by %, not the named lightning_pool_slot_belongs_to_its_session', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF. The same slot with the parent's epoch lands. Without this
  -- the check above is satisfied by a key that refuses every slot there is.
  INSERT INTO public.lightning_pool_slot
    (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000001', 'b0010000-0000-0000-0000-000000000001',
          'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000001', 1);
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot
                  WHERE id = '51070000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FAIL slot epoch: the matching-epoch slot did not land, so lightning_pool_slot_belongs_to_its_session forbids every table in the pool';
  END IF;
END $$;
\echo '  ok  SLOT EPOCH         a table naming epoch 1 under a session running at epoch 0 is refused by lightning_pool_slot_belongs_to_its_session; the matching-epoch table is ACCEPTED'

-- A SESSION AND AN INSTANCE MUST NAME A DECLARED EPOCH -----------------------
-- The two roots of the two families answer to the epoch history directly;
-- everything below them inherits it through the identity keys. An epoch that
-- was never declared is an epoch nothing can be filed under, which is what
-- makes cash_games.cluster_epoch a pointer instead of a number.
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  -- NON-VACUITY: epoch 5 of this cluster genuinely has no row yet.
  IF EXISTS (SELECT 1 FROM public.cash_cluster_epoch
              WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000001' AND epoch = 5) THEN
    RAISE EXCEPTION 'FAIL declared epoch: epoch 5 is already declared for the cluster under test, so the two refusals below would be refusing something else';
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_session
      (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
    VALUES ('b0010000-0000-0000-0000-000000000003', 'c1a50000-0000-0000-0000-000000000001', 5,
            '70000000-0000-0000-0000-000000000003', '5e550000-0000-0000-0000-000000000003', 'active');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL declared epoch: a participation period opened in an epoch that was never declared, so its rows are anchored to nothing the moment the cluster is converted';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_session_runs_in_a_declared_epoch' THEN
    RAISE EXCEPTION 'FAIL declared epoch: the session was refused by %, not the named lightning_pool_session_runs_in_a_declared_epoch', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_instance
      (id, cluster_id, cluster_epoch, state, target_size, max_size)
    VALUES ('19570000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000001', 5,
            'forming', 2, 9);
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL declared epoch: an execution container formed in an epoch that was never declared';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_instance_runs_in_a_declared_epoch' THEN
    RAISE EXCEPTION 'FAIL declared epoch: the instance was refused by %, not the named lightning_instance_runs_in_a_declared_epoch', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF. Declare the epoch and both land unchanged. ended_at is set
  -- because the cluster's epoch 0 is still the open one and
  -- cash_cluster_epoch_current allows exactly one of those -- which is itself
  -- the point: an epoch row is history, and a foreign key onto the PRIMARY KEY
  -- resolves against a finished epoch as readily as a running one.
  INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at, ended_at)
  VALUES ('c1a50000-0000-0000-0000-000000000001', 5, 'lightning', 'fixture_history',
          '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z');

  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000003', 'c1a50000-0000-0000-0000-000000000001', 5,
          '70000000-0000-0000-0000-000000000003', '5e550000-0000-0000-0000-000000000003', 'active');
  INSERT INTO public.lightning_instance
    (id, cluster_id, cluster_epoch, state, target_size, max_size)
  VALUES ('19570000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000001', 5,
          'forming', 2, 9);
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-000000000003')
     OR NOT EXISTS (SELECT 1 FROM public.lightning_instance WHERE id = '19570000-0000-0000-0000-000000000004') THEN
    RAISE EXCEPTION 'FAIL declared epoch: the session or the instance did not land once its epoch was declared, so the two keys refuse every epoch there is';
  END IF;

  -- And the slot under that session, which is what the next sections need.
  INSERT INTO public.lightning_pool_slot
    (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000004', 'b0010000-0000-0000-0000-000000000003',
          'c1a50000-0000-0000-0000-000000000001', 5,
          '70000000-0000-0000-0000-000000000003', 1);
END $$;
\echo '  ok  DECLARED EPOCH     a pool session and an instance in an undeclared epoch are refused by lightning_pool_session_runs_in_a_declared_epoch and lightning_instance_runs_in_a_declared_epoch; both are ACCEPTED once the epoch row exists'

-- A HAND IS IN ITS INSTANCE'S CLUSTER AND EPOCH ------------------------------
-- "Not 'records the same' -- cannot differ." A hand claiming cluster A epoch 4
-- while its instance was in cluster B epoch 1 would be grouped by
-- lightning_hand_by_cluster_epoch under the wrong seating regime forever.
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  -- The instance the hand will be played in, at cluster A epoch 0, and its
  -- non-vacuity: a hand refused against an instance that does not exist would
  -- be refused by the same key for a different reason.
  INSERT INTO public.lightning_instance
    (id, cluster_id, cluster_epoch, state, target_size, max_size)
  VALUES ('19570000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000001', 0,
          'dealing', 2, 9);
  IF NOT EXISTS (SELECT 1 FROM public.lightning_instance
                  WHERE id = '19570000-0000-0000-0000-000000000001'
                    AND cluster_id IS NOT DISTINCT FROM 'c1a50000-0000-0000-0000-000000000001'
                    AND cluster_epoch IS NOT DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'FAIL hand instance: the instance at cluster A epoch 0 did not land, so every refusal below is an orphan check and not a mismatch check';
  END IF;

  -- WRONG CLUSTER. Same instance, a different Cluster named on the hand.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
    VALUES ('4a4d0000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000002', 0,
            '19570000-0000-0000-0000-000000000001');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL hand instance: a hand filed itself under a Cluster its own instance is not in';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_belongs_to_its_instance' THEN
    RAISE EXCEPTION 'FAIL hand instance: the wrong-cluster hand was refused by %, not the named lightning_hand_belongs_to_its_instance', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- WRONG EPOCH. Right Cluster, right instance, a seating regime the instance
  -- never ran in. This is the half a three-column key over
  -- (instance, cluster, player) would miss.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
    VALUES ('4a4d0000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000001', 1,
            '19570000-0000-0000-0000-000000000001');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL hand instance: a hand filed itself under epoch 1 while its instance ran in epoch 0, so the history reader that groups by (cluster_id, cluster_epoch) puts it under the wrong seating regime';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_belongs_to_its_instance' THEN
    RAISE EXCEPTION 'FAIL hand instance: the wrong-epoch hand was refused by %, not the named lightning_hand_belongs_to_its_instance', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF.
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
  VALUES ('4a4d0000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000001', 0,
          '19570000-0000-0000-0000-000000000001');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand WHERE hand_id = '4a4d0000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FAIL hand instance: the hand that agrees with its instance did not land, so lightning_hand_belongs_to_its_instance forbids every Lightning hand there is';
  END IF;
END $$;
\echo '  ok  HAND INSTANCE      a hand naming its instance but another cluster, and the same hand naming another epoch, are both refused by lightning_hand_belongs_to_its_instance; the agreeing hand is ACCEPTED'

-- A HAND CANNOT NAME AN INSTANCE THAT DOES NOT EXIST -------------------------
-- lightning_hand.lightning_instance_id was NOT NULL and referenced nothing, so
-- a hand could name a container that never formed. Same key, different hole.
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  -- NON-VACUITY: the instance id really is absent.
  IF EXISTS (SELECT 1 FROM public.lightning_instance WHERE id = '19570000-0000-0000-0000-0000000000ff') THEN
    RAISE EXCEPTION 'FAIL hand orphan: the instance the test calls non-existent exists';
  END IF;

  BEGIN
    INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
    VALUES ('4a4d0000-0000-0000-0000-0000000000ff', 'c1a50000-0000-0000-0000-000000000001', 0,
            '19570000-0000-0000-0000-0000000000ff');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL hand orphan: a hand named an execution container that does not exist';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_belongs_to_its_instance' THEN
    RAISE EXCEPTION 'FAIL hand orphan: refused by %, not the named lightning_hand_belongs_to_its_instance', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF, and the second hand the seat rules below are written
  -- against: a real second container in the same cluster and epoch.
  INSERT INTO public.lightning_instance
    (id, cluster_id, cluster_epoch, state, target_size, max_size)
  VALUES ('19570000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0,
          'dealing', 2, 9);
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
  VALUES ('4a4d0000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0,
          '19570000-0000-0000-0000-000000000002');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand WHERE hand_id = '4a4d0000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FAIL hand orphan: the hand naming a real second instance did not land';
  END IF;
END $$;
\echo '  ok  HAND ORPHAN        a hand naming an instance that does not exist is refused by lightning_hand_belongs_to_its_instance; a hand naming a real second instance is ACCEPTED'

-- A PARTICIPATION SITS IN ITS OWN SLOT ---------------------------------------
-- The defect the audit found. lightning_hand_player.pool_slot_id was NOT NULL
-- and referenced nothing, so a participation row could point at ANOTHER
-- PLAYER'S table, and lightning_hand_player_by_pool_slot -- the index every
-- per-table statistic reads -- would aggregate one player's hands onto another
-- player's table.
--
-- BOTH HALVES ARE MANDATORY HERE. Keyed too widely the constraint lets a
-- participation sit at a table that is not the player's; keyed too narrowly --
-- on (pool_slot_id, cluster_id) alone, say, or on the player's ONE slot -- it
-- makes multi-tabling impossible, which is the whole product. So one player
-- sits at two different tables in two different hands, and two players sit in
-- one hand, and all of it must land.
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  -- A SECOND PLAYER with their own participation period and their own table,
  -- in the same cluster and the same epoch as the first.
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000002', '5e550000-0000-0000-0000-000000000002', 'active');
  INSERT INTO public.lightning_pool_slot
    (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000003', 'b0010000-0000-0000-0000-000000000002',
          'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000002', 1);

  -- A SECOND TABLE for the first player, under the same participation period.
  -- This is the row that makes the accept half below a statement about
  -- multi-tabling rather than about one lucky insert.
  INSERT INTO public.lightning_pool_slot
    (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000002', 'b0010000-0000-0000-0000-000000000001',
          'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000001', 2);

  -- NON-VACUITY: three distinct live tables, two of them one player's and one
  -- of them another's, all in the cluster and epoch the hand ran in.
  IF (SELECT count(*) FROM public.lightning_pool_slot
       WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000001' AND cluster_epoch = 0)
     IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL own slot: the three tables this section is written against are not all present, so neither half below measures anything';
  END IF;

  -- THE REFUSAL. Player one's participation, at player two's table. The hand,
  -- the cluster and the epoch all agree, so lightning_hand_player_belongs_to_
  -- its_hand is satisfied on purpose and exactly one key can fire.
  BEGIN
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
    VALUES ('4a4d0000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001',
            '51070000-0000-0000-0000-000000000003', 1,
            'c1a50000-0000-0000-0000-000000000001', 0, 'none');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL own slot: a participation row named ANOTHER PLAYER''S table, so every per-table statistic read through lightning_hand_player_by_pool_slot can aggregate one player''s hands onto another player''s table';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_sits_in_its_own_slot' THEN
    RAISE EXCEPTION 'FAIL own slot: refused by %, not the named lightning_hand_player_sits_in_its_own_slot', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF, PART ONE: the player at their own table.
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
  VALUES ('4a4d0000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001',
          '51070000-0000-0000-0000-000000000001', 1,
          'c1a50000-0000-0000-0000-000000000001', 0, 'none');

  -- PART TWO: a second player in the SAME hand, at their own table. A key that
  -- refused this would forbid every hand with more than one player in it.
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
  VALUES ('4a4d0000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002',
          '51070000-0000-0000-0000-000000000003', 2,
          'c1a50000-0000-0000-0000-000000000001', 0, 'fast');

  -- PART THREE, AND THE ONE THAT MATTERS: the SAME player, in a DIFFERENT hand,
  -- at their SECOND table. This is multi-tabling, and it is the case a key
  -- written over the player instead of over the player's slot destroys.
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
  VALUES ('4a4d0000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001',
          '51070000-0000-0000-0000-000000000002', 4,
          'c1a50000-0000-0000-0000-000000000001', 0, 'fold_watch');

  IF (SELECT count(*) FROM public.lightning_hand_player) IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL own slot: only % of the three legitimate participations landed, so lightning_hand_player_sits_in_its_own_slot is keyed too narrowly and multi-tabling is impossible',
      (SELECT count(*) FROM public.lightning_hand_player);
  END IF;
END $$;
\echo '  ok  OWN SLOT           a participation naming another player''s table is refused by lightning_hand_player_sits_in_its_own_slot; a player at their own table, a second player in the same hand, and the SAME player at a SECOND table in another hand are all ACCEPTED'

-- A PARTICIPATION BELONGS TO ITS HAND ----------------------------------------
-- The other half of the anchoring: the hand exists, and this row is in the same
-- cluster and epoch as it. Three refusals, each built so that
-- lightning_hand_player_sits_in_its_own_slot is SATISFIED -- with a real slot
-- belonging to that player in that cluster and that epoch -- so the only key
-- that can fire is the one under test.
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  -- The third player's participation and table in the SECOND cluster, which is
  -- what makes the cluster-mismatch case below provable against one key only.
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000002', 0,
          '70000000-0000-0000-0000-000000000003', '5e550000-0000-0000-0000-000000000004', 'active');
  INSERT INTO public.lightning_pool_slot
    (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000005', 'b0010000-0000-0000-0000-000000000004',
          'c1a50000-0000-0000-0000-000000000002', 0,
          '70000000-0000-0000-0000-000000000003', 1);

  -- NON-VACUITY: the hand the mismatches are aimed at exists, and it is in
  -- cluster A epoch 0.
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand
                  WHERE hand_id = '4a4d0000-0000-0000-0000-000000000001'
                    AND cluster_id IS NOT DISTINCT FROM 'c1a50000-0000-0000-0000-000000000001'
                    AND cluster_epoch IS NOT DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'FAIL belongs to hand: the hand under test is not in cluster A epoch 0, so the mismatches below are not mismatches';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_hand WHERE hand_id = '4a4d0000-0000-0000-0000-0000000000fe') THEN
    RAISE EXCEPTION 'FAIL belongs to hand: the hand the test calls non-existent exists';
  END IF;

  -- ONE. A hand that never happened.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
    VALUES ('4a4d0000-0000-0000-0000-0000000000fe', '70000000-0000-0000-0000-000000000001',
            '51070000-0000-0000-0000-000000000001', 5,
            'c1a50000-0000-0000-0000-000000000001', 0, 'none');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL belongs to hand: a participation row outlived, or preceded, any hand';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_belongs_to_its_hand' THEN
    RAISE EXCEPTION 'FAIL belongs to hand: the orphan participation was refused by %, not the named lightning_hand_player_belongs_to_its_hand', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- TWO. A real hand, a real table of that player's -- but in another Cluster.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
    VALUES ('4a4d0000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000003',
            '51070000-0000-0000-0000-000000000005', 6,
            'c1a50000-0000-0000-0000-000000000002', 0, 'none');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL belongs to hand: a participation filed itself under a Cluster its own hand was not played in';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_belongs_to_its_hand' THEN
    RAISE EXCEPTION 'FAIL belongs to hand: the wrong-cluster participation was refused by %, not the named lightning_hand_player_belongs_to_its_hand', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THREE. A real hand, a real table of that player's, the right Cluster -- and
  -- a seating regime the hand did not run in.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
    VALUES ('4a4d0000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000003',
            '51070000-0000-0000-0000-000000000004', 7,
            'c1a50000-0000-0000-0000-000000000001', 5, 'none');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL belongs to hand: a participation filed itself under epoch 5 while its hand ran in epoch 0';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_belongs_to_its_hand' THEN
    RAISE EXCEPTION 'FAIL belongs to hand: the wrong-epoch participation was refused by %, not the named lightning_hand_player_belongs_to_its_hand', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF: the same player, the same table, in a hand that really is
  -- in that cluster and that epoch. A key that refused this would forbid
  -- Lightning in every cluster but the first.
  INSERT INTO public.lightning_instance
    (id, cluster_id, cluster_epoch, state, target_size, max_size)
  VALUES ('19570000-0000-0000-0000-000000000003', 'c1a50000-0000-0000-0000-000000000002', 0,
          'dealing', 2, 9);
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
  VALUES ('4a4d0000-0000-0000-0000-000000000003', 'c1a50000-0000-0000-0000-000000000002', 0,
          '19570000-0000-0000-0000-000000000003');
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
  VALUES ('4a4d0000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000003',
          '51070000-0000-0000-0000-000000000005', 1,
          'c1a50000-0000-0000-0000-000000000002', 0, 'normal');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player
                  WHERE hand_id = '4a4d0000-0000-0000-0000-000000000003') THEN
    RAISE EXCEPTION 'FAIL belongs to hand: the agreeing participation in the second cluster did not land';
  END IF;
END $$;
\echo '  ok  BELONGS TO HAND    a participation naming a hand that does not exist, and one naming a cluster or an epoch its hand did not run in, are all refused by lightning_hand_player_belongs_to_its_hand; the agreeing participation in a second cluster is ACCEPTED'

-- THE TWO SEAT RULES STILL HOLD ----------------------------------------------
-- Rule 6 of the template, one level on: the remediation ADDS two columns to
-- lightning_hand_player and rebuilds nothing else on it, and a column addition
-- that quietly took the seat rules with it would break no test that only looked
-- at the new keys. Both are re-provoked here against rows that now carry a
-- cluster and an epoch.
DO $$
DECLARE v_raised boolean; v_constraint text; s smallint;
BEGIN
  -- A FOURTH PLAYER with their own table, so the seat collision below is a
  -- collision on the SEAT and not on the primary key (hand_id, player_id).
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000005', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000004', '5e550000-0000-0000-0000-000000000005', 'active');
  INSERT INTO public.lightning_pool_slot
    (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000006', 'b0010000-0000-0000-0000-000000000005',
          'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000004', 1);

  -- NON-VACUITY: seat 1 of that hand is already occupied, by a different human.
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player
                  WHERE hand_id = '4a4d0000-0000-0000-0000-000000000001' AND seat = 1
                    AND player_id IS DISTINCT FROM '70000000-0000-0000-0000-000000000004') THEN
    RAISE EXCEPTION 'FAIL seat rules: seat 1 of the hand under test is not occupied by another player, so the collision below would not be a collision';
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
    VALUES ('4a4d0000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000004',
            '51070000-0000-0000-0000-000000000006', 1,
            'c1a50000-0000-0000-0000-000000000001', 0, 'none');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL seat rules: two players occupied one chair in one committed hand';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_one_per_seat' THEN
    RAISE EXCEPTION 'FAIL seat rules: the doubled chair was refused by %, not the named lightning_hand_player_one_per_seat', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- THE ACCEPT HALF: the same player, the same hand, an empty chair.
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
  VALUES ('4a4d0000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000004',
          '51070000-0000-0000-0000-000000000006', 3,
          'c1a50000-0000-0000-0000-000000000001', 0, 'none');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player
                  WHERE hand_id = '4a4d0000-0000-0000-0000-000000000001' AND seat = 3) THEN
    RAISE EXCEPTION 'FAIL seat rules: a third player in an empty chair of the same hand did not land';
  END IF;

  -- THE RANGE. Seat 0 and seat 10 are both outside the estate's handedness.
  FOREACH s IN ARRAY ARRAY[0::smallint, 10::smallint] LOOP
    v_raised := false; v_constraint := NULL;
    BEGIN
      INSERT INTO public.lightning_hand_player
        (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
      VALUES ('4a4d0000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002',
              '51070000-0000-0000-0000-000000000003', s,
              'c1a50000-0000-0000-0000-000000000001', 0, 'none');
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'FAIL seat rules: lightning_hand_player accepted seat %', s;
    END IF;
    IF v_constraint IS DISTINCT FROM 'lightning_hand_player_seat_range' THEN
      RAISE EXCEPTION 'FAIL seat rules: seat % was refused by %, not the named lightning_hand_player_seat_range', s, coalesce(v_constraint, '<unnamed>');
    END IF;
  END LOOP;

  -- And the top of the range is INSIDE it: a nine-handed table still seats a
  -- ninth player, which a range written 1..8 would silently forbid.
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, fold_type)
  VALUES ('4a4d0000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002',
          '51070000-0000-0000-0000-000000000003', 9,
          'c1a50000-0000-0000-0000-000000000001', 0, 'none');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player
                  WHERE hand_id = '4a4d0000-0000-0000-0000-000000000002' AND seat = 9) THEN
    RAISE EXCEPTION 'FAIL seat rules: seat 9 was not accepted, so a nine-handed Lightning hand cannot be recorded';
  END IF;
END $$;
\echo '  ok  SEAT RULES         two players in one chair of one hand still raise lightning_hand_player_one_per_seat while a third chair is ACCEPTED; seat 0 and seat 10 still raise lightning_hand_player_seat_range while seat 9 is ACCEPTED'

-- THE BB INDEX IS PER EPOCH --------------------------------------------------
-- "The BB candidate is chosen among the players in the CURRENT epoch; an index
-- that spans epochs offers rows from a regime that has ended." Read out of
-- pg_index rather than pg_indexes, because the key COLUMNS and their ORDER are
-- the whole claim: (cluster_id, last_bb_at, player_id) with cluster_epoch
-- appended at the END would serve the same queries and still mix two regimes
-- in every prefix scan.
DO $$
DECLARE v_n integer; v_cols text; v_pred text; v_def text; v_rel text;
BEGIN
  SELECT t.relname, i.indnkeyatts, pg_get_expr(i.indpred, i.indrelid), pg_get_indexdef(i.indexrelid)
    INTO v_rel, v_n, v_pred, v_def
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class t  ON t.oid  = i.indrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
   WHERE n.nspname = 'public' AND ic.relname = 'lightning_pool_slot_oldest_bb';
  IF v_rel IS DISTINCT FROM 'lightning_pool_slot' THEN
    RAISE EXCEPTION 'FAIL bb index: lightning_pool_slot_oldest_bb is on %, not on lightning_pool_slot -- the BB question is asked of a TABLE', coalesce(v_rel, '<absent>');
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO v_cols
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    CROSS JOIN LATERAL unnest(string_to_array(i.indkey::text, ' ')::int[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND ic.relname = 'lightning_pool_slot_oldest_bb'
     AND k.ord <= i.indnkeyatts;
  IF v_cols IS DISTINCT FROM 'cluster_id,cluster_epoch,last_bb_at,player_id' THEN
    RAISE EXCEPTION 'FAIL bb index: lightning_pool_slot_oldest_bb is keyed (%), not (cluster_id, cluster_epoch, last_bb_at, player_id) -- without the epoch second, the ordered scan of one Cluster offers tables from a seating regime that has ended', coalesce(v_cols, '<absent>');
  END IF;
  IF v_n IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL bb index: lightning_pool_slot_oldest_bb has % key column(s), not 4', coalesce(v_n::text, '<absent>');
  END IF;

  -- Still partial on live tables only. An unpartial index answers the BB
  -- question with tables the player has already left.
  IF v_pred IS DISTINCT FROM '(closed_at IS NULL)' THEN
    RAISE EXCEPTION 'FAIL bb index: lightning_pool_slot_oldest_bb has predicate %, not (closed_at IS NULL)', coalesce(v_pred, '<none>');
  END IF;

  -- And NULLS FIRST is kept. "A slot that has never posted a big blind holds
  -- the OLDEST unresolved obligation there is, so it sorts before every
  -- timestamp." The default for ASC is NULLS LAST, which reverses exactly that.
  IF position('NULLS FIRST' IN coalesce(v_def, '')) < 1 THEN
    RAISE EXCEPTION 'FAIL bb index: lightning_pool_slot_oldest_bb does not order last_bb_at NULLS FIRST, so a table that has never posted a big blind sorts AFTER every table that has, and the player who is owed longest is offered it last. Definition: %', coalesce(v_def, '<absent>');
  END IF;
END $$;
\echo '  ok  BB INDEX           lightning_pool_slot_oldest_bb is keyed exactly (cluster_id, cluster_epoch, last_bb_at, player_id), partial on closed_at IS NULL, and still orders NULLS FIRST'

-- The preimage of the re-apply. Not row counts: the full set of
-- (relation, constraint name, definition) over the seven Lightning relations,
-- the event ledger the trigger sits on, and the epoch authority itself. The
-- remediation DROPs and re-ADDs nine constraints by name on every run, and a
-- re-apply that rebuilt one of them over a different column tuple would move no
-- row at all.
CREATE TEMP TABLE pre_reapply_constraints AS
  SELECT t.relname AS rel, c.conname AS con, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname IN ('lightning_pool_session','lightning_pool_slot','lightning_instance',
                       'lightning_reservation','lightning_blind_ledger','lightning_hand',
                       'lightning_hand_player','cash_cluster_events','cash_cluster_epoch');

CREATE TEMP TABLE pre_reapply_counts AS
  SELECT (SELECT count(*) FROM public.cash_cluster_epoch)    AS epochs,
         (SELECT count(*) FROM public.cash_games)            AS clusters,
         (SELECT count(*) FROM public.cash_cluster_events)   AS events,
         (SELECT count(*) FROM public.lightning_pool_session) AS pool_sessions,
         (SELECT count(*) FROM public.lightning_pool_slot)   AS pool_slots,
         (SELECT count(*) FROM public.lightning_instance)    AS instances,
         (SELECT count(*) FROM public.lightning_hand)        AS hands,
         (SELECT count(*) FROM public.lightning_hand_player) AS hand_players;

CREATE TEMP TABLE pre_reapply_epochs AS SELECT * FROM public.cash_cluster_epoch;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'
-- IDEMPOTENT RE-APPLY --------------------------------------------------------
-- Reaching this file at all means the second psql -f of the migration exited 0
-- under ON_ERROR_STOP; what is left is that it moved nothing. This is the
-- assertion that matters most for THIS migration, because unlike its
-- predecessor it does not only CREATE: it DROPs nine constraints by name and
-- rebuilds them, over tables that -- by the time it runs the second time --
-- hold rows the first run's keys already validated.
DO $$
DECLARE c pre_reapply_counts%ROWTYPE; v_n bigint; v_bad text; v_before text; v_after text;
BEGIN
  SELECT * INTO c FROM pre_reapply_counts;
  IF c.epochs IS NULL THEN RAISE EXCEPTION 'FAIL re-apply: the pre-re-apply capture is empty'; END IF;

  -- NON-VACUITY, PART ONE: every relation in the capture held rows before the
  -- re-apply, or "nothing moved" is the statement 0 = 0 repeated.
  IF LEAST(c.epochs, c.clusters, c.events, c.pool_sessions, c.pool_slots,
           c.instances, c.hands, c.hand_players) < 1 THEN
    RAISE EXCEPTION 'FAIL re-apply: a relation was empty before the re-apply (epochs % / clusters % / events % / sessions % / slots % / instances % / hands % / participations %), so this check would compare nothing to nothing',
      c.epochs, c.clusters, c.events, c.pool_sessions, c.pool_slots, c.instances, c.hands, c.hand_players;
  END IF;

  -- NON-VACUITY, PART TWO: the constraint capture really covers all nine
  -- relations and really contains the keys this migration adds. A capture that
  -- matched nothing would be byte-identical to itself forever.
  SELECT count(DISTINCT rel) INTO v_n FROM pre_reapply_constraints;
  IF v_n IS DISTINCT FROM 9::bigint THEN
    RAISE EXCEPTION 'FAIL re-apply: the constraint capture covers % of the nine relations, so it cannot prove the rebuild is a no-op', v_n;
  END IF;
  SELECT string_agg(x.want, ', ' ORDER BY x.want) INTO v_bad
    FROM unnest(ARRAY['cash_cluster_epoch_pkey','cash_cluster_epoch_belongs_to_a_cluster',
                      'lightning_pool_session_identity','lightning_pool_slot_identity',
                      'lightning_pool_slot_belongs_to_its_session','lightning_reservation_belongs_to_its_slot',
                      'lightning_pool_session_runs_in_a_declared_epoch','lightning_instance_runs_in_a_declared_epoch',
                      'lightning_instance_identity','lightning_hand_identity',
                      'lightning_hand_belongs_to_its_instance','lightning_hand_player_belongs_to_its_hand',
                      'lightning_hand_player_sits_in_its_own_slot']) AS x(want)
   WHERE NOT EXISTS (SELECT 1 FROM pre_reapply_constraints p WHERE p.con = x.want);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL re-apply: the capture is missing constraint(s) % that the migration adds, so the comparison below cannot see them change', v_bad;
  END IF;

  -- BYTE-IDENTICAL. One text per side, built in the same order under the C
  -- collation this harness exports, and compared as a whole.
  SELECT string_agg(format('%s|%s|%s', rel, con, def), E'\n' ORDER BY rel, con, def)
    INTO v_before FROM pre_reapply_constraints;
  SELECT string_agg(format('%s|%s|%s', t.relname, c2.conname, pg_get_constraintdef(c2.oid)), E'\n'
                    ORDER BY t.relname, c2.conname, pg_get_constraintdef(c2.oid))
    INTO v_after
    FROM pg_constraint c2
    JOIN pg_class t ON t.oid = c2.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname IN ('lightning_pool_session','lightning_pool_slot','lightning_instance',
                       'lightning_reservation','lightning_blind_ledger','lightning_hand',
                       'lightning_hand_player','cash_cluster_events','cash_cluster_epoch');
  IF v_after IS DISTINCT FROM v_before THEN
    -- Name the difference rather than only reporting one, in both directions.
    SELECT string_agg(d.line, ' | ' ORDER BY d.line) INTO v_bad FROM (
      SELECT 'LOST ' || format('%s.%s = %s', rel, con, def) AS line
        FROM pre_reapply_constraints
       EXCEPT ALL
      SELECT 'LOST ' || format('%s.%s = %s', t.relname, c2.conname, pg_get_constraintdef(c2.oid))
        FROM pg_constraint c2 JOIN pg_class t ON t.oid = c2.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname IN ('lightning_pool_session','lightning_pool_slot',
             'lightning_instance','lightning_reservation','lightning_blind_ledger','lightning_hand',
             'lightning_hand_player','cash_cluster_events','cash_cluster_epoch')
      UNION ALL
      SELECT 'GAINED ' || format('%s.%s = %s', t.relname, c2.conname, pg_get_constraintdef(c2.oid))
        FROM pg_constraint c2 JOIN pg_class t ON t.oid = c2.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname IN ('lightning_pool_session','lightning_pool_slot',
             'lightning_instance','lightning_reservation','lightning_blind_ledger','lightning_hand',
             'lightning_hand_player','cash_cluster_events','cash_cluster_epoch')
       EXCEPT ALL
      SELECT 'GAINED ' || format('%s.%s = %s', rel, con, def) FROM pre_reapply_constraints
    ) d;
    RAISE EXCEPTION 'FAIL re-apply: the constraint set is not byte-identical after the second application: %', coalesce(v_bad, '<ordering only>');
  END IF;

  -- THE BACKFILL RAN AGAIN AND ADDED NOTHING. ON CONFLICT DO NOTHING is what
  -- makes the genesis INSERT re-runnable; without it the second run raises on
  -- the primary key, and with the WRONG conflict target it would insert a
  -- duplicate epoch for every cluster that has since converted.
  IF (SELECT count(*) FROM public.cash_cluster_epoch) IS DISTINCT FROM c.epochs THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_cluster_epoch went from % rows to %', c.epochs,
      (SELECT count(*) FROM public.cash_cluster_epoch);
  END IF;
  IF EXISTS (SELECT * FROM pre_reapply_epochs EXCEPT SELECT * FROM public.cash_cluster_epoch)
     OR EXISTS (SELECT * FROM public.cash_cluster_epoch EXCEPT SELECT * FROM pre_reapply_epochs) THEN
    RAISE EXCEPTION 'FAIL re-apply: an epoch row changed on the second application, so a finished epoch''s mode, reason or start is not durable';
  END IF;

  -- And nothing else moved either.
  IF (SELECT count(*) FROM public.cash_cluster_events) IS DISTINCT FROM c.events THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_cluster_events went from % rows to %', c.events, (SELECT count(*) FROM public.cash_cluster_events); END IF;
  IF (SELECT count(*) FROM public.lightning_pool_session) IS DISTINCT FROM c.pool_sessions THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_pool_session went from % rows to %', c.pool_sessions, (SELECT count(*) FROM public.lightning_pool_session); END IF;
  IF (SELECT count(*) FROM public.lightning_pool_slot) IS DISTINCT FROM c.pool_slots THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_pool_slot went from % rows to %', c.pool_slots, (SELECT count(*) FROM public.lightning_pool_slot); END IF;
  IF (SELECT count(*) FROM public.lightning_instance) IS DISTINCT FROM c.instances THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_instance went from % rows to %', c.instances, (SELECT count(*) FROM public.lightning_instance); END IF;
  IF (SELECT count(*) FROM public.lightning_hand) IS DISTINCT FROM c.hands THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_hand went from % rows to %', c.hands, (SELECT count(*) FROM public.lightning_hand); END IF;
  IF (SELECT count(*) FROM public.lightning_hand_player) IS DISTINCT FROM c.hand_players THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_hand_player went from % rows to %', c.hand_players, (SELECT count(*) FROM public.lightning_hand_player); END IF;
END $$;
\echo '  ok  RE-APPLY           the migration applied a second time over populated tables, rebuilt its nine named constraints byte-identically, added no epoch row and moved no row in any of the nine relations'
REAPPLY

# EVERY @live-proof THE MIGRATION MAKES, EVALUATED ------------------------------
# The migration ends its header with a block of `-- @live-proof:` lines: scalar
# SQL expressions meant to be true of the database the file produces. They are
# COMMENTS, so nothing in a psql run evaluates them, and three proofs in a later
# Lightning phase shipped false in three separate rounds - every one of them the
# proof drifting away from code that was right.
#
# Generated from the file under test rather than written by hand, for the same
# reason this harness applies the real 20260920235343 rather than transcribing
# it: a hand-copied list is a second place for a proof to drift, and drift is
# the only thing this section exists to catch. The mechanism is section 22 of
# scripts/dev/test-lightning-phase4-population.sh, copied exactly: each
# expression is inlined as CODE rather than as a string literal, so nothing in
# it needs escaping and a proof that no longer PARSES fails the run too.
#
# It runs AFTER the assertions and BEFORE the second application, so what it
# reads is the catalogue and the estate the FIRST application left behind -
# every cluster of the fixture still carrying its genesis epoch, and every row
# the assertions above added on top of it.
#
# WHAT IT FOUND, and what is deliberately NOT done about it. The migration's
# SECOND @live-proof, on line 112, reads
#
#   (SELECT count(*) = (SELECT count(*) FROM public.cash_games)
#      FROM public.cash_cluster_epoch WHERE epoch = 0)
#
# and it is FALSE - not because of anything this harness does to the estate
# afterwards, but the instant the migration finishes. The genesis backfill is
# `SELECT g.id, g.cluster_epoch, ...`: one open row per cluster at THAT
# CLUSTER'S OWN epoch, which is the whole point of the backfill and what the
# migration's own read-back guard and the GENESIS BACKFILL section above both
# assert. The fixture's third cluster sits at cluster_epoch 2, so it gets a
# genesis row at epoch 2 and none at epoch 0, and the count comes out 3 against
# 4 games. The proof states an ESTATE fact - "no Cluster has ever moved off
# epoch 0" - dressed as a fact about the migration; it is accidentally true of
# a production database in which nothing has yet converted, and false of any
# database in which something has. The proof on line 113 is the same claim
# stated correctly, over g.cluster_epoch rather than 0, and it is TRUE.
#
# It is NOT deleted, NOT reworded and NOT excepted here. Migration files are
# immutable and a proof is superseded in a later migration's header and in a
# dated Correction, the way this same file supersedes 20260920235343's eighth
# proof on line 100 above - not by editing the harness that finally asked it.
# Until that supersession is written this harness is RED, and that is the
# correct colour for a file that carries a false proof.
#
# There is no quarantine here and there must not be one: every proof in the file
# is evaluated and every one must be true.
: > "$fixture/live-proofs.sql"
printf '%s\n' 'CREATE TEMP TABLE lp (n integer, lineno integer, ok boolean);' \
  >> "$fixture/live-proofs.sql"
proof_n=0
while IFS= read -r proof_line; do
  proof_n=$((proof_n + 1))
  proof_lineno=${proof_line%%:*}
  proof_expr=${proof_line#*:}
  proof_expr=${proof_expr#-- @live-proof: }
  {
    printf '%s%s%s%s%s' 'INSERT INTO lp VALUES (' "$proof_n" ', ' "$proof_lineno" ', coalesce(('
    printf '%s%s\n' "$proof_expr" ')::boolean, false));'
  } >> "$fixture/live-proofs.sql"
done < <(grep -n -- '^-- @live-proof: ' "$migration")

if [ "$proof_n" -lt 13 ]; then
  echo "FAIL live-proof: only $proof_n @live-proof line(s) were found in $migration, so this section would prove almost nothing"
  exit 1
fi

{
  printf '%s\n' 'DO $lp$'
  printf '%s\n' 'DECLARE v_bad text; v_n integer;'
  printf '%s\n' 'BEGIN'
  printf '%s%s%s\n' '  SELECT count(*)::integer INTO v_n FROM lp; IF v_n IS DISTINCT FROM ' "$proof_n" ' THEN'
  printf '%s%s%s\n' "    RAISE EXCEPTION 'FAIL live-proof: % of the " "$proof_n" " proof expressions were evaluated', v_n;"
  printf '%s\n' '  END IF;'
  printf '%s\n' '  -- NON-VACUITY: a run in which every proof answered NULL would coalesce to'
  printf '%s\n' '  -- false and fail below, and a run in which the table was empty fails above.'
  printf '%s\n' "  SELECT string_agg('#' || n || ' (line ' || lineno || ' of the migration)', ', ' ORDER BY n) INTO v_bad"
  printf '%s\n' '    FROM lp WHERE ok IS DISTINCT FROM true;'
  printf '%s\n' '  IF v_bad IS NOT NULL THEN'
  printf '%s\n' "    RAISE EXCEPTION 'FAIL live-proof: the migration carries @live-proof % that is NOT true of the database it just produced', v_bad;"
  printf '%s\n' '  END IF;'
  printf '%s\n' 'END $lp$;'
  printf '%s%s%s\n' "\\echo '  ok  EVERY LIVE PROOF   all " "$proof_n" " @live-proof expressions the migration carries in its own header were extracted from the file under test, inlined as code so that one which no longer PARSES is a failure too, and evaluated against the throwaway catalogue and the estate the first application left behind - and every single one of them is true, with no quarantine and no exception list'"
} >> "$fixture/live-proofs.sql"

"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55544 -d postgres \
  -f "$root/scripts/dev/fixtures/lightning-phase2-remediation-schema.sql" \
  -f "$phase2" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/live-proofs.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql"

echo "PASS: Lightning Phase 2 remediation, the hand knows its cluster, its instance and its epoch: the migration applies unmodified on top of 20260920235343 and makes the epoch a row, cash_cluster_epoch is a real table keyed (cluster_id, epoch) with cash_cluster_epoch_current a UNIQUE partial index on the open epoch, RLS on and anon/authenticated/PUBLIC holding nothing while service_role is explicitly granted SELECT/INSERT/UPDATE/DELETE, the genesis backfill writes exactly one open epoch per cluster carrying that cluster's own epoch and its own mode and its own created_at rather than three constants, a second OPEN epoch collides on cash_cluster_epoch_current while the successor is accepted once the first has ended, a negative epoch and an unknown mode and a backwards end and an orphan cluster each raise their own named CHECK or foreign key, the event ledger takes its cluster's epoch through a BEFORE INSERT trigger that leaves an explicitly named epoch alone and tolerates a game_id that is not a cluster and rewrote no pre-existing row, lightning_pool_session_identity and lightning_pool_slot_identity are UNIQUE over exactly (id, player_id, cluster_id, cluster_epoch), a table opened in another epoch than its session is refused by lightning_pool_slot_belongs_to_its_session while the matching-epoch table is accepted, a pool session and an instance in an undeclared epoch are refused by their runs_in_a_declared_epoch keys and accepted once the epoch row exists, a hand naming another cluster or another epoch than its instance and a hand naming an instance that does not exist are all refused by lightning_hand_belongs_to_its_instance while the agreeing hand is accepted, a participation at another player's table is refused by lightning_hand_player_sits_in_its_own_slot while one player at two tables in two hands and two players in one hand are all accepted, a participation naming a hand that does not exist or a cluster or epoch its hand did not run in is refused by lightning_hand_player_belongs_to_its_hand while the agreeing participation in a second cluster is accepted, the two seat rules still refuse a doubled chair and seats 0 and 10 while accepting a third chair and seat 9, lightning_pool_slot_oldest_bb is keyed exactly (cluster_id, cluster_epoch, last_bb_at, player_id) partial on closed_at IS NULL and still NULLS FIRST, every one of the thirteen @live-proof expressions the migration carries in its own header extracted from the file under test and evaluated against the estate it produced with no quarantine and no exception list, and the migration is idempotent on re-apply over populated tables with its nine named constraints rebuilt byte-identically"
