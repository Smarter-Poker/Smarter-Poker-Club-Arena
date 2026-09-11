-- 20260909181642_every_expiry_says_why_including_the_executors
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
--
-- ═══════════════════════════════════════════════════════════════════════════
--  EVERY EXPIRY SAYS WHY - THE TWO EXECUTOR PATHS THE 09-07 AUDIT MISSED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- docs/changelog/2026-09-07-the-feeder-cluster-audit.md, "Two things worth
-- knowing, neither fixed here":
--
--   "A move that expires says nothing about why. ... 29 `expired` with NO NOTE
--    AT ALL. Expiry is the one outcome in the move lifecycle that carries no
--    explanation, and it is the one you most need explained."
--
-- `20260907171507_an_expired_move_says_what_it_was_waiting_for` closed that in
-- `fn_cash_cluster_tick`. TWO OTHER PATHS write the same state and were not
-- touched, because they are in the executors rather than in the planner.
--
-- ── 1. THE MOVE EXECUTOR EXPIRES WITH NO NOTE AT ALL ───────────────────────
--
--   fn_cash_seat_move_execute_before_maintenance_gate:
--     IF m.expires_at <= clock_timestamp() THEN
--       UPDATE public.cash_seat_moves SET state = 'expired' WHERE id = m.id;
--
-- This is the ORIGINAL 09-07 finding, one level down: a row that says only
-- "expired". It fires when the deadline passes between the engine deciding to
-- execute and the executor reaching the row - the engine DID come, and it came
-- late - which is a different fact from every note the tick can write, and the
-- one an operator most wants distinguished from "the engine never came".
-- It gets `expired_before_the_executor_reached_it`.
--
-- ── 2. THE SWAP EXECUTOR WRITES ONE NOTE FOR FOUR CAUSES, AND MARKS A LIVE
--       PARTNER EXPIRED ─────────────────────────────────────────────────────
--
--   IF NOT FOUND OR pm.state <> 'pending' OR pm.expires_at <= v_now
--                OR m.expires_at <= v_now THEN
--     UPDATE ... SET state = CASE WHEN m.expires_at <= v_now THEN 'expired'
--                                 ELSE 'cancelled' END,
--            note = 'swap_partner_gone'
--     ...
--     IF pm.id IS NOT NULL AND pm.state = 'pending' THEN
--       UPDATE ... SET state = 'expired', note = 'swap_partner_gone'
--        WHERE id = pm.id;
--
-- Two separate untruths:
--
--   (a) `swap_partner_gone` is written when MY OWN deadline passed and the
--       partner is perfectly fine. The taxonomy then blames the other player
--       for my timeout.
--   (b) the partner - explicitly still `pending`, explicitly not expired,
--       because the branch guards on `pm.state = 'pending'` - is recorded as
--       `expired`. A move that never reached its deadline is counted in the
--       expiry statistics. So a count of expiries is not a count of expiries,
--       which is the thing 10.86 rule 1 forbids: an answer given confidently
--       where the honest answer is a different word.
--
-- Both are corrected: each side names its own cause, and a partner that is
-- alive is `cancelled` (with `swap_partner_expired`, naming what happened to
-- the OTHER side) rather than `expired`.
--
-- ── 3. THE SWAP GATE NEVER CHECKS THAT ITS DESTINATIONS EXIST (F4, folded in
--       2026-09-10 from lane B's report, section 5) ─────────────────────────
--
--   SELECT * INTO ta FROM public.tables WHERE id = m.to_table_id;
--   SELECT * INTO tb FROM public.tables WHERE id = pm.to_table_id;
--   IF ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed') THEN
--
-- On a record that was never found, `ta.lifecycle IN (...)` is NULL, and NULL
-- OR NULL is not true - so a destination that has VANISHED (deleted, or an id
-- that never existed) passes the gate and the swap goes on to insert a chair
-- on it. The single-move gate reads status too and refuses a table that is
-- not waiting|running|active; the swap gate never did. Lane B's predicate is
-- taken verbatim: both rows must exist, be open by lifecycle, AND be open by
-- status. Same `destination_unavailable` note, so the taxonomy is unchanged.
--
-- MEASURED. Over the last 24 hours neither expiry path produced a row: every expired
-- move carries a note from the tick. That is why this is a P2 and not a P1 -
-- but a taxonomy that is right only while its rarest branch never fires is not
-- a taxonomy, and the swap path in particular fires exactly when two players
-- are waiting on each other, which is when somebody will be reading it.
--
-- HOW THIS EDITS THE FUNCTIONS. Both bodies are read LIVE and patched by one
-- literal replacement each, anchored on the complete statement. The migration
-- refuses if an anchor is absent, and asserts both results afterwards.
--
-- ROLLBACK
--   Remove the added `note =` from the move gate, restore the swap gate's
--   two updates to `note = 'swap_partner_gone'` with the partner set to
--   'expired', and restore the destination test to its lifecycle-only form.
--
-- ONE transaction (production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_anchor CONSTANT text := $old$  IF m.expires_at <= clock_timestamp() THEN
    UPDATE public.cash_seat_moves SET state = 'expired' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;$old$;
  v_repl CONSTANT text := $new$  IF m.expires_at <= clock_timestamp() THEN
    -- EVERY EXPIRY SAYS WHY (2026-09-09). This one is not "the engine never
    -- came" - it came, and the deadline passed between the decision and this
    -- row. Left unnamed it was indistinguishable from every other expiry.
    UPDATE public.cash_seat_moves
       SET state = 'expired', note = 'expired_before_the_executor_reached_it'
     WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;$new$;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_seat_move_execute_before_maintenance_gate'::regproc);
  IF position('expired_before_the_executor_reached_it' in v_src) > 0 THEN
    RAISE NOTICE 'move gate already applied';
  ELSE
    IF position(v_anchor in v_src) = 0 THEN
      RAISE EXCEPTION 'the move executor expiry is not in the live definition in the shape this migration expects';
    END IF;
    v_new := replace(v_src, v_anchor, v_repl);
    IF position('expired_before_the_executor_reached_it' in v_new) = 0
       OR position('player_not_seated' in v_new) = 0
       OR position('destination_unavailable' in v_new) = 0
       OR position('destination_full' in v_new) = 0
       OR position('app.cash_seat_move' in v_new) = 0 THEN
      RAISE EXCEPTION 'a landmark of the move executor went missing in the edit';
    END IF;
    EXECUTE v_new;
  END IF;
END;
$migration$;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_anchor CONSTANT text := $old$    UPDATE public.cash_seat_moves SET state = CASE WHEN m.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
           note = 'swap_partner_gone'
     WHERE id = m.id;
    IF pm.id IS NOT NULL AND pm.state = 'pending' THEN
      UPDATE public.cash_seat_moves SET state = 'expired', note = 'swap_partner_gone' WHERE id = pm.id;
    END IF;$old$;
  v_repl CONSTANT text := $new$    -- EACH SIDE NAMES ITS OWN CAUSE (2026-09-09). This used to write
    -- 'swap_partner_gone' on both rows whatever had actually happened, so a
    -- move that timed out on its own deadline blamed the other player, and a
    -- partner that was still pending and still inside its deadline was
    -- recorded as `expired`. A count of expiries was not a count of expiries.
    UPDATE public.cash_seat_moves SET state = CASE WHEN m.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
           note = CASE WHEN m.expires_at <= v_now THEN 'own_ttl_expired'
                       WHEN pm.id IS NULL THEN 'swap_partner_gone'
                       WHEN pm.expires_at <= v_now THEN 'swap_partner_expired'
                       ELSE 'swap_partner_gone' END
     WHERE id = m.id;
    IF pm.id IS NOT NULL AND pm.state = 'pending' THEN
      -- The partner is alive: it did not expire, this side did. It is
      -- CANCELLED, and the note says which.
      UPDATE public.cash_seat_moves
         SET state = CASE WHEN pm.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
             note = CASE WHEN pm.expires_at <= v_now THEN 'own_ttl_expired' ELSE 'swap_partner_expired' END
       WHERE id = pm.id;
    END IF;$new$;
  v_dest_anchor CONSTANT text := $old$  IF ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed') THEN$old$;
  v_dest_repl CONSTANT text := $new$  -- BOTH DESTINATIONS MUST EXIST AND BE OPEN BY STATUS AS WELL (F4, 2026-09-10).
  -- On a record that was never found `ta.lifecycle IN (...)` is NULL, so a
  -- destination that vanished used to pass this test. The single-move gate
  -- has always read status too; this is the same predicate.
  IF ta.id IS NULL OR tb.id IS NULL
     OR ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed')
     OR ta.status NOT IN ('waiting', 'running', 'active')
     OR tb.status NOT IN ('waiting', 'running', 'active') THEN$new$;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_seat_swap_execute_before_maintenance_gate'::regproc);
  v_new := v_src;

  -- Part 2: each side names its own cause. Idempotent on its own marker.
  IF position('own_ttl_expired' in v_new) > 0 THEN
    RAISE NOTICE 'swap gate notes already applied';
  ELSE
    IF position(v_anchor in v_new) = 0 THEN
      RAISE EXCEPTION 'the swap executor refusal is not in the live definition in the shape this migration expects';
    END IF;
    v_new := replace(v_new, v_anchor, v_repl);
  END IF;

  -- Part 3 (F4, lane B section 5): a vanished destination passed the
  -- lifecycle test, because on a NULL record `ta.lifecycle IN (...)` is NULL.
  -- Idempotent on its own marker, independently of part 2.
  IF position('ta.id IS NULL OR tb.id IS NULL' in v_new) > 0 THEN
    RAISE NOTICE 'swap gate destination check already applied';
  ELSE
    IF position(v_dest_anchor in v_new) = 0 THEN
      RAISE EXCEPTION 'the swap executor destination check is not in the live definition in the shape this migration expects';
    END IF;
    v_new := replace(v_new, v_dest_anchor, v_dest_repl);
  END IF;

  IF v_new = v_src THEN
    RETURN;
  END IF;
  IF position('own_ttl_expired' in v_new) = 0
     OR position('swap_partner_expired' in v_new) = 0
     OR position('ta.id IS NULL OR tb.id IS NULL' in v_new) = 0
     OR position('ready_at' in v_new) = 0
     OR position('app.cash_seat_move' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the swap executor went missing in the edit';
  END IF;
  EXECUTE v_new;
END;
$migration$;

DO $assert$
DECLARE v_move text; v_swap text;
BEGIN
  v_move := pg_get_functiondef('public.fn_cash_seat_move_execute_before_maintenance_gate'::regproc);
  v_swap := pg_get_functiondef('public.fn_cash_seat_swap_execute_before_maintenance_gate'::regproc);
  IF position('expired_before_the_executor_reached_it' in v_move) = 0 THEN
    RAISE EXCEPTION 'the move executor still expires without a reason';
  END IF;
  IF position('own_ttl_expired' in v_swap) = 0 OR position('swap_partner_expired' in v_swap) = 0 THEN
    RAISE EXCEPTION 'the swap executor still writes one note for every cause';
  END IF;
  IF position('ta.id IS NULL OR tb.id IS NULL' in v_swap) = 0
     OR position($q$ta.status NOT IN ('waiting', 'running', 'active')$q$ in v_swap) = 0 THEN
    RAISE EXCEPTION 'the swap executor still lets a vanished destination through (F4)';
  END IF;
  -- No expiry path anywhere in the move lifecycle may write `expired` without
  -- also writing a note. Proven by text because the branch is rare in rows.
  IF position($q$SET state = 'expired' WHERE$q$ in v_move) > 0
     OR position($q$SET state = 'expired' WHERE$q$ in v_swap) > 0 THEN
    RAISE EXCEPTION 'an unexplained expiry survives in an executor';
  END IF;
END;
$assert$;

COMMIT;
