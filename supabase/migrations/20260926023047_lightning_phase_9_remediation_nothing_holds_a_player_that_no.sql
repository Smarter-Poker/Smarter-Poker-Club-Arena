-- 20260926023047_lightning_phase_9_remediation_nothing_holds_a_player_that_no.sql
--
-- LIGHTNING PHASE 9 REMEDIATION: NOTHING HOLDS A PLAYER THAT NOTHING CAN
-- RELEASE, THE LATCH IS NOT A BIRTHRIGHT, AND THE MONEY GUARD MEASURES THE
-- TRANSACTION IT IS IN.
--
-- 20260925215731 built the hand formation barrier and is applied. All seven
-- lightning_* tables are still empty in production and nothing is live, which
-- is the only reason every defect below is a finding rather than an incident.
-- An adversarial audit proved each of them on a throwaway backend; each was
-- proved again before this file was written; and section 16 of
-- scripts/dev/test-lightning-phase9-formation.sh reproduces every one of them
-- on its own estate BEFORE this file is applied, so that the sections after it
-- are about this file and not about a fixture that could never have failed.
--
-- ---------------------------------------------------------------------------
-- BLOCKER 1. A HAND THAT STARTED DEALING LOCKED ITS PLAYERS OUT OF LIGHTNING
-- FOR EVER.
-- ---------------------------------------------------------------------------
--
-- lightning_reservation_one_active_per_player makes a committed reservation a
-- standing bar on that player being matched again, and the bar comes off only
-- when the instance reaches complete or abandoned. fn_lightning_reap_formations
-- and the index it reads both filtered state IN ('forming', 'reserved').
-- Nothing moves an instance out of dealing or settling - the settlement phase
-- is not written, and fn_lightning_instance_abandon has no caller - so an
-- engine that died holding a dealing hand left six committed reservations that
-- no code path could release. Proved: form, begin_dealing, reap, reap again
-- with a clock a day ahead, and the instance is still dealing with six
-- committed reservations, and re-forming the same six answers
-- insufficient_legal_candidates at legal = 0. Those six players could never
-- play Lightning in that Cluster again.
--
-- THE POLICY, AND WHY IT IS NOT "ABANDON ANYTHING OLD". The specification says
-- do not abruptly kill active hands, and a reservation released out from under
-- an engine that is still dealing is worse than a stuck one: the player is
-- matchable again while still in a hand, which is two hands out of one stack.
-- So age is not the test. The test is whether anything is still VOUCHING for
-- the hand:
--
--   fn_lightning_instance_begin_dealing already moves deadline_at to now plus
--   the deal window, ten minutes by default. fn_lightning_instance_keepalive,
--   new here, is the engine's heartbeat: it pushes deadline_at forward for an
--   instance in dealing or settling - never backwards, never more than fifteen
--   minutes in one call - and it refuses an instance whose deadline has already
--   passed, because a hand that has been declared dead does not come back to
--   life because a late caller still holds its id.
--
--   The reaper now abandons dealing and settling instances past deadline_at,
--   which means past the deal window with no keepalive at all, or past the
--   window of the last keepalive. Phase 5's arithmetic applies here too: a real
--   hand at a nine-handed table finishes inside three minutes, so even an
--   engine that never sends a keepalive is not reaped under a hand that is
--   really being played, and an engine that does can play a hand of any length.
--
--   The reaper never reaps by a clock that has not arrived. p_now is clamped to
--   clock_timestamp(), so a caller passing a future time - which the old reaper
--   honoured - cannot abandon a live hand by asserting its deadline has passed.
--
--   An abandoned hand is VOID. Nothing in this database writes money before
--   settlement, so abandoning a dealing hand moves no chips. The settlement
--   phase, when it is written, must move settling to complete in the same
--   transaction that writes net_result, under the instance row lock, so that it
--   and the reaper - which takes that row FOR UPDATE SKIP LOCKED - serialise and
--   exactly one of them wins; the state graph already refuses abandoned ->
--   complete, so the loser cannot quietly finish anyway.
--
-- lightning_instance_past_deadline filtered the same two states, so it is
-- replaced by lightning_instance_live_past_deadline over all four live ones.
--
-- ---------------------------------------------------------------------------
-- BLOCKER 2. THE REAPER, THE SLOT SYNC AND SLOT OPEN WERE CALLED BY NOTHING.
-- ---------------------------------------------------------------------------
--
-- 20260925215731 argued its reaper was the third line of defence, the second
-- being fn_lightning_instance_open reaping its Cluster before opening anything.
-- But fn_lightning_form_hand - the only formation path there is - INSERTs its
-- own lightning_instance and never calls fn_lightning_instance_open, so the
-- second line defended a function nobody forms through. In the catalogue the
-- only callers of the three were fn_lightning_instance_open and each other;
-- fn_cash_clusters_tick_all had no lightning reference and no cron job named
-- one. So no live path opened a slot for a player entering the pool, and
-- nothing reaped anything. Proved: a stale reserved instance survives the next
-- formation on its own Cluster, and a pool session tick_all passes over stays
-- slotless.
--
--   fn_lightning_form_hand now reaps its own Cluster, under the Cluster row lock
--   and before its own INSERT, so a Cluster that keeps forming hands keeps
--   itself clean with nothing scheduled - which is what DECISION 2 of
--   20260925215731 claimed and did not do - and a player the reap hands back is
--   a legal candidate in the same call.
--
--   fn_cash_clusters_tick_all, the estate-wide driver the engine already calls
--   every pass, now calls fn_lightning_reap_formations once for the estate and
--   fn_lightning_pool_slots_sync once for every Cluster that is lightning or
--   still holds an open slot - a Cluster reverted to must_move keeps slots at a
--   dead epoch until something closes them. Both run after the freeze short-
--   circuit and after the Phase 5 conversion reap, and before the per-game
--   loop, each in its own sub-block - the reap in one, every Cluster's sync in
--   its own - because tick_all sets lock_timeout to 2000ms and a lock wait must
--   cost that step and not the pass. It is done by ASSERTED SUBSTITUTION: the
--   body is read from the catalogue, every anchor counted to exactly one, the
--   result EXECUTEd and read back, and every sibling behaviour of the pass
--   asserted to have survived.
--
--   NOTHING HERE CONVERTS A CLUSTER. fn_cash_cluster_begin_pending_on and
--   fn_cash_cluster_commit_lightning still have no caller, deliberately:
--   converting a Cluster before a matcher exists would strand its players in a
--   pool nobody deals from. Reaping and syncing are safe to wire today because
--   there is no Lightning Cluster for them to act on, and the day there is one
--   they are exactly what it needs.
--
-- ---------------------------------------------------------------------------
-- MAJOR 3. THE LATCH COULD BE SET AT BIRTH.
-- ---------------------------------------------------------------------------
--
-- trg_lightning_hand_is_immutable fired BEFORE UPDATE OR DELETE, so its rule
-- that the latch may only be set over a participant set that is really there
-- was a rule about UPDATE. A lightning_hand INSERTed with participants_locked_at
-- already set and player_count 6 over zero participant rows was accepted, and
-- UPDATE lightning_instance SET state = 'dealing' then released it, because the
-- step-13 precondition in fn_lightning_instance_is_disciplined asked only
-- whether participants_locked_at was set. The hand could never acquire a
-- participant - INSERT into a locked hand is refused - so it was an empty hand
-- in gameplay that nothing could fill and, by BLOCKER 1, nothing could reap.
--
-- Both halves are closed. The trigger now fires on INSERT as well and refuses a
-- hand born carrying either half of the latch, LIGHTNING_HAND_IS_BORN_UNLOCKED:
-- the latch goes on in the barrier's step-10 UPDATE or not at all. And the
-- step-13 precondition now also demands that player_count equals BOTH the
-- participant rows AND the committed reservations of the instance,
-- LIGHTNING_INSTANCE_HAND_SET_DOES_NOT_AGREE, so no road into dealing -
-- begin_dealing or a bare UPDATE - releases a hand whose set disagrees with
-- itself.
--
-- The harness's escape is closed with them. Wrapping the old step-13 branch in
-- IF FALSE AND left all sixteen sections green, because every one of them
-- reached dealing through begin_dealing, which checks the latch itself before
-- the trigger ever sees the row. The sections that prove this file drive the
-- bare UPDATE, against an unlocked hand and against a locked one whose
-- reservations disagree, so the trigger is the only thing that can refuse them.
--
-- ---------------------------------------------------------------------------
-- MAJOR 4. THE CHIP GUARD WAS A READ COMMITTED FALSE POSITIVE.
-- ---------------------------------------------------------------------------
--
-- The barrier summed the WHOLE Cluster's pool chips before and after its
-- formation block, in two statements of one READ COMMITTED transaction, with no
-- lock on lightning_pool_session. Each statement takes a fresh snapshot, so any
-- other transaction committing a change to net_result or exited_at for ANYBODY
-- in the Cluster between the two reads raised the uncaught
-- LIGHTNING_FORMATION_MOVED_MONEY, destroyed a correctly formed hand and
-- aborted the caller with no matcher_retry. Proved with a second backend
-- committing five chips to a player who was not in the hand. Once settlement
-- exists that is most formations in a busy Cluster.
--
-- THE CHOICE: RESTRICT THE GUARD TO THE PARTICIPANTS, AND LOCK THEIR POOL
-- SESSIONS FOR SHARE BEFORE A SINGLE STACK IS READ. The alternative - asserting
-- that this transaction wrote no lightning_pool_session row - has no honest SQL
-- spelling: a row written inside the barrier's own atomic block carries a
-- subtransaction id rather than the transaction's, and a test on xmin that
-- knows that is a test nobody will read correctly twice. The participant set,
-- on the other hand, is exactly the money a formation could move: the barrier
-- reads stack_before from those rows and no others, and the static proof below
-- - no fn_lightning_ body writes lightning_pool_session at all - already covers
-- every row by code. The dynamic guard exists to catch what the static proof
-- cannot see, a trigger or a future edit, and those act on the rows the
-- barrier touches.
--
-- The FOR SHARE is what makes it measure THIS transaction: once taken, no other
-- transaction can change those rows until this one ends, so a difference
-- between before and after can only have been written here. It is taken at step
-- 1, beside the slot lock and in pool session id order, BEFORE the stacks are
-- read - which also closes a quieter defect: stack_before was read under no
-- lock at all, so a settlement committing between that read and the barrier's
-- commit snapshotted a stack that no longer existed. A concurrent writer to a
-- participant now waits for the formation, which takes milliseconds. The value
-- compared is not a sum but every money column of every participant row,
-- ordered, so two stacks that swapped are a difference too.
--
-- ---------------------------------------------------------------------------
-- MAJOR 5. THE EXCEPTION LIST EXCLUDED EXACTLY THE RETRYABLE CLASSES.
-- ---------------------------------------------------------------------------
--
-- The atomic block caught unique, check, foreign key, not-null and exclusion
-- violations and let everything else through. Under concurrency the barrier's
-- real failures are lock_not_available (55P03 - the estate sets lock_timeout,
-- 2000ms inside tick_all and 8s for authenticator), deadlock_detected (40P01)
-- and serialization_failure (40001), and none of them was caught, so no
-- matcher_retry was written for precisely the failures specification 732-733
-- means by "retry where safe". Proved: a second backend holding one candidate's
-- lightning_blind_ledger row made the barrier die with "canceling statement due
-- to lock timeout" and write zero retry events.
--
-- All three are now retryable in the atomic block, with the SQLSTATE in the
-- event. And because the barrier also waits OUTSIDE that block - the Cluster
-- row FOR UPDATE, the slots FOR UPDATE, the pool sessions FOR SHARE, the reap -
-- everything after the freeze check is wrapped in a second sub-block that
-- catches the same three and only those three, rolls the whole formation back,
-- answers formation_contended and writes the matcher_retry after the rollback.
-- Genuine logic errors still propagate, LIGHTNING_FORMATION_MOVED_MONEY
-- included: it is a check_violation raised outside the atomic block, and the
-- outer handler does not name that class.
--
-- query_canceled (57014) IS DELIBERATELY NOT CAUGHT. PL/pgSQL does not catch it
-- under WHEN OTHERS, only when it is named, and naming it here would be wrong: a
-- statement_timeout fires once, so a handler that swallowed it would let the
-- statement carry on with no timeout at all and hand an ordinary retry to a
-- caller whose own budget - tick_all's eight-second statement_timeout - had
-- already run out, and an operator's pg_cancel_backend would be answered with
-- "please retry". A cancel belongs to whoever asked for it.
--
-- ---------------------------------------------------------------------------
-- MAJOR 6. TRUNCATE ERASED EVERY "IMMUTABLE" HAND.
-- ---------------------------------------------------------------------------
--
-- Row triggers do not fire on TRUNCATE, and service_role held TRUNCATE on all
-- seven lightning tables, so one statement erased every hand, participant,
-- instance, reservation and slot the row triggers exist to protect. Proved as
-- service_role, inside a transaction that rolled itself back.
--
-- BOTH A TRIGGER AND A REVOKE, AND ONE WITHOUT THE OTHER IS NOT ENOUGH.
-- postgres owns these tables and a REVOKE does not bind the owner - the owner
-- can grant itself back anything it revokes - and the migration runner, the
-- MCP and every operator psql session are postgres. So the control that binds
-- is a statement-level BEFORE TRUNCATE trigger on each of the seven tables,
-- LIGHTNING_HISTORY_IS_NOT_TRUNCATABLE, which fires for every role including
-- the owner and including a TRUNCATE that arrives by CASCADE from cash_games.
-- Getting past it takes ALTER TABLE ... DISABLE TRIGGER or DROP TRIGGER, which
-- is DDL, is logged as DDL, and is not a thing anybody does by accident.
-- TRUNCATE is ALSO revoked from service_role, because the application's role
-- has no business holding it and a leaked service key should not get as far as
-- the trigger. All seven tables, not five: lightning_pool_session is where the
-- stacks are, and lightning_blind_ledger is where the debts are.
--
-- ---------------------------------------------------------------------------
-- MAJOR 7. SPECIFICATION 2137-2143 WAS NOT MET.
-- ---------------------------------------------------------------------------
--
-- "Every hand must record: rules_version, matcher_version,
-- blind_algorithm_version, lightning_version, rake_version, cluster_epoch."
-- lightning_hand had cluster_epoch. The other five are added, stamped by the
-- barrier at step 7 in the very INSERT that creates the hand, NOT NULL, refused
-- when blank by a named CHECK, and immutable from birth by the same trigger
-- that freezes the hand's identity. Where each comes from, and why:
--
--   rules_version     'ruleset:' plus the md5 of the Cluster's ruleset_snapshot,
--                     read under the Cluster row lock the barrier already
--                     holds. The estate has no rules version number anywhere;
--                     a content hash of the ruleset is a version that cannot
--                     drift from the rules it names, because it IS them, and
--                     jsonb's text form is canonical.
--   rake_version      'rake:' plus the md5 of ruleset_snapshot -> 'rake', the
--                     Cluster's declared rake policy, for the same reason. It
--                     records the policy the hand was formed under; the
--                     schedule behind a policy of 'existing' is versioned by
--                     whatever owns that schedule, and the Lightning rake
--                     writer, when it exists, is where a finer version belongs.
--   blind_algorithm_version  'fn_lightning_blind_order:' plus the md5 of that
--                     function's installed source. A constant would have to be
--                     bumped by hand by whoever next edits the P2 key, and the
--                     one edit that forgets makes every later hand lie about
--                     how its blinds were chosen. A hash cannot forget.
--   lightning_version 'fn_lightning_form_hand:' plus the md5 of the barrier's
--                     own installed source, for the same reason: it names
--                     exactly the code that formed the hand.
--   matcher_version   from the CALLER, as p_matcher_version, and REQUIRED. The
--                     matcher is the one component the database cannot see, so
--                     only the matcher can say which one it is. A formation
--                     without it is refused with matcher_version_required
--                     before anything is locked or written.
--
-- p_matcher_version is a new parameter, so the barrier's signature changes: the
-- body is re-cut by asserted substitution into the new signature and the old
-- eight-argument function is dropped in the same transaction. Nothing calls it
-- in production, and after this file nothing can call the old one.
--
-- A hand formed before this file - there are none in production - carries
-- 'unrecorded_before_versioning' in all five, which is the truth about it.
--
-- ---------------------------------------------------------------------------
-- THE MINORS.
-- ---------------------------------------------------------------------------
--
-- (a) THE P2 KEY IS PINNED, ALL FIVE TERMS. Deleting sl.opened_at ASC from
--     fn_lightning_blind_order left every section green, and the matcher's
--     p_bb_player override tied on only three terms, so a matcher could name a
--     player who loses on pool entry. fn_lightning_blind_order itself is
--     unchanged - its five-term ORDER BY is specification 604-608 in order - and
--     is now pinned twice: a @live-proof below matches the exact ORDER BY, and
--     the harness builds five pairs, one per term, each pair tied on every
--     earlier term, won by X on its own term and by Y on every later one, so
--     deleting or reordering ANY term flips at least one pair. The override now
--     ties on pool entry too, so the only freedom the matcher keeps is among
--     players P2 cannot tell apart except by id, and the id is a tie-break for
--     determinism, not a fairness rule.
--
-- (b) A STALE SLOT IS CLOSED, NOT RETURNED. fn_lightning_pool_slot_open's
--     idempotency read was keyed on (Cluster, player, open), so a player who
--     left and re-entered - a new pool session - or who survived an epoch bump
--     was answered already_open with a slot bound to an exited session or a
--     dead epoch. The read is now keyed on the pool session and its epoch; any
--     other open slot of that player in that Cluster is closed in the same call,
--     superseded_by_pool_session or epoch_advanced, and a fresh one opened; and
--     a pool session whose epoch is not the Cluster's current one is refused.
--
-- (c) POSITIONS AT SEVEN, EIGHT AND NINE. Every seat below the hijack was 'utg',
--     so an eight-handed hand had three players under the gun and incremented
--     three utg_counts. Seats three to n-3 are now utg, utg1, utg2 and lj as the
--     table grows, the position CHECK admits those names, and exactly one player
--     per hand is under the gun. Six-handed and below are unchanged, seat for
--     seat.
--
-- (d) lightning_reservation.lightning_instance_id IS NOT NULL. Specification 716
--     names instance_id among the fields every reservation needs; the barrier,
--     the only writer, always binds one; production holds no rows.
--     lightning_reservation_committed_names_its_instance already kept a
--     COMMITTED reservation from lacking one, and a pending one was reapable by
--     expiry - but a pending claim belonging to no instance is one the release
--     trigger can never see, and there is no reason to be able to write one.
--
-- ---------------------------------------------------------------------------
-- TWO PROOFS OF 20260925215731 ARE KNOWINGLY SUPERSEDED HERE.
-- ---------------------------------------------------------------------------
--
-- That file is applied and cannot be edited. Two of its @live-proofs name an
-- exact set this file deliberately grows, and are superseded by proofs below
-- that name the new set; the harness re-evaluates every OTHER proof of
-- 20260925215731 after this file is applied, so the rest are proved still true
-- rather than assumed to be.
--
--   Its second proof, the nine-name list of callable fn_lightning_ functions,
--   gains fn_lightning_instance_keepalive.
--   Its fifteenth, the six-name list of trg_lightning_ triggers, gains the
--   seven TRUNCATE triggers.
--
-- HOUSE RULES OBSERVED: one BEGIN/COMMIT; one ADD COLUMN per ALTER TABLE; every
-- ADD CONSTRAINT, CREATE TRIGGER and signature change guarded so the file is
-- re-appliable; every re-cut done by asserted substitution - read from the
-- catalogue, every anchor counted to exactly one, replaced, EXECUTEd, read back
-- and asserted again - and no existing body retyped; every nullable CHECK
-- operand named; every new function SECURITY INVOKER with an explicit
-- search_path, revoked from PUBLIC, anon and authenticated and granted to
-- service_role only; recovery (the reap, the keepalive) not gated on the
-- freeze, for the reason Phase 5 records; and no is_horse anywhere, Law 10.5.
--
-- A `-- @live-proof:` below is a statement about the CODE - a body, a
-- constraint, a trigger, an index, a grant - and never about today's estate.
--
-- @live-proof: (SELECT array_agg(p.proname::text ORDER BY p.proname) = ARRAY['fn_lightning_blind_order', 'fn_lightning_form_hand', 'fn_lightning_instance_abandon', 'fn_lightning_instance_begin_dealing', 'fn_lightning_instance_keepalive', 'fn_lightning_instance_open', 'fn_lightning_pool_slot_open', 'fn_lightning_pool_slots_sync', 'fn_lightning_pool_stack', 'fn_lightning_reap_formations'] FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND p.prorettype <> 'trigger'::regtype)
-- @live-proof: (SELECT array_agg(t.tgname::text ORDER BY t.tgname) = ARRAY['trg_lightning_blind_ledger_refuses_truncate', 'trg_lightning_hand_is_immutable', 'trg_lightning_hand_player_is_immutable', 'trg_lightning_hand_player_refuses_truncate', 'trg_lightning_hand_refuses_truncate', 'trg_lightning_instance_is_disciplined', 'trg_lightning_instance_refuses_truncate', 'trg_lightning_instance_releases_its_reservations', 'trg_lightning_pool_session_refuses_truncate', 'trg_lightning_pool_slot_holds_its_history', 'trg_lightning_pool_slot_refuses_truncate', 'trg_lightning_reservation_is_disciplined', 'trg_lightning_reservation_refuses_truncate'] AND bool_and(t.tgenabled = 'O') FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname LIKE 'lightning%' AND t.tgname ~ '^trg_lightning_')
-- @live-proof: (SELECT count(*) = 7 AND bool_and((t.tgtype::integer & 32) <> 0 AND (t.tgtype::integer & 1) = 0 AND (t.tgtype::integer & 2) <> 0 AND t.tgenabled = 'O' AND t.tgfoid = 'public.fn_lightning_refuses_truncate()'::regprocedure) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname ~ '_refuses_truncate$' AND t.tgrelid IN ('public.lightning_hand'::regclass, 'public.lightning_hand_player'::regclass, 'public.lightning_instance'::regclass, 'public.lightning_reservation'::regclass, 'public.lightning_pool_slot'::regclass, 'public.lightning_pool_session'::regclass, 'public.lightning_blind_ledger'::regclass))
-- @live-proof: (SELECT s ~ 'LIGHTNING_HISTORY_IS_NOT_TRUNCATABLE' AND s !~ 'RETURN (NEW|OLD|NULL)' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_refuses_truncate()'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning%' AND privilege_type = 'TRUNCATE' AND grantee IN ('service_role', 'anon', 'authenticated', 'PUBLIC')))
-- @live-proof: (SELECT (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 1) <> 0 AND (t.tgtype::integer & 4) <> 0 AND (t.tgtype::integer & 8) <> 0 AND (t.tgtype::integer & 16) <> 0 FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_hand'::regclass AND t.tgname = 'trg_lightning_hand_is_immutable')
-- @live-proof: (SELECT s ~ 'TG_OP = ''INSERT''' AND s ~ 'LIGHTNING_HAND_IS_BORN_UNLOCKED' AND s ~ 'NEW\.participants_locked_at IS NOT NULL OR NEW\.player_count IS NOT NULL' AND s ~ 'NEW\.rules_version IS DISTINCT FROM OLD\.rules_version' AND s ~ 'NEW\.matcher_version IS DISTINCT FROM OLD\.matcher_version' AND s ~ 'NEW\.blind_algorithm_version IS DISTINCT FROM OLD\.blind_algorithm_version' AND s ~ 'NEW\.lightning_version IS DISTINCT FROM OLD\.lightning_version' AND s ~ 'NEW\.rake_version IS DISTINCT FROM OLD\.rake_version' AND s ~ 'LIGHTNING_HAND_IS_NOT_DELETABLE' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_hand_is_immutable()'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'IF NEW\.state = ''dealing''[[:space:]]+AND NOT EXISTS' AND s ~ 'LIGHTNING_INSTANCE_HAS_AN_UNLOCKED_HAND' AND s ~ 'IF NEW\.state = ''dealing''[[:space:]]+AND EXISTS' AND s ~ 'LIGHTNING_INSTANCE_HAND_SET_DOES_NOT_AGREE' AND s ~ 'FROM public\.lightning_hand_player hp WHERE hp\.hand_id = h\.hand_id' AND s ~ 'r\.lightning_instance_id = NEW\.id AND r\.state = ''committed''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_instance_is_disciplined()'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'li\.state IN \(''forming'', ''reserved'', ''dealing'', ''settling''\)' AND s ~ 'p_now := LEAST\(coalesce\(p_now, clock_timestamp\(\)\), clock_timestamp\(\)\)' AND position('p_now := LEAST' in s) < position('UPDATE public.lightning_reservation' in s) AND s ~ 'completed_at = CASE WHEN li\.started_at IS NOT NULL' AND s !~ 'fn_platform_frozen' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_reap_formations(timestamp with time zone,integer,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT pg_get_expr(i.indpred, i.indrelid) ~ 'forming' AND pg_get_expr(i.indpred, i.indrelid) ~ 'reserved' AND pg_get_expr(i.indpred, i.indrelid) ~ 'dealing' AND pg_get_expr(i.indpred, i.indrelid) ~ 'settling' AND pg_get_indexdef(i.indexrelid) ~ '\(deadline_at\)' AND to_regclass('public.lightning_instance_past_deadline') IS NULL FROM pg_index i WHERE i.indexrelid = 'public.lightning_instance_live_past_deadline'::regclass)
-- @live-proof: (SELECT s ~ 'li\.state IN \(''dealing'', ''settling''\)' AND s ~ 'past_deadline' AND s ~ 'GREATEST\(i\.deadline_at, v_now \+ v_extend\)' AND s ~ 'FOR UPDATE' AND s ~ 'interval ''15 minutes''' AND s !~ 'fn_platform_frozen' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_instance_keepalive(uuid,interval,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT array_agg(p.proname::text ORDER BY p.proname) = ARRAY['fn_lightning_form_hand', 'fn_lightning_instance_begin_dealing', 'fn_lightning_instance_open', 'fn_lightning_pool_slot_open', 'fn_lightning_pool_slots_sync'] FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_platform_frozen')
-- @live-proof: (SELECT to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone)') IS NULL AND to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)') IS NOT NULL)
-- @live-proof: (SELECT position('fn_lightning_reap_formations' in s) > 0 AND position('fn_lightning_reap_formations' in s) < position('INSERT INTO public.lightning_instance' in s) AND position('FOR UPDATE' in s) < position('fn_lightning_reap_formations' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'FROM public\.lightning_pool_session ps[^;]*FOR SHARE' AND position('FOR SHARE' in s) < position('fn_lightning_pool_stack' in s) AND s !~ 'ps\.cluster_id = g\.id AND ps\.exited_at IS NULL' AND s ~ 'v_money_after IS DISTINCT FROM v_money_before' AND s ~ 'LIGHTNING_FORMATION_MOVED_MONEY' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'OR exclusion_violation[[:space:]]+OR lock_not_available OR deadlock_detected OR serialization_failure THEN' AND s ~ 'WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN' AND s ~ 'formation_contended' AND s ~ 'WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname ~ '^fn_lightning_' OR p.proname = 'fn_cash_clusters_tick_all') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'query_canceled|57014'))
-- @live-proof: (SELECT count(*) = 5 AND bool_and(a.attnotnull) FROM pg_attribute a WHERE a.attrelid = 'public.lightning_hand'::regclass AND NOT a.attisdropped AND a.attname IN ('rules_version', 'matcher_version', 'blind_algorithm_version', 'lightning_version', 'rake_version'))
-- @live-proof: (SELECT pg_get_constraintdef(c.oid) ~ 'rules_version IS NOT NULL' AND pg_get_constraintdef(c.oid) ~ 'matcher_version IS NOT NULL' AND pg_get_constraintdef(c.oid) ~ 'blind_algorithm_version IS NOT NULL' AND pg_get_constraintdef(c.oid) ~ 'lightning_version IS NOT NULL' AND pg_get_constraintdef(c.oid) ~ 'rake_version IS NOT NULL' AND pg_get_constraintdef(c.oid) ~ 'btrim' FROM pg_constraint c WHERE c.conrelid = 'public.lightning_hand'::regclass AND c.conname = 'lightning_hand_versions_are_named')
-- @live-proof: (SELECT s ~ 'rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version' AND s ~ 'matcher_version_required' AND s ~ 'md5\(p\.prosrc\)' AND s ~ 'fn_lightning_blind_order\(uuid,integer,uuid\[\]\)' AND s ~ 'ruleset_snapshot' AND position('matcher_version_required' in s) < position('fn_platform_frozen' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'ORDER BY \(coalesce\(bl\.missed_bb_debt, 0\) > 0 OR coalesce\(bl\.bb_owed, 0\) > 0\) DESC,[[:space:]]+sl\.last_bb_at ASC NULLS FIRST,[[:space:]]+coalesce\(bl\.updated_at, sl\.opened_at\) ASC,[[:space:]]+sl\.opened_at ASC,[[:space:]]+sl\.player_id ASC\)' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ '''entered_pool'',[[:space:]]+bo\.entered_pool' AND s ~ '\(e -> ''entered_pool''\)\)[[:space:]]+IS NOT DISTINCT FROM' AND s ~ '\(v_pool -> 0 -> ''entered_pool''\)\)' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT s ~ 'sl\.pool_session_id = ps\.id AND sl\.cluster_epoch = ps\.cluster_epoch' AND s ~ 'superseded_by_pool_session' AND s ~ 'pool_session_epoch_is_not_current' AND position('superseded_by_pool_session' in s) < position('INSERT INTO public.lightning_pool_slot' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_pool_slot_open(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT pg_get_constraintdef(c.oid) ~ '''utg1''' AND pg_get_constraintdef(c.oid) ~ '''utg2''' AND pg_get_constraintdef(c.oid) ~ '''lj''' AND pg_get_constraintdef(c.oid) ~ '''utg''' FROM pg_constraint c WHERE c.conrelid = 'public.lightning_hand_player'::regclass AND c.conname = 'lightning_hand_player_position_check')
-- @live-proof: (SELECT s ~ 'WHEN s\.seat = 3[[:space:]]+THEN ''utg''' AND s ~ 'THEN ''lj''' AND s ~ 'THEN ''utg1''' AND s ~ 'ELSE ''utg2'' END' AND s !~ 'ELSE ''utg'' END' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = 'public.lightning_reservation'::regclass AND a.attname = 'lightning_instance_id')
-- @live-proof: (SELECT s ~ 'public\.fn_lightning_reap_formations\(\)' AND s ~ 'public\.fn_lightning_pool_slots_sync\(lc\.id\)' AND position('fn_platform_frozen' in s) < position('fn_cash_cluster_reap_stuck_conversions' in s) AND position('fn_cash_cluster_reap_stuck_conversions' in s) < position('fn_lightning_reap_formations' in s) AND position('fn_lightning_reap_formations' in s) < position('fn_lightning_pool_slots_sync' in s) AND position('fn_lightning_pool_slots_sync' in s) < position('FOR w IN' in s) AND (SELECT count(*) FROM regexp_matches(s, 'EXCEPTION WHEN OTHERS THEN', 'g')) = 4 AND s !~ 'is_horse' AND s !~ 'fn_cash_cluster_begin_pending_on|fn_cash_cluster_commit_lightning|fn_cash_cluster_abort_pending_on' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse'))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ '(INSERT INTO|UPDATE|DELETE FROM)[[:space:]]+(public\.)?(table_seats|wallets|club_wallets|union_wallets|chip_ledger|ca_settlements|cash_player_session|lightning_pool_session)\y') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_')
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'fn_platform_frozen') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_reap_formations', 'fn_lightning_instance_abandon', 'fn_lightning_instance_keepalive', 'fn_lightning_instance_releases_its_reservations', 'fn_lightning_refuses_truncate'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND routine_name ~ '^fn_lightning_' AND grantee IN ('anon', 'authenticated', 'PUBLIC')))
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) AND bool_and(NOT p.prosecdef AND array_to_string(p.proconfig, ',') ~ 'search_path') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_')
-- @live-proof: (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'INSERT INTO public\.lightning_hand[[:space:]]')

BEGIN;

-- THE DDL DOES NOT QUEUE BEHIND THE ENGINE. Every Lightning migration from
-- 20260921025504 on carries this, and Phase 9 did not. This file ALTERs
-- lightning_hand, lightning_hand_player and lightning_reservation, replaces an
-- index on lightning_instance and re-cuts fn_cash_clusters_tick_all, and the
-- engine's pass holds row and table locks on all of them. An ACCESS EXCLUSIVE
-- request that waits does not wait alone: every later reader queues behind it,
-- which is how the Phase 2 remediation once deadlocked against the live tick.
-- Eight seconds, then a clean refusal that changed nothing, to be re-run once -
-- never in a retry loop. Section 28 of scripts/dev/test-lightning-phase9-
-- formation.sh proves the refusal arrives by lock timeout, at eight seconds.
SET LOCAL lock_timeout = '8s';

-- ===========================================================================
-- SECTION 1. THE FIVE VERSIONS A HAND IS FORMED UNDER (MAJOR 7).
-- ===========================================================================

-- ONE ADD COLUMN PER ALTER TABLE: every DDL statement here fires a PostgREST
-- schema reload, and a multi-column ALTER that fails on its third clause has
-- cost the same reload as one that succeeded. Nullable at birth only so that
-- the hands already in the table can be stamped honestly before NOT NULL goes
-- on below; nothing is ever written to them as NULL.
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS rules_version text;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS matcher_version text;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS blind_algorithm_version text;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS lightning_version text;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS rake_version text;

-- A hand formed before this file recorded none of the five, and inventing them
-- would be a lie about how it was formed. Production has no such hand; an
-- estate that does says so in all five columns. The UPDATE runs before the
-- identity trigger is re-cut below to freeze these columns, and on a second
-- application it matches nothing.
UPDATE public.lightning_hand h
   SET rules_version           = coalesce(h.rules_version, 'unrecorded_before_versioning'),
       matcher_version         = coalesce(h.matcher_version, 'unrecorded_before_versioning'),
       blind_algorithm_version = coalesce(h.blind_algorithm_version, 'unrecorded_before_versioning'),
       lightning_version       = coalesce(h.lightning_version, 'unrecorded_before_versioning'),
       rake_version            = coalesce(h.rake_version, 'unrecorded_before_versioning')
 WHERE h.rules_version IS NULL OR h.matcher_version IS NULL OR h.blind_algorithm_version IS NULL
    OR h.lightning_version IS NULL OR h.rake_version IS NULL;

ALTER TABLE public.lightning_hand ALTER COLUMN rules_version SET NOT NULL;
ALTER TABLE public.lightning_hand ALTER COLUMN matcher_version SET NOT NULL;
ALTER TABLE public.lightning_hand ALTER COLUMN blind_algorithm_version SET NOT NULL;
ALTER TABLE public.lightning_hand ALTER COLUMN lightning_version SET NOT NULL;
ALTER TABLE public.lightning_hand ALTER COLUMN rake_version SET NOT NULL;

DO $ddl$
BEGIN
  -- A VERSION THAT IS BLANK IS NOT A VERSION. Every operand is named IS NOT
  -- NULL as well as non-blank even though the columns are NOT NULL, because a
  -- CHECK over a NULL evaluates to NULL and PASSES, and this CHECK must keep
  -- meaning something if a later file ever relaxes a column.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_hand'::regclass
                    AND conname = 'lightning_hand_versions_are_named') THEN
    ALTER TABLE public.lightning_hand
      ADD CONSTRAINT lightning_hand_versions_are_named
      CHECK (rules_version IS NOT NULL AND length(btrim(rules_version)) > 0
             AND matcher_version IS NOT NULL AND length(btrim(matcher_version)) > 0
             AND blind_algorithm_version IS NOT NULL AND length(btrim(blind_algorithm_version)) > 0
             AND lightning_version IS NOT NULL AND length(btrim(lightning_version)) > 0
             AND rake_version IS NOT NULL AND length(btrim(rake_version)) > 0);
  END IF;

  -- MINOR (c). The position vocabulary grows by the four names a seven-, eight-
  -- or nine-handed hand needs below the hijack, so that exactly one player per
  -- hand is under the gun and utg_count is incremented once. NULL stays
  -- admitted exactly as 20260920235343 admitted it - the barrier never writes
  -- one, and this file is not the place to change what a position may be when
  -- it is absent. Guarded on its own content, so a second application leaves
  -- it alone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_hand_player'::regclass
                    AND conname = 'lightning_hand_player_position_check'
                    AND pg_get_constraintdef(oid) ~ '''utg1''') THEN
    ALTER TABLE public.lightning_hand_player
      DROP CONSTRAINT IF EXISTS lightning_hand_player_position_check;
    ALTER TABLE public.lightning_hand_player
      ADD CONSTRAINT lightning_hand_player_position_check
      CHECK ("position" IS NULL
             OR "position" = ANY (ARRAY['utg', 'utg1', 'utg2', 'lj', 'hj', 'co', 'btn', 'sb', 'bb']));
  END IF;

  -- MINOR (d). A reservation belongs to an instance. The only writer binds one,
  -- production holds no reservation at all, and a reservation that belongs to
  -- no instance is a claim trg_lightning_instance_releases_its_reservations
  -- can never see. If one exists anywhere this file is applied, it is refused
  -- BY NAME rather than by the generic NOT NULL message, because the person
  -- reading it needs to know it is a live claim this file will not guess an
  -- owner for.
  IF EXISTS (SELECT 1 FROM public.lightning_reservation r WHERE r.lightning_instance_id IS NULL) THEN
    RAISE EXCEPTION 'LIGHTNING_RESERVATION_HAS_NO_INSTANCE: % reservation(s) belong to no instance, and this file will not invent one; release or remove them deliberately and apply again',
      (SELECT count(*) FROM public.lightning_reservation r WHERE r.lightning_instance_id IS NULL);
  END IF;
END
$ddl$;

ALTER TABLE public.lightning_reservation ALTER COLUMN lightning_instance_id SET NOT NULL;

COMMENT ON COLUMN public.lightning_hand.rules_version IS
  'Specification 2138. ''ruleset:'' plus the md5 of the Cluster''s ruleset_snapshot, read by fn_lightning_form_hand under the Cluster row lock at barrier step 7: a version that cannot drift from the rules it names because it is a hash of them. Immutable from birth.';
COMMENT ON COLUMN public.lightning_hand.matcher_version IS
  'Specification 2139. Supplied by the matcher as p_matcher_version and required - the matcher is the one component the database cannot see. Immutable from birth.';
COMMENT ON COLUMN public.lightning_hand.blind_algorithm_version IS
  'Specification 2140. ''fn_lightning_blind_order:'' plus the md5 of that function''s installed source at formation, so an edit to the P2 key cannot leave later hands claiming the old one. Immutable from birth.';
COMMENT ON COLUMN public.lightning_hand.lightning_version IS
  'Specification 2141. ''fn_lightning_form_hand:'' plus the md5 of the barrier''s installed source at formation: exactly the code that formed the hand. Immutable from birth.';
COMMENT ON COLUMN public.lightning_hand.rake_version IS
  'Specification 2142. ''rake:'' plus the md5 of the Cluster''s ruleset_snapshot -> ''rake'', the declared rake policy the hand was formed under. Immutable from birth.';

-- ===========================================================================
-- SECTION 2. THE SWEEP READS ALL FOUR LIVE STATES (BLOCKER 1).
-- ===========================================================================

-- The old index filtered forming and reserved, which is the same blind spot as
-- the reaper it served. Replaced rather than altered, because a partial
-- index's predicate cannot be changed in place; the new name keeps a second
-- application a no-op.
DROP INDEX IF EXISTS public.lightning_instance_past_deadline;
CREATE INDEX IF NOT EXISTS lightning_instance_live_past_deadline
  ON public.lightning_instance (deadline_at)
  WHERE state IN ('forming', 'reserved', 'dealing', 'settling');

-- ===========================================================================
-- SECTION 3. TRUNCATE IS REFUSED BY TRIGGER AND REVOKED FROM THE APP (MAJOR 6).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_refuses_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- A STATEMENT-LEVEL BEFORE TRUNCATE trigger, because row triggers do not
  -- fire on TRUNCATE and every immutability rule in Phase 9 is a row trigger.
  -- It fires for every role, the owner included, and for a TRUNCATE that
  -- arrives by CASCADE. History is closed, not deleted.
  RAISE EXCEPTION 'LIGHTNING_HISTORY_IS_NOT_TRUNCATABLE: TRUNCATE of %.% was refused; row triggers do not fire on TRUNCATE, so it would erase in one statement every hand, participant, instance, reservation, slot, pool session or blind ledger row the row triggers exist to keep',
    TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$fn$;

DO $truncate$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_instance',
                           'lightning_reservation', 'lightning_pool_slot',
                           'lightning_pool_session', 'lightning_blind_ledger'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = format('public.%I', t)::regclass
                      AND tgname = 'trg_' || t || '_refuses_truncate') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_lightning_refuses_truncate()',
                     'trg_' || t || '_refuses_truncate', t);
    END IF;
    -- The owner is not bound by this and does not need to be: the trigger
    -- above is what binds the owner. This takes the privilege away from the
    -- role the application actually runs as.
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM service_role, anon, authenticated, PUBLIC', t);
  END LOOP;
END
$truncate$;

-- ===========================================================================
-- SECTION 4. THE LATCH IS NOT A BIRTHRIGHT, AND THE VERSIONS ARE FROZEN (MAJOR 3,
-- MAJOR 7). ASSERTED SUBSTITUTION INTO fn_lightning_hand_is_immutable.
-- ===========================================================================
--
-- Every re-cut in this file has the same shape, and it is spelled out once
-- here. The installed body is read from the catalogue - not from the file that
-- installed it - and each anchor is counted in the text AS IT STANDS AT THAT
-- MOMENT, so an anchor that a previous replacement duplicated is caught too;
-- it must occur exactly once or nothing is substituted. The result is
-- EXECUTEd, read BACK from the catalogue, and asserted to carry the new
-- behaviour and every sibling behaviour it was written next to. A body that
-- already carries the new behaviour is left alone, so a second application
-- changes nothing.

DO $recut$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_hand_is_immutable()'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_hand_is_immutable()'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
$a$  IF NEW.hand_id IS DISTINCT FROM OLD.hand_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.lightning_instance_id IS DISTINCT FROM OLD.lightning_instance_id$a$,
$a$  -- THE LATCH IS ONE-WAY. Clearing it would unlock every rule in$a$];
  b      text[] := ARRAY[
$b$  -- THE LATCH IS NOT A THING A HAND CAN BE BORN WITH (2026-09-26). This
  -- trigger used to fire on UPDATE and DELETE only, so "the latch may only be
  -- set over a set that is really there" was a rule about UPDATE: a hand
  -- INSERTed already locked at player_count 6 over no participant rows was
  -- accepted, could never be given a participant, and could be dealt. The
  -- latch goes on in barrier step 10's UPDATE, over rows that exist, or not at
  -- all. The versions are NOT NULL and CHECKed by the table, so they need
  -- nothing here on the way in.
  IF TG_OP = 'INSERT' THEN
    IF NEW.participants_locked_at IS NOT NULL OR NEW.player_count IS NOT NULL THEN
      RAISE EXCEPTION 'LIGHTNING_HAND_IS_BORN_UNLOCKED: hand % was inserted already carrying the latch (participants_locked_at %, player_count %), which is barrier step 10 performed before the participants it counts exist; a hand born locked can never be given the set it claims',
        NEW.hand_id, NEW.participants_locked_at, NEW.player_count USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.hand_id IS DISTINCT FROM OLD.hand_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.lightning_instance_id IS DISTINCT FROM OLD.lightning_instance_id$b$,
$b$  -- THE VERSIONS THE HAND WAS FORMED UNDER ARE PART OF WHAT IT IS
  -- (2026-09-26). Specification 2137-2143; stamped at step 7 in the INSERT
  -- that creates the hand, so they are frozen from birth rather than from the
  -- latch - there is no moment at which rewriting one is formation.
  IF NEW.rules_version IS DISTINCT FROM OLD.rules_version
     OR NEW.matcher_version IS DISTINCT FROM OLD.matcher_version
     OR NEW.blind_algorithm_version IS DISTINCT FROM OLD.blind_algorithm_version
     OR NEW.lightning_version IS DISTINCT FROM OLD.lightning_version
     OR NEW.rake_version IS DISTINCT FROM OLD.rake_version THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % was formed under rules %, matcher %, blind algorithm %, lightning % and rake %, and the versions it was formed under may not be rewritten',
      OLD.hand_id, OLD.rules_version, OLD.matcher_version, OLD.blind_algorithm_version,
      OLD.lightning_version, OLD.rake_version USING ERRCODE = 'check_violation';
  END IF;

  -- THE LATCH IS ONE-WAY. Clearing it would unlock every rule in$b$];
BEGIN
  IF v_src ~ 'LIGHTNING_HAND_IS_BORN_UNLOCKED' THEN
    RAISE NOTICE 'fn_lightning_hand_is_immutable already refuses a hand born locked; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_hand_is_immutable carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef(v_fn);
  FOREACH r IN ARRAY ARRAY['LIGHTNING_HAND_IS_BORN_UNLOCKED', 'NEW.rake_version IS DISTINCT FROM OLD.rake_version',
                           'LIGHTNING_HAND_IS_NOT_DELETABLE', 'THE LATCH IS ONE-WAY',
                           'THE LATCH MAY ONLY BE SET OVER A SET THAT IS REALLY THERE',
                           'NEW.formed_at IS DISTINCT FROM OLD.formed_at',
                           'that count may not be rewritten'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_hand_is_immutable does not carry "%"', r;
    END IF;
  END LOOP;
  -- The INSERT branch comes BEFORE the first read of OLD, which is NULL on an
  -- INSERT and would otherwise make every IS DISTINCT FROM below true.
  IF position('TG_OP = ''INSERT''' in v_live) > position('NEW.hand_id IS DISTINCT FROM OLD.hand_id' in v_live) THEN
    RAISE EXCEPTION 'the INSERT branch of fn_lightning_hand_is_immutable sits after the first read of OLD';
  END IF;

  -- AND THE TRIGGER FIRES ON INSERT. It was created BEFORE UPDATE OR DELETE;
  -- the function above is inert on INSERT until the trigger calls it there.
  -- Dropped and re-created in this transaction, so there is no instant at which
  -- lightning_hand has no immutability trigger at all.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lightning_hand'::regclass
               AND tgname = 'trg_lightning_hand_is_immutable' AND (tgtype::integer & 4) = 0) THEN
    DROP TRIGGER trg_lightning_hand_is_immutable ON public.lightning_hand;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lightning_hand'::regclass
                   AND tgname = 'trg_lightning_hand_is_immutable') THEN
    CREATE TRIGGER trg_lightning_hand_is_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON public.lightning_hand
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_hand_is_immutable();
  END IF;
END
$recut$;

-- ===========================================================================
-- SECTION 5. A HAND IS DEALT ONLY IF ITS SET AGREES WITH ITSELF (MAJOR 3).
-- ASSERTED SUBSTITUTION INTO fn_lightning_instance_is_disciplined.
-- ===========================================================================

DO $recut$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_instance_is_disciplined()'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_instance_is_disciplined()'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
$a$      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_AN_UNLOCKED_HAND: instance % tried to begin dealing hand % whose participant set is not locked',
        OLD.id, NEW.hand_id USING ERRCODE = 'check_violation';
    END IF;$a$];
  b      text[] := ARRAY[
$b$      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_AN_UNLOCKED_HAND: instance % tried to begin dealing hand % whose participant set is not locked',
        OLD.id, NEW.hand_id USING ERRCODE = 'check_violation';
    END IF;

    -- A LOCKED HAND IS NOT ENOUGH (2026-09-26). The branch above asks only
    -- whether the latch is set, and a latch is a claim: a hand born locked at
    -- player_count 6 over no rows passed it and was dealt empty. A hand is
    -- released into gameplay only when its count, its participant rows and its
    -- instance's committed reservations are the same number. begin_dealing
    -- checks this too, and this is where it is true of every other road.
    IF NEW.state = 'dealing'
       AND EXISTS (SELECT 1 FROM public.lightning_hand h
                    WHERE h.hand_id = NEW.hand_id
                      AND (h.player_count IS NULL
                           OR h.player_count IS DISTINCT FROM
                              (SELECT count(*)::smallint FROM public.lightning_hand_player hp WHERE hp.hand_id = h.hand_id)
                           OR h.player_count IS DISTINCT FROM
                              (SELECT count(*)::smallint FROM public.lightning_reservation r
                                WHERE r.lightning_instance_id = NEW.id AND r.state = 'committed'))) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAND_SET_DOES_NOT_AGREE: instance % tried to begin dealing hand % locked at player_count % over % participant row(s) and % committed reservation(s)',
        OLD.id, NEW.hand_id,
        (SELECT h.player_count FROM public.lightning_hand h WHERE h.hand_id = NEW.hand_id),
        (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = NEW.hand_id),
        (SELECT count(*) FROM public.lightning_reservation r
          WHERE r.lightning_instance_id = NEW.id AND r.state = 'committed')
        USING ERRCODE = 'check_violation';
    END IF;$b$];
BEGIN
  IF v_src ~ 'LIGHTNING_INSTANCE_HAND_SET_DOES_NOT_AGREE' THEN
    RAISE NOTICE 'fn_lightning_instance_is_disciplined already demands an agreeing set; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_instance_is_disciplined carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef(v_fn);
  FOREACH r IN ARRAY ARRAY['LIGHTNING_INSTANCE_HAND_SET_DOES_NOT_AGREE', 'LIGHTNING_INSTANCE_HAS_AN_UNLOCKED_HAND',
                           'LIGHTNING_INSTANCE_IS_BORN_FORMING', 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT',
                           'LIGHTNING_INSTANCE_CLUSTER_IS_NOT_LIGHTNING', 'LIGHTNING_INSTANCE_STATE_IS_NOT_REVERSIBLE',
                           'LIGHTNING_INSTANCE_HAS_NO_HAND', 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_instance_is_disciplined does not carry "%"', r;
    END IF;
  END LOOP;
END
$recut$;

-- ===========================================================================
-- SECTION 6. THE REAPER REACHES A HAND NOTHING IS VOUCHING FOR (BLOCKER 1).
-- ASSERTED SUBSTITUTION INTO fn_lightning_reap_formations.
-- ===========================================================================

DO $recut$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_reap_formations(timestamp with time zone,integer,uuid)'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_reap_formations(timestamp with time zone,integer,uuid)'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
$a$  UPDATE public.lightning_reservation r
     SET state = 'expired',$a$,
$a$     WHERE li.state IN ('forming', 'reserved')$a$,
$a$       SET state = 'abandoned',
           abandon_reason = format('reaped: %s since %s, past the deadline this instance was born with',
                                   li.state, justify_interval(p_now - li.created_at))
     WHERE li.id = i.id;$a$];
  b      text[] := ARRAY[
$b$  -- NEVER REAP BY A CLOCK THAT HAS NOT ARRIVED (2026-09-26). This now reaps
  -- dealing and settling hands, and a caller passing a future p_now would
  -- otherwise abandon a live hand by asserting that its deadline had passed.
  -- A past p_now only ever reaps less.
  p_now := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());

  UPDATE public.lightning_reservation r
     SET state = 'expired',$b$,
$b$     -- ALL FOUR LIVE STATES (2026-09-26). A dealing or settling instance used
     -- to be invisible here, and its committed reservations were a permanent
     -- bar on its players. Its deadline_at is the one begin_dealing or its
     -- last keepalive set, so past it means nothing is vouching for the hand.
     WHERE li.state IN ('forming', 'reserved', 'dealing', 'settling')$b$,
$b$       SET state = 'abandoned',
           -- A HAND THAT WAS BEING DEALT IS VOID (2026-09-26). Nothing writes
           -- money before settlement, so abandoning it moves no chips, and the
           -- reason says whose silence ended it.
           abandon_reason = CASE
             WHEN li.state IN ('dealing', 'settling') THEN
               format('reaped: %s since %s, past the deadline %s that begin_dealing or its last keepalive set, with nothing vouching for it since; the hand is void',
                      li.state, justify_interval(p_now - coalesce(li.started_at, li.created_at)), li.deadline_at)
             ELSE
               format('reaped: %s since %s, past the deadline this instance was born with',
                      li.state, justify_interval(p_now - li.created_at))
           END,
           -- lightning_instance_lifecycle_order wants completed_at on or after
           -- started_at; an instance that never dealt keeps a NULL, exactly as
           -- fn_lightning_instance_abandon leaves it.
           completed_at = CASE WHEN li.started_at IS NOT NULL
                               THEN GREATEST(p_now, li.started_at) ELSE li.completed_at END
     WHERE li.id = i.id;$b$];
BEGIN
  IF v_src ~ 'p_now := LEAST' THEN
    RAISE NOTICE 'fn_lightning_reap_formations already reaps dealing and settling; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_reap_formations carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef(v_fn);
  FOREACH r IN ARRAY ARRAY['p_now := LEAST', 'li.state IN (''forming'', ''reserved'', ''dealing'', ''settling'')',
                           'FOR UPDATE SKIP LOCKED', 'expired_before_commit', 'reservations_expired',
                           'instances_abandoned', 'GREATEST(p_now, li.started_at)'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_reap_formations does not carry "%"', r;
    END IF;
  END LOOP;
  IF regexp_replace(v_live, '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_platform_frozen' THEN
    RAISE EXCEPTION 'the reaper is gated on the freeze, and giving a player back must always be possible';
  END IF;
END
$recut$;

-- ===========================================================================
-- SECTION 7. THE ENGINE'S HEARTBEAT (BLOCKER 1).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_instance_keepalive(
  p_instance_id uuid,
  p_extend      interval                 DEFAULT interval '2 minutes',
  p_now         timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  i          record;
  -- Never from the future, for the same reason the reaper never reaps by a
  -- clock that has not arrived: a deadline is a statement about real time.
  v_now      timestamp with time zone := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
  -- A heartbeat, not a lease: at least thirty seconds so that a keepalive is
  -- worth sending, at most fifteen minutes so that one leaked call cannot keep
  -- a dead engine's players out of the pool for an evening.
  v_extend   interval := LEAST(GREATEST(coalesce(p_extend, interval '2 minutes'), interval '30 seconds'),
                               interval '15 minutes');
  v_deadline timestamp with time zone;
BEGIN
  -- NOT GATED ON THE FREEZE. A hand already in flight when a maintenance break
  -- begins is allowed to finish - "allow already-started hands to resolve
  -- normally" - and refusing its heartbeat would have the reaper abandon it
  -- under a live engine, which is the one thing this function exists to stop.
  SELECT li.id, li.state, li.deadline_at, li.hand_id
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'alive', false, 'reason', 'not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_instance li
                  WHERE li.id = i.id AND li.state IN ('dealing', 'settling')) THEN
    RETURN jsonb_build_object('ok', false, 'alive', false, 'reason', 'wrong_state', 'state', i.state);
  END IF;

  -- A HAND DECLARED DEAD STAYS DEAD. Past its deadline the reaper is entitled
  -- to it and may already hold it, so a late heartbeat is told so rather than
  -- being allowed to race the reaper for a hand whose players are about to be
  -- handed back.
  IF i.deadline_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'alive', false, 'reason', 'past_deadline',
                              'deadline_at', i.deadline_at);
  END IF;

  -- FORWARD ONLY. A short keepalive never shortens a longer window that
  -- begin_dealing or an earlier keepalive granted.
  v_deadline := GREATEST(i.deadline_at, v_now + v_extend);
  UPDATE public.lightning_instance li SET deadline_at = v_deadline WHERE li.id = i.id;

  RETURN jsonb_build_object('ok', true, 'alive', true, 'instance_id', i.id, 'hand_id', i.hand_id,
                            'state', i.state, 'deadline_at', v_deadline);
END
$fn$;

-- ===========================================================================
-- SECTION 8. A STALE SLOT IS CLOSED, NOT RETURNED (MINOR b).
-- ASSERTED SUBSTITUTION INTO fn_lightning_pool_slot_open.
-- ===========================================================================

DO $recut$
DECLARE
  v_fn   constant regprocedure := 'public.fn_lightning_pool_slot_open(uuid,timestamp with time zone)'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_lightning_pool_slot_open(uuid,timestamp with time zone)'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  -- The return anchor goes FIRST: the refusal added by the second replacement
  -- ends in the same text at a deeper indent, which would make it occur twice.
  a      text[] := ARRAY[
$a$                            'cluster_epoch', ps.cluster_epoch);$a$,
$a$  v_slot  uuid;$a$,
$a$  SELECT sl.id INTO v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'opened', false, 'reason', 'already_open',
                              'pool_slot_id', v_slot);
  END IF;$a$];
  b      text[] := ARRAY[
$b$                            'cluster_epoch', ps.cluster_epoch,
                            'stale_slots_closed', v_closed);$b$,
$b$  v_slot  uuid;
  v_closed integer := 0;$b$,
$b$  -- A SESSION FROM A DEAD EPOCH OPENS NOTHING (2026-09-26). The sync pass only
  -- offers sessions at the Cluster's current epoch, but this is callable on its
  -- own, and a slot at a dead epoch is one the barrier can never use and the
  -- one-open-per-player index will not let the player replace.
  IF ps.cluster_epoch IS DISTINCT FROM
     (SELECT g.cluster_epoch FROM public.cash_games g WHERE g.id = ps.cluster_id) THEN
    RETURN jsonb_build_object('ok', false, 'opened', false,
                              'reason', 'pool_session_epoch_is_not_current',
                              'pool_session_epoch', ps.cluster_epoch);
  END IF;

  -- IDEMPOTENT ON THE POOL SESSION (2026-09-26), not on the player. The read
  -- used to be keyed on (Cluster, player, open), so a player who left and came
  -- back - a new pool session - was answered already_open with the slot of the
  -- session that had exited, and one who survived an epoch bump with a slot
  -- at the dead epoch.
  SELECT sl.id INTO v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL
     AND sl.pool_session_id = ps.id AND sl.cluster_epoch = ps.cluster_epoch;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'opened', false, 'reason', 'already_open',
                              'pool_slot_id', v_slot);
  END IF;

  -- ANY OTHER OPEN SLOT OF THIS PLAYER IN THIS CLUSTER IS STALE, and is closed
  -- here, in this call, rather than left for a sync pass: it is bound to a
  -- session that has gone or an epoch that has ended, and while it stays open
  -- lightning_pool_slot_one_open_per_player refuses the slot this player
  -- actually needs. A hand in flight that sat in it is untouched - the hand
  -- names the slot by id, and the player's committed reservation still bars a
  -- second hand until that one ends.
  UPDATE public.lightning_pool_slot sl
     SET closed_at = GREATEST(p_now, sl.opened_at),
         close_reason = CASE WHEN sl.cluster_epoch IS DISTINCT FROM ps.cluster_epoch
                             THEN 'epoch_advanced' ELSE 'superseded_by_pool_session' END,
         updated_at = p_now
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL;
  GET DIAGNOSTICS v_closed = ROW_COUNT;$b$];
BEGIN
  IF v_src ~ 'superseded_by_pool_session' THEN
    RAISE NOTICE 'fn_lightning_pool_slot_open already closes a stale slot; leaving it alone';
  ELSE
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_pool_slot_open carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef(v_fn);
  FOREACH r IN ARRAY ARRAY['superseded_by_pool_session', 'pool_session_epoch_is_not_current',
                           'sl.pool_session_id = ps.id AND sl.cluster_epoch = ps.cluster_epoch',
                           'fn_platform_frozen', 'pool_session_has_exited', 'no_such_pool_session',
                           'FOR UPDATE', 'stale_slots_closed'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_pool_slot_open does not carry "%"', r;
    END IF;
  END LOOP;
  IF position('superseded_by_pool_session' in v_live) > position('INSERT INTO public.lightning_pool_slot' in v_live) THEN
    RAISE EXCEPTION 'fn_lightning_pool_slot_open closes the stale slot after inserting the new one, which the one-open index refuses';
  END IF;
END
$recut$;

-- ===========================================================================
-- SECTION 9. THE BARRIER (BLOCKER 2, MAJORS 4, 5 AND 7, MINORS a AND c).
-- ASSERTED SUBSTITUTION INTO fn_lightning_form_hand, INTO A NEW SIGNATURE.
-- ===========================================================================
--
-- The new signature appends p_matcher_version. CREATE OR REPLACE with a
-- different argument list creates a second function rather than replacing the
-- first, so the re-cut body is EXECUTEd under the new signature and the old
-- eight-argument function is dropped in the same transaction: there is no
-- instant at which a caller can reach a barrier that stamps no versions, and
-- no instant at which two barriers exist.

DO $recut$
DECLARE
  v_old  regprocedure := to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone)');
  v_sig  regprocedure := to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)');
  v_src  text;
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
-- 1. the signature
$a$p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb$a$,
-- 2. the declarations
$a$  v_msg       text;$a$,
-- 3. matcher_version is required, before the freeze check
$a$  -- theFreezeIsTotal. Forming a hand during the maintenance break is exactly$a$,
-- 4. the contention sub-block opens
$a$  -- THE CLUSTER ROW IS TAKEN FOR UPDATE BEFORE THE EPOCH IS READ, which$a$,
-- 5. the reap and the versions, under the Cluster lock
$a$                              'reason', 'epoch_is_not_open', 'cluster_epoch', v_epoch);
  END IF;$a$,
-- 6. the whole-pool measure goes
$a$  -- THE CHIP TOTAL OF THE WHOLE POOL, BEFORE. Compared again after the
  -- formation block; see the end of this function.
  SELECT coalesce(sum(coalesce(ps.starting_stack, 0) + coalesce(ps.net_result, 0)), 0)
    INTO v_before FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;$a$,
-- 7. the pool sessions FOR SHARE, beside the slot lock
$a$   ORDER BY sl.player_id
   FOR UPDATE;$a$,
-- 8. pool entry travels with each candidate
$a$           'debt_age',        bo.debt_age,$a$,
-- 9. the override ties on pool entry too
$a$    SELECT ((e -> 'bb_unresolved'), (e -> 'last_bb_at'), (e -> 'debt_age'))
           IS NOT DISTINCT FROM
           ((v_pool -> 0 -> 'bb_unresolved'), (v_pool -> 0 -> 'last_bb_at'), (v_pool -> 0 -> 'debt_age'))$a$,
-- 10. positions at seven, eight and nine
$a$                            ELSE 'utg' END,$a$,
-- 11. the participants' money, before
$a$  v_hand := gen_random_uuid();$a$,
-- 12. the comment that counts the classes
$a$  -- The exception list is CLOSED: anything that is not one of these five$a$,
-- 13. the retryable classes
$a$    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation
      OR exclusion_violation THEN$a$,
-- 14. the versions, stamped at step 7
$a$    INSERT INTO public.lightning_hand
      (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at)
    VALUES (v_hand, g.id, v_epoch, v_instance, p_now);$a$,
-- 15. the participants' money, after
$a$  SELECT coalesce(sum(coalesce(ps.starting_stack, 0) + coalesce(ps.net_result, 0)), 0)
    INTO v_after FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: Cluster % pool chip total went from % to % while forming hand %, and forming a hand is a seating transition, not an economic transaction',
      g.id, v_before, v_after, v_hand USING ERRCODE = 'check_violation';
  END IF;$a$,
-- 16. the formed event names its matcher
$a$    'bb', v_bb, 'sb', v_sb, 'btn', v_btn, 'at', p_now), v_epoch);$a$,
-- 17. the contention sub-block closes
$a$                            'seats', v_seats, 'state', 'reserved');$a$];
  b      text[] := ARRAY[
-- 1
$b$p_now timestamp with time zone DEFAULT clock_timestamp(), p_matcher_version text DEFAULT NULL::text)
 RETURNS jsonb$b$,
-- 2
$b$  v_msg       text;
  -- 2026-09-26: the participants' money under the FOR SHARE lock, and the
  -- versions the hand is stamped with at step 7.
  v_money_before      text;
  v_money_after       text;
  v_rules_version     text;
  v_rake_version      text;
  v_blind_version     text;
  v_lightning_version text;$b$,
-- 3
$b$  -- SPECIFICATION 2139 (2026-09-26). Every hand records its matcher_version,
  -- and the matcher is the one component the database cannot see, so only the
  -- caller can say which one it is. Refused before anything is locked, read or
  -- written.
  IF p_matcher_version IS NULL OR length(btrim(p_matcher_version)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'matcher_version_required');
  END IF;

  -- theFreezeIsTotal. Forming a hand during the maintenance break is exactly$b$,
-- 4
$b$  -- CONTENTION IS A RETRY, NOT A CRASH (2026-09-26). From here to the end of
  -- the function the barrier waits on locks - the Cluster row, the slots, the
  -- participants' pool sessions, the reap - and the estate sets lock_timeout.
  -- This sub-block catches lock_not_available, deadlock_detected and
  -- serialization_failure, and only those, rolls the whole formation back and
  -- answers formation_contended with a matcher_retry. It does NOT catch
  -- query_canceled: a cancel belongs to whoever asked for it, and the header of
  -- 20260926023047 says why.
  BEGIN

  -- THE CLUSTER ROW IS TAKEN FOR UPDATE BEFORE THE EPOCH IS READ, which$b$,
-- 5
$b$                              'reason', 'epoch_is_not_open', 'cluster_epoch', v_epoch);
  END IF;

  -- THE NEXT FORMATION BURIES THE LAST ONE'S CORPSE (2026-09-26). DECISION 2 of
  -- 20260925215731 said this and put it in fn_lightning_instance_open, which no
  -- formation path calls. It is here now, under the Cluster row lock and before
  -- the INSERT below, so a player it hands back is a legal candidate in this
  -- same call. The reaper clamps its clock to clock_timestamp().
  PERFORM public.fn_lightning_reap_formations(p_now, 200, g.id);

  -- SPECIFICATION 2137-2143: THE VERSIONS THIS HAND IS FORMED UNDER, read now,
  -- under the same Cluster row lock that binds its epoch. The header of
  -- 20260926023047 says why each comes from where it does.
  SELECT 'ruleset:' || md5(coalesce(cg.ruleset_snapshot, '{}'::jsonb)::text),
         'rake:' || md5(coalesce(cg.ruleset_snapshot -> 'rake', 'null'::jsonb)::text)
    INTO v_rules_version, v_rake_version
    FROM public.cash_games cg WHERE cg.id = g.id;
  SELECT 'fn_lightning_blind_order:' || md5(p.prosrc) INTO v_blind_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure;
  SELECT 'fn_lightning_form_hand:' || md5(p.prosrc) INTO v_lightning_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)'::regprocedure;$b$,
-- 6
$b$  -- THE MONEY GUARD NO LONGER MEASURES THE WHOLE POOL (2026-09-26). It read
  -- every pool session of the Cluster in two READ COMMITTED statements under no
  -- lock, so any commit anywhere in the Cluster between them looked like this
  -- formation moving money. It measures the participants now, under the
  -- FOR SHARE lock step 1 takes; see v_money_before below.$b$,
-- 7
$b$   ORDER BY sl.player_id
   FOR UPDATE;

  -- AND THEIR POOL SESSIONS, FOR SHARE (2026-09-26), in pool session id order
  -- and BEFORE a single stack is read. From here to commit no other
  -- transaction can change a candidate's starting_stack, net_result,
  -- ending_stack or exited_at, so the stack_before snapshotted below is the
  -- stack that is still there when the hand commits, and the money guard at the
  -- end measures what THIS transaction did and nothing else. A settlement
  -- writing to one of these players waits for the formation, which is
  -- milliseconds.
  PERFORM 1 FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT sl.pool_session_id FROM public.lightning_pool_slot sl
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ps.id
   FOR SHARE;$b$,
-- 8
$b$           'debt_age',        bo.debt_age,
           'entered_pool',    bo.entered_pool,$b$,
-- 9
$b$    -- AND POOL ENTRY (2026-09-26), P2 tie-break 3. Without it a matcher could
    -- name a player who loses on pool entry. The only freedom left is among
    -- players P2 cannot tell apart except by id, and the id is a tie-break for
    -- determinism, not a fairness rule.
    SELECT ((e -> 'bb_unresolved'), (e -> 'last_bb_at'), (e -> 'debt_age'), (e -> 'entered_pool'))
           IS NOT DISTINCT FROM
           ((v_pool -> 0 -> 'bb_unresolved'), (v_pool -> 0 -> 'last_bb_at'), (v_pool -> 0 -> 'debt_age'),
            (v_pool -> 0 -> 'entered_pool'))$b$,
-- 10
$b$                            -- SEVEN, EIGHT AND NINE HANDED (2026-09-26). Every
                            -- seat below the hijack used to be utg, so an
                            -- eight-handed hand had three players under the
                            -- gun and three utg_counts moved. Exactly one now.
                            WHEN s.seat = 3             THEN 'utg'
                            WHEN s.seat = v_n - 3       THEN 'lj'
                            WHEN s.seat = 4             THEN 'utg1'
                            ELSE 'utg2' END,$b$,
-- 11
$b$  -- F12'S SHAPE, MEASURED OVER THE PARTICIPANTS (2026-09-26). Every money
  -- column of every participant's pool session, ordered, as text - not a sum,
  -- so two stacks that swapped are a difference too. These rows are held
  -- FOR SHARE since step 1, so nothing but this transaction can change them
  -- before the comparison at the end.
  SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                    || ':' || coalesce(ps.net_result::text, 'null')
                    || ':' || coalesce(ps.ending_stack::text, 'null')
                    || ':' || coalesce(ps.exited_at::text, 'open'), '|' ORDER BY ps.id)
    INTO v_money_before
    FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);

  v_hand := gen_random_uuid();$b$,
-- 12
$b$  -- The exception list is CLOSED: anything that is not one of these eight$b$,
-- 13
$b$    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation
      OR exclusion_violation
      -- THE RETRYABLE CLASSES (2026-09-26). A lock wait past lock_timeout, a
      -- deadlock victim and a serialization failure are exactly what
      -- specification 732-733 means by "retry where safe": this block is
      -- rolled back whole and the caller retries in a fresh transaction.
      OR lock_not_available OR deadlock_detected OR serialization_failure THEN$b$,
-- 14
$b$    INSERT INTO public.lightning_hand
      (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at,
       rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version)
    VALUES (v_hand, g.id, v_epoch, v_instance, p_now,
            v_rules_version, btrim(p_matcher_version), v_blind_version, v_lightning_version, v_rake_version);$b$,
-- 15
$b$  SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                    || ':' || coalesce(ps.net_result::text, 'null')
                    || ':' || coalesce(ps.ending_stack::text, 'null')
                    || ':' || coalesce(ps.exited_at::text, 'open'), '|' ORDER BY ps.id)
    INTO v_money_after
    FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);
  IF v_money_after IS DISTINCT FROM v_money_before THEN
    RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: the pool sessions of the % participants of hand % in Cluster % were rewritten while it was formed (% became %), and forming a hand is a seating transition, not an economic transaction',
      v_n, v_hand, g.id, v_money_before, v_money_after USING ERRCODE = 'check_violation';
  END IF;$b$,
-- 16
$b$    'bb', v_bb, 'sb', v_sb, 'btn', v_btn, 'matcher_version', btrim(p_matcher_version),
    'at', p_now), v_epoch);$b$,
-- 17
$b$                            'seats', v_seats, 'state', 'reserved');

  EXCEPTION
    WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      -- Everything since the sub-block opened is rolled back: the reap, the
      -- formation, every lock taken after the Cluster row. The evidence is
      -- written here, after the rollback, and is the one thing that survives
      -- it. cluster_epoch 0 lets trg_cash_cluster_events_take_the_clusters_epoch
      -- fill in the Cluster's epoch when the lock that failed was the one
      -- taken before the epoch was read.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
      VALUES (p_cluster_id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_contended', 'sqlstate', v_sqlstate, 'message', v_msg,
        'at', p_now), coalesce(v_epoch, 0));
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_contended',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;$b$];
BEGIN
  IF v_sig IS NOT NULL AND v_old IS NULL THEN
    RAISE NOTICE 'fn_lightning_form_hand already carries p_matcher_version; leaving it alone';
  ELSIF v_old IS NOT NULL AND v_sig IS NULL THEN
    v_src := pg_get_functiondef(v_old);
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_lightning_form_hand carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
    DROP FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone);
  ELSE
    RAISE EXCEPTION 'fn_lightning_form_hand exists under % of its two signatures; refusing to guess which is the barrier',
      CASE WHEN v_old IS NULL THEN 'neither' ELSE 'both' END;
  END IF;

  v_sig := to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text)');
  IF v_sig IS NULL OR to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone)') IS NOT NULL THEN
    RAISE EXCEPTION 'after the re-cut the barrier is not exactly the nine-argument fn_lightning_form_hand';
  END IF;
  v_live := pg_get_functiondef(v_sig);
  -- THE NEW BEHAVIOUR, READ BACK.
  FOREACH r IN ARRAY ARRAY['matcher_version_required', 'fn_lightning_reap_formations(p_now, 200, g.id)',
                           'FOR SHARE', 'v_money_after IS DISTINCT FROM v_money_before',
                           'OR lock_not_available OR deadlock_detected OR serialization_failure THEN',
                           'WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN',
                           'formation_contended', '''entered_pool'',    bo.entered_pool',
                           'rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version',
                           'THEN ''utg1''',
                           -- AND EVERY SIBLING BEHAVIOUR OF THE BARRIER SURVIVED.
                           'fn_platform_frozen', 'no_candidate_set', 'cluster_is_not_lightning',
                           'epoch_is_not_open', 'insufficient_legal_candidates', 'bb_choice_is_not_p2_legal',
                           'fn_lightning_blind_order(g.id, v_epoch, v_legal)', 'LIGHTNING_FORMATION_SET_IS_WRONG',
                           'LIGHTNING_FORMATION_MOVED_MONEY', 'formation_refused', 'lightning_hand_formed',
                           'SET participants_locked_at = p_now, player_count = v_n::smallint',
                           'lightning_blind_ledger', 'last_bb_at     = CASE'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the re-cut fn_lightning_form_hand does not carry "%"', r;
    END IF;
  END LOOP;
  v_live := regexp_replace(v_live, '--[^' || chr(10) || ']*', '', 'g');
  IF NOT (position('FOR SHARE' in v_live) < position('fn_lightning_pool_stack' in v_live)
          AND position('fn_lightning_reap_formations' in v_live) < position('INSERT INTO public.lightning_instance' in v_live)
          AND position('matcher_version_required' in v_live) < position('fn_platform_frozen' in v_live)) THEN
    RAISE EXCEPTION 'the re-cut fn_lightning_form_hand has its lock, its reap or its version check in the wrong place';
  END IF;
  IF v_live ~ 'ps\.cluster_id = g\.id AND ps\.exited_at IS NULL' THEN
    RAISE EXCEPTION 'the whole-pool money measure survived the re-cut';
  END IF;
  IF v_live ~ 'query_canceled|57014' THEN
    RAISE EXCEPTION 'the barrier catches query_canceled, and a cancel belongs to whoever asked for it';
  END IF;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the barrier now mentions is_horse';
  END IF;
END
$recut$;

-- ===========================================================================
-- SECTION 10. THE PASS THAT REACHES THEM (BLOCKER 2).
-- ASSERTED SUBSTITUTION INTO fn_cash_clusters_tick_all.
-- ===========================================================================
--
-- The Lightning reap and the pool sync go AFTER the freeze short-circuit - a
-- frozen platform still costs one row read, and recovery that is wanted during
-- a break is an operator's direct call, which neither function refuses - AFTER
-- the Phase 5 conversion reap, and BEFORE the per-game loop. The estate-wide
-- reap is one sub-block and each Cluster's sync is its own, because tick_all
-- sets lock_timeout to 2000ms and one held row must cost one step, not the
-- pass. WHEN OTHERS there does not catch query_canceled, so the pass's own
-- eight-second statement_timeout still ends the pass. Nothing added here
-- converts a Cluster, and nothing added here mentions is_horse.

DO $pass$
DECLARE
  v_fn   constant regprocedure := 'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure;
  v_src  text := pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure);
  v_new  text;
  v_live text;
  v_n    integer;
  k      integer;
  r      text;
  a      text[] := ARRAY[
$a$  v_reaped jsonb := '{}'::jsonb;$a$,
$a$    v_reaped := jsonb_build_object('ok', false, 'sqlstate', v_sqlstate, 'message', v_message);
  END;$a$,
$a$    'reaped', v_reaped,$a$];
  b      text[] := ARRAY[
$b$  v_reaped jsonb := '{}'::jsonb;
  v_lightning_reaped jsonb := '{}'::jsonb;
  v_lightning_synced jsonb := '[]'::jsonb;
  lc record;$b$,
$b$    v_reaped := jsonb_build_object('ok', false, 'sqlstate', v_sqlstate, 'message', v_message);
  END;

  -- LIGHTNING'S RECOVERY AND ITS POOL DOOR (2026-09-26). Until now nothing in
  -- the estate called either: no formation path reaped, and no player entering
  -- a Lightning pool was ever given a slot. The reap hands back the players of
  -- any instance - forming, reserved, dealing or settling - that nothing has
  -- vouched for past its deadline; the sync opens a slot for every pool
  -- session that has none and closes every slot whose session or epoch has
  -- gone. Clusters that are lightning, and any other Cluster still holding an
  -- open slot, because a Cluster reverted to must_move keeps slots at a dead
  -- epoch until something closes them. Neither converts anything.
  BEGIN
    v_lightning_reaped := public.fn_lightning_reap_formations();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_lightning_reaped := jsonb_build_object('ok', false, 'sqlstate', v_sqlstate, 'message', v_message);
  END;

  FOR lc IN
    SELECT cg.id FROM public.cash_games cg
     WHERE cg.cluster_mode = 'lightning'
        OR EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
                    WHERE sl.cluster_id = cg.id AND sl.closed_at IS NULL)
     ORDER BY cg.id
  LOOP
    BEGIN
      v_lightning_synced := v_lightning_synced || jsonb_build_object(
        'cluster_id', lc.id, 'result', public.fn_lightning_pool_slots_sync(lc.id));
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_lightning_synced := v_lightning_synced || jsonb_build_object(
        'cluster_id', lc.id, 'error', jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message));
    END;
  END LOOP;$b$,
$b$    'reaped', v_reaped,
    'lightning_reaped', v_lightning_reaped,
    'lightning_synced', v_lightning_synced,$b$];
BEGIN
  IF v_src ~ 'fn_lightning_reap_formations' THEN
    RAISE NOTICE 'fn_cash_clusters_tick_all already reaps and syncs Lightning; leaving it alone';
  ELSE
    IF (SELECT count(*) FROM regexp_matches(v_src, 'FOR w IN', 'g')) <> 1 THEN
      RAISE EXCEPTION 'fn_cash_clusters_tick_all carries its pass loop more than once; refusing to substitute blind';
    END IF;
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'fn_cash_clusters_tick_all carries anchor % % time(s) rather than once; refusing to substitute blind', k, v_n;
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;

  v_live := pg_get_functiondef(v_fn);
  IF (SELECT count(*) FROM regexp_matches(v_live, 'public\.fn_lightning_reap_formations\(\)', 'g')) <> 1
     OR (SELECT count(*) FROM regexp_matches(v_live, 'public\.fn_lightning_pool_slots_sync\(lc\.id\)', 'g')) <> 1 THEN
    RAISE EXCEPTION 'the live pass does not call the Lightning reap and the pool sync exactly once each';
  END IF;
  -- AFTER THE FREEZE AND THE CONVERSION REAP, BEFORE THE LOOP, asserted by
  -- position rather than by reading the diff, because that order is the whole
  -- of the argument above.
  IF NOT (position('fn_platform_frozen' in v_live) < position('fn_cash_cluster_reap_stuck_conversions' in v_live)
          AND position('fn_cash_cluster_reap_stuck_conversions' in v_live) < position('fn_lightning_reap_formations' in v_live)
          AND position('fn_lightning_reap_formations' in v_live) < position('fn_lightning_pool_slots_sync' in v_live)
          AND position('fn_lightning_pool_slots_sync' in v_live) < position('FOR w IN' in v_live)) THEN
    RAISE EXCEPTION 'the Lightning steps are not between the conversion reap and the pass loop';
  END IF;
  -- EVERY SIBLING BEHAVIOUR OF THE PASS SURVIVED.
  FOREACH r IN ARRAY ARRAY['fn_cash_cluster_tick', 'fn_cash_cluster_balance', 'lock_timeout',
                           'controller_tick_error', 'v_budget', 'rested_games', 'deferred',
                           'fn_platform_frozen', 'fn_cash_cluster_reap_stuck_conversions',
                           '''reaped'', v_reaped', 'lightning_reaped', 'lightning_synced'] LOOP
    IF position(r in v_live) = 0 THEN
      RAISE EXCEPTION 'the substitution into fn_cash_clusters_tick_all ate %', r;
    END IF;
  END LOOP;
  IF v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and the pass now mentions is_horse';
  END IF;
  -- THE CAPABILITY GATE. Converting a Cluster before a matcher exists strands
  -- its players; the pass must never be the thing that does it.
  IF regexp_replace(v_live, '--[^' || chr(10) || ']*', '', 'g')
     ~ 'fn_cash_cluster_begin_pending_on|fn_cash_cluster_commit_lightning|fn_cash_cluster_abort_pending_on' THEN
    RAISE EXCEPTION 'the pass now calls a conversion function, and nothing may convert a Cluster before its matcher exists';
  END IF;
END
$pass$;

-- ===========================================================================
-- SECTION 11. NOTHING HERE IS REACHABLE BY A BROWSER (SPECIFICATION 532).
-- ===========================================================================

REVOKE ALL ON FUNCTION public.fn_lightning_instance_keepalive(uuid, interval, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_keepalive(uuid, interval, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_refuses_truncate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_refuses_truncate() TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone, text) TO service_role;

COMMENT ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone, text) IS
  'THE HAND FORMATION BARRIER, specification 503-517, steps 1 to 10 and the binding that makes step 13 legal, re-cut by 20260926023047. Takes a candidate set in the matcher''s order and the matcher''s own version, reaps its Cluster, locks the candidates'' slots FOR UPDATE and their pool sessions FOR SHARE before reading a stack, and either returns a fully formed hand - instance opened and bound, seats reserved, positions and blind roles assigned along the whole five-term P2 key, stack_before snapshotted, an immutable hand_id stamped with rules_version, matcher_version, blind_algorithm_version, lightning_version and rake_version, and the participant set latched - or returns formed:false having written nothing but a matcher_retry. Refusals of data and contention (lock_not_available, deadlock_detected, serialization_failure) are retries; query_canceled and any money moving during formation are not, and propagate. Steps 11 and 12, the shuffle and the deal, are the engine''s.';

COMMENT ON FUNCTION public.fn_lightning_reap_formations(timestamp with time zone, integer, uuid) IS
  'Expires pending reservations past expires_at and abandons forming, reserved, dealing and settling instances past deadline_at - for a dealing or settling hand, the deadline begin_dealing or its last fn_lightning_instance_keepalive set, so a hand is reaped only when nothing has vouched for it - releasing their reservations through trg_lightning_instance_releases_its_reservations. Never reaps by a clock that has not arrived: p_now is clamped to clock_timestamp(). Called by fn_lightning_form_hand for its own Cluster and by fn_cash_clusters_tick_all for the estate. Deliberately NOT gated on fn_platform_frozen(): giving a player back is recovery, and the break is when recovery happens.';

COMMENT ON FUNCTION public.fn_lightning_instance_keepalive(uuid, interval, timestamp with time zone) IS
  'The engine''s heartbeat for a hand in flight. Moves deadline_at of a dealing or settling instance forward to at least now plus p_extend (30 seconds to 15 minutes), never backwards, and refuses an instance already past its deadline: a hand the reaper is entitled to is not brought back by a late caller. Without a keepalive a dealing hand is reaped when the deal window begin_dealing set runs out; with one it is reaped only when the engine stops vouching for it. Not gated on the freeze, because a hand already in flight when a break begins is allowed to finish.';

COMMENT ON FUNCTION public.fn_lightning_refuses_truncate() IS
  'BEFORE TRUNCATE, FOR EACH STATEMENT, on all seven lightning tables. Row triggers do not fire on TRUNCATE, so without this one statement erases every fact Phase 9''s immutability triggers keep. Fires for every role including the owner, which a REVOKE cannot bind.';

COMMIT;
