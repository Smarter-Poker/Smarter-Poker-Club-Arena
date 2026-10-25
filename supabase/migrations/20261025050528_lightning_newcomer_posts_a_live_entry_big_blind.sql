-- @live-proof: (SELECT position('ENTRY BIG BLIND' IN pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure))>0 AND position('''entry_bb''' IN pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)'::regprocedure))>0 AND position('IN (''bb'', ''entry_bb'')' IN pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure))>0 AND position('x-smarter-lightning-entry-bb' IN pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)'::regprocedure))>0 AND position('x-smarter-lightning-entry-bb' IN pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure))>0)
-- 20261025050528_lightning_newcomer_posts_a_live_entry_big_blind.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-24, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST."
-- 20261024195059 holds a newcomer (a pool slot that has never been the big
-- blind, lightning_pool_slot.last_bb_at IS NULL) who is not one of the pass's
-- big blinds, EXCEPT `EXIT WHEN v_g2 = 0`: a hold that would leave the pass no
-- hand at all is not taken, so every newcomer is seated anyway and the second
-- one is dealt the SMALL BLIND (P2 ranks last_bb_at NULLS FIRST, so the next
-- newcomer is the next in line for the small blind). Measured on the
-- TypeScript port, which is the SQL line for line: 2 newcomers + 3 regulars
-- deals one newcomer the small blind; 3 + 3 deals two off the big blind; 4 + 3
-- deals three; a pass after "4 newcomers + 8 regulars" too. Production pools
-- hold 8-39 players today, so it is rare, and real for every thin pool.
--
-- THE FIX, at the line that decides it (CLAUDE.md 10.11/10.12): the pass is
-- not stalled (it still deals), and a newcomer it seats outside the big blind
-- POSTS A LIVE ENTRY BIG BLIND from their seat ("post to play", the standard
-- way into a fast-fold pool). Their first hand therefore costs and plays
-- exactly like the big blind: one big blind, live, counted toward their call,
-- and they keep the option. The real big blind is unchanged and nobody else's
-- blind changes. They are stamped like the big blind (last_bb_at, and
-- bb_count in the blind ledger), so they are not newcomers afterwards and are
-- never charged twice.
--
--   - fn_lightning_match_plan: after the hold loop, the newcomers the pass
--     seats outside its big blinds are its ENTRY BIG BLINDS (`entry_bb` on each
--     group, in seat order; `entry_big_blind` on the plan). The small blind is
--     taken from the players who are not entry posters first; only a group
--     with nobody else (a pool of only newcomers) gives it to an entry poster,
--     whose small blind is then dead and who posts the entry big blind instead.
--   - fn_lightning_form_hand: the barrier derives the same set from its own
--     locked P2 row (a candidate with last_bb_at NULL who is not the big
--     blind), records each as blind_role 'entry_bb', takes the small blind
--     from the others first, stamps every entry poster like the big blind
--     (last_bb_at, hands_since_bb = 0, bb_count + 1) and never stamps a small
--     blind it did not post. Its re-check accepts a dead small blind in seat 1
--     held by an entry poster, and the replay answer names seat 1 as `sb`.
--   - fn_lightning_instance_releases_its_reservations: a hand voided before
--     dealing gives an entry poster's stamps back exactly as a big blind's
--     (20261024231549 read only 'bb'), so a voided entry post leaves a
--     newcomer a newcomer.
--
-- ACTIVATION, AND WHY IT IS SAFE IN EVERY ORDER. An 'entry_bb' participant is
-- dealt correctly only by an engine that posts it; an engine from before this
-- change would deal them a free hand. And until
-- 20261025050534 (daily window) widens lightning_hand_player_blind_role_check,
-- inserting 'entry_bb' is a check_violation, which the barrier treats as an
-- impossible state and freezes the Cluster. So nothing here emits 'entry_bb'
-- unless THE GATE, read per call in the plan and in the barrier (one text,
-- substituted into both below), says BOTH:
--   1. the request comes from an engine that posts it: PostgREST's
--      request.headers carries x-smarter-lightning-entry-bb: 1, which only the
--      new engine's Lightning RPC client sends (LightningSupervisor); and
--   2. lightning_hand_player_blind_role_check admits 'entry_bb'.
-- Either one missing, the plan, the barrier and the release trigger behave
-- exactly as today (the entry set is empty and every ordering key ties). The
-- rule turns on by itself when the last of this migration, the window
-- migration and the engine release is installed, and off again if the engine
-- is rolled back. No config row, no operator flag, no ordering to remember.
--
-- Horses are players (CLAUDE.md 10.5): nothing here reads a horse marker. No
-- money moves here; the entry post is the engine's, at the felt, and it reaches
-- the books through the hand's settlement like every other posted blind.
--
-- Applied as md5-guarded text replacements of the live definitions (the house
-- pattern from 20261023230001, 20261024195059 and 20261024231549): every
-- anchor must occur exactly once, so a drifted source aborts instead of
-- overwriting someone else's change. No object is declared: the gate is
-- inlined rather than a new function, so nothing here is absent from the live
-- schema before it is applied.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $source$
DECLARE
  r record;
  e record;
  s text;
  n text;
  -- THE GATE, once. A plpgsql block that sets v_entry_on; the plan and the
  -- barrier each run it where they decide (@@ENTRY_GATE@@ below).
  v_gate CONSTANT text := $g$  -- THE ENTRY BIG BLIND GATE (20261025050528). Open only when the calling
  -- engine posts the entry big blind (PostgREST request.headers carries
  -- x-smarter-lightning-entry-bb: 1, which LightningSupervisor sends) AND
  -- lightning_hand_player can record it (20261025050534 admits 'entry_bb').
  -- Either missing, nothing here emits 'entry_bb' and this is the function
  -- it was before.
  BEGIN
    v_entry_on := coalesce(nullif(current_setting('request.headers', true), '')::jsonb
                             ->> 'x-smarter-lightning-entry-bb', '') = '1'
                  AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                               WHERE c.conrelid = 'public.lightning_hand_player'::regclass
                                 AND c.conname = 'lightning_hand_player_blind_role_check'
                                 AND position('''entry_bb''' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0);
  EXCEPTION WHEN invalid_text_representation THEN
    v_entry_on := false;
  END;
$g$;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)', '94892943ee2a9cba3f495e507f2ff0d3'),
    ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)', '9dfe2626d4dbed01843f67cc69c430ad'),
    ('public.fn_lightning_instance_releases_its_reservations()', 'c939c6325086f93f6b9fce077348125d')
  ) x(sig, want) LOOP
    s := pg_get_functiondef(r.sig::regprocedure);
    IF md5(s) IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'Lightning source changed; requalify the entry big blind before installation: %', r.sig;
    END IF;
    n := s;
    FOR e IN SELECT * FROM (VALUES
      -- ── fn_lightning_match_plan ─────────────────────────────────────────
      ('fn_lightning_match_plan', 1,
       $a$  v_held      uuid[] := ARRAY[]::uuid[];
$a$,
       $b$  v_held      uuid[] := ARRAY[]::uuid[];
  v_entry     uuid[] := ARRAY[]::uuid[];
  v_entry_on  boolean := false;
$b$),
      ('fn_lightning_match_plan', 2,
       $a$  v_wait := coalesce(v_rest_all[v_need + 1:cardinality(v_rest_all)], ARRAY[]::uuid[]);
$a$,
       $b$  v_wait := coalesce(v_rest_all[v_need + 1:cardinality(v_rest_all)], ARRAY[]::uuid[]);

  -- ENTRY BIG BLIND (Dan 2026-10-24: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST";
  -- 20261025050528). The hold loop above seats a newcomer outside the big
  -- blinds only when holding would leave the pass no hand. Each such newcomer
  -- the pass seats posts a LIVE ENTRY BIG BLIND: one big blind, counted toward
  -- their call, with the option, exactly as the big blind plays. Only when the
  -- calling engine posts it and the participant row can record it (the
  -- gate); otherwise the set is empty and the plan is the plan before this
  -- change.
@@ENTRY_GATE@@  IF v_entry_on THEN
    v_entry := ARRAY(SELECT u.pid FROM unnest(v_rest) WITH ORDINALITY u(pid, ord)
                      WHERE u.pid = ANY (v_newcomer) ORDER BY u.ord);
  END IF;
$b$),
      ('fn_lightning_match_plan', 3,
       $a$                  ORDER BY (v_info -> u.pid::text ->> 'p2')::integer LIMIT v_g);
$a$,
       $b$                  ORDER BY (u.pid = ANY (v_entry)), (v_info -> u.pid::text ->> 'p2')::integer LIMIT v_g);
$b$),
      ('fn_lightning_match_plan', 4,
       $a$      'bb', v_bb,
      'keys', jsonb_build_object(
$a$,
       $b$      'bb', v_bb,
      'entry_bb', to_jsonb(ARRAY(SELECT m FROM unnest(ARRAY[v_bb] || CASE WHEN v_sb IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_sb] END || v_order)
                                         WITH ORDINALITY q(m, o)
                                  WHERE m = ANY (v_entry) ORDER BY o)),
      'keys', jsonb_build_object(
$b$),
      ('fn_lightning_match_plan', 5,
       $a$    'legal_count', v_n,
    'groups', v_groups,
$a$,
       $b$    'legal_count', v_n,
    'entry_big_blind', v_entry_on,
    'groups', v_groups,
$b$),
      -- ── fn_lightning_form_hand ──────────────────────────────────────────
      ('fn_lightning_form_hand', 1,
       $a$  v_btn       uuid;
$a$,
       $b$  v_btn       uuid;
  -- 20261025050528: the candidates who post a live entry big blind.
  v_entry     uuid[] := ARRAY[]::uuid[];
  v_entry_on  boolean := false;
$b$),
      ('fn_lightning_form_hand', 2,
       $a$                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'sb'),
$a$,
       $b$                WHERE hp.hand_id = v_replay.hand_id
                  AND (hp.blind_role = 'sb' OR (hp.seat = 1 AND hp.blind_role = 'entry_bb'))),
$b$),
      ('fn_lightning_form_hand', 3,
       $a$  SELECT (t.e ->> 'player_id')::uuid INTO v_sb
    FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
   WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
   ORDER BY t.ord LIMIT 1;
$a$,
       $b$  -- ENTRY BIG BLIND (20261025050528). A candidate who has never been the
  -- big blind (last_bb_at NULL on the barrier's own locked P2 row) and is not
  -- this hand's big blind posts a live entry big blind from their seat. Only
  -- when the calling engine posts it and the row can record it (the gate);
  -- otherwise the set is empty and the barrier is the barrier before this
  -- change. The small blind is taken from the others first; a hand with
  -- nobody else gives seat 1 to an entry poster, whose small blind is then
  -- dead.
@@ENTRY_GATE@@  IF v_entry_on THEN
    v_entry := ARRAY(SELECT (t.e ->> 'player_id')::uuid
                       FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
                      WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
                        AND jsonb_typeof(t.e -> 'last_bb_at') = 'null'
                      ORDER BY t.ord);
  END IF;
  SELECT (t.e ->> 'player_id')::uuid INTO v_sb
    FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
   WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
   ORDER BY ((t.e ->> 'player_id')::uuid = ANY (v_entry)), t.ord LIMIT 1;
$b$),
      ('fn_lightning_form_hand', 4,
       $a$           'blind_role', CASE WHEN s.seat = 1 THEN 'sb'
$a$,
       $b$           'blind_role', CASE WHEN s.pid = ANY (v_entry) THEN 'entry_bb'
                              WHEN s.seat = 1 THEN 'sb'
$b$),
      ('fn_lightning_form_hand', 5,
       $a$       SET last_bb_at     = CASE WHEN sl.player_id = v_bb  THEN p_now ELSE sl.last_bb_at END,
           last_sb_at     = CASE WHEN sl.player_id = v_sb  THEN p_now ELSE sl.last_sb_at END,
$a$,
       $b$       SET last_bb_at     = CASE WHEN sl.player_id = v_bb OR sl.player_id = ANY (v_entry) THEN p_now ELSE sl.last_bb_at END,
           last_sb_at     = CASE WHEN sl.player_id = v_sb AND NOT (sl.player_id = ANY (v_entry)) THEN p_now ELSE sl.last_sb_at END,
$b$),
      ('fn_lightning_form_hand', 6,
       $a$           hands_since_bb = CASE WHEN sl.player_id = v_bb  THEN 0 ELSE sl.hands_since_bb + 1 END,
           hands_since_sb = CASE WHEN sl.player_id = v_sb  THEN 0 ELSE sl.hands_since_sb + 1 END,
$a$,
       $b$           hands_since_bb = CASE WHEN sl.player_id = v_bb OR sl.player_id = ANY (v_entry) THEN 0 ELSE sl.hands_since_bb + 1 END,
           hands_since_sb = CASE WHEN sl.player_id = v_sb AND NOT (sl.player_id = ANY (v_entry)) THEN 0 ELSE sl.hands_since_sb + 1 END,
$b$),
      ('fn_lightning_form_hand', 7,
       $a$           (coalesce(hp.blind_role, 'none') = 'bb')::integer,
$a$,
       $b$           (coalesce(hp.blind_role, 'none') IN ('bb', 'entry_bb'))::integer,
$b$),
      ('fn_lightning_form_hand', 8,
       $a$            WHERE hp.hand_id = v_hand AND hp.blind_role = 'sb') <> 1
$a$,
       $b$            WHERE hp.hand_id = v_hand
              AND (hp.blind_role = 'sb' OR (hp.seat = 1 AND hp.blind_role = 'entry_bb'))) <> 1
$b$),
      ('fn_lightning_form_hand', 9,
       $a$                            'seats', v_seats, 'state', 'reserved', 'request_id', p_request_id);
$a$,
       $b$                            'seats', v_seats, 'entry_bb', to_jsonb(v_entry),
                            'state', 'reserved', 'request_id', p_request_id);
$b$),
      -- ── fn_lightning_instance_releases_its_reservations ─────────────────
      ('fn_lightning_instance_releases_its_reservations', 1,
       $a$                   (coalesce(hp.blind_role, 'none') = 'bb')::integer AS bb,
$a$,
       $b$                   (coalesce(hp.blind_role, 'none') IN ('bb', 'entry_bb'))::integer AS bb,
$b$),
      ('fn_lightning_instance_releases_its_reservations', 2,
       $a$                   coalesce(hp.blind_role, 'none') = 'bb' AS was_bb,
$a$,
       $b$                   coalesce(hp.blind_role, 'none') IN ('bb', 'entry_bb') AS was_bb,
$b$),
      ('fn_lightning_instance_releases_its_reservations', 3,
       $a$                SELECT max(d.formed_at) FILTER (WHERE d.blind_role = 'bb')  AS bb_at,
$a$,
       $b$                SELECT max(d.formed_at) FILTER (WHERE d.blind_role IN ('bb', 'entry_bb'))  AS bb_at,
$b$)
    ) p(fn, k, old_text, new_text)
    WHERE r.sig LIKE 'public.' || p.fn || '(%' ORDER BY p.k LOOP
      IF (length(n) - length(replace(n, e.old_text, ''))) / length(e.old_text) <> 1 THEN
        RAISE EXCEPTION 'Lightning entry big blind anchor % of % is not exactly once', e.k, e.fn;
      END IF;
      n := replace(n, e.old_text, replace(e.new_text, '@@ENTRY_GATE@@', v_gate));
    END LOOP;
    IF n = s OR position('@@ENTRY_GATE@@' IN n) > 0 THEN
      RAISE EXCEPTION 'Lightning entry big blind replacement did not take: %', r.sig;
    END IF;
    EXECUTE n;
  END LOOP;

  IF position('ENTRY BIG BLIND' IN pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure)) = 0
     OR position('''entry_bb''' IN pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)'::regprocedure)) = 0
     OR position('IN (''bb'', ''entry_bb'')' IN pg_get_functiondef('public.fn_lightning_instance_releases_its_reservations()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Lightning entry big blind did not install';
  END IF;
END
$source$;

COMMIT;
