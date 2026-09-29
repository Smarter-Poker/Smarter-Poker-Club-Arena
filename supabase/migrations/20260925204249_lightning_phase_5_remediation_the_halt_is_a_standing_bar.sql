-- 20260925204249_lightning_phase_5_remediation_the_halt_is_a_standing_bar.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
-- WHAT THIS CHANGES, AND WHY
-- ===========================================================================
--
-- THE HALT WAS A ONE-SHOT CANCEL AND THE SPECIFICATION ASKED FOR A STANDING
-- BAR. This is the finding that made this file necessary, and it is worth
-- stating as a sequence of seconds rather than as a design opinion.
--
--   t+0    fn_cash_cluster_begin_pending_on moves the Cluster to PENDING_ON,
--          stops every member table dealing, and cancels the pending
--          cash_seat_moves rows that were outstanding AT THAT INSTANT. That
--          cancellation is correct and it is also the whole of the defence.
--   t+1    a player taps "seat change". fn_cash_seat_change_request is
--          SECURITY DEFINER and is granted to `authenticated`, so the tap
--          reaches the database with no engine in the way. It locks the
--          Cluster row, and the ONLY thing it asks about the Cluster is
--          `IF NOT g.must_move` - the boolean CAPABILITY, which says this is
--          a must-move game rather than a manual one, and which stays true
--          through a conversion from end to end. It then calls
--          fn_cash_seat_change_plan, which INSERTs a fresh pending
--          cash_seat_moves row.
--   t+2    the tick is standing down (20260921151618 saw to that) and the
--          balancer is standing down, so nothing reconciles that move. It
--          simply sits there, pending.
--   t+n    the engine's start-up wait loop - the one that never re-reads its
--          table row, and so can neither see the halt set nor see it lifted -
--          runs executeIdleSeatMoves() and executes it, writing table_seats
--          in the middle of a conversion whose entire safety argument is that
--          table_seats does not move.
--
-- Neither function's body mentioned `cluster_mode` or `dealing_halted_at`.
-- Step 6 of the specification is "stop starting new nonessential table
-- assignments that would conflict with conversion", and "stop starting" is a
-- standing bar for the length of the conversion, not one cancellation at the
-- start of it.
--
-- WHERE THE BAR GOES, AND WHERE IT DELIBERATELY DOES NOT. There are 49
-- functions in this schema that write table_seats. Barring all of them would
-- mean a trigger on table_seats, which is a MONEY_TABLE - a new trigger there
-- has to be declared in ca_declared_money_triggers and is gated by
-- scripts/ci/check-money-trigger-declared.mjs - and it would bar the engine's
-- own seating, which is the thing that has to keep working. So the bar goes in
-- exactly TWO places, chosen because they are the two ends of the one path
-- that can create a cluster seat assignment while a conversion is open:
--
--   fn_cash_seat_change_request  - THE DOOR. It refuses out loud, with a named
--     error, so the player is told the game is changing format rather than
--     being silently ignored. It is the only one of the two that a browser can
--     reach, and it is the one the audit found.
--
--   fn_cash_seat_change_plan     - THE WRITER. It is the function that actually
--     INSERTs the cash_seat_moves row, and it returns 0 having planned nothing.
--     It does not raise, because the tick calls it and the tick must not start
--     erroring; it stands down exactly as the tick and the balancer already do,
--     on exactly the predicate they already use.
--
-- BOTH USE `cluster_mode IS DISTINCT FROM 'must_move'`, which is not a new
-- rule: it is verbatim the guard 20260921151618 substituted into
-- fn_cash_cluster_tick and fn_cash_cluster_balance. cash_games.cluster_mode is
-- NOT NULL DEFAULT 'must_move', so IS DISTINCT FROM is belt and braces rather
-- than a NULL defence, and it is written that way so that all four guards read
-- identically and a reader comparing them finds no difference to wonder about.
--
-- THE THREE WRITERS THAT ARE LEFT ALONE, AND WHY, because a bar whose scope is
-- not stated is a bar somebody widens next year:
--
--   trg_table_scope_cascade is reachable by `authenticated` and does write
--     table_seats. It propagates tables.seat_game_scope to
--     table_seats.active_game_scope when the scope LABEL changes. It moves
--     nobody, seats nobody, vacates nobody and touches no stack. A conversion
--     has no opinion about it.
--
--   process_tournament_rebuy is reachable by `authenticated` and does write
--     table_seats, and a tournament table has cluster_id NULL. cash_games.
--     cluster_mode is a cash-cluster state; there is no cluster to be
--     converting. Tournaments are a different subsystem and stay one.
--
--   fn_cash_game_join is not barred either, and that is a decision rather than
--     an oversight: acceptance test F14 requires that a player joining between
--     PENDING_ON and the commit is COUNTED and enters the pool, and
--     20260921151618's own harness proves exactly that. Admission is not a
--     table assignment that conflicts with the conversion; it is the
--     population the conversion is measuring.
--
-- ===========================================================================
-- A STUCK PENDING_ON WAS UNRECOVERABLE, AND NOW IT IS REAPED
-- ===========================================================================
--
-- fn_cash_cluster_commit_lightning can leave a Cluster in PENDING_ON in four
-- ways. It returns `hands_in_flight` without aborting, by design, because the
-- caller is expected to poll. And its three RAISE EXCEPTION paths -
-- LIGHTNING_CONVERSION_MOVED_MONEY, LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND
-- and LIGHTNING_CONVERSION_STRANDED_A_PLAYER - roll the whole transaction back,
-- which leaves the mode at pending_on, every member table halted, and the
-- conversion row `pending`, because those writes were the ones undone.
--
-- In pending_on the tick stands down and the balancer stands down, so nothing
-- in the estate reaps it. fn_cash_cluster_abort_pending_on, which is exactly
-- the cure, had no caller anywhere in SQL or TypeScript. The result is a
-- Cluster whose every table has stopped dealing until a human notices.
--
-- So: fn_cash_cluster_reap_stuck_conversions, called once a pass from
-- fn_cash_clusters_tick_all - the estate-wide driver, which is the thing that
-- keeps running precisely BECAUSE the per-Cluster tick stood down.
--
-- FIFTEEN MINUTES, AND HERE IS THE ARITHMETIC RATHER THAN THE TASTE. The only
-- legitimate reason a conversion sits in PENDING_ON is the conversion-safe
-- hand boundary at step 9. The halt means no new hand starts, so the set of
-- in-flight hands only shrinks; a real no-limit hand at a nine-handed table
-- finishes inside three minutes even with the longest shot clock this platform
-- offers. Fifteen minutes is five times that.
--
-- At the other end sits the six-hour window commit_lightning uses to decide a
-- hand_history row with ended_at NULL is abandoned rather than live. A
-- conversion blocked by a row left behind by a crashed engine waits the full
-- six hours - and waits with every table of that Cluster not dealing. That is
-- far worse than aborting: an abort is two columns and a record, the Cluster
-- goes straight back to MUST_MOVE and deals again, and 20260921151618's own
-- section 19 proves a Cluster whose conversion was aborted is still genuinely
-- convertible under a fresh request id. So the reaper must fire well inside
-- six hours, and fifteen minutes is one twenty-fourth of it.
--
-- The reaper is NOT gated on fn_platform_frozen(), for the same reason
-- fn_cash_cluster_abort_pending_on is not: leaving a half-converted Cluster
-- must always be possible. It is nevertheless placed AFTER tick_all's own
-- freeze short-circuit, so during a maintenance break it does not run at all -
-- and that costs nothing, because during the break no table is dealing
-- anywhere, so a Cluster stuck in PENDING_ON is indistinguishable from its
-- neighbours until the break lifts, and the first pass afterwards reaps it.
-- tick_all's promise that a frozen platform costs one row read survives.
--
-- It is bounded three ways: at most p_limit conversions a pass (50), oldest
-- first, and the whole call is wrapped in a sub-block in tick_all so that a
-- lock wait - tick_all sets lock_timeout to 2000ms - costs the reap and not
-- the pass.
--
-- ===========================================================================
-- ONE DEFINITION OF CLUSTER MEMBERSHIP, AT LAST
-- ===========================================================================
--
-- 20260921151618 re-cut fn_cash_cluster_live_eligible and
-- fn_cash_cluster_population onto `coalesce(is_deleted, false) = false AND
-- coalesce(tb.lifecycle, '') <> 'closed'`, because tables.status and
-- tables.lifecycle are both nullable and a CHECK that evaluates to NULL
-- PASSES, so the old `tb.status IN ('waiting', 'running', 'active') AND
-- tb.lifecycle <> 'closed'` silently dropped a whole board.
--
-- It did not finish the job. Asked of the live catalogue today, FIVE functions
-- still carry that predicate. They are enumerated here because the audit asked
-- for the enumeration and because the two that are left alone are the
-- interesting half:
--
--   fn_cash_cluster_census    RE-CUT HERE. This is the one that matters most.
--     The tick reads the census; the balancer reads the census; the seat-change
--     planner reads the census. A Cluster whose board has a NULL status is
--     invisible to all three while being perfectly visible to
--     fn_cash_cluster_live_eligible, which is the number that authorises the
--     conversion. The tick reading one membership and the threshold reading
--     another is the exact two-readers defect 20260921064717 was restructured
--     to make impossible.
--
--   fn_cash_game_lobby        RE-CUT HERE. It is the player-facing list of the
--     tables of a game, and its own comment says it deliberately uses "the same
--     predicate as fn_cash_cluster_census". That sentence was true and has to
--     stay true, so the two move together or neither does.
--
--   fn_cash_cluster_tick      LEFT ALONE, deliberately. Its occurrence is
--     inside the "does this Cluster already have a board to deal on, or should
--     I open a feeder" test, and it is spelled `lifecycle IN ('live',
--     'opening', 'breaking') AND status IN ('waiting', 'running', 'active')` -
--     an INCLUSION list on lifecycle as well as on status. It is not asking
--     which boards are in the Cluster; it is asking which boards are in one of
--     three named lifecycles. Widening it would change when the tick opens
--     tables, which is a seating decision in a 41,000-character function that
--     this file has no business re-timing.
--
--   fn_cash_game_join         LEFT ALONE, deliberately. All three of its
--     occurrences are paired with `lifecycle IN ('live', 'opening')`, and they
--     answer "which board may I be SEATED at right now", not "which boards are
--     in this Cluster". Widening them would start seating players at paused
--     boards, which is a bug and not a fix.
--
--   cash_tables_needing_engine LEFT ALONE. It has no cluster_id in it at all;
--     it asks which tables in the whole estate need an engine process. Its
--     status filter is engine dispatch.
--
-- Measured against production on 2026-09-25: 5,875 cluster tables, 0 with a
-- NULL lifecycle and 0 with a NULL status. This is armed and not detonated,
-- which is the only time it is cheap to disarm.
--
-- ===========================================================================
-- THE SMALLER CORRECTIONS
-- ===========================================================================
--
-- 1. commit_lightning ANSWERED ok: true WHEN IT DID NOT CONVERT. Its two
--    self-abort paths return `fn_cash_cluster_abort_pending_on(...) ||
--    jsonb_build_object('converted', false)`, and an abort answers ok: true -
--    correctly, for the abort. But every other early return in that function
--    pairs ok:false with converted:false, so a caller that branches on `ok`
--    alone, which is what the sibling returns taught it to do, reads a
--    self-abort as a success. Both now answer ok:false, keeping converted:false
--    and keeping the abort_reason the abort put there.
--
-- 2. THE STRANDING SCAN COULD TURN A RECOVERABLE ABORT INTO A HARD RAISE.
--    commit_lightning's v_stranded query filters `tb.dealing_halted_at IS NOT
--    NULL` and, alone among the five scans in that function, omits is_deleted
--    and lifecycle. A soft-deleted board carrying a stale halt therefore counts
--    its seated players as stranded, and the function RAISEs
--    LIGHTNING_CONVERSION_STRANDED_A_PLAYER - rolling the transaction back and
--    leaving the Cluster in PENDING_ON, which is defect (2) above arriving by
--    a third door. It now carries the same two filters its four siblings do.
--
-- 3. tables_halted COUNTED THE WRONG TABLES. It is the ROW_COUNT of an UPDATE
--    that carries `AND dealing_halted_at IS NULL`, so it counts tables this
--    call NEWLY halted, not tables that are halted. On a Cluster with a board
--    already stopped for some other reason - which begin_pending_on explicitly
--    leaves alone - a caller reading tables_halted is told fewer boards are
--    stopped than are stopped. It is CHANGED rather than renamed:
--    tables_halted is now the count of member boards not dealing after the
--    UPDATE, which is what its name says, and tables_newly_halted is the
--    ROW_COUNT, which is what nobody had. Both are in the answer and both are
--    in the event.
--
-- 4. THE ABORT NEVER GAVE BACK THE SEAT MOVES THE BEGIN TOOK AWAY.
--    begin_pending_on cancels every pending cash_seat_moves row of the Cluster
--    and stamps the note 'cancelled by lightning pending_on'. The abort lifted
--    the halt and left them cancelled. For a move the tick planned that is
--    harmless - the tick re-plans on its next pass - but a move that came from
--    a SEAT CHANGE leaves cash_seat_change_requests saying 'moved' with a
--    move_id pointing at a cancelled row, so the player has spent their one
--    seat change of the stay and has no move. The abort now restores exactly
--    the rows this conversion cancelled: matched on the note it wrote, bounded
--    to rows resolved after the PREVIOUS conversion of the same Cluster opened
--    (the begin cancels a fraction of a second before it writes its own row, so
--    a bound against this conversion's own opened_at would match nothing, and
--    the previous one's is the tightest these two timestamps allow), and
--    skipped for any player
--    who has since acquired another pending move, because
--    cash_seat_moves_one_pending_per_player is a unique index and a restore
--    that violates it would take the whole abort down with it.
--
-- 5. THE FREEZE COULD LAND IN THE WINDOW BETWEEN THE CHECK AND THE LOCK.
--    begin_pending_on asks fn_platform_frozen() before `SELECT ... FOR UPDATE`,
--    so a break beginning while this call waits on a tick's lock is missed and
--    the Cluster is halted during the break. It is asked AGAIN after the lock.
--    The pre-lock check stays: it is what keeps a frozen platform from queueing
--    behind a tick at all.
--
-- 6. open_cluster_sessions HAD NO EPOCH AND COULD NOT HAVE ONE.
--    fn_cash_cluster_lightning_state reports cluster_epoch, and its
--    live_eligible counts pool sessions AT that epoch - and open_cluster_
--    sessions counts cash_player_session rows with no epoch filter, which reads
--    like an omission. It is not one and it must not be "fixed":
--    cash_player_session HAS no cluster_epoch column, by design, because "a
--    Lightning Pool Session is subordinate to the continuous Cash Player
--    Session. Entering/exiting Lightning does not create a new cash session."
--    The cash session outlives the epoch on purpose. So the asymmetry is made
--    EXPLICIT instead: the object gains open_pool_sessions, which IS
--    epoch-scoped, beside the cash count that deliberately is not, and the body
--    says so where a reader will meet it.
--
-- 7. fn_cash_cluster_pool_health HAD NO CALLER. WIRED, NOT DELETED. Deleting
--    it was the first instinct and it is wrong twice over: Phase 4's contract
--    is that fn_cash_cluster_population, fn_cash_cluster_lightning_state and
--    fn_cash_cluster_pool_health all report exactly what
--    fn_cash_cluster_live_eligible reports - scripts/dev/test-lightning-phase4-
--    population.sh section 15 asserts precisely that, on every Cluster it
--    builds - so dropping the third reader would take a standing harness red
--    and would remove one of the three places that disagreement can be caught.
--    It is wired instead, at the one moment an operator most needs it and on a
--    path cold enough to afford it: when the reaper aborts a stuck conversion,
--    the reap event carries the Cluster's pool health at the moment it was
--    reaped - population, thresholds, headroom, seat occupancy and confidence -
--    so the post-mortem of "why did this Cluster sit halted for a quarter of an
--    hour" is in the event rather than reconstructed from a database that has
--    since moved on.
--
-- ===========================================================================
-- THE POOL SESSION GROWS THE NINE FIELDS THE SPECIFICATION NAMED
-- ===========================================================================
--
-- The LIGHTNING POOL SESSION section of the specification lists twenty-one
-- fields to track. Nine of them did not exist: hands, fast_folds,
-- normal_folds, fold_and_watch, showdowns, hands_per_hour, average_wait,
-- p95_wait and p99_wait. They are added here, NOT NULL with a zero default, so
-- that Phase 6's matcher has somewhere to write and so that a pool session
-- that has played nothing reads as nought rather than as unknown.
--
-- The three wait fields are MILLISECONDS, the unit lightning_pool_slot.
-- p95_wait_ms and p99_wait_ms already use, and they keep the specification's
-- names because the specification's names are what the next agent will search
-- for. The unit is in a COMMENT ON COLUMN on each of them, where it cannot
-- drift away from the column.
--
-- IDLE_POOL IS A PHASE 6 SUB-STATE OF 'active', AND commit_lightning IS RIGHT
-- TO INSERT 'active'. Step 19 says "place eligible players into IDLE_POOL" and
-- IDLE_POOL is in the specification's list of conceptual player states. So is
-- MATCHING. So are RESERVED, IN_INSTANCE, IN_HAND, FOLDED, WATCHING,
-- SEATED_MAIN, SEATED_FEEDER, PENDING_MOVE and GHOST_BB - eleven conceptual
-- states, and lightning_pool_session_state_check carries NONE of them. What it
-- carries is joining, eligibility_check, active, sit_out, disconnected,
-- leaving and closed: the admission states, one umbrella for "in the pool and
-- playable", and the three ways out. That is a deliberate reduction and not an
-- oversight, and adding idle_pool ALONE would break it - the column would
-- become half a matcher state machine and half an umbrella, and a player would
-- be idle_pool at the exact moment the matcher wanted them matching, with no
-- vocabulary to say so. IDLE_POOL versus MATCHING versus RESERVED versus
-- IN_INSTANCE is the matcher's state machine, the matcher is Phase 6, and the
-- matcher owns the instance side. 'active' is the right value at step 19.
--
-- AND THE TRAP THAT DECISION LEAVES IS DISARMED RATHER THAN DOCUMENTED.
-- fn_cash_cluster_live_eligible counted `s.state = 'active'` - a single
-- INCLUSION - so the day anyone adds a state to that CHECK, every pool session
-- in it stops counting, the population of a Lightning Cluster silently falls,
-- and the OFF threshold drains a Cluster full of people. The predicate is
-- inverted here: it now counts every open pool session whose state is NOT one
-- of joining, eligibility_check, sit_out, disconnected, leaving or closed. On
-- today's vocabulary that is the same six-letter word and exactly the same
-- number. On tomorrow's it is the safe default - a new state COUNTS unless
-- somebody deliberately names it as not counting - and @live-proof #10 below
-- reconciles the exclusion list against the live CHECK so that the two can
-- never quietly drift apart.
--
-- ===========================================================================
-- CORRECTION (2026-09-25): FOUR PROOFS OF 20260921151618 ARE KNOWINGLY
-- SUPERSEDED HERE
-- ===========================================================================
--
-- A `-- @live-proof:` is a claim that an expression is true of the database
-- the file produces. Four of 20260921151618's were true on the day of its
-- apply for reasons that had nothing to do with the code it shipped, which
-- makes them proofs of an empty room. That migration cannot be edited - it is
-- applied - so each is superseded here by one that says something about the
-- CODE, and the supersession is recorded out loud rather than the old proof
-- being quietly reworded. 20260921151618 gave 20260921064717's five-occurrence
-- proof exactly this treatment, and 20260920235343 #8 before it.
--
--   SUPERSEDED A - "no table is halted under a must_move Cluster"
--     (20260921151618 line 180, and again in its final DO $assert$). tables.
--     dealing_halted_at is ADD COLUMNed by that same file with no default, so
--     every row in the estate is NULL when the proof runs and NOT EXISTS is
--     true of an empty set. Superseded by #5 below, which names the only three
--     functions in the schema that may write that column at all.
--
--   SUPERSEDED B - "no committed conversion failed to move the epoch"
--     (line 183, and again in the DO $assert$). cash_cluster_conversion is
--     CREATEd empty in the same file and is further constrained so that the
--     shape being forbidden is unrepresentable. Superseded by #6 below, which
--     asserts the code that WRITES epoch_after computes it as the epoch before
--     plus one.
--
--   SUPERSEDED C - "no Cluster is lightning_enabled" (final DO $assert$).
--     A fact about the estate on one afternoon. It stops being true the hour
--     Phase 6 turns the first Cluster on, and it says nothing about this code.
--     Superseded by #7 below, which asserts the CAPABILITY IS OPT-IN in the
--     schema: cash_games.lightning_enabled is NOT NULL and defaults false, so
--     a Cluster is born without it however many are later given it.
--
--   SUPERSEDED D - "every must_move Cluster still answers its own state"
--     (final DO $assert$), asked as a count of cash_games where
--     fn_cash_cluster_lightning_state(g.id) IS NULL. That function returns NULL
--     on exactly one path - NOT FOUND - and the rows are selected FROM
--     cash_games, so the count is zero by construction. Superseded by #8 below,
--     which asserts that single-NULL-return property directly, of the body.
--
-- TWO MORE OF ITS PROOFS ARE NOT SUPERSEDED BUT ARE REPLACED BY STRICTER
-- VERSIONS HERE, because they were narrower than their own sentences:
--
--   #11 below is the seat-write proof. 20260921151618's greps UPDATE and
--     DELETE on table_seats and does not grep INSERT, so a conversion function
--     that SEATED somebody would pass it. INSERT is added, in both the
--     schema-qualified and the bare spelling, and the reaper is held to the
--     same bar.
--
--   #12 below is the "nothing calls the conversion" catalogue scan.
--     20260921151618's pattern names fn_cash_cluster_begin_pending_on and
--     fn_cash_cluster_commit_lightning and omits fn_cash_cluster_abort_pending_
--     on, so a function calling only the abort was invisible to it. The abort
--     is added, and fn_cash_cluster_reap_stuck_conversions - which this file
--     ships precisely to call the abort - is named in the exemption rather than
--     left to slip through a gap in the pattern.
--
-- HOUSE RULES OBSERVED: one BEGIN/COMMIT for the whole file, because every DDL
-- statement fires Supabase's schema-cache reload and it takes about 28 seconds;
-- one ADD COLUMN per ALTER TABLE; every ADD CONSTRAINT guarded by an existence
-- check so the file is re-appliable; every large function re-cut by ASSERTED
-- SUBSTITUTION - read from pg_get_functiondef, anchor counted, replace(),
-- siblings re-asserted, EXECUTE, then read BACK from the catalogue and asserted
-- again - and never retyped.
--
-- @live-proof: (SELECT s ~ 'SEAT_CHANGE_CLUSTER_CONVERTING' AND s ~ 'cluster_mode IS DISTINCT FROM ''must_move''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'cluster_mode IS DISTINCT FROM ''must_move''')
-- @live-proof: (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'fn_cash_cluster_reap_stuck_conversions')
-- @live-proof: (SELECT array_agg(p.proname::text ORDER BY p.proname) = ARRAY['fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_commit_lightning'] FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'SET dealing_halted_at')
-- @live-proof: (SELECT s ~ 'v_epoch := g\.cluster_epoch \+ 1;' AND s ~ 'SET status = ''committed'', epoch_after = v_epoch' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = 'false' FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'public.cash_games'::regclass AND a.attname = 'lightning_enabled')
-- @live-proof: (SELECT (SELECT count(*) FROM regexp_matches(s, 'RETURN NULL;', 'g')) = 1 AND s ~ 'IF NOT FOUND THEN' AND s ~ 'cluster_mode IN \(''must_move'', ''pending_on''\)' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT count(*) = 9 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lightning_pool_session' AND column_name IN ('hands', 'fast_folds', 'normal_folds', 'fold_and_watch', 'showdowns', 'hands_per_hour', 'average_wait', 'p95_wait', 'p99_wait') AND is_nullable = 'NO' AND column_default IS NOT NULL)
-- @live-proof: (SELECT s ~ 'NOT IN \(''joining'', ''eligibility_check'', ''sit_out'', ''disconnected'', ''leaving'', ''closed''\)' AND s !~ 's\.state = ''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT bool_and(pg_get_constraintdef(c.oid) LIKE '%''' || v || '''%') FROM unnest(ARRAY['joining', 'eligibility_check', 'sit_out', 'disconnected', 'leaving', 'closed']) v, pg_constraint c WHERE c.conname = 'lightning_pool_session_state_check')
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'INSERT INTO public\.table_seats|INSERT INTO table_seats|UPDATE public\.table_seats|UPDATE table_seats|DELETE FROM public\.table_seats|DELETE FROM table_seats') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning', 'fn_cash_cluster_reap_stuck_conversions'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname NOT IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning', 'fn_cash_cluster_reap_stuck_conversions') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_cash_cluster_begin_pending_on|fn_cash_cluster_commit_lightning|fn_cash_cluster_abort_pending_on'))
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_cash_cluster_reap_stuck_conversions')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_cash_cluster_pool_health')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_cluster_census', 'fn_cash_game_lobby') AND pg_get_functiondef(p.oid) ~ 'status IN \(''waiting'', ''running'', ''active''\)'))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'coalesce\(tb?\.lifecycle, ''''\) <> ''closed''') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_cluster_census', 'fn_cash_game_lobby', 'fn_cash_cluster_live_eligible', 'fn_cash_cluster_population'))
-- @live-proof: (SELECT (SELECT count(*) FROM regexp_matches(s, 'jsonb_build_object\(''ok'', false, ''converted'', false\)', 'g')) = 2 FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'tb\.dealing_halted_at IS NOT NULL' AND (SELECT count(*) FROM regexp_matches(s, 'coalesce\(tb\.lifecycle, ''''\) <> ''closed''', 'g')) >= 5 FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'tables_newly_halted' AND (SELECT count(*) FROM regexp_matches(s, 'fn_platform_frozen', 'g')) = 2 FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'cancelled by lightning pending_on' AND s ~ 'SET state = ''pending''' AND s !~ 'fn_platform_frozen' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_abort_pending_on(uuid,uuid,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'open_pool_sessions')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_seat_change_request', 'fn_cash_seat_change_plan', 'fn_cash_cluster_reap_stuck_conversions', 'fn_cash_cluster_census', 'fn_cash_game_lobby', 'fn_cash_cluster_live_eligible', 'fn_cash_cluster_lightning_state') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND routine_name = 'fn_cash_cluster_reap_stuck_conversions' AND grantee IN ('anon', 'authenticated', 'PUBLIC')))
-- @live-proof: (SELECT has_function_privilege('service_role', 'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure, 'EXECUTE'))
-- @live-proof: (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_reap_stuck_conversions')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE hands < 0 OR fast_folds < 0 OR normal_folds < 0 OR fold_and_watch < 0 OR showdowns < 0 OR hands_per_hour < 0 OR average_wait < 0 OR p95_wait < 0 OR p99_wait < 0))
-- @live-proof: (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.lightning_pool_session'::regclass AND conname = 'lightning_pool_session_counters_are_not_negative')

BEGIN;

-- ===========================================================================
-- 1. THE DOOR REFUSES WHILE THE CLUSTER IS CONVERTING
-- ===========================================================================
-- fn_cash_seat_change_request is SECURITY DEFINER and granted to
-- `authenticated`. It is the only path in this file's blast radius that a
-- browser reaches without an engine in between, and it is the path the audit
-- walked. The guard goes immediately AFTER the manual_game test and before the
-- seat lookup, for the same reason the tick's stand-down goes after its own
-- manual_game test: a manual game is not a must-move game at all and should
-- still be told so, rather than being told a conversion is in progress.
--
-- It RAISES rather than returning a refusal object, because every other
-- refusal in this function raises with ERRCODE check_violation and the client
-- that reads them has one error path, not two.
--
-- Substituted rather than retyped. The anchor is the manual_game IF, asserted
-- to occur exactly once, and the SEVEN other named refusals this function
-- carries are asserted to have survived by name, out of the catalogue.

DO $door$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure);
  v_anchor constant text :=
'  IF NOT g.must_move THEN' || chr(10) ||
'    RAISE EXCEPTION ''SEAT_CHANGE_MANUAL_GAME: a manual table has no seat change'' USING ERRCODE = ''check_violation'';' || chr(10) ||
'  END IF;';
  v_new  text;
  v_live text;
  r      text;
BEGIN
  IF v_src ~ 'SEAT_CHANGE_CLUSTER_CONVERTING' THEN
    RAISE NOTICE 'fn_cash_seat_change_request already carries the conversion bar; leaving it alone';
  ELSE
    IF (SELECT count(*) FROM regexp_matches(v_src, 'SEAT_CHANGE_MANUAL_GAME', 'g')) <> 1
       OR position(v_anchor in v_src) = 0 THEN
      RAISE EXCEPTION 'fn_cash_seat_change_request does not carry the manual_game anchor exactly once; refusing to substitute blind';
    END IF;

    v_new := replace(v_src, v_anchor, v_anchor || chr(10) || chr(10) ||
'  -- THE HALT IS A STANDING BAR, NOT A ONE-SHOT CANCEL (2026-09-25).' || chr(10) ||
'  -- g.must_move one line above is the CAPABILITY - is this a must-move game -' || chr(10) ||
'  -- and it stays true right through a Lightning conversion. cluster_mode is' || chr(10) ||
'  -- the STATE. A Cluster in pending_on has had every one of its tables stopped' || chr(10) ||
'  -- and a Cluster in lightning has no physical seat change to give; in both,' || chr(10) ||
'  -- the tick and the balancer are standing down, so a move planned here would' || chr(10) ||
'  -- be reconciled by nothing and then executed mid-conversion by the engine''s' || chr(10) ||
'  -- start-up wait loop, which never re-reads its table row and so cannot see' || chr(10) ||
'  -- the halt. Specification step 6: "stop starting new nonessential table' || chr(10) ||
'  -- assignments that would conflict with conversion".' || chr(10) ||
'  IF g.cluster_mode IS DISTINCT FROM ''must_move'' THEN' || chr(10) ||
'    RAISE EXCEPTION ''SEAT_CHANGE_CLUSTER_CONVERTING: this game is changing format and is not moving anybody right now'' USING ERRCODE = ''check_violation'';' || chr(10) ||
'  END IF;');
    IF v_new = v_src THEN
      RAISE EXCEPTION 'the substitution into fn_cash_seat_change_request changed nothing';
    END IF;
    EXECUTE v_new;
  END IF;

  -- READ BACK FROM THE CATALOGUE, never from v_new.
  v_live := pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure);
  IF v_live !~ 'SEAT_CHANGE_CLUSTER_CONVERTING' THEN
    RAISE EXCEPTION 'the live seat-change door does not refuse a converting Cluster';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_live, 'SEAT_CHANGE_CLUSTER_CONVERTING', 'g')) <> 1 THEN
    RAISE EXCEPTION 'the live seat-change door carries the conversion bar % time(s) rather than the one refusal message',
      (SELECT count(*) FROM regexp_matches(v_live, 'SEAT_CHANGE_CLUSTER_CONVERTING', 'g'));
  END IF;
  -- EVERY SIBLING REFUSAL SURVIVED. A replace() into 4,800 characters that ate
  -- one of these would still pass every assertion above.
  FOREACH r IN ARRAY ARRAY['GAME_NOT_FOUND', 'SEAT_CHANGE_MANUAL_GAME', 'NOT_IN_GAME',
                           'SEAT_CHANGE_NOT_FROM_MAIN', 'SEAT_CHANGE_TABLE_CLOSING',
                           'MOVE_PENDING', 'SEAT_CHANGE_USED', 'SEAT_CHANGE_TABLE_UNAVAILABLE',
                           'SEAT_CHANGE_NEVER_TO_MAIN', 'SEAT_CHANGE_NO_OTHER_TABLE'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_seat_change_request ate the % refusal', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the seat-change door now mentions is_horse';
  END IF;
  IF length(v_live) <= length(v_src) AND v_src !~ 'SEAT_CHANGE_CLUSTER_CONVERTING' THEN
    RAISE EXCEPTION 'the seat-change door did not grow, so the guard was not added';
  END IF;
END $door$;

-- ===========================================================================
-- 2. AND THE WRITER PLANS NOTHING, WHICH IS THE HALF THAT ACTUALLY BITES
-- ===========================================================================
-- fn_cash_seat_change_plan is the function that INSERTs the cash_seat_moves
-- row. The door above is the only caller a browser reaches, but the planner is
-- also called by the tick's reconcile step and by fn_cash_seat_change_request
-- itself, and barring the door alone would leave the writer willing.
--
-- It RETURNS 0 rather than raising, for the same reason fn_cash_cluster_balance
-- returns 0 rather than raising: the tick calls it inside its own pass and a
-- tick that starts raising becomes a controller_tick_error row every pass. The
-- predicate is verbatim the one 20260921151618 substituted into the tick and
-- the balancer, so that all four stand-downs read identically.

DO $plan$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure);
  v_anchor constant text := '  v_census := public.fn_cash_cluster_census(p_game_id, p_now);';
  v_new  text;
  v_live text;
  r      text;
BEGIN
  IF v_src ~ 'cluster_mode' THEN
    RAISE NOTICE 'fn_cash_seat_change_plan already reads cluster_mode; leaving it alone';
  ELSE
    IF (SELECT count(*) FROM regexp_matches(v_src, regexp_replace(v_anchor, '([().*+?\[\]{}|^$\\])', '\\\1', 'g'), 'g')) <> 1 THEN
      RAISE EXCEPTION 'fn_cash_seat_change_plan does not carry the census anchor exactly once; refusing to substitute blind';
    END IF;

    v_new := replace(v_src, v_anchor,
'  -- THE PLANNER STANDS DOWN WHILE THE CLUSTER IS CONVERTING (2026-09-25).' || chr(10) ||
'  -- Same guard, same predicate and the same reason as fn_cash_cluster_tick and' || chr(10) ||
'  -- fn_cash_cluster_balance: in pending_on every table of this Cluster has been' || chr(10) ||
'  -- stopped and nothing will reconcile a move; in lightning there is no' || chr(10) ||
'  -- physical seat to change to. Zero moves planned, no exception, because the' || chr(10) ||
'  -- tick calls this inside its own pass. Shape and predicate are the' || chr(10) ||
'  -- balancer''s, verbatim.' || chr(10) ||
'  IF EXISTS (SELECT 1 FROM public.cash_games cg' || chr(10) ||
'              WHERE cg.id = p_game_id AND cg.cluster_mode IS DISTINCT FROM ''must_move'') THEN' || chr(10) ||
'    RETURN 0;' || chr(10) ||
'  END IF;' || chr(10) ||
v_anchor);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'the substitution into fn_cash_seat_change_plan changed nothing';
    END IF;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure);
  IF v_live !~ 'cluster_mode IS DISTINCT FROM ''must_move''' THEN
    RAISE EXCEPTION 'the live seat-change planner does not stand down for a converting Cluster';
  END IF;
  IF v_live !~ 'fn_cash_cluster_census' THEN
    RAISE EXCEPTION 'the substitution into fn_cash_seat_change_planner ate its census';
  END IF;
  -- The planner's own sibling behaviours, asserted by name out of the
  -- catalogue: the two returns of the seat change, and the swap.
  FOREACH r IN ARRAY ARRAY['left_table', 'now_on_main_one', 'seat_change_returned',
                           'cash_seat_change_requests', 'cash_seat_moves'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_seat_change_plan ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the seat-change planner now mentions is_horse';
  END IF;
END $plan$;

-- ===========================================================================
-- 3. THE BOUNDED REAPER
-- ===========================================================================
-- See the header for the arithmetic behind fifteen minutes. In short: the only
-- legitimate wait is the conversion-safe hand boundary, the halt means that set
-- only shrinks, a real hand is minutes, and the alternative is a Cluster whose
-- every table has stopped dealing for up to the six hours commit_lightning
-- allows an abandoned hand_history row.
--
-- IT REAPS ONLY WHAT IT UNDERSTANDS. A pending conversion whose to_mode is not
-- 'lightning', or whose Cluster is not in pending_on, is COUNTED AND SKIPPED
-- rather than touched: Phase 10's LIGHTNING -> MUST-MOVE drain will open
-- pending conversions of its own through pending_off, and a reaper that called
-- the pending_on abort on one of those would be told wrong_state and would
-- come back to the same row every pass for ever. The skip is in the answer, so
-- that a row this thing keeps declining to reap is visible rather than silent.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_reap_stuck_conversions(
  p_max_age interval                 DEFAULT interval '15 minutes',
  p_now     timestamp with time zone DEFAULT clock_timestamp(),
  p_limit   integer                  DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  c         record;
  v_res     jsonb;
  v_aborted boolean;
  v_seen    integer := 0;
  v_reaped  integer := 0;
  v_skipped integer := 0;
  v_rows    jsonb   := '[]'::jsonb;
  -- A caller asking for a one-second reaper is asking to abort conversions
  -- that are working. The floor is the shortest interval in which a hand
  -- boundary can plausibly still be arriving.
  v_age     interval := GREATEST(coalesce(p_max_age, interval '15 minutes'), interval '1 minute');
BEGIN
  -- DELIBERATELY NOT GATED ON fn_platform_frozen(), for the same reason
  -- fn_cash_cluster_abort_pending_on is not: leaving a half-converted Cluster
  -- must always be possible, and the break is when incidents are handled. Its
  -- caller short-circuits on the freeze before it gets here, which is a
  -- decision about the PASS rather than about this function - see the header.
  FOR c IN
    SELECT cc.id, cc.cluster_id, cc.conversion_request_id, cc.opened_at,
           cc.to_mode, g.cluster_mode
      FROM public.cash_cluster_conversion cc
      JOIN public.cash_games g ON g.id = cc.cluster_id
     WHERE cc.status = 'pending'
       AND cc.opened_at < p_now - v_age
     ORDER BY cc.opened_at, cc.id
     LIMIT GREATEST(1, coalesce(p_limit, 50))
  LOOP
    v_seen := v_seen + 1;

    IF c.to_mode IS DISTINCT FROM 'lightning' OR c.cluster_mode IS DISTINCT FROM 'pending_on' THEN
      v_skipped := v_skipped + 1;
      v_rows := v_rows || jsonb_build_object(
        'conversion_id', c.id, 'cluster_id', c.cluster_id, 'reaped', false,
        'reason', 'not_a_pending_on_lightning_conversion',
        'to_mode', c.to_mode, 'cluster_mode', c.cluster_mode);
      CONTINUE;
    END IF;

    v_res := public.fn_cash_cluster_abort_pending_on(
      c.cluster_id, c.conversion_request_id,
      format('reaped: PENDING_ON for %s, past the %s this estate allows a conversion to hold its tables',
             justify_interval(p_now - c.opened_at), v_age));
    v_aborted := coalesce((v_res ->> 'aborted')::boolean, false);

    IF v_aborted THEN
      v_reaped := v_reaped + 1;
      -- THE ONE CALLER fn_cash_cluster_pool_health HAS EVER HAD, and the
      -- moment it is worth paying for: an operator reading this event
      -- afterwards gets the Cluster's population, thresholds, headroom, seat
      -- occupancy and confidence as they stood when it was reaped, rather than
      -- having to reconstruct them from a database that has moved on.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (c.cluster_id, 'lightning_pending_on_reaped', jsonb_build_object(
        'conversion_id', c.id, 'conversion_request_id', c.conversion_request_id,
        'opened_at', c.opened_at,
        'stuck_for', justify_interval(p_now - c.opened_at)::text,
        'max_age', v_age::text,
        'abort', v_res,
        'pool_health', public.fn_cash_cluster_pool_health(c.cluster_id, p_now)));
    ELSE
      v_skipped := v_skipped + 1;
    END IF;

    v_rows := v_rows || jsonb_build_object(
      'conversion_id', c.id, 'cluster_id', c.cluster_id,
      'reaped', v_aborted, 'answer', v_res);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'examined', v_seen, 'reaped', v_reaped, 'skipped', v_skipped,
    'max_age', v_age::text, 'as_of', p_now, 'conversions', v_rows);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_reap_stuck_conversions(interval, timestamp with time zone, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_reap_stuck_conversions(interval, timestamp with time zone, integer) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_reap_stuck_conversions(interval, timestamp with time zone, integer) IS
  'The recovery nothing had: a cash_cluster_conversion left pending for longer than p_max_age (fifteen minutes by default) is aborted and its halts lifted, so a Cluster whose commit_lightning raised - or whose caller stopped polling - cannot sit in PENDING_ON with every table stopped until a human notices. Reachable from fn_cash_clusters_tick_all, which keeps running precisely because the per-Cluster tick stands down in pending_on. Skips any pending conversion that is not a lightning conversion of a pending_on Cluster, so Phase 10''s drain is not touched. Not gated on the platform freeze, deliberately, exactly as the abort it calls is not.';

-- ===========================================================================
-- 4. AND THE PASS THAT CAN REACH IT
-- ===========================================================================
-- fn_cash_clusters_tick_all is the estate-wide driver. The reap goes AFTER its
-- freeze short-circuit - so a frozen platform still costs one row read, and a
-- Cluster stuck in PENDING_ON during a break is reaped by the first pass after
-- the break, when it starts costing something again - and BEFORE the loop, so
-- a Cluster reaped this pass is ticked this pass rather than next.
--
-- It is wrapped in its own sub-block. tick_all sets lock_timeout to 2000ms and
-- the reap takes Cluster row locks through the abort; a lock wait must cost the
-- reap and not the whole pass, exactly as the per-game tick's sub-block makes a
-- lock wait cost one game.

DO $pass$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure);
  v_dec constant text := '  v_deferred integer := 0;';
  v_for constant text := '  FOR w IN' || chr(10) || '    SELECT l.game_id';
  v_ret constant text := '  RETURN jsonb_build_object(' || chr(10) || '    ''ok'', true,' || chr(10) || '    ''games'', v_games,';
  v_new text;
  v_live text;
  r     text;
BEGIN
  IF v_src ~ 'fn_cash_cluster_reap_stuck_conversions' THEN
    RAISE NOTICE 'fn_cash_clusters_tick_all already reaps stuck conversions; leaving it alone';
  ELSE
    IF position(v_dec in v_src) = 0 OR position(v_for in v_src) = 0 OR position(v_ret in v_src) = 0 THEN
      RAISE EXCEPTION 'fn_cash_clusters_tick_all does not carry all three anchors; refusing to substitute blind';
    END IF;
    IF (SELECT count(*) FROM regexp_matches(v_src, 'FOR w IN', 'g')) <> 1 THEN
      RAISE EXCEPTION 'fn_cash_clusters_tick_all carries its pass loop more than once; refusing to substitute blind';
    END IF;

    v_new := replace(v_src, v_dec, v_dec || chr(10) || '  v_reaped jsonb := ''{}''::jsonb;');
    v_new := replace(v_new, v_for,
'  -- THE REAP (2026-09-25). A cash_cluster_conversion that has sat pending too' || chr(10) ||
'  -- long is aborted here, because the per-Cluster tick stands down in' || chr(10) ||
'  -- pending_on and so cannot reap itself. After the freeze short-circuit above,' || chr(10) ||
'  -- so a break still costs one row read; before the loop, so a Cluster reaped' || chr(10) ||
'  -- now is ticked now. In its own sub-block, because lock_timeout is 2000ms and' || chr(10) ||
'  -- a lock wait must cost the reap rather than the pass.' || chr(10) ||
'  BEGIN' || chr(10) ||
'    v_reaped := public.fn_cash_cluster_reap_stuck_conversions();' || chr(10) ||
'  EXCEPTION WHEN OTHERS THEN' || chr(10) ||
'    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;' || chr(10) ||
'    v_reaped := jsonb_build_object(''ok'', false, ''sqlstate'', v_sqlstate, ''message'', v_message);' || chr(10) ||
'  END;' || chr(10) || chr(10) ||
v_for);
    v_new := replace(v_new, v_ret, v_ret || chr(10) || '    ''reaped'', v_reaped,');
    IF v_new = v_src THEN
      RAISE EXCEPTION 'the substitution into fn_cash_clusters_tick_all changed nothing';
    END IF;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure);
  IF (SELECT count(*) FROM regexp_matches(v_live, 'fn_cash_cluster_reap_stuck_conversions', 'g')) <> 1 THEN
    RAISE EXCEPTION 'the live pass calls the reaper % time(s) rather than once',
      (SELECT count(*) FROM regexp_matches(v_live, 'fn_cash_cluster_reap_stuck_conversions', 'g'));
  END IF;
  -- THE REAP IS AFTER THE FREEZE AND BEFORE THE LOOP, asserted by position
  -- rather than by reading the diff, because that ordering is the whole of the
  -- argument in the header.
  IF NOT (position('fn_platform_frozen' in v_live) < position('fn_cash_cluster_reap_stuck_conversions' in v_live)
          AND position('fn_cash_cluster_reap_stuck_conversions' in v_live) < position('FOR w IN' in v_live)) THEN
    RAISE EXCEPTION 'the reap is not between the freeze short-circuit and the pass loop';
  END IF;
  -- EVERY SIBLING BEHAVIOUR OF THE PASS SURVIVED.
  FOREACH r IN ARRAY ARRAY['fn_cash_cluster_tick', 'fn_cash_cluster_balance', 'lock_timeout',
                           'controller_tick_error', 'v_budget', 'rested_games', 'deferred',
                           'fn_platform_frozen'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_clusters_tick_all ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the pass now mentions is_horse';
  END IF;
END $pass$;

-- ===========================================================================
-- 5. ONE MEMBERSHIP PREDICATE: THE CENSUS AND THE LOBBY
-- ===========================================================================
-- See the header for the full enumeration of the five functions that carried
-- the uncoalesced predicate and the reasons the other three keep it. These two
-- are the cluster-membership readers, and they move onto exactly the predicate
-- 20260921151618 gave fn_cash_cluster_live_eligible and
-- fn_cash_cluster_population: is_deleted false and lifecycle not closed, both
-- coalesced, and status deciding nothing.
--
-- THE CENSUS IS THE IMPORTANT ONE. The tick, the balancer and the seat-change
-- planner all read it, so a board it cannot see is a board none of them can
-- see - while fn_cash_cluster_live_eligible, the number that authorises a
-- conversion, sees it perfectly. Two readers of one membership that disagree is
-- exactly the defect 20260921064717 was restructured to make impossible.

DO $census$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_cluster_census(uuid,timestamp with time zone)'::regprocedure);
  v_old constant text := 'tb.status IN (''waiting'', ''running'', ''active'') AND tb.lifecycle <> ''closed''';
  v_new_pred constant text := 'coalesce(tb.lifecycle, '''') <> ''closed''';
  v_new  text;
  v_live text;
  r      text;
BEGIN
  IF (SELECT count(*) FROM regexp_matches(v_src, 'tb\.status IN \(''waiting'', ''running'', ''active''\)', 'g')) = 0
     AND v_src ~ 'coalesce\(tb\.lifecycle' THEN
    RAISE NOTICE 'fn_cash_cluster_census already uses the coalesced membership predicate; leaving it alone';
  ELSE
    IF (SELECT count(*) FROM regexp_matches(v_src, 'tb\.status IN \(''waiting'', ''running'', ''active''\) AND tb\.lifecycle <> ''closed''', 'g')) <> 1 THEN
      RAISE EXCEPTION 'fn_cash_cluster_census does not carry the uncoalesced membership predicate exactly once; refusing to substitute blind';
    END IF;
    v_new := replace(v_src, v_old, v_new_pred);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'the substitution into fn_cash_cluster_census changed nothing';
    END IF;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef('public.fn_cash_cluster_census(uuid,timestamp with time zone)'::regprocedure);
  IF v_live ~ 'tb\.status IN \(' THEN
    RAISE EXCEPTION 'the live census still decides Cluster membership by a nullable status column';
  END IF;
  IF v_live !~ 'coalesce\(tb\.lifecycle, ''''\) <> ''closed''' THEN
    RAISE EXCEPTION 'the live census does not carry the coalesced membership predicate';
  END IF;
  -- tb.status SURVIVES AS A PROJECTED COLUMN. cash_cluster_census_row carries a
  -- status field that the tick reads; the substitution must have removed the
  -- FILTER and kept the SELECT, and a replace() that ate both would pass every
  -- assertion above.
  FOREACH r IN ARRAY ARRAY['tb\.status, tb\.created_at', 'cash_cluster_census_row',
                           'open_unreserved|GREATEST\(0, q\.max_players', 'table_waitlist',
                           'coalesce\(tb\.is_deleted, false\) = false'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_cluster_census ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the census now mentions is_horse';
  END IF;
END $census$;

-- The lobby's own comment says, in the body, that it uses "the same predicate
-- as fn_cash_cluster_census". That sentence has to stay true, so the two move
-- together. The anchor is two lines rather than one because `t.lifecycle <>
-- 'closed'` occurs TWICE in this function and only one of them is the Cluster
-- membership filter.

DO $lobby$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure);
  v_old constant text := 'AND t.status IN (''waiting'', ''running'', ''active'')' || chr(10) ||
                         '     AND t.lifecycle <> ''closed'';';
  v_new_pred constant text := 'AND coalesce(t.lifecycle, '''') <> ''closed'';';
  v_before integer;
  v_new  text;
  v_live text;
  r      text;
BEGIN
  v_before := (SELECT count(*) FROM regexp_matches(v_src, 't\.lifecycle <> ''closed''', 'g'));
  IF v_src !~ 't\.status IN \(''waiting'', ''running'', ''active''\)' AND v_src ~ 'coalesce\(t\.lifecycle' THEN
    RAISE NOTICE 'fn_cash_game_lobby already uses the coalesced membership predicate; leaving it alone';
  ELSE
    IF (SELECT count(*) FROM regexp_matches(v_src, 't\.status IN \(''waiting'', ''running'', ''active''\)', 'g')) <> 1
       OR position(v_old in v_src) = 0 THEN
      RAISE EXCEPTION 'fn_cash_game_lobby does not carry the two-line membership anchor exactly once; refusing to substitute blind';
    END IF;
    IF v_before <> 2 THEN
      RAISE EXCEPTION 'fn_cash_game_lobby carries t.lifecycle <> closed % time(s) rather than the two this substitution was written against', v_before;
    END IF;
    v_new := replace(v_src, v_old, v_new_pred);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'the substitution into fn_cash_game_lobby changed nothing';
    END IF;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure);
  IF v_live ~ 't\.status IN \(' THEN
    RAISE EXCEPTION 'the live lobby still decides Cluster membership by a nullable status column';
  END IF;
  IF v_live !~ 'coalesce\(t\.lifecycle, ''''\) <> ''closed''' THEN
    RAISE EXCEPTION 'the live lobby does not carry the coalesced membership predicate';
  END IF;
  -- THE OTHER t.lifecycle <> 'closed' IS NOT A MEMBERSHIP PREDICATE AND MUST
  -- HAVE SURVIVED. A wider substitution would have eaten it and nothing above
  -- would have noticed.
  IF (SELECT count(*) FROM regexp_matches(v_live, 't\.lifecycle <> ''closed''', 'g')) <> 1 THEN
    RAISE EXCEPTION 'the substitution into fn_cash_game_lobby did not leave exactly one non-membership t.lifecycle test standing';
  END IF;
  FOREACH r IN ARRAY ARRAY['coalesce\(t\.is_deleted, false\) = false', 'jsonb_agg', 'main_index'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_game_lobby ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the lobby now mentions is_horse';
  END IF;
END $lobby$;

-- ===========================================================================
-- 6. commit_lightning: ok:false ON A SELF-ABORT, AND A STRANDING SCAN THAT
--    FILTERS LIKE ITS FOUR SIBLINGS
-- ===========================================================================
-- Two independent substitutions into one function, each asserted, each read
-- back from the catalogue. See the header, SMALLER CORRECTIONS 1 and 2.

DO $commit$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure);
  v_abort_old constant text := '|| jsonb_build_object(''converted'', false)';
  v_abort_new constant text := '|| jsonb_build_object(''ok'', false, ''converted'', false)';
  v_scan_old constant text := '   WHERE tb.cluster_id = g.id' || chr(10) ||
                              '     AND tb.dealing_halted_at IS NOT NULL';
  v_scan_new constant text := '   WHERE tb.cluster_id = g.id' || chr(10) ||
                              -- THE FOUR SIBLING SCANS IN THIS FUNCTION ALL
                              -- CARRY THESE TWO. This one did not, so a
                              -- soft-deleted board with a stale halt turned a
                              -- recoverable self-abort into a RAISE that rolls
                              -- the transaction back and leaves the Cluster in
                              -- PENDING_ON with nothing to reap it.
                              '     AND coalesce(tb.is_deleted, false) = false' || chr(10) ||
                              '     AND coalesce(tb.lifecycle, '''') <> ''closed''' || chr(10) ||
                              '     AND tb.dealing_halted_at IS NOT NULL';
  v_new  text;
  v_live text;
  v_n    integer;
  r      text;
BEGIN
  IF v_src ~ 'jsonb_build_object\(''ok'', false, ''converted'', false\)' THEN
    RAISE NOTICE 'fn_cash_cluster_commit_lightning already answers ok:false on a self-abort; leaving that alone';
  ELSE
    v_n := (SELECT count(*) FROM regexp_matches(v_src, '\|\| jsonb_build_object\(''converted'', false\)', 'g'));
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'fn_cash_cluster_commit_lightning carries % self-abort return(s) rather than the two this migration expects; refusing to substitute blind', v_n;
    END IF;
    v_src := replace(v_src, v_abort_old, v_abort_new);
  END IF;

  IF position(v_scan_new in v_src) > 0 THEN
    RAISE NOTICE 'the stranding scan already filters is_deleted and lifecycle; leaving it alone';
  ELSE
    IF (SELECT count(*) FROM regexp_matches(v_src, regexp_replace(v_scan_old, '([().*+?\[\]{}|^$\\])', '\\\1', 'g'), 'g')) <> 1 THEN
      RAISE EXCEPTION 'fn_cash_cluster_commit_lightning does not carry the stranding scan anchor exactly once; refusing to substitute blind';
    END IF;
    v_src := replace(v_src, v_scan_old, v_scan_new);
  END IF;

  v_new := v_src;
  EXECUTE v_new;

  -- READ BACK FROM THE CATALOGUE.
  v_live := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_n := (SELECT count(*) FROM regexp_matches(v_live, 'jsonb_build_object\(''ok'', false, ''converted'', false\)', 'g'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the live commit answers ok:false on % of its two self-abort paths', v_n;
  END IF;
  IF v_live ~ '\|\| jsonb_build_object\(''converted'', false\)' THEN
    RAISE EXCEPTION 'the live commit still has a self-abort path that answers ok:true while converting nothing';
  END IF;
  v_n := (SELECT count(*) FROM regexp_matches(v_live, 'coalesce\(tb\.lifecycle, ''''\) <> ''closed''', 'g'));
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'the live commit carries the tb-qualified coalesced membership predicate % time(s) rather than the four it had plus the stranding scan', v_n;
  END IF;
  -- EVERY GUARD THE COMMIT HAD BEFORE THIS FILE TOUCHED IT.
  FOREACH r IN ARRAY ARRAY['fn_platform_frozen', 'hands_in_flight', 'fn_cash_cluster_lightning_state',
                           'would_turn_on', 'ca\.epoch_reason', 'LIGHTNING_CONVERSION_MOVED_MONEY',
                           'LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND', 'LIGHTNING_CONVERSION_STRANDED_A_PLAYER',
                           'request_id_belongs_to_another_cluster', 'already_committed',
                           'conversion_already_closed', 'lightning_pool_session',
                           'SET status = ''committed'', epoch_after = v_epoch'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_cluster_commit_lightning ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the commit now mentions is_horse';
  END IF;
  IF v_live ~ 'INSERT INTO public\.table_seats|INSERT INTO table_seats|UPDATE public\.table_seats|UPDATE table_seats|DELETE FROM public\.table_seats|DELETE FROM table_seats' THEN
    RAISE EXCEPTION 'the commit writes table_seats, and the seat is the one thing a conversion never touches';
  END IF;
END $commit$;

-- ===========================================================================
-- 7. begin_pending_on: THE FREEZE IS ASKED AGAIN UNDER THE LOCK, AND
--    tables_halted COUNTS HALTED TABLES
-- ===========================================================================
-- See the header, SMALLER CORRECTIONS 3 and 5.

DO $begin$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure);
  v_lock constant text :=
'  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;' || chr(10) ||
'  IF NOT FOUND THEN' || chr(10) ||
'    RETURN jsonb_build_object(''ok'', false, ''pending'', false, ''reason'', ''not_found'');' || chr(10) ||
'  END IF;';
  v_diag constant text := '  GET DIAGNOSTICS v_halted = ROW_COUNT;';
  v_live text;
  v_n    integer;
  r      text;
BEGIN
  IF v_src ~ 'tables_newly_halted' THEN
    RAISE NOTICE 'fn_cash_cluster_begin_pending_on already counts halted and newly halted separately; leaving it alone';
  ELSE
    IF position(v_lock in v_src) = 0 OR position(v_diag in v_src) = 0
       OR position('''tables_halted'', v_halted, ''seat_moves_cancelled'', v_cancel));' in v_src) = 0
       OR position('''cluster_mode'', ''pending_on'', ''tables_halted'', v_halted,' in v_src) = 0
       OR position('  v_halted integer;' in v_src) = 0 THEN
      RAISE EXCEPTION 'fn_cash_cluster_begin_pending_on does not carry all five anchors; refusing to substitute blind';
    END IF;
    v_n := (SELECT count(*) FROM regexp_matches(v_src, 'fn_platform_frozen', 'g'));
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_cash_cluster_begin_pending_on asks the freeze % time(s) rather than the one this substitution was written against', v_n;
    END IF;

    v_src := replace(v_src, '  v_halted integer;',
'  v_halted integer;' || chr(10) ||
'  v_halted_total integer;');

    v_src := replace(v_src, v_lock, v_lock || chr(10) || chr(10) ||
'  -- AND THE FREEZE IS ASKED AGAIN, NOW THAT THE LOCK IS HELD (2026-09-25).' || chr(10) ||
'  -- The pre-lock check above is what keeps a frozen platform from queueing' || chr(10) ||
'  -- behind a tick at all, and it stays. But this call can wait on that lock' || chr(10) ||
'  -- for as long as a tick holds it, and a break beginning inside that window' || chr(10) ||
'  -- was missed entirely - the Cluster was then halted, and its conversion' || chr(10) ||
'  -- opened, during the maintenance break the freeze exists to keep the engine' || chr(10) ||
'  -- out of.' || chr(10) ||
'  IF public.fn_platform_frozen() THEN' || chr(10) ||
'    RETURN jsonb_build_object(''ok'', false, ''pending'', false, ''reason'', ''platform_frozen'');' || chr(10) ||
'  END IF;');

    v_src := replace(v_src, v_diag, v_diag || chr(10) ||
'  -- tables_halted COUNTS TABLES THAT ARE HALTED (2026-09-25). The ROW_COUNT' || chr(10) ||
'  -- above is of an UPDATE carrying AND dealing_halted_at IS NULL, so it is the' || chr(10) ||
'  -- number of boards this call NEWLY stopped - which is not the number of' || chr(10) ||
'  -- boards that are stopped whenever one of them was already halted for some' || chr(10) ||
'  -- other reason, which this function deliberately leaves alone. Both numbers' || chr(10) ||
'  -- are now in the answer and in the event: the one whose name was wrong, and' || chr(10) ||
'  -- the one nobody had.' || chr(10) ||
'  SELECT count(*)::integer INTO v_halted_total FROM public.tables' || chr(10) ||
'   WHERE cluster_id = g.id' || chr(10) ||
'     AND coalesce(is_deleted, false) = false' || chr(10) ||
'     AND coalesce(lifecycle, '''') <> ''closed''' || chr(10) ||
'     AND dealing_halted_at IS NOT NULL;');

    v_src := replace(v_src, '''tables_halted'', v_halted, ''seat_moves_cancelled'', v_cancel));',
                            '''tables_halted'', v_halted_total, ''tables_newly_halted'', v_halted,' || chr(10) ||
                            '    ''seat_moves_cancelled'', v_cancel));');
    v_src := replace(v_src, '''cluster_mode'', ''pending_on'', ''tables_halted'', v_halted,',
                            '''cluster_mode'', ''pending_on'', ''tables_halted'', v_halted_total,' || chr(10) ||
                            '    ''tables_newly_halted'', v_halted,');
    EXECUTE v_src;
  END IF;

  v_live := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_n := (SELECT count(*) FROM regexp_matches(v_live, 'fn_platform_frozen', 'g'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the live begin asks the freeze % time(s) rather than once before the lock and once after it', v_n;
  END IF;
  IF strpos(substr(v_live, position('FOR UPDATE' in v_live)), 'fn_platform_frozen') = 0 THEN
    RAISE EXCEPTION 'the second freeze check is not after the lock';
  END IF;
  IF v_live !~ 'tables_newly_halted' OR v_live !~ 'v_halted_total' THEN
    RAISE EXCEPTION 'the live begin does not separate halted from newly halted';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_live, 'tables_newly_halted', 'g')) <> 2 THEN
    RAISE EXCEPTION 'the live begin does not carry tables_newly_halted in both the answer and the event';
  END IF;
  FOREACH r IN ARRAY ARRAY['already_known', 'already_committed', 'conversion_already_aborted',
                           'request_id_belongs_to_another_cluster', 'threshold_not_reached',
                           'wrong_state', 'lightning_pending_on', 'cancelled by lightning pending_on',
                           'FOR UPDATE', 'cash_cluster_conversion'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_cluster_begin_pending_on ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the begin now mentions is_horse';
  END IF;
  IF v_live ~ 'INSERT INTO public\.table_seats|INSERT INTO table_seats|UPDATE public\.table_seats|UPDATE table_seats|DELETE FROM public\.table_seats|DELETE FROM table_seats' THEN
    RAISE EXCEPTION 'the begin writes table_seats, and the seat is the one thing a conversion never touches';
  END IF;
END $begin$;

-- ===========================================================================
-- 8. abort_pending_on GIVES BACK THE SEAT MOVES THE BEGIN TOOK AWAY
-- ===========================================================================
-- See the header, SMALLER CORRECTION 4. The restore is narrow on purpose:
--
--   MATCHED ON THE NOTE THE BEGIN WROTE, so a move cancelled by a leave, an
--   expiry or a player's own cancel is not resurrected.
--   BOUNDED TO THIS CONVERSION by resolved_at >= the conversion's opened_at, so
--   a previous conversion's cancellations on the same Cluster stay cancelled.
--   SKIPPED FOR A PLAYER WHO NOW HAS ANOTHER PENDING MOVE, because
--   cash_seat_moves_one_pending_per_player is a UNIQUE index and a restore that
--   violated it would take the whole abort down with it - and an abort that can
--   raise is an abort that cannot recover anything.
--   THE NOTE MARKER IS REMOVED AGAIN, so a row restored and cancelled a second
--   time by a second conversion is matched once rather than accumulating.

DO $abort$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_cluster_abort_pending_on(uuid,uuid,text)'::regprocedure);
  v_diag constant text := '  GET DIAGNOSTICS v_resume = ROW_COUNT;';
  v_live text;
  r      text;
BEGIN
  IF v_src ~ 'v_restored' THEN
    RAISE NOTICE 'fn_cash_cluster_abort_pending_on already restores the cancelled seat moves; leaving it alone';
  ELSE
    IF position(v_diag in v_src) = 0
       OR position('  v_resume integer;' in v_src) = 0
       OR position('''tables_resumed'', v_resume,' in v_src) = 0
       OR position('''tables_resumed'', v_resume);' in v_src) = 0 THEN
      RAISE EXCEPTION 'fn_cash_cluster_abort_pending_on does not carry all four anchors; refusing to substitute blind';
    END IF;

    v_src := replace(v_src, '  v_resume integer;',
'  v_resume integer;' || chr(10) ||
'  v_restored integer;');

    v_src := replace(v_src, v_diag, v_diag || chr(10) || chr(10) ||
'  -- AND THE SEAT MOVES COME BACK (2026-09-25). begin_pending_on cancelled' || chr(10) ||
'  -- every pending move of this Cluster and stamped the note below. Lifting the' || chr(10) ||
'  -- halt without giving them back leaves a player who spent their one seat' || chr(10) ||
'  -- change of the stay holding a cash_seat_change_requests row that says' || chr(10) ||
'  -- ''moved'' against a cash_seat_moves row that says ''cancelled'' - the tick' || chr(10) ||
'  -- re-plans its own moves on the next pass, but it will not re-plan that one.' || chr(10) ||
'  UPDATE public.cash_seat_moves m' || chr(10) ||
'     SET state = ''pending'', resolved_at = NULL,' || chr(10) ||
'         note = nullif(btrim(regexp_replace(m.note, ''( \| )?cancelled by lightning pending_on$'', '''')), '''')' || chr(10) ||
'   WHERE m.game_id = g.id' || chr(10) ||
'     AND m.state = ''cancelled''' || chr(10) ||
'     AND m.note LIKE ''%cancelled by lightning pending_on''' || chr(10) ||
'     -- BOUNDED TO THIS CONVERSION, WITHOUT A MAGIC CONSTANT. The begin' || chr(10) ||
'     -- cancels a fraction of a second BEFORE it writes its own row, so' || chr(10) ||
'     -- resolved_at is a hair EARLIER than v_conv.opened_at and a >= against it' || chr(10) ||
'     -- would match nothing. What separates our cancellations from an earlier' || chr(10) ||
'     -- conversion''s on the same Cluster is the earlier conversion''s own' || chr(10) ||
'     -- opened_at, and that is the tightest bound these two timestamps allow.' || chr(10) ||
'     AND m.resolved_at > coalesce((SELECT max(c2.opened_at) FROM public.cash_cluster_conversion c2' || chr(10) ||
'                                    WHERE c2.cluster_id = g.id AND c2.opened_at < v_conv.opened_at),' || chr(10) ||
'                                  ''-infinity''::timestamptz)' || chr(10) ||
'     -- cash_seat_moves_one_pending_per_player is a UNIQUE index. A restore' || chr(10) ||
'     -- that violated it would raise out of an abort, and an abort that can' || chr(10) ||
'     -- raise is one that cannot recover anything.' || chr(10) ||
'     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves x' || chr(10) ||
'                      WHERE x.player_id = m.player_id AND x.state = ''pending'');' || chr(10) ||
'  GET DIAGNOSTICS v_restored = ROW_COUNT;');

    v_src := replace(v_src, '''tables_resumed'', v_resume,',
                            '''tables_resumed'', v_resume, ''seat_moves_restored'', v_restored,');
    v_src := replace(v_src, '''tables_resumed'', v_resume);',
                            '''tables_resumed'', v_resume, ''seat_moves_restored'', v_restored);');
    EXECUTE v_src;
  END IF;

  v_live := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_abort_pending_on(uuid,uuid,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  IF v_live !~ 'SET state = ''pending''' OR v_live !~ 'cancelled by lightning pending_on' THEN
    RAISE EXCEPTION 'the live abort does not restore the seat moves the begin cancelled';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_live, 'seat_moves_restored', 'g')) <> 2 THEN
    RAISE EXCEPTION 'the live abort does not report seat_moves_restored in both the answer and the event';
  END IF;
  -- THE ONE THING THIS FUNCTION MUST NEVER GROW. It is deliberately not gated
  -- on the platform freeze, because recovering a half-converted Cluster during
  -- an incident must always be possible, and 20260921151618 asserts the same.
  IF v_live ~ 'fn_platform_frozen' THEN
    RAISE EXCEPTION 'the abort is now gated on the freeze, so a half-converted Cluster could not be recovered during an incident';
  END IF;
  FOREACH r IN ARRAY ARRAY['already_aborted', 'conversion_already_closed', 'wrong_state',
                           'no_such_conversion', 'request_id_belongs_to_another_cluster',
                           'dealing_halted_reason = ''lightning_pending_on''', 'unstated',
                           'lightning_pending_on_aborted', 'FOR UPDATE'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_cluster_abort_pending_on ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the abort now mentions is_horse';
  END IF;
  IF v_live ~ 'INSERT INTO public\.table_seats|INSERT INTO table_seats|UPDATE public\.table_seats|UPDATE table_seats|DELETE FROM public\.table_seats|DELETE FROM table_seats' THEN
    RAISE EXCEPTION 'the abort writes table_seats, and the seat is the one thing a conversion never touches';
  END IF;
END $abort$;

-- ===========================================================================
-- 9. THE NINE FIELDS THE SPECIFICATION NAMED
-- ===========================================================================
-- One ADD COLUMN per ALTER TABLE, house rule, because a multi-column ALTER is
-- harder to read in a diff than nine one-line ones and costs the same single
-- schema-cache reload inside this one transaction.
--
-- All nine are NOT NULL DEFAULT 0. A pool session that has played no hands has
-- played nought hands; NULL would mean "nobody has said", and every one of
-- these is a counter Phase 6's matcher increments from zero.

ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS hands integer NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS fast_folds integer NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS normal_folds integer NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS fold_and_watch integer NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS showdowns integer NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS hands_per_hour numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS average_wait integer NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS p95_wait integer NOT NULL DEFAULT 0;
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS p99_wait integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.lightning_pool_session.hands IS 'Hands this pool session has been dealt into. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.fast_folds IS 'Folds taken before the action reached the player - the Lightning fast fold. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.normal_folds IS 'Folds taken in turn. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.fold_and_watch IS 'Folds where the player chose to keep watching the instance out rather than be rematched. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.showdowns IS 'Hands this pool session saw to showdown. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.hands_per_hour IS 'Observed hands per hour for this pool session. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.average_wait IS 'MILLISECONDS between being returned to the pool and being seated in the next instance, averaged. The unit is milliseconds, the same unit lightning_pool_slot.p95_wait_ms uses; the NAME is the specification''s, because that is what the next agent will search for. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.p95_wait IS 'MILLISECONDS, 95th percentile of the same wait. Unit as average_wait. Specification, LIGHTNING POOL SESSION.';
COMMENT ON COLUMN public.lightning_pool_session.p99_wait IS 'MILLISECONDS, 99th percentile of the same wait. Unit as average_wait. Specification, LIGHTNING POOL SESSION.';

-- ONE NAMED CHECK OVER ALL NINE. Guarded, so the file re-applies.
DO $ck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_pool_session'::regclass
                    AND conname = 'lightning_pool_session_counters_are_not_negative') THEN
    ALTER TABLE public.lightning_pool_session
      ADD CONSTRAINT lightning_pool_session_counters_are_not_negative
      CHECK (hands >= 0 AND fast_folds >= 0 AND normal_folds >= 0 AND fold_and_watch >= 0
             AND showdowns >= 0 AND hands_per_hour >= 0 AND average_wait >= 0
             AND p95_wait >= 0 AND p99_wait >= 0);
  END IF;
END $ck$;

-- ===========================================================================
-- 10. THE AUTHORISING NUMBER STOPS DEPENDING ON ONE SPELLING OF 'active'
-- ===========================================================================
-- See the header: 'active' stays the value commit_lightning inserts and
-- IDLE_POOL stays a Phase 6 sub-state of it. What changes is the shape of the
-- test in fn_cash_cluster_live_eligible. A single INCLUSION means that the day
-- anybody widens lightning_pool_session_state_check, every session in the new
-- state stops counting - the population of a Lightning Cluster silently falls
-- and the OFF threshold drains a Cluster full of people. An EXCLUSION list
-- fails the other way: a state nobody has thought about counts, and a state
-- that must not count has to be named. On today's vocabulary the two are the
-- same query and the same number.

DO $le$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure);
  v_old constant text := 'AND s.exited_at IS NULL AND s.state = ''active''';
  v_new_pred constant text :=
'AND s.exited_at IS NULL' || chr(10) ||
'              AND s.state NOT IN (''joining'', ''eligibility_check'', ''sit_out'', ''disconnected'', ''leaving'', ''closed'')';
  v_live text;
  v_n    integer;
  r      text;
BEGIN
  IF v_src ~ 'NOT IN \(''joining''' THEN
    RAISE NOTICE 'fn_cash_cluster_live_eligible already counts by exclusion; leaving it alone';
  ELSE
    v_n := (SELECT count(*) FROM regexp_matches(v_src, 's\.state = ''active''', 'g'));
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_cash_cluster_live_eligible tests the pool state % time(s) rather than the one this substitution was written against', v_n;
    END IF;
    v_src := replace(v_src, v_old, v_new_pred);
    EXECUTE v_src;
  END IF;

  v_live := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  IF v_live !~ 'NOT IN \(''joining'', ''eligibility_check'', ''sit_out'', ''disconnected'', ''leaving'', ''closed''\)' THEN
    RAISE EXCEPTION 'the live eligible counter does not count the pool by exclusion';
  END IF;
  IF v_live ~ 's\.state = ''' THEN
    RAISE EXCEPTION 'the live eligible counter still carries a bare state equality, so a new pool state would silently stop counting';
  END IF;
  -- AND EVERY STATE IT REFUSES TO COUNT IS A STATE THE TABLE CAN ACTUALLY
  -- HOLD. A rename in the CHECK that the counter did not follow leaves the
  -- counter excluding a value nothing can be in, which is the quiet half of
  -- this class of defect.
  FOREACH r IN ARRAY ARRAY['joining', 'eligibility_check', 'sit_out', 'disconnected', 'leaving', 'closed'] LOOP
    IF pg_get_constraintdef((SELECT oid FROM pg_constraint
                              WHERE conrelid = 'public.lightning_pool_session'::regclass
                                AND conname = 'lightning_pool_session_state_check'))
       NOT LIKE '%''' || r || '''%' THEN
      RAISE EXCEPTION 'fn_cash_cluster_live_eligible excludes the pool state %, which lightning_pool_session_state_check does not permit', r;
    END IF;
  END LOOP;
  -- THE DOUBLED GUARD 20260921064717 PUT THERE SURVIVED.
  FOREACH r IN ARRAY ARRAY['UNION', 'count\(DISTINCT u\.player_id\)', 'GREATEST\(0',
                           'coalesce\(tb\.lifecycle, ''''\) <> ''closed''', 'p_disconnected'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_cluster_live_eligible ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the eligible counter now mentions is_horse';
  END IF;
END $le$;

-- ===========================================================================
-- 11. THE STATE OBJECT SAYS WHICH OF ITS COUNTS IS EPOCH-SCOPED
-- ===========================================================================
-- See the header, SMALLER CORRECTION 6. open_cluster_sessions counting
-- cash_player_session with no epoch filter is not an omission and must not be
-- "fixed": cash_player_session HAS no cluster_epoch column, deliberately,
-- because the cash session is continuous across the conversion by
-- specification. The asymmetry is made visible instead.

DO $state$
DECLARE
  v_src text := pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure);
  v_count constant text :=
'  SELECT count(*)::integer INTO v_open' || chr(10) ||
'    FROM public.cash_player_session s' || chr(10) ||
'   WHERE s.cluster_id = g.id AND s.closed_at IS NULL;';
  v_live text;
  r      text;
BEGIN
  IF v_src ~ 'open_pool_sessions' THEN
    RAISE NOTICE 'fn_cash_cluster_lightning_state already reports open_pool_sessions; leaving it alone';
  ELSE
    IF position(v_count in v_src) = 0
       OR position('  v_open   integer;' in v_src) = 0
       OR position('    ''open_cluster_sessions'', v_open,' in v_src) = 0 THEN
      RAISE EXCEPTION 'fn_cash_cluster_lightning_state does not carry all three anchors; refusing to substitute blind';
    END IF;

    v_src := replace(v_src, '  v_open   integer;',
'  v_open   integer;' || chr(10) ||
'  v_pool   integer;');
    v_src := replace(v_src, v_count, v_count || chr(10) || chr(10) ||
'  -- AND THE ONE THAT IS EPOCH-SCOPED, BESIDE THE ONE THAT IS NOT (2026-09-25).' || chr(10) ||
'  -- v_open above counts cash sessions and carries NO epoch, and it cannot:' || chr(10) ||
'  -- cash_player_session has no cluster_epoch column, because "a Lightning Pool' || chr(10) ||
'  -- Session is subordinate to the continuous Cash Player Session. Entering/' || chr(10) ||
'  -- exiting Lightning does not create a new cash session." The cash session' || chr(10) ||
'  -- outlives the epoch on purpose. Reading that count beside cluster_epoch and' || chr(10) ||
'  -- beside a live_eligible that IS epoch-scoped invited exactly the wrong' || chr(10) ||
'  -- conclusion, so the epoch-scoped count now sits next to it and says so.' || chr(10) ||
'  SELECT count(*)::integer INTO v_pool' || chr(10) ||
'    FROM public.lightning_pool_session ps' || chr(10) ||
'   WHERE ps.cluster_id = g.id AND ps.cluster_epoch = g.cluster_epoch' || chr(10) ||
'     AND ps.exited_at IS NULL;');
    v_src := replace(v_src, '    ''open_cluster_sessions'', v_open,',
'    ''open_cluster_sessions'', v_open,' || chr(10) ||
'    ''open_pool_sessions'',    v_pool,');
    EXECUTE v_src;
  END IF;

  v_live := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  IF v_live !~ 'open_pool_sessions' THEN
    RAISE EXCEPTION 'the live state object does not carry the epoch-scoped pool count';
  END IF;
  -- THE CHEAP READER STAYS CHEAP. Phase 4 asserts this object does NOT call
  -- fn_cash_cluster_population, and a pool count is not an excuse to start.
  IF v_live ~ 'fn_cash_cluster_population' THEN
    RAISE EXCEPTION 'the state object now calls the breakdown, and it is the reader the lobby embeds on every poll';
  END IF;
  FOREACH r IN ARRAY ARRAY['open_cluster_sessions', 'fn_cash_cluster_live_eligible',
                           'fn_cash_cluster_lightning_thresholds', 'would_turn_on', 'would_turn_off',
                           'cluster_mode IN \(''must_move'', ''pending_on''\)',
                           'cluster_mode IN \(''lightning'', ''pending_off''\)',
                           'confidence', 'handedness', 'RETURN NULL;'] LOOP
    IF v_live !~ r THEN
      RAISE EXCEPTION 'the substitution into fn_cash_cluster_lightning_state ate %', r;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM regexp_matches(v_live, 'RETURN NULL;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'the live state object returns NULL on more than the one NOT FOUND path, so a NULL from it no longer means "no such Cluster"';
  END IF;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the state object now mentions is_horse';
  END IF;
END $state$;

-- ===========================================================================
-- 12. POST-APPLY READ-BACK FROM THE CATALOGUE AND THE ESTATE
-- ===========================================================================
-- Everything here is read back from the running database rather than from a
-- variable this file built, and every one of these is a statement about CODE
-- or about a schema shape rather than about how empty a table happens to be on
-- the afternoon of the apply - which is the whole of the Correction recorded in
-- the header.

DO $assert$
DECLARE
  v_door   text := regexp_replace(pg_get_functiondef('public.fn_cash_seat_change_request(uuid,uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_plan   text := regexp_replace(pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_tick   text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_bal    text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_reap   text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_bad    bigint;
BEGIN
  -- FOUR STAND-DOWNS, ONE PREDICATE. The tick and the balancer got theirs from
  -- 20260921151618; the door and the planner get theirs here. All four read
  -- identically, which is the point: a reader comparing them finds nothing to
  -- wonder about.
  IF v_tick !~ 'cluster_mode IS DISTINCT FROM ''must_move'''
     OR v_bal !~ 'cluster_mode IS DISTINCT FROM ''must_move'''
     OR v_plan !~ 'cluster_mode IS DISTINCT FROM ''must_move'''
     OR v_door !~ 'cluster_mode IS DISTINCT FROM ''must_move''' THEN
    RAISE EXCEPTION 'the four cluster stand-downs do not all read cluster_mode IS DISTINCT FROM must_move';
  END IF;
  IF v_door !~ 'SEAT_CHANGE_CLUSTER_CONVERTING' THEN
    RAISE EXCEPTION 'the seat-change door does not refuse a converting Cluster, so the halt is still a one-shot cancel';
  END IF;
  -- LAW 10.5 SURVIVED ALL OF IT.
  IF v_tick ~ 'is_horse' OR v_bal ~ 'is_horse' OR v_plan ~ 'is_horse'
     OR v_door ~ 'is_horse' OR v_reap ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and one of the functions this file touched now mentions is_horse';
  END IF;

  -- THE REAPER EXISTS, IS SHUT, AND IS REACHED.
  IF v_reap ~ 'fn_platform_frozen' THEN
    RAISE EXCEPTION 'the reaper is gated on the freeze, and leaving a half-converted Cluster must always be possible';
  END IF;
  IF v_reap !~ 'fn_cash_cluster_pool_health' THEN
    RAISE EXCEPTION 'the reap event does not carry the pool health of the Cluster it reaped, so fn_cash_cluster_pool_health is dead code again';
  END IF;
  IF regexp_replace(pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'fn_cash_cluster_reap_stuck_conversions' THEN
    RAISE EXCEPTION 'nothing in the estate can reach the reaper, and the per-Cluster tick stands down in pending_on';
  END IF;
  SELECT count(*) INTO v_bad FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public' AND routine_name = 'fn_cash_cluster_reap_stuck_conversions'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_bad <> 0 THEN RAISE EXCEPTION 'the reaper is executable by a browser'; END IF;
  IF NOT has_function_privilege('service_role',
        'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the reaper, so the engine cannot run it either';
  END IF;

  -- ONE MEMBERSHIP PREDICATE ACROSS THE FOUR READERS THAT ANSWER "WHICH BOARDS
  -- ARE IN THIS CLUSTER".
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN ('fn_cash_cluster_census', 'fn_cash_game_lobby',
                       'fn_cash_cluster_live_eligible', 'fn_cash_cluster_population')
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'coalesce\(tb?\.lifecycle, ''''\) <> ''closed''';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% cluster-membership reader(s) still do not use the coalesced predicate', v_bad;
  END IF;
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN ('fn_cash_cluster_census', 'fn_cash_game_lobby')
     AND pg_get_functiondef(p.oid) ~ 'status IN \(''waiting'', ''running'', ''active''\)';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% membership reader(s) still decide by a nullable status column', v_bad;
  END IF;

  -- THE NINE FIELDS ARE THERE AND CANNOT GO NEGATIVE.
  SELECT count(*) INTO v_bad FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'lightning_pool_session'
     AND column_name IN ('hands', 'fast_folds', 'normal_folds', 'fold_and_watch', 'showdowns',
                         'hands_per_hour', 'average_wait', 'p95_wait', 'p99_wait')
     AND is_nullable = 'NO' AND column_default IS NOT NULL;
  IF v_bad <> 9 THEN
    RAISE EXCEPTION 'only % of the nine specification fields exist as NOT NULL columns with a default', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_pool_session'::regclass
                    AND conname = 'lightning_pool_session_counters_are_not_negative') THEN
    RAISE EXCEPTION 'the nine counters carry no non-negativity constraint';
  END IF;

  -- COMMIT_LIGHTNING STILL INSERTS 'active', WHICH IS THE DECISION THIS FILE
  -- RECORDED RATHER THAN A THING THAT MERELY HAPPENS TO BE TRUE.
  IF regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ '''active'', clock_timestamp\(\), ts\.stack' THEN
    RAISE EXCEPTION 'the commit no longer creates pool sessions in the active state, and nothing in this file decided to change that';
  END IF;

  -- AND THE INVARIANTS THAT MUST HOLD WHATEVER STATE THE ESTATE IS IN. These
  -- are not proofs of an empty room: they are false of any estate that has a
  -- conversion open on a Cluster that is not converting, or a pending seat move
  -- on a Cluster whose tick has stood down.
  SELECT count(*) INTO v_bad FROM public.cash_cluster_conversion c
    JOIN public.cash_games g ON g.id = c.cluster_id
   WHERE c.status = 'pending' AND g.cluster_mode NOT IN ('pending_on', 'pending_off');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% conversion(s) are open on a Cluster that is not converting', v_bad;
  END IF;
  SELECT count(*) INTO v_bad FROM public.cash_seat_moves m
    JOIN public.cash_games g ON g.id = m.game_id
   WHERE m.state = 'pending' AND g.cluster_mode IS DISTINCT FROM 'must_move';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% seat move(s) are pending on a Cluster whose tick and balancer have stood down, which is the defect this file exists to close', v_bad;
  END IF;
END $assert$;

COMMIT;
