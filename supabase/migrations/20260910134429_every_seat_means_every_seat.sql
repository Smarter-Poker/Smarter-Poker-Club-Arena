-- every_seat_means_every_seat
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The last player-facing use of the uuid-VERSION regex in production.
--
-- ca_index_every_seat fills ca_hand_player_idx, the index every stats read
-- goes through. Its seat filter is two clauses:
--
--   WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}$'      -- shape
--     AND NOT pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5]...'    -- version
--
-- The second one indexes ONLY the ids that FAIL a uuid-version check: the 62
-- horses whose ids are 00000000-0000-0000-0000-0000000000NN, and the 33 human
-- accounts that predate the v4 generator. It reads as a horse filter and it is
-- the opposite - it is the catch-up half of a pass whose first half had the
-- version check the right way round and therefore skipped those 95 people.
-- Two halves of one filter that should never have existed.
--
-- That is the same defect this morning's a_player_id_is_a_uuid_not_a_uuid_version
-- took out of the two bounty doors, left in the stats indexer because it was
-- doing no damage here: measured over the 35,132 seats dealt between 30 and 10
-- minutes ago, ZERO are missing from the index, horse or human - the live
-- projector indexes everyone and this function only ever backfilled history.
-- Doing no damage is not the same as being correct. The next person who needs
-- "a uuid regex for a player" copies the nearest one, and the nearest one is
-- this.
--
-- So the clause goes, and the function does what it is named: every seat. The
-- insert is ON CONFLICT DO NOTHING, so indexing the seats the other half
-- already covered is idempotent and costs an insert attempt.
--
-- Asserted text substitution on the live definition: the anchor must appear
-- exactly once, the shape check must survive, and the version pattern must be
-- gone afterwards. Nine uses remain in production functions after this and
-- every one of them validates an id the PLATFORM generates - a transcode job,
-- a bounty obligation set by the caller's own GUC, a solver run, a dataset, a
-- purchase - never a person. tests/a-player-id-is-a-uuid-not-a-uuid-version.law.test.ts
-- freezes that list so it can only shrink.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text;
  v_new_def text;
  v_n integer;
  v_shape text := E'WHERE pl->>''userId'' ~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''';
  v_old text := E'\n        AND NOT pl->>''userId'' ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''';
  v_new text := E'\n        /* EVERY SEAT MEANS EVERY SEAT (2026-09-10). The clause that stood\n'
             || E'           here indexed ONLY the ids that FAIL a uuid-version check - the\n'
             || E'           62 horses whose ids are 00000000-0000-0000-0000-0000000000NN\n'
             || E'           and the 33 human accounts that predate the v4 generator -\n'
             || E'           because an earlier pass had the same check the right way round\n'
             || E'           and skipped exactly those 95 people. A player id is a uuid, not\n'
             || E'           a uuid of a particular version (CLAUDE.md 10.5). The insert is\n'
             || E'           ON CONFLICT DO NOTHING, so indexing every seat is idempotent. */';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ca_index_every_seat' AND p.prokind = 'f';
  IF v_def IS NULL THEN RAISE EXCEPTION 'ca_index_every_seat is missing'; END IF;

  IF position('EVERY SEAT MEANS EVERY SEAT' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the seat indexer carries % version-checked player-id clause(s), expected 1', v_n;
    END IF;

    v_new_def := replace(v_def, v_old, v_new);
    EXECUTE v_new_def;

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ca_index_every_seat' AND p.prokind = 'f';
  END IF;

  -- the version check is gone
  IF position('[1-5][0-9a-f]{3}-[89ab]' IN v_def) <> 0 THEN
    RAISE EXCEPTION 'the seat indexer still validates a player id by its uuid version';
  END IF;
  -- the SHAPE check is not - an id that is not a uuid must still be refused
  IF position(v_shape IN v_def) = 0 THEN
    RAISE EXCEPTION 'the seat indexer lost its uuid SHAPE check; it would index anything';
  END IF;
  -- and it still writes the index
  IF position('INSERT INTO public.ca_hand_player_idx' IN v_def) = 0
     OR position('ON CONFLICT DO NOTHING' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the seat indexer no longer writes ca_hand_player_idx idempotently';
  END IF;

  -- no LIVE function may validate a PERSON by uuid version once this lands.
  -- The nine that remain all validate a platform-generated id; named here so
  -- that a tenth appearing is visible in the failure message.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND l.lanname <> 'c'
     AND position('[1-5][0-9a-f]{3}-[89ab]' IN pg_get_functiondef(p.oid)) > 0
     AND p.proname NOT IN (
       'complete_rights_cleared_youtube_transcode',  -- transcode job id
       'fn_attach_bounty_award_obligation',          -- app.bounty_obligation_id GUC
       'fn_collect_bounty',                          -- app.bounty_obligation_id GUC
       'fn_gto_v31_ingest_source_artifact',          -- artifact id
       'fn_gto_v31_register_dataset',                -- input bundle id
       'fn_horse_solver_agreement_v31_decision',     -- dataset id
       'fn_purchase_club_shop_item_diamonds',        -- purchase id
       'fn_solver_compact_heartbeat',                -- solver run id
       'fn_solver_worker_heartbeat'                  -- solver run id
     );
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% production function(s) outside the platform-id allowlist still carry a uuid-version check', v_n;
  END IF;
END
$body$;

COMMIT;
