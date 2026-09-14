-- ═══════════════════════════════════════════════════════════════════════════
--  A PLAYED LAUNCH PROVES ITSELF FROM THE BOARD, NOT FROM A RECEIPT IT NEVER
--  GOT TO WRITE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-09-12)
--
-- Forty tournaments dealt hands on 2026-09-08, eliminated 82 players between
-- them, and then stopped. They have been sitting in REGISTERING ever since,
-- holding 2,574.12 of player money across 125 players. One of them,
-- `Breakfast Turbo`, paid places 2, 3, 4 and 5 between 14:38 and 14:43 and
-- never paid place 1: its champion has been owed 53.12 for three days and
-- twenty-one hours.
--
-- ── THE FIX FOR THIS ALREADY EXISTS AND CANNOT REACH THEM ─────────────────
--
-- On 2026-09-11 this exact incident was diagnosed and two of the three layers
-- it needed were fixed:
--
--   GameServer start gate   `finishingADealtGame` offers a finalized, past-start
--                           row to the launch path. Correct, deployed, firing.
--                           The log shows it every five minutes:
--                             "Starting tournament: NLH Heads-Up 1 (finalized
--                              pool, already dealt - finishing with the field
--                              it has (1 on the board))"
--
--   completion RPC          `fn_prove_played_launch_recovery` generalises the
--                           roster proof so a played-down field can complete.
--                           Correct, installed, and NEVER REACHED.
--
-- The middle layer was missed. `TournamentManagerBase.startTournament` counts
-- the field and stands down before it writes the launch receipt:
--
--     [Tournament:90c4d93f] Starting...
--     [Tournament:90c4d93f] Only 1 of 2 player(s) - standing down so the field
--                           can be filled (NOT cancelling)
--
-- It does have a played-game escape hatch, and it is Spin-only:
--
--     if (spinPaidGateWillRun && requiredField === SPEC_SPIN_SEATS && regCount === 2)
--
-- A paid Spin holding exactly two of its three survives that gate. A heads-up
-- game holding one of two does not. An MTT holding two of four does not. So
-- the manager stands down, no receipt is written, and the completion RPC that
-- would have finished the game is never called at all. `have_a_receipt = 0`
-- on all forty, four days on, with 1,839 receipts written that same day by
-- launches that got past this gate.
--
-- The proof was generalised at the end of the chain and left narrow in the
-- middle of it.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────
--
-- `fn_prove_played_launch_recovery` already proves a played launch from the
-- board: a finalized pool, hands actually dealt, no entrant in a pre-deal
-- status, a dealt field that met the requirement, and every survivor holding a
-- live seat. It takes the started_at to check as an argument, because its one
-- caller had a receipt to check it against.
--
-- The manager has no receipt yet. That is the whole problem. So this derives
-- the value instead of demanding it: the first hand in `hand_history` for the
-- tournament IS the moment it started, and it is a fact rather than a claim.
--
-- The started_at comparison inside the proof is therefore satisfied by
-- construction on this path, and that is correct rather than a loophole: the
-- check exists to catch a RECEIPT whose claim disagrees with what happened,
-- and here there is no claim to disagree. Every other check in the proof does
-- its full work, including the one that matters most, that every surviving
-- player holds a live seat. A game that has not dealt is refused at the first
-- line, so this can never open the door to an under-filled fresh launch.
--
-- The returned `started_at` is then what the manager writes into the launch
-- receipt, which is what makes the completion RPC's own check pass honestly a
-- moment later: the receipt says the game began when the first hand was dealt,
-- because it did.
--
-- Run against production on 2026-09-12, read-only, inside a rolled-back
-- transaction: all forty stalled tournaments return ok, and no other row
-- qualifies.

CREATE OR REPLACE FUNCTION public.fn_prove_played_launch_from_board(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_first_hand timestamptz;
  v_proof      jsonb;
BEGIN
  /* The first hand is the start. A tournament with no hand is not a played
     launch and is refused here, before any other question is asked. */
  SELECT min(h.created_at)
    INTO v_first_hand
    FROM public.hand_history h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.tournament_id = p_tournament_id;

  IF v_first_hand IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_hand_was_dealt');
  END IF;

  v_proof := public.fn_prove_played_launch_recovery(p_tournament_id, v_first_hand);

  /* On success the caller needs the value it must stamp into the receipt, so
     that the completion RPC's own started_at check passes on the truth. On
     refusal the proof's reason is returned untouched. */
  IF COALESCE((v_proof->>'ok')::boolean, false) THEN
    RETURN jsonb_set(v_proof, '{started_at}', to_jsonb(v_first_hand));
  END IF;

  RETURN v_proof;
END;
$function$;

-- The engine builds its client with SUPABASE_SERVICE_ROLE_KEY. No browser role
-- has any business proving a launch.
REVOKE ALL ON FUNCTION public.fn_prove_played_launch_from_board(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prove_played_launch_from_board(uuid)
  TO service_role;

DO $$
DECLARE
  v_ok      integer;
  v_stalled integer;
  v_fresh   integer;
BEGIN
  IF has_function_privilege('anon', 'public.fn_prove_played_launch_from_board(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_prove_played_launch_from_board(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_prove_played_launch_from_board is executable by a browser role';
  END IF;

  SELECT count(*)::int INTO v_stalled
    FROM public.tournaments t
    JOIN LATERAL (SELECT max(tp.eliminated_at) AS at
                    FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id AND tp.status = 'eliminated') last ON last.at IS NOT NULL
   WHERE t.status NOT IN ('RUNNING', 'COMPLETED', 'CANCELLED')
     AND last.at < now() - interval '30 minutes';

  SELECT count(*)::int INTO v_ok
    FROM public.tournaments t
    JOIN LATERAL (SELECT max(tp.eliminated_at) AS at
                    FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id AND tp.status = 'eliminated') last ON last.at IS NOT NULL
   WHERE t.status NOT IN ('RUNNING', 'COMPLETED', 'CANCELLED')
     AND last.at < now() - interval '30 minutes'
     AND COALESCE((public.fn_prove_played_launch_from_board(t.id)->>'ok')::boolean, false);

  /* A tournament that has dealt nothing must never prove a played launch. */
  SELECT count(*)::int INTO v_fresh
    FROM public.tournaments t
   WHERE t.status = 'REGISTERING'
     AND NOT EXISTS (SELECT 1 FROM public.hand_history h
                       JOIN public.tables tb ON tb.id = h.table_id
                      WHERE tb.tournament_id = t.id)
     AND COALESCE((public.fn_prove_played_launch_from_board(t.id)->>'ok')::boolean, false);

  IF v_fresh <> 0 THEN
    RAISE EXCEPTION
      'fn_prove_played_launch_from_board approved % tournament(s) that never dealt a hand', v_fresh;
  END IF;

  RAISE NOTICE
    'fn_prove_played_launch_from_board OK: % of % stalled played tournament(s) provable from the board; 0 undealt tournaments approved.',
    v_ok, v_stalled;
END $$;
