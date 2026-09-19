-- ============================================================================
-- THE DIAMOND SEAT GUARDS KNOW A TOURNAMENT SEAT
-- ============================================================================
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL
-- policy). Apply OUTSIDE minute :50-:03 UTC; the break-window event triggers
-- refuse non-temporary DDL inside it and roll the whole transaction back.
--
-- ── WHAT IS WRONG TODAY ─────────────────────────────────────────────────────
--
-- `poker_diamond_custody.purpose` has permitted 'tournament_entry' since
-- 20260909065458, and `fn_poker_diamond_reserve` has priced one since the same
-- day (buy_in_amount + buy_in_fee, gated on `tournaments_enabled` since
-- 20260912112311). Three guards never learned that tournaments exist. All three
-- branch on `clubs.asset = 'diamonds'` and nothing else:
--
--   fn_poker_guard_chip_seat             BEFORE INSERT OR UPDATE OF table_id
--   fn_poker_bind_diamond_seat           AFTER INSERT
--   fn_poker_diamond_seat_keeps_custody  DEFERRABLE CONSTRAINT, both directions
--
-- and between them they assert ONE equation for every Diamond seat:
--
--     table_seats.stack = poker_diamond_custody.balance
--
-- For cash that equation IS the product: the stack a player sits down with is
-- exactly the Diamonds held for that seat, which is why a cash-out can pay the
-- stack and be right. For a tournament it is a category error. The Diamond
-- Money Contract is explicit: "Tournament playing stacks are nonredeemable
-- tournament units. Entry and prize money are diamonds. Tournament units must
-- never become withdrawable diamonds just because the UI uses diamond
-- artwork." A 10,000-unit starting stack under the equation above would demand
-- 10,000 real Diamonds in custody. Phase 8 cannot proceed until the equation
-- is scoped to the seats it is true of.
--
-- ── THE DANGER, WHICH IS THE WHOLE POINT OF THIS MIGRATION ──────────────────
--
-- Today "a Diamond playing stack cannot reach a wallet" is enforced by an
-- ACCIDENT: a Diamond seat IS its custody, so there is no such thing as a
-- stack that is not already real Diamonds. Breaking that equation REMOVES a
-- guard. Removing it without a replacement would leave the arena strictly less
-- safe than it is now.
--
-- So the equation is not merely narrowed. It is replaced, in this same
-- transaction, by a rule stated positively and enforced in both places the old
-- accident covered:
--
--   A DIAMOND TOURNAMENT SEAT IS ADMITTED BY A FUNDED ENTRY, NEVER BY ITS
--   STACK. The stack is a play unit and bears no relation to custody. The
--   money is the ENTRY: one custody row, bound to the tournament and never to
--   a seat, holding exactly what was reserved for it and nothing that play
--   produced.
--
-- WHY THAT IS AT LEAST AS STRONG AS THE ACCIDENT IT REPLACES. The only channel
-- from a playing stack to a wallet was ever "custody.balance follows the stack,
-- and a release pays custody.balance". This migration severs that channel at
-- both ends and says so by name:
--
--   * a tournament entry NEVER carries seat_id / seat_joined_at / occupancy_id,
--     so no code that looks up "the custody for this seat" can find one on a
--     tournament seat (P0813). The old rule allowed that binding; this forbids
--     it;
--   * an entry's balance is, at every commit, EXACTLY the sum of the Diamond
--     movements recorded against it (P0814). A movement is written only by
--     fn_poker_diamond_reserve / fn_poker_diamond_release, each of which
--     journals the wallet, so a stack written into custody has no movement
--     behind it and the transaction aborts. Under the old rule, the stack was
--     REQUIRED to be the balance; under this one, a balance that play moved is
--     refused;
--   * an entry is fixed to the player and the event it paid for (P0815), so an
--     entry cannot be re-pointed at a richer seat, a different player or a
--     different tournament;
--   * every live Diamond tournament seat must be covered by a live funded
--     entry at every commit (P0812), which is the coverage the old arm gave,
--     restated without the stack.
--
-- The balance rule is deliberately "equals its movements" rather than "never
-- changes". Phase 8 also has to carry re-entry, rebuy and add-on, and those are
-- real money arriving through the reserve door. A rule of "never changes" would
-- have forced the next agent to weaken this one. "Only what was reserved for
-- it" forbids exactly what play could do and nothing a funded movement does.
--
-- ── THE CONTRACT THIS SETS FOR THE ENTRY DOOR THAT DOES NOT EXIST YET ───────
--
-- fn_poker_diamond_reserve writes a tournament_entry custody row in state
-- 'reserved'. The guards below require state 'active'. So the entry function,
-- when it is written, must activate the entry as part of registering the
-- player, BEFORE any seat exists. That is the tournament mirror of what
-- fn_poker_bind_diamond_seat does for cash, moved to where the money is: at
-- the entry, not at the seat. Until it exists, and while
-- `ca_arena_settings.tournaments_enabled` is false, a Diamond tournament seat
-- is refused by name at three doors rather than by accident at one.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
--
-- It opens nothing. `tournaments_enabled` is not touched and stays false,
-- `cash_games_enabled` is not touched, no custody row is written, no money
-- moves, and no cash behaviour changes: the cash branch of every guard is the
-- live text, sliced out and put back unaltered, and asserted afterwards. There
-- is no repair job, sweep, backfill or reconciler here; every new rule is a
-- refusal on the live path (CLAUDE.md 10.11, 10.12). No new wall-clock deadline
-- is introduced, so section 13's thaw list is unchanged.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. THE BOARD HAS NOT MOVED UNDERNEATH THIS.
--
--    Every rewrite below slices an anchored clause out of the LIVE definition
--    rather than retyping it, so the exact text matters. These are the md5s of
--    pg_get_functiondef as measured on 2026-09-13; if any of them has changed,
--    the anchors are not what this migration was written against and it must
--    abort rather than guess.
--
--    The watchlist is pinned by MEMBERSHIP instead of by hash, because what
--    matters there is that no name is lost, and a reformat is not a change.
--    An added name is: this migration would silently drop it, so it refuses
--    and says which one.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  v_missing text := '';
  v_list text[];
  v_name text;
  c_expected constant text[] := ARRAY[
    'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
    'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
    'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
    'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
    'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
    'fn_ca_journal_append_only','fn_ca_is_midway_scope',
    'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
    'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
    'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
    'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
    'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
    'fn_ca_post_correction','fn_ca_repair_write_failure',
    'fn_poker_diamond_reserve','fn_poker_diamond_release',
    'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
    'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
    'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
    'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
    'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
    'fn_ca_guard_watchlist'];
BEGIN
  IF (SELECT md5(pg_get_functiondef('public.fn_poker_guard_chip_seat()'::regprocedure)))
     IS DISTINCT FROM '63c4678ff882ce5712bce692a46bcc2d' THEN
    RAISE EXCEPTION 'diamond_seat_guard_prerequisite_changed:fn_poker_guard_chip_seat()';
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_poker_bind_diamond_seat()'::regprocedure)))
     IS DISTINCT FROM 'e17ef6b101b7035c71950e0ffd4bbfbc' THEN
    RAISE EXCEPTION 'diamond_seat_guard_prerequisite_changed:fn_poker_bind_diamond_seat()';
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_poker_diamond_seat_keeps_custody()'::regprocedure)))
     IS DISTINCT FROM 'd92a8e88ba54a6a09f673b975e752924' THEN
    RAISE EXCEPTION 'diamond_seat_guard_prerequisite_changed:fn_poker_diamond_seat_keeps_custody()';
  END IF;

  -- The watched guard whose baseline this migration is about to move must be
  -- sitting ON that baseline now. If it is already adrift, somebody else has an
  -- open notice about it and declaring this change would close theirs silently.
  IF (SELECT def_hash FROM public.ca_guard_defs WHERE proname='fn_poker_diamond_seat_keeps_custody')
     IS DISTINCT FROM 'd92a8e88ba54a6a09f673b975e752924' THEN
    RAISE EXCEPTION 'fn_poker_diamond_seat_keeps_custody is not on its recorded baseline; that notice belongs to whoever moved it';
  END IF;

  v_list := public.fn_ca_guard_watchlist();
  IF array_length(v_list, 1) <> 41 THEN
    RAISE EXCEPTION 'the guard watchlist holds % names, this migration was written against 41', array_length(v_list, 1);
  END IF;
  FOREACH v_name IN ARRAY c_expected LOOP
    IF NOT (v_name = ANY(v_list)) THEN v_missing := v_missing || ' ' || v_name; END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'the guard watchlist no longer names:%', v_missing;
  END IF;

  -- Nothing has ever written a tournament entry, and nothing may be holding one
  -- when the rules about it change.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody WHERE purpose='tournament_entry') THEN
    RAISE EXCEPTION 'a tournament_entry custody row exists already; this migration assumed none did';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'the Diamond tournament switch is already ON; these guards must be in place before it opens';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. THE ADMISSION GUARD (BEFORE INSERT OR UPDATE OF table_id).
--
--    The cash block is sliced out whole and put back character for character
--    inside the new IS NULL branch, so the cash rule cannot drift while this
--    edit is made. The tournament branch is new, and it asks two questions the
--    cash branch has no use for:
--
--      P0810  is there a funded, live entry for THIS player and THIS event,
--             in an arena whose tournament switch is open;
--      P0811  and, when the seat is MOVING, is it moving inside that event.
--
--    The second is what the deleted `TG_OP<>'INSERT'` used to cover by refusing
--    every move outright. A cash seat still may not move: its custody is bound
--    to that seat at that table. A tournament seat MUST be able to move, because
--    balancing is how a tournament is dealt, and its entry survives the move
--    precisely because the entry was never bound to the seat. What must not
--    survive is a move into a DIFFERENT tournament, which would carry one
--    event's paid entry onto another event's felt.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_hits integer;
  c_a constant text := $a$ IF TG_OP<>'INSERT' OR NOT EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
   WHERE c.user_id=NEW.user_id AND c.target_id=NEW.table_id AND c.purpose='cash_seat'
     AND c.entry_key='seat:'||NEW.id AND c.state='reserved' AND c.balance=NEW.stack
     AND c.seat_id IS NULL AND a.cash_games_enabled
 ) THEN
   RAISE EXCEPTION 'Diamond Seat Requires Atomic Custody Funding' USING ERRCODE='23514';
 END IF;$a$;
BEGIN
  SELECT pg_get_functiondef('public.fn_poker_guard_chip_seat()'::regprocedure) INTO v_old;
  IF position('tournament_entry' in v_old) > 0 THEN
    RAISE NOTICE 'the admission guard already knows a tournament seat; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_old) - length(replace(v_old, c_a, ''))) / length(c_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'admission guard: cash block matched % times, expected 1', v_hits;
  END IF;

  v_new := replace(v_old, c_a, $r$ IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) IS NULL THEN
   /* A CASH SEAT IS ITS CUSTODY. The stack a player sits down with IS the
      Diamonds held for that seat, which is why a cash-out can pay the stack.
      This block is the live rule, unchanged. */
   IF TG_OP<>'INSERT' OR NOT EXISTS (
     SELECT 1 FROM public.poker_diamond_custody c
       JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
     WHERE c.user_id=NEW.user_id AND c.target_id=NEW.table_id AND c.purpose='cash_seat'
       AND c.entry_key='seat:'||NEW.id AND c.state='reserved' AND c.balance=NEW.stack
       AND c.seat_id IS NULL AND a.cash_games_enabled
   ) THEN
     RAISE EXCEPTION 'Diamond Seat Requires Atomic Custody Funding' USING ERRCODE='23514';
   END IF;
 ELSE
   /* A TOURNAMENT SEAT IS NOT ITS CUSTODY. The stack is a nonredeemable play
      unit; the money is the ENTRY, held against the tournament. So the seat is
      admitted by a funded live entry and by NO equation with the stack. */
   IF NOT EXISTS (
     SELECT 1 FROM public.tables t
       JOIN public.poker_diamond_custody c ON c.target_id=t.tournament_id
        AND c.user_id=NEW.user_id AND c.arena_id=t.club_id
        AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL
       JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
     WHERE t.id=NEW.table_id AND a.tournaments_enabled
   ) THEN
     RAISE EXCEPTION 'Diamond Tournament Seat Requires A Funded Entry' USING ERRCODE='P0810';
   END IF;
   /* One entry buys one event. Balancing may move the seat from table to table
      inside that event, and nowhere else. */
   IF TG_OP='UPDATE' THEN
     IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=OLD.table_id)
        IS DISTINCT FROM (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) THEN
       RAISE EXCEPTION 'A Diamond Tournament Seat Moves Only Inside Its Own Tournament'
         USING ERRCODE='P0811';
     END IF;
   END IF;
 END IF;$r$);

  IF v_new = v_old
     OR position('Diamond Tournament Seat Requires A Funded Entry' in v_new) = 0
     OR position('A Diamond Tournament Seat Moves Only Inside Its Own Tournament' in v_new) = 0
     OR position('Diamond Seat Requires Atomic Custody Funding' in v_new) = 0
     OR position('a.cash_games_enabled' in v_new) = 0 THEN
    RAISE EXCEPTION 'admission guard: rewrite did not take, or lost the cash rule';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 2. THE BINDER (AFTER INSERT).
--
--    A cash seat is bound to its custody here: seat_id, seat_joined_at,
--    occupancy_id and state='active' are stamped onto the reserved row, and a
--    ROW_COUNT of anything but 1 refuses the seat.
--
--    A TOURNAMENT ENTRY IS NEVER BOUND TO A SEAT, and that is not an omission
--    to be filled in later: it is the mechanism. Nothing seat-shaped exists on
--    the row, so there is nothing to re-point when the player is moved,
--    balanced or re-seated, and one entry covers every seat that player takes
--    for the life of the event. Seating therefore asserts the entry and leaves
--    custody exactly as the entry door left it.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_hits integer;
  -- The anchor is the WHOLE cash binding statement, terminator included. A
  -- fragment that stopped at the SET clause would put half an UPDATE in this
  -- file, and `scripts/ci/check-unqualified-writes.mjs` would read it - quite
  -- correctly - as an UPDATE with no WHERE.
  c_a constant text := $a$ UPDATE public.poker_diamond_custody
   SET seat_id=NEW.id,seat_joined_at=NEW.joined_at,occupancy_id=NEW.occupancy_id,state='active'
   WHERE user_id=NEW.user_id AND target_id=NEW.table_id AND purpose='cash_seat'
     AND entry_key='seat:'||NEW.id AND state='reserved' AND balance=NEW.stack AND seat_id IS NULL;$a$;
BEGIN
  SELECT pg_get_functiondef('public.fn_poker_bind_diamond_seat()'::regprocedure) INTO v_old;
  IF position('tournament_entry' in v_old) > 0 THEN
    RAISE NOTICE 'the binder already knows a tournament seat; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_old) - length(replace(v_old, c_a, ''))) / length(c_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'binder: custody update anchor matched % times, expected 1', v_hits;
  END IF;

  v_new := replace(v_old, c_a, $r$ /* A TOURNAMENT ENTRY BINDS ITS CUSTODY TO THE ENTRY, NEVER TO A SEAT. That
    is what lets one entry survive a table move, a balance and a re-seat: there
    is nothing seat-shaped on the row to re-point. Seating asserts the entry and
    touches no custody at all. */
 IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) IS NOT NULL THEN
   IF NOT EXISTS (
     SELECT 1 FROM public.tables t
       JOIN public.poker_diamond_custody c ON c.target_id=t.tournament_id
        AND c.user_id=NEW.user_id AND c.arena_id=t.club_id
        AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL
     WHERE t.id=NEW.table_id
   ) THEN
     RAISE EXCEPTION 'Diamond Tournament Seat Requires A Funded Entry' USING ERRCODE='P0810';
   END IF;
   RETURN NULL;
 END IF;
 UPDATE public.poker_diamond_custody
   SET seat_id=NEW.id,seat_joined_at=NEW.joined_at,occupancy_id=NEW.occupancy_id,state='active'
   WHERE user_id=NEW.user_id AND target_id=NEW.table_id AND purpose='cash_seat'
     AND entry_key='seat:'||NEW.id AND state='reserved' AND balance=NEW.stack AND seat_id IS NULL;$r$);

  IF v_new = v_old
     OR position('Diamond Tournament Seat Requires A Funded Entry' in v_new) = 0
     OR position('diamond_seat_custody_binding_failed' in v_new) = 0
     OR position($c$purpose='cash_seat'$c$ in v_new) = 0 THEN
    RAISE EXCEPTION 'binder: rewrite did not take, or lost the cash binding';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 3. THE COMMIT-TIME INVARIANT (DEFERRABLE CONSTRAINT TRIGGER, both
--    directions).
--
--    Before: every ACTIVE custody row had to match a live seat on stack, and
--    every live Diamond seat had to have such a custody. One equation, applied
--    to every Diamond seat there is.
--
--    After: that equation is the CASH rule, said so, and the tournament rule is
--    its own arm saying what is true there instead. The arms are disjoint by
--    `tables.tournament_id`, so no live Diamond seat has lost a rule; each now
--    has the rule that is true of it.
--
--      arm A  an active CASH custody matches its live seat, stack included
--      arm B  a live seat at a Diamond CASH table has such a custody
--      arm C  a live seat at a Diamond TOURNAMENT table is covered by a live
--             funded entry for that event, and the stack is not mentioned
--
--    Arm A gains `purpose='cash_seat'` and arm B's inner lookup gains it too.
--    Neither is a weakening: a tournament entry carrying a seat binding at all
--    is refused outright by section 4, so there is no row those clauses could
--    have caught that section 4 does not refuse harder.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_hits integer;
  c_a constant text := $a$   WHERE c.seat_id=ANY(v_ids) AND c.state='active'
$a$;
  c_b constant text := $b$ ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;$b$;
BEGIN
  SELECT pg_get_functiondef('public.fn_poker_diamond_seat_keeps_custody()'::regprocedure) INTO v_old;
  IF position('tournament_entry' in v_old) > 0 THEN
    RAISE NOTICE 'the seat/custody invariant already knows a tournament seat; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_old) - length(replace(v_old, c_a, ''))) / length(c_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'seat/custody invariant: arm A anchor matched % times, expected 1', v_hits;
  END IF;
  v_new := replace(v_old, c_a, $r$   WHERE c.seat_id=ANY(v_ids) AND c.state='active' AND c.purpose='cash_seat'
$r$);

  v_hits := (length(v_new) - length(replace(v_new, c_b, ''))) / length(c_b);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'seat/custody invariant: arm B anchor matched % times, expected 1', v_hits;
  END IF;
  v_new := replace(v_new, c_b, $r$ ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.purpose='cash_seat' AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 /* A DIAMOND TOURNAMENT SEAT HOLDS AN ENTRY, NOT A BALANCE. The stack is a
    nonredeemable play unit and bears no relation to custody, so nothing in
    this arm compares it to anything. What must be true at every commit is that
    the seat is covered by a live funded entry for THIS event, held against the
    tournament and not against the seat. */
 IF EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.user_id=s.user_id AND c.target_id=t.tournament_id AND c.arena_id=s.club_id
         AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL)
 ) THEN
   RAISE EXCEPTION 'A Diamond Tournament Seat Must Hold Its Funded Entry' USING ERRCODE='P0812';
 END IF;
 RETURN NULL;$r$);

  IF v_new = v_old
     OR position('A Diamond Tournament Seat Must Hold Its Funded Entry' in v_new) = 0
     OR position('diamond_seat_and_custody_must_commit_together' in v_new) = 0
     OR position('s.stack=c.balance' in v_new) = 0
     OR position('c.balance=s.stack' in v_new) = 0 THEN
    RAISE EXCEPTION 'seat/custody invariant: rewrite did not take, or lost the cash equation';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 4. THE REPLACEMENT FOR THE ACCIDENT: AN ENTRY IS THE ENTRY.
--
--    Sections 1 to 3 stopped requiring stack = balance on a tournament seat.
--    This is what stands in its place, and it is the half that makes the change
--    a narrowing rather than a hole. Three refusals, at every commit, for every
--    tournament_entry custody row:
--
--      P0813  it never carries a seat binding. Nothing that looks up "the
--             custody for this seat" can ever find a tournament entry, which is
--             what closes fn_poker_diamond_cashout and fn_poker_diamond_release
--             against a playing stack by construction rather than by check.
--      P0814  its balance equals the sum of the Diamond movements recorded
--             against it. Movements are append-only, service-only, and written
--             only by the reserve and release doors, each of which journals the
--             wallet. A balance that play produced has no movement behind it
--             and the transaction aborts at commit.
--      P0815  it is fixed to the player and the event it paid for.
--
--    DEFERRED, because the reserve door inserts the custody row before the
--    movement row that pays for it, and both are one transaction. Checking at
--    statement time would refuse the legitimate order of writes.
--
--    This is a refusal, not a detector: it aborts the transaction that broke
--    the rule, at the moment it breaks it. Nothing here repairs, sweeps,
--    back-fills or reconciles anything (CLAUDE.md 10.12). Its reader is the
--    writer, immediately; its drift is watched by fn_ca_guard_defs_watch,
--    because section 5 puts it on the watchlist.
--
--    `poker_diamond_custody` is not one of the nine tables
--    `fn_undeclared_money_triggers` watches, so this trigger is not registered
--    in ca_declared_money_triggers; it is declared here, in the migration that
--    creates it, and pinned by a law.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_moved bigint;
BEGIN
 -- OLD is only touched inside the UPDATE branch; a BEFORE/AFTER INSERT has none.
 IF TG_OP='UPDATE' THEN
   IF OLD.purpose='tournament_entry' OR NEW.purpose='tournament_entry' THEN
     IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.target_id IS DISTINCT FROM OLD.target_id
        OR NEW.arena_id IS DISTINCT FROM OLD.arena_id
        OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
        OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
       RAISE EXCEPTION 'A Diamond Tournament Entry Is Fixed To The Player And Event It Paid For'
         USING ERRCODE='P0815';
     END IF;
   END IF;
 END IF;
 IF NEW.purpose <> 'tournament_entry' THEN RETURN NULL; END IF;

 IF NEW.seat_id IS NOT NULL OR NEW.seat_joined_at IS NOT NULL OR NEW.occupancy_id IS NOT NULL THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Never Binds To A Seat' USING ERRCODE='P0813';
 END IF;

 SELECT COALESCE(sum(CASE WHEN m.action='reserve' THEN m.amount ELSE -m.amount END),0)
   INTO v_moved FROM public.poker_diamond_movements m WHERE m.custody_id=NEW.id;
 IF NEW.balance IS DISTINCT FROM v_moved THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Holds Only What Was Reserved For It'
     USING ERRCODE='P0814';
 END IF;

 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry()
 FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS zzz_diamond_entry_custody_is_the_entry ON public.poker_diamond_custody;
CREATE CONSTRAINT TRIGGER zzz_diamond_entry_custody_is_the_entry
 AFTER INSERT OR UPDATE ON public.poker_diamond_custody DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry();

-- ---------------------------------------------------------------------------
-- 5. EVERY GUARD TOUCHED HERE IS WATCHED, AND EVERY MOVE IS DECLARED.
--
--    20260912122636 put the eight Diamond money doors on fn_ca_guard_watchlist
--    because "each one is the only thing standing between a tournament stack
--    and a wallet, and none of them was watched". Two of the three seat guards
--    were not on that list, and the entry rule in section 4 did not exist. All
--    three go on it now: a guard that can be redefined without anybody noticing
--    is not a guard.
--
--    The 41 existing names are reproduced exactly and nothing leaves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors. Each one is the only thing standing between a
      -- tournament stack and a wallet, and none of them was watched.
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules Phase 8 installed. A live redefinition of any of these
      -- un-snaps every divide in the tournament path with every test green.
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The three seat guards that decide whether a Diamond seat is a cash seat
      -- or a tournament seat. Redefine any one of them back to a single
      -- stack = balance equation and a playing stack becomes real Diamonds.
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- And the list itself, because a watchlist nobody watches can be
      -- shortened as easily as the guards it names.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;

DO $do$
DECLARE
  v_name text;
  c_declared constant text[] := ARRAY[
    'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
    'fn_poker_diamond_seat_keeps_custody',
    'fn_poker_diamond_entry_custody_is_the_entry','fn_ca_guard_watchlist'];
BEGIN
  -- The declaration door refuses a name that is not on the list and a guard
  -- that does not exist, so this is also the second proof that the widening
  -- above did what it says.
  FOREACH v_name IN ARRAY c_declared LOOP
    PERFORM public.fn_ca_declare_guard_redefinition(
      v_name, 'migration the_diamond_seat_guards_know_a_tournament_seat');
  END LOOP;
  RAISE NOTICE 'guard watchlist: % baseline(s) declared by this migration', array_length(c_declared, 1);
END;
$do$;

-- ---------------------------------------------------------------------------
-- 6. THE CASH RULE SURVIVED, THE TOURNAMENT RULE IS REAL, THE WATCHER HAS
--    NOTHING TO SAY, AND NOTHING WAS OPENED.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_admit text; v_bind text; v_keep text; v_entry text;
  v_list text[]; v_name text; v_lost text := ''; v_hash text;
  v_from integer; v_to integer;
  v_unbaselined text := ''; v_drifting text := ''; v_undeclared text := '';
  c_declared constant text[] := ARRAY[
    'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
    'fn_poker_diamond_seat_keeps_custody',
    'fn_poker_diamond_entry_custody_is_the_entry','fn_ca_guard_watchlist'];
  c_original constant text[] := ARRAY[
    'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
    'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
    'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
    'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
    'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
    'fn_ca_journal_append_only','fn_ca_is_midway_scope',
    'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
    'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
    'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
    'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
    'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
    'fn_ca_post_correction','fn_ca_repair_write_failure',
    'fn_poker_diamond_reserve','fn_poker_diamond_release',
    'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
    'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
    'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
    'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
    'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
    'fn_ca_guard_watchlist'];
BEGIN
  SELECT pg_get_functiondef('public.fn_poker_guard_chip_seat()'::regprocedure) INTO v_admit;
  SELECT pg_get_functiondef('public.fn_poker_bind_diamond_seat()'::regprocedure) INTO v_bind;
  SELECT pg_get_functiondef('public.fn_poker_diamond_seat_keeps_custody()'::regprocedure) INTO v_keep;
  SELECT pg_get_functiondef('public.fn_poker_diamond_entry_custody_is_the_entry()'::regprocedure)
    INTO v_entry;

  -- THE CASH RULE IS UNTOUCHED. Every clause the cash seat depends on is still
  -- in all three functions, including the equation itself.
  IF position('Diamond Seat Requires Atomic Custody Funding' in v_admit) = 0
     OR position('a.cash_games_enabled' in v_admit) = 0
     OR position('c.balance=NEW.stack' in v_admit) = 0
     OR position($q$TG_OP<>'INSERT'$q$ in v_admit) = 0 THEN
    RAISE EXCEPTION 'the cash admission rule was disturbed';
  END IF;
  IF position('diamond_seat_custody_binding_failed' in v_bind) = 0
     OR position('seat_id=NEW.id,seat_joined_at=NEW.joined_at,occupancy_id=NEW.occupancy_id' in v_bind) = 0
     OR position('balance=NEW.stack' in v_bind) = 0 THEN
    RAISE EXCEPTION 'the cash binding was disturbed';
  END IF;
  IF position('diamond_seat_and_custody_must_commit_together' in v_keep) = 0
     OR position('s.stack=c.balance' in v_keep) = 0
     OR position('c.balance=s.stack' in v_keep) = 0 THEN
    RAISE EXCEPTION 'the cash seat/custody equation was disturbed';
  END IF;

  -- THE TOURNAMENT RULE IS REAL, and each refusal names itself.
  IF position('P0810' in v_admit) = 0 OR position('P0811' in v_admit) = 0
     OR position($q$c.purpose='tournament_entry' AND c.state='active'$q$ in v_admit) = 0
     OR position('a.tournaments_enabled' in v_admit) = 0 THEN
    RAISE EXCEPTION 'the admission guard does not admit a tournament seat by its entry';
  END IF;
  IF position('P0810' in v_bind) = 0 THEN
    RAISE EXCEPTION 'the binder does not assert the entry it refuses to bind';
  END IF;
  -- AND IT NEVER BINDS ONE. The only seat binding written anywhere is the cash
  -- one, inside the branch this migration put a tournament seat in front of.
  IF (length(v_bind) - length(replace(v_bind, 'SET seat_id=', ''))) / length('SET seat_id=') <> 1 THEN
    RAISE EXCEPTION 'the binder writes a seat binding more than once';
  END IF;
  IF position('P0812' in v_keep) = 0
     OR position($q$c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL$q$ in v_keep) = 0 THEN
    RAISE EXCEPTION 'the commit-time invariant does not cover a tournament seat';
  END IF;
  -- AND NEITHER TOURNAMENT BRANCH MENTIONS THE STACK. Each window runs from
  -- the branch's own discriminator to its own refusal, never for a fixed number
  -- of characters, so it grows with the code it guards. A stack comparison
  -- anywhere inside one would be the equation coming back under a new name.
  v_from := position('t.tournament_id IS NOT NULL' in v_keep);
  v_to := position('P0812' in v_keep);
  IF v_from = 0 OR v_to <= v_from THEN
    RAISE EXCEPTION 'the tournament arm of the commit-time invariant cannot be located';
  END IF;
  IF position('stack' in substr(v_keep, v_from, v_to - v_from)) > 0 THEN
    RAISE EXCEPTION 'the tournament arm compares a playing stack to custody';
  END IF;

  v_from := position($q$c.purpose='tournament_entry'$q$ in v_admit);
  v_to := position('P0811' in v_admit);
  IF v_from = 0 OR v_to <= v_from THEN
    RAISE EXCEPTION 'the tournament branch of the admission guard cannot be located';
  END IF;
  IF position('stack' in substr(v_admit, v_from, v_to - v_from)) > 0 THEN
    RAISE EXCEPTION 'the admission guard admits a tournament seat by its stack';
  END IF;
  IF position('P0813' in v_entry) = 0 OR position('P0814' in v_entry) = 0
     OR position('P0815' in v_entry) = 0
     OR position('poker_diamond_movements' in v_entry) = 0 THEN
    RAISE EXCEPTION 'the entry rule does not carry its three refusals';
  END IF;

  -- The entry rule is armed, deferred, and closed to a browser.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='poker_diamond_custody'
       AND g.tgname='zzz_diamond_entry_custody_is_the_entry'
       AND NOT g.tgisinternal AND g.tgdeferrable AND g.tginitdeferred) THEN
    RAISE EXCEPTION 'the entry rule is not armed as a deferred constraint trigger';
  END IF;
  IF has_function_privilege('anon','public.fn_poker_diamond_entry_custody_is_the_entry()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_poker_diamond_entry_custody_is_the_entry()','EXECUTE') THEN
    RAISE EXCEPTION 'the entry rule is executable by anon or authenticated';
  END IF;

  -- THE WATCHLIST GREW AND NOTHING LEFT IT.
  v_list := public.fn_ca_guard_watchlist();
  FOREACH v_name IN ARRAY c_original LOOP
    IF NOT (v_name = ANY(v_list)) THEN v_lost := v_lost || ' ' || v_name; END IF;
  END LOOP;
  IF v_lost <> '' THEN
    RAISE EXCEPTION 'widening the watchlist dropped:%', v_lost;
  END IF;
  FOREACH v_name IN ARRAY ARRAY['fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
                                'fn_poker_diamond_entry_custody_is_the_entry'] LOOP
    IF NOT (v_name = ANY(v_list)) THEN
      RAISE EXCEPTION 'the watchlist does not name %', v_name;
    END IF;
  END LOOP;
  IF array_length(v_list, 1) <> 44 THEN
    RAISE EXCEPTION 'the watchlist holds % names, expected 44', array_length(v_list, 1);
  END IF;

  -- THE WATCHER HAS NOTHING TO SAY ABOUT THE FIVE THIS MIGRATION MOVED. A name
  -- it did NOT move that is already off its baseline is somebody else's open
  -- notice; this neither closes it nor asserts it away.
  FOREACH v_name IN ARRAY v_list LOOP
    SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
      INTO v_hash
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION 'watched function % does not exist', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_guard_defs WHERE proname = v_name) THEN
      v_unbaselined := v_unbaselined || ' ' || v_name;
    ELSIF v_name = ANY(c_declared) THEN
      IF (SELECT def_hash FROM public.ca_guard_defs WHERE proname = v_name) <> v_hash THEN
        v_drifting := v_drifting || ' ' || v_name;
      END IF;
      IF (SELECT declared_ref FROM public.ca_guard_defs WHERE proname = v_name)
         IS DISTINCT FROM 'migration the_diamond_seat_guards_know_a_tournament_seat' THEN
        v_undeclared := v_undeclared || ' ' || v_name;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.ca_guard_def_history
                      WHERE proname = v_name AND def_hash = v_hash) THEN
        RAISE EXCEPTION 'the text of % was not kept, so a later notice would have nothing to diff against', v_name;
      END IF;
    END IF;
  END LOOP;
  IF v_unbaselined <> '' THEN
    RAISE EXCEPTION 'these watched functions have no baseline:%', v_unbaselined;
  END IF;
  IF v_drifting <> '' THEN
    RAISE EXCEPTION 'these declared functions are not on the baseline this migration recorded:%', v_drifting;
  END IF;
  IF v_undeclared <> '' THEN
    RAISE EXCEPTION 'these functions were not baselined by this migration:%', v_undeclared;
  END IF;
  IF has_function_privilege('anon','public.fn_ca_guard_watchlist()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_ca_guard_watchlist()','EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_guard_watchlist became executable by anon or authenticated; CREATE OR REPLACE was expected to keep its grants';
  END IF;

  -- NOTHING WAS OPENED AND NOTHING WAS WRITTEN.
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'the Diamond tournament switch is ON; this migration must not open it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody WHERE purpose='tournament_entry') THEN
    RAISE EXCEPTION 'a tournament_entry custody row was written; this migration writes none';
  END IF;

  RAISE NOTICE 'diamond seat guards: cash unchanged, tournament admitted by its entry, 44 watched, door still shut';
END;
$do$;

COMMIT;
