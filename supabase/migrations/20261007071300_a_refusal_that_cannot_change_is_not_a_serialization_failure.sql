-- 20261007071300_a_refusal_that_cannot_change_is_not_a_serialization_failure.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (issue #6326)
--
-- PostgREST 14 treats SQLSTATE 40001 (serialization_failure) as transient and
-- re-runs the whole request transaction, on the same pooled connection, until
-- it stops failing. It never returns the 40001 to the caller and no statement
-- timeout ends it, because every attempt is a new statement. Supabase documents
-- this as a PostgREST 14 bug, fixed in PostgREST 16 ("SQLSTATE 40001 in an RPC
-- function causes infinite retries"). This project runs PostgREST 14.5 with a
-- 41-connection pool.
--
-- A function that raises 40001 for a condition a retry cannot change therefore
-- pins one pool connection for ever. Production 2026-10-06 15:33 to
-- 2026-10-07 02:06 UTC:
--
--   * fn_complete_tournament_terminal -> ..._pre_seat_guard -> fn_settle_tournament_places
--     raised 'observed winner ca905025... does not match locked winner <NULL>
--     for tournament 62a15104...' USING ERRCODE = '40001' 3,467,664 times, about
--     100 a second, from 457 PostgREST backends (parsed.application_name
--     'PostgREST 14.5', sql_state_code 40001). The engine sent roughly ten
--     HTTP requests a minute; the rest were PostgREST's own retries.
--   * Every engine attempt the engine abandoned left one backend looping. The
--     number of looping backends rose by about one a minute (22 at 00:30,
--     39 at 00:53, 40 at 01:02) until it reached the pool size, and then every
--     other request waited 10 s for a connection and got 504 PGRST003:
--     8,326 504s a minute at 01:03, 7,414 at 01:11. PostgREST then recycled
--     (01:12-01:14, a 26,840-request 503 burst) and the count restarted at 2.
--     That cycle is the "about hourly" outage: 15:36, 16:56, 17:50, 18:44,
--     19:52, 20:44, 21:49, 22:45, 23:39, 01:03. It has no tie to the :55 break.
--   * The loop and the outages began and ended together: no 504 storm before
--     15:33 on 2026-10-06, none after 02:06 on 2026-10-07, when the event was
--     recovered and the refusal stopped being reached.
--
-- The refusal itself was right. It runs after `FOR UPDATE` on the whole
-- roster, so the state it compares is committed and locked: asking again
-- within the same request returns the same answer. It is a refusal, not a
-- serialization failure, and it must reach the engine as one.
--
-- THE CHANGE: every raise below compares a caller's observation with a durable
-- or locked record (an immutable receipt, or a roster under its row locks)
-- and now raises SQLSTATE 55000 (object_not_in_prerequisite_state), the code
-- these functions already use for their other state refusals. Messages are
-- unchanged, so the engine's text-matched handlers (receipt adoption in
-- server/src/tournament/terminalSettlementRpc.ts) are unchanged; they are now
-- simply reached. A refusal is answered in milliseconds and the engine retries
-- on its own cadence (requestTournamentTerminalReceipt: five bounded attempts,
-- then the serialized resolver, then TerminalSettlementRefusedError).
--
--   fn_settle_tournament_places                 observed winner does not match locked winner
--   fn_settle_satellite_tournament_pre_money_path_gate  observed winner does not match locked last survivor
--   fn_settle_tournament_bubble_protection      observed bubble user does not match durable place
--   fn_complete_tournament_terminal_pre_seat_guard  terminal replay parameters disagree with stored receipt
--                                               mystery evidence receipt conflicts with canonical proof
--   fn_resolve_tournament_terminal_outcome      terminal outcome parameters disagree with stored receipt
--   fn_ca_tournament_terminal_receipt           receipt winner differs from observed winner
--   fn_resolve_satellite_settlement_outcome     satellite outcome winner disagrees with stored receipt
--   fn_ca_satellite_settlement_receipt          satellite receipt winner differs from observed winner
--   fn_ca_satellite_cohort_receipt              satellite cohort receipt identity differs
--   fn_ca_tournament_cancellation_receipt       cancellation actor disagrees with stored receipt
--   fn_poker_diamond_tournament_cancellation_receipt  cancellation actor disagrees with stored receipt
--
-- The 2026-09-10 bursts of 'terminal replay parameters disagree' (50-80 a
-- second, docs/changelog/2026-09-10-terminal-replay-disagreement-is-not-retried-forever.md)
-- were this same retry, ended only when the manager fence made the request's
-- pre-request hook refuse.
--
-- Not changed: 40001 raised for a lost compare-and-set or a lane that is busy
-- (F06_RETRY_CANONICAL_LANE, '... CAS changed % rows', '... lost its claim').
-- There the retry re-reads a state another transaction is changing, and it
-- ends when that transaction commits.
--
-- HOW: each body is read from pg_get_functiondef, pinned by md5, and only the
-- SQLSTATE literal inside the one RAISE that carries the message is changed.
-- The reverse substitution must reproduce the pinned text exactly, so nothing
-- else in a function can move. CREATE OR REPLACE keeps the owner, SECURITY
-- DEFINER, search_path and every grant. No money, row or grant is touched.
--
-- LIVE PROOF: true once every one of the eleven bodies has no disagreement
-- refusal left on 40001 (false before this migration: all eleven matched).
-- @live-proof: (SELECT count(*) = 11 AND bool_and(pg_get_functiondef(p.oid) !~ $re$(does not match|disagree|differs|conflicts with)[^;]*ERRCODE\s*=\s*'40001'$re$) FROM pg_proc p WHERE p.oid = ANY(ARRAY['public.fn_settle_tournament_places(uuid,uuid)','public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)','public.fn_settle_tournament_bubble_protection(uuid,uuid)','public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','public.fn_ca_tournament_terminal_receipt(uuid,uuid)','public.fn_resolve_satellite_settlement_outcome(uuid,uuid)','public.fn_ca_satellite_settlement_receipt(uuid,uuid)','public.fn_ca_satellite_cohort_receipt(uuid,uuid[])','public.fn_ca_tournament_cancellation_receipt(uuid,uuid)','public.fn_poker_diamond_tournament_cancellation_receipt(uuid,uuid)']::regprocedure[]))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  r record;
  v_oid regprocedure;
  v_def text;
  v_new text;
  v_back text;
  v_key text;
  v_pos integer;
  v_rel integer;
  v_frag text;
  v_new_frag text;
  v_frags text[];
  v_new_frags text[];
  v_codes_before integer;
  v_codes_after integer;
  v_changed integer := 0;
  i integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_settle_tournament_places(uuid,uuid)',
       '24b0227e8e6ec41edebca88030e58f5e',
       ARRAY['does not match locked winner']),
      ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
       '9c1fe1572030f0b31d9127467d2deb54',
       ARRAY['does not match the locked last survivor in satellite']),
      ('public.fn_settle_tournament_bubble_protection(uuid,uuid)',
       '269d06d1d01e3211dcabee29f6d91113',
       ARRAY['does not match durable place']),
      ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
       '587f4eb17a08a0b2a2570be1662071a6',
       ARRAY['terminal replay parameters disagree with stored receipt',
             'mystery evidence receipt conflicts with canonical proof']),
      ('public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
       'be748996b334541f84debbc2e9eb5457',
       ARRAY['terminal outcome parameters disagree with stored receipt']),
      ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)',
       '0063a1bf2739d27f52e7f5111b1e67ad',
       ARRAY['receipt winner % differs from observed winner']),
      ('public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',
       '833313597d84e3530c73552e42ee45b1',
       ARRAY['satellite outcome winner disagrees with stored receipt']),
      ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)',
       'b9b523653a134c0eac2e7e3f114a3c77',
       ARRAY['receipt winner % differs from observed winner']),
      ('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])',
       'f6ac69c5c3eec3bd254d42fca180be60',
       ARRAY['satellite cohort receipt identity differs']),
      ('public.fn_ca_tournament_cancellation_receipt(uuid,uuid)',
       'cf0bf7f56e2e50376626c37b59cfaca8',
       ARRAY['cancellation actor disagrees with stored receipt']),
      ('public.fn_poker_diamond_tournament_cancellation_receipt(uuid,uuid)',
       '361d90e78dee65236635da53740c1eeb',
       ARRAY['cancellation actor disagrees with stored receipt'])
    ) AS t(sig, pin, keys)
  LOOP
    v_oid := r.sig::regprocedure;
    v_def := pg_get_functiondef(v_oid);
    IF md5(v_def) <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %, pinned %)', r.sig, md5(v_def), r.pin;
    END IF;
    v_codes_before := (SELECT count(*) FROM regexp_matches(v_def, $re$ERRCODE\s*=\s*'40001'$re$, 'g'));

    v_new := v_def;
    v_frags := ARRAY[]::text[];
    v_new_frags := ARRAY[]::text[];
    FOREACH v_key IN ARRAY r.keys LOOP
      IF (length(v_def) - length(replace(v_def, v_key, ''))) / length(v_key) <> 1 THEN
        RAISE EXCEPTION '% must carry "%" exactly once', r.sig, v_key;
      END IF;
      v_pos := strpos(v_def, v_key);
      v_rel := strpos(substr(v_def, v_pos), $q$'40001'$q$);
      IF v_rel = 0 OR v_rel > 220 THEN
        RAISE EXCEPTION '% has no 40001 within its "%" raise', r.sig, v_key;
      END IF;
      -- From the message to the closing quote of '40001', inclusive.
      v_frag := substr(v_def, v_pos, v_rel - 1 + 7);
      IF strpos(v_frag, ';') > 0 OR v_frag !~ $re$ERRCODE\s*=\s*'40001'$$re$ THEN
        RAISE EXCEPTION '% "%" raise is not one statement ending in ERRCODE 40001: %', r.sig, v_key, v_frag;
      END IF;
      IF (length(v_def) - length(replace(v_def, v_frag, ''))) / length(v_frag) <> 1 THEN
        RAISE EXCEPTION '% "%" raise text is not unique', r.sig, v_key;
      END IF;
      v_new_frag := left(v_frag, length(v_frag) - 7) || $q$'55000'$q$;
      v_new := replace(v_new, v_frag, v_new_frag);
      v_frags := v_frags || v_frag;
      v_new_frags := v_new_frags || v_new_frag;
    END LOOP;

    EXECUTE v_new;

    v_back := pg_get_functiondef(v_oid);
    v_codes_after := (SELECT count(*) FROM regexp_matches(v_back, $re$ERRCODE\s*=\s*'40001'$re$, 'g'));
    IF v_codes_after <> v_codes_before - array_length(r.keys, 1) THEN
      RAISE EXCEPTION '% kept % 40001 raises, expected %', r.sig, v_codes_after,
        v_codes_before - array_length(r.keys, 1);
    END IF;
    FOR i IN REVERSE array_length(v_frags, 1) .. 1 LOOP
      v_back := replace(v_back, v_new_frags[i], v_frags[i]);
    END LOOP;
    IF md5(v_back) <> r.pin THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', r.sig;
    END IF;
    v_changed := v_changed + array_length(r.keys, 1);
  END LOOP;

  IF v_changed <> 12 THEN
    RAISE EXCEPTION 'expected 12 refusals moved off 40001, moved %', v_changed;
  END IF;
END $m$;

COMMIT;
