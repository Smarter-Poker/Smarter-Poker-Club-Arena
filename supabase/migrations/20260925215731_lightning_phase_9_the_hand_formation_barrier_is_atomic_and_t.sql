-- 20260925215731_lightning_phase_9_the_hand_formation_barrier_is_atomic_and_t.sql
--
-- LIGHTNING PHASE 9: THE HAND FORMATION BARRIER IS ATOMIC, AND THE PARTICIPANT
-- SET IS LOCKED THE MOMENT IT IS COMPLETE.
--
-- WHERE THIS STOPS, AND WHY THAT IS NOT A GAP.
--
-- The specification's barrier has thirteen steps. This file builds ONE to TEN,
-- and it builds the PRECONDITION of thirteen. It does not build eleven or
-- twelve, and it must not: step 11 is "shuffle using existing authoritative RNG
-- architecture" and step 12 is "commit deck/deal", and neither a shuffle nor a
-- deal belongs in the database. The authoritative RNG lives in the engine, the
-- deck never touches a table in this schema, and a hole card that existed as a
-- row in Postgres would be a hole card that every replica, every backup and
-- every future SELECT could see. So what this file produces is a FORMED,
-- LOCKED, IMMUTABLE PARTICIPANT SET - an instance bound to a Cluster and an
-- epoch, seats assigned, positions and blind roles assigned, stack_before
-- snapshotted, an immutable hand_id, and a latch that makes every one of those
-- facts unwritable afterwards - which the engine then shuffles for and deals.
-- Step 13, "release hand into gameplay", is a door
-- (fn_lightning_instance_begin_dealing) whose precondition is checked here and
-- whose far side is the engine's.
--
-- THE FAILURE THIS WHOLE FILE EXISTS TO PREVENT.
--
-- A Lightning hand is formed out of a pool, not out of a table. Nobody is
-- sitting anywhere. The set of people in a hand is decided by a matcher, in
-- code, in the space of a few milliseconds, and until the barrier closes there
-- is nothing in the database that says who those people are. That is the
-- window. In it, two matchers can pick the same player for two hands; a player
-- who has already left the pool can be dealt in; a seat can be handed to two
-- people; a blind can be assigned to somebody the fairness policy would never
-- have chosen; and - worst, because it is silent - a hand can be formed,
-- partially written, and then interrupted, leaving reservations held by a
-- player who is not in any hand and an instance nobody will ever finish.
--
-- Every one of those is a state the DATABASE can be made to refuse, and this
-- file refuses them in the database rather than in the matcher, because the
-- matcher does not exist yet and when it does there will be more than one
-- version of it running at once during a deploy.
--
-- ---------------------------------------------------------------------------
-- DECISION 1: THE POOL SLOT IS CREATED ON POOL ENTRY, NOT BY THE CONVERSION.
-- ---------------------------------------------------------------------------
--
-- fn_cash_cluster_commit_lightning creates a lightning_pool_session for every
-- eligible seated player and creates NO lightning_pool_slot. A reservation
-- cannot exist without a slot - lightning_reservation_belongs_to_its_slot is a
-- four-column foreign key into lightning_pool_slot - so as things stand no
-- Lightning hand can be formed for anybody at all.
--
-- There were two places to fix that, and the conversion is the wrong one, for
-- two independent reasons.
--
--   FIRST, IT WOULD HAVE TO BE DONE BY ASSERTED SUBSTITUTION. 20260921151618 is
--   applied; its function body is 6,000 characters of load-bearing conversion
--   logic; and editing an applied migration is forbidden. The only way to add
--   a statement to it is to read pg_get_functiondef, assert an anchor occurs
--   once, replace() it and EXECUTE the result - which is exactly the pattern
--   scripts/dev/test-lightning-phase5-conversion.sh was written because of: a
--   substitution into a body nobody has measured is a substitution into
--   whatever happens to be installed, and it passes every assertion it makes
--   about itself.
--
--   SECOND, AND FATALLY, THE CONVERSION IS NOT THE ONLY DOOR INTO THE POOL.
--   It runs once, for the founding population, at the instant a Cluster
--   becomes Lightning. Every player who joins that Cluster afterwards - which
--   is nearly everybody who will ever play in it - arrives through a door the
--   conversion has long since stopped watching. A slot created by the
--   conversion would cover the first twenty people and nobody after them, and
--   the defect would present as "Lightning works for an hour after a
--   conversion and then quietly stops dealing anyone new in".
--
-- So the slot is opened by fn_lightning_pool_slot_open, keyed on the pool
-- session, idempotent, and fn_lightning_pool_slots_sync opens one for every
-- open pool session that has not got one and closes every slot whose pool
-- session has gone. One writer, both doors, and the founding population of a
-- Cluster converted before this file existed is picked up by the same sync
-- pass that picks up the next arrival.
--
-- ---------------------------------------------------------------------------
-- DECISION 2: AN INSTANCE IS BORN WITH A DEADLINE, AND THE NEXT FORMATION
-- BURIES THE LAST ONE'S CORPSE.
-- ---------------------------------------------------------------------------
--
-- Phase 5 learned this the expensive way. A Cluster could be left in PENDING_ON
-- for ever, because the thing that put it there had no obligation to take it
-- out again, and the answer arrived afterwards as
-- fn_cash_cluster_reap_stuck_conversions - a reaper bolted to the cluster tick,
-- which works, and which only works while somebody keeps calling the tick.
--
-- A `forming` Lightning instance is the same shape and much worse, because
-- there are thousands of them an hour and each one holds reservations that
-- make its players unmatchable. So this file does not rely on a reaper alone:
--
--   1. lightning_instance.deadline_at is NOT NULL with a default and a CHECK
--      that it is later than created_at. An instance cannot be created without
--      a deadline. There is no code path that forgets one, because there is no
--      code path that is allowed to.
--
--   2. fn_lightning_instance_open REAPS THE CLUSTER'S EXPIRED INSTANCES BEFORE
--      IT OPENS A NEW ONE, in the same transaction. A Cluster that keeps
--      forming hands cleans itself; a Cluster that has stopped forming hands
--      has no live instance that matters, and the first formation after the
--      outage clears whatever the outage left.
--
--   3. fn_lightning_instance_begin_dealing refuses an instance already past its
--      deadline, so a stale formed hand cannot be released into gameplay by a
--      late caller holding its id.
--
--   4. fn_lightning_reap_formations exists for the estate-wide sweep, and is
--      deliberately NOT gated on fn_platform_frozen(), for the same reason
--      fn_cash_cluster_abort_pending_on is not: recovery is what the break is
--      for.
--
-- The point is that (1) and (2) are true with nothing scheduled. The reaper is
-- the third line of defence here rather than the first.
--
-- ---------------------------------------------------------------------------
-- DECISION 3: ONE ACTIVE RESERVATION PER PLAYER IS AN INDEX, AND THAT FORCED
-- THE POOL TO BE SINGLE-SLOT.
-- ---------------------------------------------------------------------------
--
-- Specification 725 is absolute: "A player can never have more than one active
-- Lightning reservation within the same logical gaming session." The schema as
-- built enforces something weaker and differently shaped -
-- lightning_reservation_one_pending_per_slot, unique on pool_slot_id where the
-- state is pending. That is one pending reservation per SLOT.
--
-- And lightning_pool_slot_one_open is unique on (player_id, cluster_id, slot)
-- where closed_at is null - so one player may hold slot 1 AND slot 2 open in
-- the same Cluster at the same time, and therefore two pending reservations,
-- and therefore be dealt into two hands at once out of a single stack. The
-- per-slot index is not a weaker version of rule 725; it is orthogonal to it.
--
-- Two indexes close that, and they have to be read together:
--
--   lightning_reservation_one_active_per_player, unique on
--   (cluster_id, player_id) where state IN ('pending','committed') - "active"
--   meaning taken and not yet given back, which is both halves of it: a
--   pending reservation is a claim, and a committed one is a player who is IN
--   a hand. A player in a hand may not be reserved for another.
--
--   lightning_pool_slot_one_open_per_player, unique on (cluster_id, player_id)
--   where closed_at is null - one open slot per player per Cluster, which is
--   what makes the first index total rather than a thing a second slot walks
--   around.
--
-- The second of those is a real narrowing of the schema's intent, and it is
-- worth saying so out loud: lightning_pool_slot.slot ranges 1..24 because the
-- pool was designed to let one player hold several concurrent seats. Rule 725
-- and a multi-slot pool cannot both be true. Rule 725 is the specification, so
-- the pool is single-slot until the specification says otherwise, and the slot
-- column keeps its range so that the day it changes, only the index moves.
--
-- A committed reservation is returned to the player when its INSTANCE reaches
-- a terminal state - complete or abandoned - by
-- trg_lightning_instance_releases_its_reservations, which is an AFTER trigger
-- on lightning_instance rather than a line in a function, so that it is true of
-- every road into `complete` including the settlement phase that has not been
-- written yet.
--
-- ---------------------------------------------------------------------------
-- THE BARRIER IS ONE FUNCTION, ONE TRANSACTION, AND ITS FAILURE PATH LEAVES
-- NOTHING BEHIND AT ALL.
-- ---------------------------------------------------------------------------
--
-- Specification 727-733 says that when formation fails the system must release
-- player reservations, release seat reservations, release instance
-- reservations, restore the player to the correct pool state, retry where safe
-- and emit matcher_retry.
--
-- fn_lightning_form_hand does all of the writing inside an inner
-- BEGIN ... EXCEPTION block. A unique violation, a check violation, a foreign
-- key violation, a not-null violation or one of the barrier's own pre-commit
-- assertions rolls that block back to its implicit savepoint - and the
-- instance, the reservations, the hand and the hand players all cease to have
-- ever existed. That is stronger than releasing them: there is no released
-- reservation to read, no abandoned instance to reap, no partially written
-- hand, and the players' pool state is restored because it was never changed.
--
-- The one thing that must SURVIVE the rollback is the evidence, so the
-- matcher_retry event is emitted in the OUTER block, after the rollback, into
-- cash_cluster_events, carrying the SQLSTATE and message of whatever refused.
-- A retry that leaves no trace is a retry loop nobody can see.
--
-- The exception list is deliberately closed. Anything that is not one of those
-- five classes propagates and aborts the caller's transaction, because a
-- barrier that swallows every error is a barrier that turns a bug into a
-- silent no-hand, and the Lightning pool would simply stop dealing with no row
-- anywhere saying why.
--
-- ---------------------------------------------------------------------------
-- WHAT IS IMPLEMENTED OF P2, AND WHAT IS LEFT TO THE MATCHER.
-- ---------------------------------------------------------------------------
--
-- P2 (specification 598-624) is the matcher's policy and this is not the
-- matcher. But the barrier is the thing that WRITES the blind roles, so a
-- barrier that assigns them freely makes P2 unenforceable no matter how good
-- the matcher is. What is implemented here is the floor:
--
--   IMPLEMENTED. The primary BB candidate is the eligible player with the
--   oldest unresolved BB obligation, read from lightning_blind_ledger
--   (missed_bb_debt, bb_owed) and lightning_pool_slot.last_bb_at, ordered
--   exactly along lightning_pool_slot_oldest_bb - the P2 index that was built
--   for this and until now had no reader: unresolved obligation first, then
--   last_bb_at ascending NULLS FIRST so a player who has never paid a big
--   blind outranks everyone who has, then blind-debt age, then pool entry,
--   then player_id as the deterministic stable tie-break. That is tie-breaks
--   1, 2, 3 and 4 of specification 604-608, in order.
--
--   IMPLEMENTED. The small blind is the next player by the same key, and the
--   barrier stamps last_bb_at, last_sb_at, last_button_at, hands_since_bb and
--   hands_since_sb, and increments the six role counters in
--   lightning_blind_ledger. Without that stamp the same player is the big
--   blind of every hand for ever, because last_bb_at would never move.
--
--   IMPLEMENTED AS A REFUSAL. The barrier takes an optional p_bb_player - the
--   matcher's own choice - and refuses it unless it ties, on the whole P2 key,
--   with the candidate the barrier would have chosen. So the matcher may
--   decide, and may not decide something P2 could never have chosen. That is
--   the only P2 rule that has to live down here.
--
--   LEFT TO THE MATCHER. Which players are candidates at all; the micro-batch;
--   the convergence toward equal BB burden over long runs; missed_bb_debt and
--   bb_owed themselves, which are obligations created when a blind is DUE and
--   discharged when it is POSTED, and posting is the engine's; and every one
--   of P3's position-fairness questions, which are advisory by specification
--   and must never delay a legal hand. The barrier fills seats 3..n in the
--   ORDER THE CALLER GAVE THEM, untouched, so that when the matcher has a
--   button policy the barrier is already obeying it.
--
--   THE BARRIER WRITES NO MONEY. missed_bb_debt, bb_owed, sb_owed,
--   starting_stack, net_result and ending_stack are not touched by anything in
--   this file. Forming a hand moves no chips; it only records who is obliged
--   to post what, and posting happens after step 12.
--
-- ---------------------------------------------------------------------------
-- THE FOUR "NO" RULES, AND WHERE EACH ONE ACTUALLY BITES.
-- ---------------------------------------------------------------------------
--
-- Specification 519-524. These are enforced by triggers on lightning_hand and
-- lightning_hand_player rather than by discipline in the functions, so that
-- they are true of a hand written by a future phase, by a backfill script, by
-- an operator with psql, or by a matcher that has a bug. Neither table is one
-- of the nine MONEY_TABLEs scripts/ci/check-money-trigger-declared.mjs watches,
-- so no declaration row is required or written.
--
-- The latch is one column: lightning_hand.participants_locked_at. It is NULL
-- while the barrier is assembling the hand and set, once, in the same statement
-- that records player_count, at barrier step 10. It is a ONE-WAY latch -
-- trg_lightning_hand_is_immutable refuses to clear it or to move it - and every
-- rule below keys off it, so "after the formation barrier" is a fact in a
-- column rather than a convention in a function.
--
--   no participant substitution ... UPDATE of player_id or pool_slot_id on a
--                                   locked hand is refused, and so is DELETE of
--                                   a participant row.
--   no silent seat swap ........... UPDATE of seat on a locked hand is refused.
--   no blind reassignment ......... UPDATE of position or blind_role on a
--                                   locked hand is refused, and so is
--                                   stack_before, which is the snapshot the
--                                   blinds are posted against.
--   no additional player insertion . INSERT into lightning_hand_player for a
--                                   locked hand is refused outright.
--   no matcher mutation ........... is the four above plus: lightning_hand may
--                                   not be DELETEd at all, its hand_id,
--                                   cluster_id, cluster_epoch,
--                                   lightning_instance_id, formed_at and
--                                   player_count are frozen, and
--                                   lightning_instance.hand_id is write-once,
--                                   so a hand cannot be re-pointed at a
--                                   different instance nor an instance at a
--                                   different hand.
--
-- fold_type and stack_after stay writable, always. They are the hand being
-- PLAYED, which is the whole point of forming it, and freezing them would
-- freeze the game.
--
-- ---------------------------------------------------------------------------
-- NOTHING FORMS FOR A CLUSTER THAT IS NOT LIGHTNING, AND NOTHING FORMS ACROSS
-- AN EPOCH BOUNDARY.
-- ---------------------------------------------------------------------------
--
-- Barrier step 9 is "bind cluster_epoch". lightning_instance already carries a
-- foreign key into cash_cluster_epoch, which proves the epoch EXISTED; it does
-- not prove it is the epoch the Cluster is in now, and an epoch bump is exactly
-- what happens when a Cluster is converted, reverted or re-converted. So
-- trg_lightning_instance_is_disciplined refuses an INSERT whose cluster is not
-- in cluster_mode 'lightning' with lightning_enabled true, whose cluster_epoch
-- is not the Cluster's CURRENT epoch, or whose cash_cluster_epoch row has been
-- ended. It is a trigger and not a CHECK because it has to read two other
-- tables, and it is on the table rather than in the function because a hand
-- formed for a must_move Cluster by any route at all is a hand dealt at tables
-- that are still dealing.
--
-- The barrier additionally takes the cash_games row FOR UPDATE before it reads
-- the epoch, which serialises formation against the conversion's own
-- FOR UPDATE and makes "the epoch I bound is the epoch that was current" true
-- rather than likely.
--
-- ---------------------------------------------------------------------------
-- stack_before COMES FROM WHERE THE CONVERSION PUT IT.
-- ---------------------------------------------------------------------------
--
-- The conversion wrote lightning_pool_session.starting_stack = the player's
-- table_seats.stack at the instant the Cluster became Lightning, and every hand
-- since has moved lightning_pool_session.net_result. So the player's stack now
-- is starting_stack + net_result, and that is what fn_lightning_pool_stack
-- returns and what the barrier snapshots into
-- lightning_hand_player.stack_before. It is read, never written: the barrier
-- measures the Cluster's whole pool chip total before and after the formation
-- block and RAISES - uncaught, aborting the caller - if it moved, because a
-- barrier that moves money is not a thing to retry.
--
-- A player whose stack is not strictly positive is not a legal candidate. They
-- cannot post.
--
-- ---------------------------------------------------------------------------
-- LAW 10.5, AND THE FREEZE.
-- ---------------------------------------------------------------------------
--
-- A horse counts exactly like a human. There is no is_horse anywhere in this
-- file, in any predicate, any ordering or any filter, and a @live-proof below
-- asserts that of the installed bodies rather than of the file.
--
-- theFreezeIsTotal. fn_lightning_form_hand, fn_lightning_instance_open,
-- fn_lightning_instance_begin_dealing and fn_lightning_pool_slot_open all
-- refuse while fn_platform_frozen() is true - forming a hand during the
-- maintenance break is precisely what the freeze forbids. fn_lightning_reap_-
-- formations, fn_lightning_instance_abandon and the closing half of
-- fn_lightning_pool_slots_sync are NOT gated on it, for the reason Phase 5
-- records: giving a player their reservation back, abandoning a dead instance
-- and closing the slot of somebody who has left are all recovery, and the break
-- is when recovery happens.
--
-- NOTHING HERE IS REACHABLE BY A BROWSER. Specification 532 forbids matcher
-- logic in the UI. Every function in this file is revoked from PUBLIC, anon and
-- authenticated and granted only to service_role, and every one of them is
-- SECURITY INVOKER: service_role carries BYPASSRLS on this database, the six
-- lightning tables are granted to postgres and service_role alone, and a
-- SECURITY DEFINER function would only add an owner-privileged surface that
-- nothing needs.
--
-- A `-- @live-proof:` below is a parenthesised SELECT that must be TRUE of the
-- database this migration produces. Every one of them is a statement about the
-- CODE - a body, a constraint, a trigger, an index, a grant - and not about
-- today's estate. An estate proof ("no lightning_hand row exists") is true
-- until the feature is switched on and then silently stops meaning anything;
-- four of those have already been found in this project and removed.
--
-- @live-proof: (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'fn_lightning_form_hand')
-- @live-proof: (SELECT array_agg(p.proname::text ORDER BY p.proname) = ARRAY['fn_lightning_blind_order', 'fn_lightning_form_hand', 'fn_lightning_instance_abandon', 'fn_lightning_instance_begin_dealing', 'fn_lightning_instance_open', 'fn_lightning_pool_slot_open', 'fn_lightning_pool_slots_sync', 'fn_lightning_pool_stack', 'fn_lightning_reap_formations'] FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND p.prorettype <> 'trigger'::regtype)
-- @live-proof: (SELECT array_agg(p.proname::text ORDER BY p.proname) = ARRAY['fn_lightning_form_hand', 'fn_lightning_instance_begin_dealing', 'fn_lightning_instance_open', 'fn_lightning_pool_slot_open', 'fn_lightning_pool_slots_sync'] FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_platform_frozen')
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'fn_platform_frozen') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_reap_formations', 'fn_lightning_instance_abandon', 'fn_lightning_instance_releases_its_reservations', 'fn_lightning_hand_player_is_immutable'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse'))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ '(INSERT INTO|UPDATE|DELETE FROM)[[:space:]]+(public\.)?(table_seats|wallets|club_wallets|union_wallets|chip_ledger|ca_settlements|cash_player_session|lightning_pool_session)\y') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_')
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ '(INSERT INTO|UPDATE)[[:space:]]+(public\.)?lightning_blind_ledger[^;]*(missed_bb_debt|missed_sb_debt|bb_owed|sb_owed)[[:space:]]*=') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_')
-- @live-proof: (SELECT i.indisunique AND pg_get_expr(i.indpred, i.indrelid) ~ 'pending' AND pg_get_expr(i.indpred, i.indrelid) ~ 'committed' AND pg_get_indexdef(i.indexrelid) ~ 'cluster_id, player_id' FROM pg_index i WHERE i.indexrelid = 'public.lightning_reservation_one_active_per_player'::regclass)
-- @live-proof: (SELECT i.indisunique AND pg_get_expr(i.indpred, i.indrelid) ~ 'closed_at IS NULL' AND pg_get_indexdef(i.indexrelid) ~ 'cluster_id, player_id' FROM pg_index i WHERE i.indexrelid = 'public.lightning_pool_slot_one_open_per_player'::regclass)
-- @live-proof: (SELECT a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) ~ 'clock_timestamp' FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'public.lightning_instance'::regclass AND a.attname = 'deadline_at')
-- @live-proof: (SELECT pg_get_constraintdef(oid) ~ 'deadline_at > created_at' FROM pg_constraint WHERE conrelid = 'public.lightning_instance'::regclass AND conname = 'lightning_instance_deadline_follows_creation')
-- @live-proof: (SELECT pg_get_constraintdef(oid) ~ 'abandon_reason IS NOT NULL' AND pg_get_constraintdef(oid) ~ 'abandon_reason IS NULL' FROM pg_constraint WHERE conrelid = 'public.lightning_instance'::regclass AND conname = 'lightning_instance_abandon_is_explained')
-- @live-proof: (SELECT count(*) = 2 FROM pg_attribute WHERE attrelid = 'public.lightning_hand'::regclass AND NOT attisdropped AND attname IN ('participants_locked_at', 'player_count'))
-- @live-proof: (SELECT pg_get_constraintdef(oid) ~ 'participants_locked_at IS NULL' AND pg_get_constraintdef(oid) ~ 'player_count' FROM pg_constraint WHERE conrelid = 'public.lightning_hand'::regclass AND conname = 'lightning_hand_lock_counts_its_set')
-- @live-proof: (SELECT array_agg(t.tgname::text ORDER BY t.tgname) = ARRAY['trg_lightning_hand_is_immutable', 'trg_lightning_hand_player_is_immutable', 'trg_lightning_instance_is_disciplined', 'trg_lightning_instance_releases_its_reservations', 'trg_lightning_pool_slot_holds_its_history', 'trg_lightning_reservation_is_disciplined'] AND bool_and(t.tgenabled = 'O') FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname LIKE 'lightning%' AND t.tgname ~ '^trg_lightning_')
-- @live-proof: (SELECT s ~ 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION' AND s ~ 'LIGHTNING_NO_SILENT_SEAT_SWAP' AND s ~ 'LIGHTNING_NO_BLIND_REASSIGNMENT' AND s ~ 'LIGHTNING_NO_ADDITIONAL_PLAYER_INSERTION' AND s ~ 'participants_locked_at' FROM (SELECT pg_get_functiondef('public.fn_lightning_hand_player_is_immutable()'::regprocedure) AS s) q)
-- @live-proof: (SELECT s !~ 'NEW\.fold_type IS DISTINCT FROM OLD\.fold_type' AND s !~ 'NEW\.stack_after IS DISTINCT FROM OLD\.stack_after' FROM (SELECT pg_get_functiondef('public.fn_lightning_hand_player_is_immutable()'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'participants_locked_at' AND s ~ 'LIGHTNING_HAND_IS_IMMUTABLE' AND s ~ 'LIGHTNING_HAND_IS_NOT_DELETABLE' FROM (SELECT pg_get_functiondef('public.fn_lightning_hand_is_immutable()'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'cluster_mode' AND s ~ 'lightning_enabled' AND s ~ 'cluster_epoch' AND s ~ 'ended_at IS NULL' AND s ~ 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT' FROM (SELECT pg_get_functiondef('public.fn_lightning_instance_is_disciplined()'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'fn_lightning_reap_formations' AND position('fn_lightning_reap_formations' in s) < position('INSERT INTO public.lightning_instance' in s) FROM (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'fn_lightning_instance_open') q)
-- @live-proof: (SELECT s ~ 'FROM public\.cash_games[^;]*FOR UPDATE' AND s ~ 'cluster_mode IS DISTINCT FROM ''lightning''' AND s ~ 'cash_cluster_epoch' FROM (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'fn_lightning_form_hand') q)
-- @live-proof: (SELECT s ~ 'last_bb_at' AND s ~ 'NULLS FIRST' AND s ~ 'missed_bb_debt' AND s ~ 'bb_owed' AND s ~ 'row_number\(\) OVER' FROM (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'fn_lightning_blind_order') q)
-- @live-proof: (SELECT s ~ 'fn_lightning_blind_order' AND s ~ 'bb_choice_is_not_p2_legal' AND s !~ 'NULLS FIRST' FROM (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'fn_lightning_form_hand') q)
-- @live-proof: (SELECT array_agg(p.proname::text) = ARRAY['fn_lightning_blind_order'] FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'NULLS FIRST')
-- @live-proof: (SELECT s ~ 'lightning_matcher_retry' AND s ~ 'WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation' AND s ~ 'LIGHTNING_FORMATION_MOVED_MONEY' FROM (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = 'fn_lightning_form_hand') q)
-- @live-proof: (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'INSERT INTO public\.lightning_hand_player')
-- @live-proof: (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'INSERT INTO public\.lightning_hand[[:space:]]')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND routine_name ~ '^fn_lightning_' AND grantee IN ('anon', 'authenticated', 'PUBLIC')))
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND p.prorettype <> 'trigger'::regtype)
-- @live-proof: (SELECT bool_and(NOT p.prosecdef AND array_to_string(p.proconfig, ',') ~ 'search_path') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_')
-- @live-proof: (SELECT bool_and(c.relrowsecurity) AND NOT EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c2 ON c2.oid = pol.polrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace WHERE n2.nspname = 'public' AND c2.relname LIKE 'lightning%') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'lightning%')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning%' AND grantee IN ('anon', 'authenticated', 'PUBLIC')))
-- @live-proof: (SELECT s ~ 'LIGHTNING_RESERVATION_STATE_IS_NOT_REVERSIBLE' AND s ~ 'LIGHTNING_RESERVATION_IS_IMMUTABLE' FROM (SELECT pg_get_functiondef('public.fn_lightning_reservation_is_disciplined()'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'LIGHTNING_POOL_SLOT_HOLDS_A_RESERVATION' FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_slot_holds_its_history()'::regprocedure) AS s) q)

BEGIN;

-- ===========================================================================
-- SECTION 1. THE SHAPE OF AN INSTANCE AND OF A HAND.
-- ===========================================================================

-- ONE ADD COLUMN PER ALTER TABLE, deliberately: every DDL statement on this
-- database fires a PostgREST schema reload of roughly 28 seconds, and a
-- multi-column ALTER that fails on its third clause has already cost the same
-- reload as one that succeeded.

ALTER TABLE public.lightning_instance
  ADD COLUMN IF NOT EXISTS deadline_at timestamp with time zone NOT NULL
  DEFAULT (clock_timestamp() + interval '45 seconds');

ALTER TABLE public.lightning_instance
  ADD COLUMN IF NOT EXISTS abandon_reason text;

ALTER TABLE public.lightning_hand
  ADD COLUMN IF NOT EXISTS participants_locked_at timestamp with time zone;

ALTER TABLE public.lightning_hand
  ADD COLUMN IF NOT EXISTS player_count smallint;

DO $ddl$
BEGIN
  -- deadline_at and created_at are both NOT NULL, so this CHECK can never
  -- evaluate to NULL and can never pass by being unknown. That is worth
  -- stating, because tables_dealing_halt_is_explained in this same estate
  -- forbids nothing at all for exactly that reason.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_instance'::regclass
                    AND conname = 'lightning_instance_deadline_follows_creation') THEN
    ALTER TABLE public.lightning_instance
      ADD CONSTRAINT lightning_instance_deadline_follows_creation
      CHECK (deadline_at > created_at);
  END IF;

  -- abandon_reason IS nullable, so both arms name it explicitly rather than
  -- leaning on one side of an OR: an abandoned instance nobody can explain is
  -- an incident nobody can reconstruct.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_instance'::regclass
                    AND conname = 'lightning_instance_abandon_is_explained') THEN
    ALTER TABLE public.lightning_instance
      ADD CONSTRAINT lightning_instance_abandon_is_explained
      CHECK ((state <> 'abandoned' AND abandon_reason IS NULL)
             OR (state = 'abandoned' AND abandon_reason IS NOT NULL
                 AND length(btrim(abandon_reason)) > 0));
  END IF;

  -- THE LATCH AND ITS COUNT MOVE TOGETHER OR NOT AT ALL. A locked hand with no
  -- player_count would make "the set is complete" a claim nothing can check
  -- afterwards; a player_count on an unlocked hand would be a count of a set
  -- that can still change. Both columns are nullable, so both arms are stated.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_hand'::regclass
                    AND conname = 'lightning_hand_lock_counts_its_set') THEN
    ALTER TABLE public.lightning_hand
      ADD CONSTRAINT lightning_hand_lock_counts_its_set
      CHECK ((participants_locked_at IS NULL AND player_count IS NULL)
             OR (participants_locked_at IS NOT NULL AND player_count IS NOT NULL
                 AND player_count >= 2 AND player_count <= 9
                 AND participants_locked_at >= formed_at));
  END IF;
END
$ddl$;

-- ===========================================================================
-- SECTION 2. THE TWO INDEXES THAT MAKE RULE 725 TRUE.
-- ===========================================================================

-- See DECISION 3 in the header. The per-slot index the schema already carries
-- is orthogonal to rule 725 rather than a weaker form of it, and on its own it
-- permits one player to hold two open slots and therefore two live claims on a
-- single stack.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_reservation_one_active_per_player
  ON public.lightning_reservation (cluster_id, player_id)
  WHERE state IN ('pending', 'committed');

CREATE UNIQUE INDEX IF NOT EXISTS lightning_pool_slot_one_open_per_player
  ON public.lightning_pool_slot (cluster_id, player_id)
  WHERE closed_at IS NULL;

-- The reaper's read path. Without it the estate-wide sweep is a sequential
-- scan of every instance ever formed, which on a busy Lightning Cluster is a
-- table that grows by thousands an hour.
CREATE INDEX IF NOT EXISTS lightning_instance_past_deadline
  ON public.lightning_instance (deadline_at)
  WHERE state IN ('forming', 'reserved');

COMMENT ON COLUMN public.lightning_instance.deadline_at IS
  'The moment after which this instance is abandoned if it has not advanced. NOT NULL with a default so that no code path can create an instance without one; extended by the barrier on reaching reserved and again by fn_lightning_instance_begin_dealing. Phase 5 had to add its reaper after a Cluster had already been wedged; this column exists so that the reaper is the third line of defence rather than the first.';

COMMENT ON COLUMN public.lightning_hand.participants_locked_at IS
  'Barrier step 10. NULL while fn_lightning_form_hand is assembling the hand; set once, in the same statement that records player_count, when the participant set is complete. A one-way latch: specification 519-524 - no participant substitution, no silent seat swap, no blind reassignment, no additional player insertion - are all enforced against this column by trg_lightning_hand_player_is_immutable.';

-- ===========================================================================
-- SECTION 3. THE FOUR "NO" RULES OF SPECIFICATION 519-524.
-- ===========================================================================
--
-- Neither lightning_hand nor lightning_hand_player is one of the nine tables
-- scripts/ci/check-money-trigger-declared.mjs watches (table_seats,
-- club_members, club_wallets, union_wallets, wallets, chip_ledger,
-- tournaments, tournament_players, ca_settlements), so no
-- ca_declared_money_triggers row is required for any trigger in this file, and
-- none is written. That was checked against the MONEY_TABLES constant in that
-- file rather than assumed.

CREATE OR REPLACE FUNCTION public.fn_lightning_hand_player_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_hand   uuid;
  v_locked timestamp with time zone;
BEGIN
  -- OLD is unassigned in a BEFORE INSERT trigger and reading it raises, so the
  -- hand is taken from the right record before anything else happens.
  IF TG_OP = 'DELETE' THEN v_hand := OLD.hand_id; ELSE v_hand := NEW.hand_id; END IF;

  SELECT h.participants_locked_at INTO v_locked
    FROM public.lightning_hand h WHERE h.hand_id = v_hand;

  -- An unlocked hand is a hand the barrier is still assembling. Everything
  -- below is about what happens AFTER the barrier, which is exactly what the
  -- latch records.
  IF v_locked IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'LIGHTNING_NO_ADDITIONAL_PLAYER_INSERTION: hand % locked its participant set at %, and player % arrived for seat % afterwards',
      v_hand, v_locked, NEW.player_id, NEW.seat USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION: hand % locked its participant set at %, and removing player % from seat % would substitute the set the hand was formed with',
      v_hand, v_locked, OLD.player_id, OLD.seat USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.pool_slot_id IS DISTINCT FROM OLD.pool_slot_id THEN
    RAISE EXCEPTION 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION: hand % seat % was formed for player % in slot % and may not become player % in slot %',
      v_hand, OLD.seat, OLD.player_id, OLD.pool_slot_id, NEW.player_id, NEW.pool_slot_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.seat IS DISTINCT FROM OLD.seat THEN
    RAISE EXCEPTION 'LIGHTNING_NO_SILENT_SEAT_SWAP: hand % seated player % at seat % and may not move them to seat %',
      v_hand, OLD.player_id, OLD.seat, NEW.seat USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.position IS DISTINCT FROM OLD.position
     OR NEW.blind_role IS DISTINCT FROM OLD.blind_role THEN
    RAISE EXCEPTION 'LIGHTNING_NO_BLIND_REASSIGNMENT: hand % gave player % position %/blind role % at formation and may not reassign them to %/%',
      v_hand, OLD.player_id, OLD.position, OLD.blind_role, NEW.position, NEW.blind_role
      USING ERRCODE = 'check_violation';
  END IF;

  -- stack_before is the snapshot the blinds are posted against, and hand_id,
  -- cluster_id and cluster_epoch are the bindings barrier steps 7, 8 and 9
  -- made. Rewriting any of them after the fact is a different hand wearing
  -- this one's primary key.
  IF NEW.hand_id IS DISTINCT FROM OLD.hand_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.stack_before IS DISTINCT FROM OLD.stack_before THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_PLAYER_IS_IMMUTABLE: hand % player % may not have its hand, Cluster, epoch or stack_before rewritten after the formation barrier',
      v_hand, OLD.player_id USING ERRCODE = 'check_violation';
  END IF;

  -- Everything not named above stays writable, and the two that matter are
  -- fold_type and stack_after: they are the hand being PLAYED, which is the
  -- reason it was formed. A barrier that froze them would freeze the game.
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_hand_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_NOT_DELETABLE: hand % was formed at % and is a fact; a hand that can be deleted is a participant set that can be substituted by deleting and re-forming it',
      OLD.hand_id, OLD.formed_at USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.hand_id IS DISTINCT FROM OLD.hand_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.lightning_instance_id IS DISTINCT FROM OLD.lightning_instance_id
     OR NEW.formed_at IS DISTINCT FROM OLD.formed_at THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % may not have its identity, Cluster, epoch, instance or formation time rewritten',
      OLD.hand_id USING ERRCODE = 'check_violation';
  END IF;

  -- THE LATCH IS ONE-WAY. Clearing it would unlock every rule in
  -- fn_lightning_hand_player_is_immutable in a single UPDATE, which is the one
  -- bypass that would make all four of them decorative.
  IF OLD.participants_locked_at IS NOT NULL
     AND NEW.participants_locked_at IS DISTINCT FROM OLD.participants_locked_at THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % locked its participant set at % and the latch may not be cleared or moved',
      OLD.hand_id, OLD.participants_locked_at USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.participants_locked_at IS NOT NULL
     AND NEW.player_count IS DISTINCT FROM OLD.player_count THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % locked % participants and that count may not be rewritten',
      OLD.hand_id, OLD.player_count USING ERRCODE = 'check_violation';
  END IF;

  -- THE LATCH MAY ONLY BE SET OVER A SET THAT IS REALLY THERE. Without this a
  -- caller could lock a hand at a player_count that does not match the rows,
  -- and every later reader would believe a set of two was a set of six.
  IF OLD.participants_locked_at IS NULL AND NEW.participants_locked_at IS NOT NULL THEN
    IF NEW.player_count IS DISTINCT FROM
       (SELECT count(*)::smallint FROM public.lightning_hand_player hp WHERE hp.hand_id = NEW.hand_id) THEN
      RAISE EXCEPTION 'LIGHTNING_HAND_IS_IMMUTABLE: hand % was locked at player_count % over % participant row(s)',
        NEW.hand_id, NEW.player_count,
        (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = NEW.hand_id)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

-- ===========================================================================
-- SECTION 4. THE INSTANCE IS BOUND TO A LIGHTNING CLUSTER AND TO ONE EPOCH.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_instance_is_disciplined()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'forming' THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_IS_BORN_FORMING: instance for Cluster % was inserted in state % rather than forming, so the formation barrier it is supposed to pass through has already been skipped',
        NEW.cluster_id, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.hand_id IS NOT NULL THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_IS_BORN_EMPTY: instance for Cluster % was inserted already carrying hand %, which is barrier step 8 performed before steps 1 to 7',
        NEW.cluster_id, NEW.hand_id USING ERRCODE = 'check_violation';
    END IF;

    SELECT id, cluster_mode, lightning_enabled, cluster_epoch
      INTO g FROM public.cash_games WHERE id = NEW.cluster_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_NO_CLUSTER: instance names Cluster % which does not exist',
        NEW.cluster_id USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- coalesce on lightning_enabled because the column is a nullable-shaped
    -- added boolean in the general case and `NOT x` over NULL is NULL, which
    -- an IF takes as false and which would admit exactly the Cluster this
    -- refuses.
    IF g.cluster_mode IS DISTINCT FROM 'lightning'
       OR coalesce(g.lightning_enabled, false) = false THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_CLUSTER_IS_NOT_LIGHTNING: Cluster % is in cluster_mode % with lightning_enabled %, and a hand formed for it would be dealt at tables that are still dealing cash',
        NEW.cluster_id, g.cluster_mode, coalesce(g.lightning_enabled, false)
        USING ERRCODE = 'check_violation';
    END IF;

    -- BARRIER STEP 9. The foreign key into cash_cluster_epoch proves the epoch
    -- EXISTED. It does not prove it is the epoch the Cluster is in now, and a
    -- conversion, a revert or a re-conversion moves that number under a
    -- matcher that read it a moment ago.
    IF NEW.cluster_epoch IS DISTINCT FROM g.cluster_epoch THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT: instance for Cluster % bound epoch % while the Cluster is at epoch %',
        NEW.cluster_id, NEW.cluster_epoch, g.cluster_epoch USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                    WHERE e.cluster_id = NEW.cluster_id AND e.epoch = NEW.cluster_epoch
                      AND e.ended_at IS NULL) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT: epoch % of Cluster % has ended, or was never opened, so nothing may be formed inside it',
        NEW.cluster_epoch, NEW.cluster_id USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.target_size IS DISTINCT FROM OLD.target_size
     OR NEW.max_size IS DISTINCT FROM OLD.max_size
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'LIGHTNING_INSTANCE_IS_IMMUTABLE: instance % may not have its Cluster, epoch, target size, max size or creation time rewritten',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- hand_id IS WRITE-ONCE. Re-pointing an instance at a second hand is
  -- participant substitution performed one level up, where none of the
  -- lightning_hand_player rules can see it.
  IF OLD.hand_id IS NOT NULL AND NEW.hand_id IS DISTINCT FROM OLD.hand_id THEN
    RAISE EXCEPTION 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION: instance % is bound to hand % and may not be re-pointed at %',
      OLD.id, OLD.hand_id, NEW.hand_id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'forming'  AND NEW.state IN ('reserved', 'abandoned'))
         OR (OLD.state = 'reserved' AND NEW.state IN ('dealing', 'abandoned'))
         OR (OLD.state = 'dealing'  AND NEW.state IN ('settling', 'abandoned'))
         OR (OLD.state = 'settling' AND NEW.state IN ('complete', 'abandoned'))) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_STATE_IS_NOT_REVERSIBLE: instance % may not go from % to %',
        OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.state IN ('reserved', 'dealing', 'settling', 'complete') AND NEW.hand_id IS NULL THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_NO_HAND: instance % reached % with no hand bound, so barrier step 8 never happened',
        OLD.id, NEW.state USING ERRCODE = 'check_violation';
    END IF;

    -- BARRIER STEP 13'S PRECONDITION, stated where nothing can route around
    -- it: a hand is released into gameplay only once its participant set is
    -- locked. The shuffle and the deal are the engine's and are not in this
    -- database at all.
    IF NEW.state = 'dealing'
       AND NOT EXISTS (SELECT 1 FROM public.lightning_hand h
                        WHERE h.hand_id = NEW.hand_id AND h.participants_locked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'LIGHTNING_INSTANCE_HAS_AN_UNLOCKED_HAND: instance % tried to begin dealing hand % whose participant set is not locked',
        OLD.id, NEW.hand_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_instance_releases_its_reservations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- WHY THIS IS A TRIGGER AND NOT A LINE IN fn_lightning_instance_abandon.
  -- lightning_reservation_one_active_per_player makes a committed reservation
  -- a standing bar on that player being matched again. The bar has to come off
  -- on EVERY road into a terminal state - abandon, the reaper, and the
  -- settlement phase that has not been written yet - and a road that forgets
  -- would take a player out of the pool permanently with no row saying why.
  UPDATE public.lightning_reservation r
     SET state = 'released',
         resolved_at = clock_timestamp(),
         reason = coalesce(r.reason, 'instance_' || NEW.state)
   WHERE r.lightning_instance_id = NEW.id
     AND r.state IN ('pending', 'committed');
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_reservation_is_disciplined()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_epoch integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'LIGHTNING_RESERVATION_IS_BORN_PENDING: reservation for player % was inserted in state %, so it was never a claim anybody could lose a race for',
        NEW.player_id, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
                    WHERE sl.id = NEW.pool_slot_id AND sl.closed_at IS NULL) THEN
      RAISE EXCEPTION 'LIGHTNING_RESERVATION_SLOT_IS_CLOSED: player % was reserved against pool slot % which is closed, so they have already left the pool',
        NEW.player_id, NEW.pool_slot_id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lightning_instance_id IS NOT NULL THEN
      SELECT i.cluster_epoch INTO v_epoch FROM public.lightning_instance i WHERE i.id = NEW.lightning_instance_id;
      IF v_epoch IS DISTINCT FROM NEW.cluster_epoch THEN
        RAISE EXCEPTION 'LIGHTNING_RESERVATION_CROSSES_AN_EPOCH: reservation at epoch % names instance % which runs at epoch %',
          NEW.cluster_epoch, NEW.lightning_instance_id, v_epoch USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id
     OR NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch
     OR NEW.pool_slot_id IS DISTINCT FROM OLD.pool_slot_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'LIGHTNING_RESERVATION_IS_IMMUTABLE: reservation % may not have its identity, player, Cluster, epoch, slot or creation time rewritten',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.lightning_instance_id IS NOT NULL
     AND NEW.lightning_instance_id IS DISTINCT FROM OLD.lightning_instance_id THEN
    RAISE EXCEPTION 'LIGHTNING_RESERVATION_IS_IMMUTABLE: reservation % is bound to instance % and may not be moved to %',
      OLD.id, OLD.lightning_instance_id, NEW.lightning_instance_id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'pending'   AND NEW.state IN ('committed', 'released', 'expired'))
         OR (OLD.state = 'committed' AND NEW.state = 'released')) THEN
      RAISE EXCEPTION 'LIGHTNING_RESERVATION_STATE_IS_NOT_REVERSIBLE: reservation % may not go from % to %; a released or expired claim that can become pending again is a claim two matchers can both hold',
        OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slot_holds_its_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- THE HOLE THIS CLOSES IS A CASCADE, AND IT IS IN THE SCHEMA ALREADY.
  -- lightning_reservation_belongs_to_its_slot is ON DELETE CASCADE, so
  -- deleting a pool slot silently erases every reservation ever taken against
  -- it - including committed ones, which are the record of who was in a hand.
  -- lightning_hand_player's own foreign key is RESTRICT, so the hand side is
  -- already safe and the reservation side was not.
  IF EXISTS (SELECT 1 FROM public.lightning_reservation r WHERE r.pool_slot_id = OLD.id) THEN
    RAISE EXCEPTION 'LIGHTNING_POOL_SLOT_HOLDS_A_RESERVATION: pool slot % of player % has reservations recorded against it, and deleting it would cascade them away; close the slot instead',
      OLD.id, OLD.player_id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_hand_player hp WHERE hp.pool_slot_id = OLD.id) THEN
    RAISE EXCEPTION 'LIGHTNING_POOL_SLOT_HOLDS_A_RESERVATION: pool slot % of player % sat in a formed hand and may not be deleted',
      OLD.id, OLD.player_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$fn$;

DO $trg$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lightning_hand_player_is_immutable'
                   AND tgrelid = 'public.lightning_hand_player'::regclass) THEN
    CREATE TRIGGER trg_lightning_hand_player_is_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON public.lightning_hand_player
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_hand_player_is_immutable();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lightning_hand_is_immutable'
                   AND tgrelid = 'public.lightning_hand'::regclass) THEN
    CREATE TRIGGER trg_lightning_hand_is_immutable
      BEFORE UPDATE OR DELETE ON public.lightning_hand
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_hand_is_immutable();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lightning_instance_is_disciplined'
                   AND tgrelid = 'public.lightning_instance'::regclass) THEN
    CREATE TRIGGER trg_lightning_instance_is_disciplined
      BEFORE INSERT OR UPDATE ON public.lightning_instance
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_instance_is_disciplined();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lightning_instance_releases_its_reservations'
                   AND tgrelid = 'public.lightning_instance'::regclass) THEN
    CREATE TRIGGER trg_lightning_instance_releases_its_reservations
      AFTER UPDATE ON public.lightning_instance
      FOR EACH ROW
      WHEN (NEW.state IN ('complete', 'abandoned') AND OLD.state IS DISTINCT FROM NEW.state)
      EXECUTE FUNCTION public.fn_lightning_instance_releases_its_reservations();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lightning_reservation_is_disciplined'
                   AND tgrelid = 'public.lightning_reservation'::regclass) THEN
    CREATE TRIGGER trg_lightning_reservation_is_disciplined
      BEFORE INSERT OR UPDATE ON public.lightning_reservation
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_reservation_is_disciplined();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lightning_pool_slot_holds_its_history'
                   AND tgrelid = 'public.lightning_pool_slot'::regclass) THEN
    CREATE TRIGGER trg_lightning_pool_slot_holds_its_history
      BEFORE DELETE ON public.lightning_pool_slot
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_pool_slot_holds_its_history();
  END IF;
END
$trg$;

-- ===========================================================================
-- SECTION 5. THE POOL SLOT, WHICH NOTHING CREATED UNTIL NOW.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_pool_stack(p_pool_session_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- WHERE THE CONVERSION PUT IT. fn_cash_cluster_commit_lightning wrote
  -- starting_stack from the player's table_seats.stack at the instant the
  -- Cluster became Lightning, and every settled hand since has moved
  -- net_result. This function READS; nothing in this file writes either column.
  SELECT round(coalesce(s.starting_stack, 0) + coalesce(s.net_result, 0), 2)
    FROM public.lightning_pool_session s
   WHERE s.id = p_pool_session_id;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slot_open(
  p_pool_session_id uuid,
  p_now             timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  ps      record;
  v_slot  uuid;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'platform_frozen');
  END IF;

  SELECT s.id, s.cluster_id, s.cluster_epoch, s.player_id, s.state, s.exited_at
    INTO ps FROM public.lightning_pool_session s WHERE s.id = p_pool_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'no_such_pool_session');
  END IF;
  IF ps.exited_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'pool_session_has_exited');
  END IF;

  -- IDEMPOTENT ON PURPOSE. This is called from a sync pass that may run twice
  -- in the same second, from two workers, during a deploy. An existing open
  -- slot is the right answer, not a unique violation.
  SELECT sl.id INTO v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'opened', false, 'reason', 'already_open',
                              'pool_slot_id', v_slot);
  END IF;

  -- slot 1, ALWAYS, and the header says why: lightning_pool_slot.slot ranges
  -- 1..24 because the pool was designed for a player to hold several
  -- concurrent seats, and specification 725 forbids a player holding more than
  -- one active reservation in a session. The column keeps its range so that
  -- the day the specification changes, only an index moves.
  INSERT INTO public.lightning_pool_slot
    (pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at, updated_at)
  VALUES (ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, 1, p_now, p_now)
  RETURNING id INTO v_slot;

  RETURN jsonb_build_object('ok', true, 'opened', true, 'pool_slot_id', v_slot,
                            'player_id', ps.player_id, 'cluster_id', ps.cluster_id,
                            'cluster_epoch', ps.cluster_epoch);
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slots_sync(
  p_cluster_id uuid,
  p_now        timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g        record;
  s        record;
  v_closed integer := 0;
  v_opened integer := 0;
  v_frozen boolean := public.fn_platform_frozen();
BEGIN
  SELECT id, cluster_mode, lightning_enabled, cluster_epoch
    INTO g FROM public.cash_games WHERE id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- THE CLOSING HALF IS NOT GATED ON THE FREEZE. A slot belonging to somebody
  -- who has left the pool, or to an epoch the Cluster is no longer in, is a
  -- standing claim on a player who is not there, and giving it back is
  -- recovery. Phase 5 makes the same distinction between commit and abort.
  UPDATE public.lightning_pool_slot sl
     SET closed_at = p_now,
         close_reason = CASE WHEN sl.cluster_epoch IS DISTINCT FROM g.cluster_epoch
                             THEN 'epoch_advanced' ELSE 'pool_session_exited' END,
         updated_at = p_now
   WHERE sl.cluster_id = g.id
     AND sl.closed_at IS NULL
     AND (sl.cluster_epoch IS DISTINCT FROM g.cluster_epoch
          OR EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                      WHERE ps.id = sl.pool_session_id AND ps.exited_at IS NOT NULL));
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  IF v_frozen THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'platform_frozen',
                              'slots_closed', v_closed, 'slots_opened', 0);
  END IF;

  IF g.cluster_mode IS DISTINCT FROM 'lightning' OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'cluster_is_not_lightning',
                              'cluster_mode', g.cluster_mode,
                              'slots_closed', v_closed, 'slots_opened', 0);
  END IF;

  -- NO is_horse. Law 10.5: a horse enters the pool, takes a slot, is reserved
  -- and is dealt exactly as a human is, and P0's legality list has no carve-out
  -- for one.
  FOR s IN
    SELECT ps.id FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = g.id AND ps.cluster_epoch = g.cluster_epoch
       AND ps.exited_at IS NULL AND ps.state = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
                        WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
                          AND sl.closed_at IS NULL)
     ORDER BY ps.entered_at, ps.id
  LOOP
    IF coalesce((public.fn_lightning_pool_slot_open(s.id, p_now) ->> 'opened')::boolean, false) THEN
      v_opened := v_opened + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'reason', 'synced',
                            'cluster_epoch', g.cluster_epoch,
                            'slots_closed', v_closed, 'slots_opened', v_opened);
END
$fn$;

-- ===========================================================================
-- SECTION 6. THE P2 KEY, WHICH THE INDEX WAS BUILT FOR AND NOTHING HAS READ.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_blind_order(
  p_cluster_id    uuid,
  p_cluster_epoch integer,
  p_players       uuid[])
RETURNS TABLE (
  p2_rank       integer,
  player_id     uuid,
  pool_slot_id  uuid,
  bb_unresolved boolean,
  last_bb_at    timestamp with time zone,
  debt_age      timestamp with time zone,
  entered_pool  timestamp with time zone)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- SPECIFICATION 598-624, tie-breaks 1 to 4, in order:
  --   the eligible player with the oldest UNRESOLVED BB obligation first,
  --   then the oldest unpaid BB timestamp - NULLS FIRST, so a player who has
  --   never paid one outranks everybody who has, which is also the exact
  --   ordering of lightning_pool_slot_oldest_bb, the P2 index that was built
  --   for this and until now had no reader,
  --   then the oldest blind-debt age,
  --   then pool entry,
  --   then player_id, the deterministic stable id.
  SELECT row_number() OVER (
           ORDER BY (coalesce(bl.missed_bb_debt, 0) > 0 OR coalesce(bl.bb_owed, 0) > 0) DESC,
                    sl.last_bb_at ASC NULLS FIRST,
                    coalesce(bl.updated_at, sl.opened_at) ASC,
                    sl.opened_at ASC,
                    sl.player_id ASC)::integer,
         sl.player_id,
         sl.id,
         (coalesce(bl.missed_bb_debt, 0) > 0 OR coalesce(bl.bb_owed, 0) > 0),
         sl.last_bb_at,
         coalesce(bl.updated_at, sl.opened_at),
         sl.opened_at
    FROM public.lightning_pool_slot sl
    LEFT JOIN public.lightning_blind_ledger bl
      ON bl.cluster_id = sl.cluster_id AND bl.player_id = sl.player_id
   WHERE sl.cluster_id = p_cluster_id
     AND sl.cluster_epoch = p_cluster_epoch
     AND sl.closed_at IS NULL
     AND (p_players IS NULL OR sl.player_id = ANY (p_players));
$fn$;

-- ===========================================================================
-- SECTION 7. THE INSTANCE LIFECYCLE, AND THE THING THAT BURIES THE DEAD.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_reap_formations(
  p_now        timestamp with time zone DEFAULT clock_timestamp(),
  p_limit      integer                  DEFAULT 200,
  p_cluster_id uuid                     DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  i          record;
  v_expired  integer := 0;
  v_abandoned integer := 0;
  v_rows     jsonb := '[]'::jsonb;
BEGIN
  -- DELIBERATELY NOT GATED ON fn_platform_frozen(). Giving a player back a
  -- reservation they can no longer use, and burying an instance that will
  -- never form, are recovery, and the break is when incidents are handled.
  -- fn_cash_cluster_abort_pending_on and fn_cash_cluster_reap_stuck_conversions
  -- make the same choice for the same reason, and Phase 5's header records it.

  UPDATE public.lightning_reservation r
     SET state = 'expired',
         resolved_at = p_now,
         reason = coalesce(r.reason, 'expired_before_commit')
   WHERE r.state = 'pending'
     AND r.expires_at <= p_now
     AND (p_cluster_id IS NULL OR r.cluster_id = p_cluster_id);
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  FOR i IN
    SELECT li.id, li.cluster_id, li.cluster_epoch, li.state, li.hand_id,
           li.created_at, li.deadline_at
      FROM public.lightning_instance li
     WHERE li.state IN ('forming', 'reserved')
       AND li.deadline_at <= p_now
       AND (p_cluster_id IS NULL OR li.cluster_id = p_cluster_id)
     ORDER BY li.deadline_at, li.id
     LIMIT GREATEST(1, coalesce(p_limit, 200))
     FOR UPDATE SKIP LOCKED
  LOOP
    -- The AFTER trigger on lightning_instance is what hands the players back:
    -- see fn_lightning_instance_releases_its_reservations and DECISION 3.
    UPDATE public.lightning_instance li
       SET state = 'abandoned',
           abandon_reason = format('reaped: %s since %s, past the deadline this instance was born with',
                                   li.state, justify_interval(p_now - li.created_at))
     WHERE li.id = i.id;
    v_abandoned := v_abandoned + 1;
    v_rows := v_rows || jsonb_build_object('instance_id', i.id, 'cluster_id', i.cluster_id,
                                           'was', i.state, 'hand_id', i.hand_id,
                                           'deadline_at', i.deadline_at);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'as_of', p_now,
                            'reservations_expired', v_expired,
                            'instances_abandoned', v_abandoned,
                            'instances', v_rows);
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_instance_open(
  p_cluster_id  uuid,
  p_target_size smallint                 DEFAULT NULL,
  p_max_size    smallint                 DEFAULT NULL,
  p_form_window interval                 DEFAULT interval '45 seconds',
  p_now         timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g        record;
  v_target smallint;
  v_max    smallint;
  v_id     uuid;
  v_window interval := GREATEST(coalesce(p_form_window, interval '45 seconds'), interval '5 seconds');
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'platform_frozen');
  END IF;

  SELECT id, cluster_mode, lightning_enabled, cluster_epoch, handedness
    INTO g FROM public.cash_games WHERE id = p_cluster_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'not_found');
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'lightning' OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'cluster_is_not_lightning',
                              'cluster_mode', g.cluster_mode);
  END IF;

  -- DECISION 2, THE SELF-HEALING HALF. The corpse of the last formation that
  -- died is buried by the next one that starts, in this transaction, before
  -- anything new is created. A Cluster that keeps dealing keeps itself clean
  -- with nothing scheduled anywhere; the estate-wide sweep is the third line
  -- of defence rather than the first.
  PERFORM public.fn_lightning_reap_formations(p_now, 200, g.id);

  v_target := coalesce(p_target_size, GREATEST(2, LEAST(6, coalesce(g.handedness, 6)))::smallint);
  v_max    := coalesce(p_max_size, GREATEST(v_target, LEAST(9, coalesce(g.handedness, 6))::smallint));
  IF v_max < v_target THEN v_max := v_target; END IF;
  IF v_target < 2 THEN v_target := 2; END IF;
  IF v_max > 9 THEN v_max := 9; END IF;

  INSERT INTO public.lightning_instance
    (cluster_id, cluster_epoch, state, target_size, max_size, created_at, deadline_at)
  VALUES (g.id, g.cluster_epoch, 'forming', v_target, v_max, p_now, p_now + v_window)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'opened', true, 'instance_id', v_id,
                            'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch,
                            'target_size', v_target, 'max_size', v_max,
                            'deadline_at', p_now + v_window);
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_instance_abandon(
  p_instance_id uuid,
  p_reason      text,
  p_now         timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  i        record;
  v_reason text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'abandoned_without_a_stated_reason');
BEGIN
  -- NOT gated on the freeze: see fn_lightning_reap_formations.
  SELECT li.id, li.state, li.started_at, li.hand_id
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'abandoned', false, 'reason', 'not_found');
  END IF;
  IF i.state IN ('complete', 'abandoned') THEN
    RETURN jsonb_build_object('ok', true, 'abandoned', false, 'reason', 'already_terminal',
                              'state', i.state);
  END IF;

  UPDATE public.lightning_instance li
     SET state = 'abandoned',
         abandon_reason = v_reason,
         -- lightning_instance_lifecycle_order forbids completed_at without
         -- started_at, so an instance abandoned before it ever dealt keeps a
         -- NULL completed_at. That is the schema's rule and not a choice made
         -- here; abandon_reason is what records that it ended.
         completed_at = CASE WHEN li.started_at IS NOT NULL THEN p_now ELSE li.completed_at END
   WHERE li.id = i.id;

  RETURN jsonb_build_object('ok', true, 'abandoned', true, 'instance_id', i.id,
                            'was', i.state, 'hand_id', i.hand_id, 'reason', v_reason);
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_instance_begin_dealing(
  p_instance_id uuid,
  p_deal_window interval                 DEFAULT interval '10 minutes',
  p_now         timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  i          record;
  h          record;
  v_players  integer;
  v_committed integer;
  v_window   interval := GREATEST(coalesce(p_deal_window, interval '10 minutes'), interval '30 seconds');
BEGIN
  -- BARRIER STEP 13, AND ONLY ITS PRECONDITION. What is on the far side of
  -- this door is steps 11 and 12 - the shuffle, using the engine's
  -- authoritative RNG, and the deal - and neither of those is or should be in
  -- this database.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'platform_frozen');
  END IF;

  SELECT li.id, li.state, li.hand_id, li.cluster_id, li.cluster_epoch, li.deadline_at
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'not_found');
  END IF;
  IF i.state IS DISTINCT FROM 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'wrong_state', 'state', i.state);
  END IF;
  IF i.deadline_at <= p_now THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'past_deadline',
                              'deadline_at', i.deadline_at);
  END IF;

  SELECT lh.hand_id, lh.participants_locked_at, lh.player_count
    INTO h FROM public.lightning_hand lh WHERE lh.hand_id = i.hand_id;
  IF NOT FOUND OR h.participants_locked_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'participant_set_is_not_locked');
  END IF;

  SELECT count(*)::integer INTO v_players
    FROM public.lightning_hand_player hp WHERE hp.hand_id = h.hand_id;
  SELECT count(*)::integer INTO v_committed
    FROM public.lightning_reservation r
   WHERE r.lightning_instance_id = i.id AND r.state = 'committed';

  IF v_players IS DISTINCT FROM h.player_count
     OR v_committed IS DISTINCT FROM h.player_count THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'participant_set_does_not_agree',
                              'player_count', h.player_count, 'players', v_players,
                              'committed_reservations', v_committed);
  END IF;

  -- EVERY COMMITTED RESERVATION SITS IN THE SEAT THE HAND GAVE IT. Counting
  -- agreement is satisfied by two sets of the same size holding different
  -- people, which is the substitution the whole barrier exists to prevent.
  IF EXISTS (
    SELECT 1 FROM public.lightning_reservation r
     WHERE r.lightning_instance_id = i.id AND r.state = 'committed'
       AND NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                        WHERE hp.hand_id = h.hand_id AND hp.player_id = r.player_id
                          AND hp.seat = r.seat_number)) THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'reservations_do_not_match_the_seats');
  END IF;

  UPDATE public.lightning_instance li
     SET state = 'dealing', started_at = p_now, deadline_at = p_now + v_window
   WHERE li.id = i.id;

  RETURN jsonb_build_object('ok', true, 'dealing', true, 'instance_id', i.id,
                            'hand_id', h.hand_id, 'players', v_players,
                            'cluster_id', i.cluster_id, 'cluster_epoch', i.cluster_epoch,
                            'deadline_at', p_now + v_window);
END
$fn$;

-- ===========================================================================
-- SECTION 8. THE BARRIER. ONE FUNCTION, ONE TRANSACTION, STEPS 1 TO 10.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_form_hand(
  p_cluster_id      uuid,
  p_players         uuid[],
  p_target_size     smallint                 DEFAULT NULL,
  p_max_size        smallint                 DEFAULT NULL,
  p_bb_player       uuid                     DEFAULT NULL,
  p_reservation_ttl interval                 DEFAULT interval '20 seconds',
  p_form_window     interval                 DEFAULT interval '45 seconds',
  p_now             timestamp with time zone DEFAULT clock_timestamp())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g           record;
  v_epoch     integer;
  v_cand      uuid[];
  v_legal     uuid[];
  v_pool      jsonb;
  v_seats     jsonb;
  v_n         integer;
  v_target    smallint;
  v_max       smallint;
  v_bb        uuid;
  v_sb        uuid;
  v_btn       uuid;
  v_ok        boolean;
  v_instance  uuid;
  v_hand      uuid;
  v_before    numeric;
  v_after     numeric;
  v_sqlstate  text;
  v_msg       text;
  v_ttl       interval := GREATEST(coalesce(p_reservation_ttl, interval '20 seconds'), interval '5 seconds');
  v_window    interval := GREATEST(coalesce(p_form_window, interval '45 seconds'), interval '5 seconds');
BEGIN
  IF p_cluster_id IS NULL OR p_players IS NULL OR coalesce(array_length(p_players, 1), 0) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'no_candidate_set');
  END IF;

  -- theFreezeIsTotal. Forming a hand during the maintenance break is exactly
  -- what the freeze forbids; releasing one is not, which is why
  -- fn_lightning_reap_formations and fn_lightning_instance_abandon are not
  -- gated and this is.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                              'reason', 'platform_frozen');
  END IF;

  -- THE CLUSTER ROW IS TAKEN FOR UPDATE BEFORE THE EPOCH IS READ, which
  -- serialises formation against fn_cash_cluster_commit_lightning's own
  -- FOR UPDATE on the same row. Without it "the epoch I bound is the epoch the
  -- Cluster is in" is likely rather than true, and a conversion landing
  -- between the read and the INSERT would bind a hand to an epoch that no
  -- longer exists.
  SELECT id, cluster_mode, lightning_enabled, cluster_epoch, handedness
    INTO g FROM public.cash_games WHERE id = p_cluster_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'reason', 'not_found');
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'cluster_is_not_lightning',
                              'cluster_mode', g.cluster_mode,
                              'lightning_enabled', coalesce(g.lightning_enabled, false));
  END IF;
  v_epoch := g.cluster_epoch;
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                  WHERE e.cluster_id = g.id AND e.epoch = v_epoch AND e.ended_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'epoch_is_not_open', 'cluster_epoch', v_epoch);
  END IF;

  -- THE CHIP TOTAL OF THE WHOLE POOL, BEFORE. Compared again after the
  -- formation block; see the end of this function.
  SELECT coalesce(sum(coalesce(ps.starting_stack, 0) + coalesce(ps.net_result, 0)), 0)
    INTO v_before FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;

  -- The caller's order is the matcher's order and is preserved exactly;
  -- duplicates are collapsed to their first mention rather than silently
  -- seating somebody twice.
  v_cand := ARRAY(SELECT x.pid FROM (
              SELECT u.pid, min(u.ord) AS ord
                FROM unnest(p_players) WITH ORDINALITY AS u(pid, ord)
               WHERE u.pid IS NOT NULL
               GROUP BY u.pid) x ORDER BY x.ord);

  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING. The slots are
  -- taken FOR UPDATE in player_id order - a fixed order, so two matchers
  -- racing for an overlapping candidate set queue rather than deadlock.
  PERFORM 1 FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
     AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand)
   ORDER BY sl.player_id
   FOR UPDATE;

  -- P0 LEGALITY, and there is no is_horse in it. Law 10.5: a horse is a
  -- player. A candidate is legal when they hold an open pool slot at THIS
  -- Cluster and THIS epoch, an open and active pool session, a strictly
  -- positive stack - a player who cannot post is not a legal candidate - and
  -- no reservation anybody else is already holding.
  SELECT coalesce(array_agg(q.pid), ARRAY[]::uuid[]) INTO v_legal FROM (
    SELECT sl.player_id AS pid
      FROM public.lightning_pool_slot sl
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
     WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch AND sl.closed_at IS NULL
       AND sl.player_id = ANY (v_cand)
       AND ps.cluster_id = g.id AND ps.cluster_epoch = v_epoch
       AND ps.exited_at IS NULL AND ps.state = 'active'
       AND public.fn_lightning_pool_stack(ps.id) > 0
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation r
                        WHERE r.cluster_id = sl.cluster_id AND r.player_id = sl.player_id
                          AND r.state IN ('pending', 'committed'))
  ) q;

  -- AND THE P2 ORDER COMES FROM THE ONE FUNCTION THAT OWNS THE KEY. An earlier
  -- cut of this file wrote the ordering out a second time here, and the two
  -- copies were then two places for the key to drift - which a mutation run
  -- caught by changing one of them and watching nothing go red, because the
  -- other was the one that mattered. fn_lightning_blind_order is now the only
  -- expression of specification 601-608 in the database, and this is its
  -- caller.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       bo.player_id,
           'pool_slot_id',    bo.pool_slot_id,
           'pool_session_id', sl.pool_session_id,
           'stack',           public.fn_lightning_pool_stack(sl.pool_session_id),
           'bb_unresolved',   bo.bb_unresolved,
           'last_bb_at',      bo.last_bb_at,
           'debt_age',        bo.debt_age,
           'caller_rank',     o.ord)
         ORDER BY bo.p2_rank)
    INTO v_pool
    FROM public.fn_lightning_blind_order(g.id, v_epoch, v_legal) bo
    JOIN public.lightning_pool_slot sl ON sl.id = bo.pool_slot_id
    JOIN unnest(v_cand) WITH ORDINALITY AS o(pid, ord) ON o.pid = bo.player_id;

  v_n      := coalesce(jsonb_array_length(v_pool), 0);
  v_target := coalesce(p_target_size, GREATEST(2, LEAST(6, coalesce(g.handedness, 6)))::smallint);
  v_max    := coalesce(p_max_size, GREATEST(v_target, LEAST(9, coalesce(g.handedness, 6))::smallint));
  IF v_max < v_target THEN v_max := v_target; END IF;
  IF v_target < 2 THEN v_target := 2; END IF;
  IF v_max > 9 THEN v_max := 9; END IF;

  IF v_n < v_target THEN
    -- SPECIFICATION 733. Nothing was taken, so there is nothing to release -
    -- but the retry still has to be VISIBLE, or a matcher spinning on a pool
    -- that can never fill leaves no trace anywhere.
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
    VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
      'reason', 'insufficient_legal_candidates', 'offered', array_length(v_cand, 1),
      'legal', v_n, 'target_size', v_target, 'at', p_now), v_epoch);
    RETURN jsonb_build_object('ok', true, 'formed', false, 'retry', true,
                              'reason', 'insufficient_legal_candidates',
                              'offered', array_length(v_cand, 1), 'legal', v_n,
                              'target_size', v_target);
  END IF;

  -- OVER-SUPPLY IS TRIMMED ALONG THE P2 KEY, not along the caller's order, so
  -- the player most owed a big blind is never the one dropped.
  IF v_n > v_max THEN
    SELECT jsonb_agg(z.e ORDER BY z.ord) INTO v_pool
      FROM (SELECT e, ord FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)) z
     WHERE z.ord <= v_max;
    v_n := v_max;
  END IF;

  -- BARRIER STEP 5, FIRST HALF, AND THE ONE P2 RULE THAT HAS TO LIVE DOWN
  -- HERE. The barrier's own choice is the P2-maximal candidate. A matcher may
  -- override it, and may not override it with somebody P2 could never have
  -- chosen: p_bb_player is accepted only if it ties on the WHOLE key -
  -- unresolved obligation, last_bb_at, blind-debt age - with the candidate the
  -- barrier would have taken.
  v_bb := (v_pool -> 0 ->> 'player_id')::uuid;
  IF p_bb_player IS NOT NULL AND p_bb_player IS DISTINCT FROM v_bb THEN
    SELECT ((e -> 'bb_unresolved'), (e -> 'last_bb_at'), (e -> 'debt_age'))
           IS NOT DISTINCT FROM
           ((v_pool -> 0 -> 'bb_unresolved'), (v_pool -> 0 -> 'last_bb_at'), (v_pool -> 0 -> 'debt_age'))
      INTO v_ok
      FROM jsonb_array_elements(v_pool) e
     WHERE (e ->> 'player_id')::uuid = p_bb_player;
    IF NOT coalesce(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                'reason', 'bb_choice_is_not_p2_legal',
                                'asked_for', p_bb_player, 'p2_would_choose', v_bb);
    END IF;
    v_bb := p_bb_player;
  END IF;

  SELECT (t.e ->> 'player_id')::uuid INTO v_sb
    FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
   WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
   ORDER BY t.ord LIMIT 1;

  -- BARRIER STEPS 3, 4, 5 AND 6 AS ONE MAP. Seat 1 is the small blind, seat 2
  -- the big blind, and seats 3..n are filled IN THE ORDER THE CALLER GAVE
  -- THEM: P3 position fairness is advisory and the matcher's, and a barrier
  -- that re-sorted those seats would be quietly overruling it. Heads-up, seat
  -- 1 is the button and posts the small blind, which is why blind_role and
  -- position are separate columns.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       s.pid,
           'pool_slot_id',    (s.e ->> 'pool_slot_id')::uuid,
           'pool_session_id', (s.e ->> 'pool_session_id')::uuid,
           'stack_before',    (s.e ->> 'stack')::numeric,
           'seat',            s.seat,
           'position', CASE WHEN v_n = 2 AND s.seat = 1 THEN 'btn'
                            WHEN v_n = 2                THEN 'bb'
                            WHEN s.seat = 1             THEN 'sb'
                            WHEN s.seat = 2             THEN 'bb'
                            WHEN s.seat = v_n           THEN 'btn'
                            WHEN s.seat = v_n - 1       THEN 'co'
                            WHEN s.seat = v_n - 2       THEN 'hj'
                            ELSE 'utg' END,
           'blind_role', CASE WHEN s.seat = 1 THEN 'sb'
                              WHEN s.seat = 2 THEN 'bb'
                              ELSE 'none' END)
         ORDER BY s.seat)
    INTO v_seats
    FROM (
      SELECT r.e, r.pid,
             (CASE WHEN r.pid = v_bb THEN 2
                   WHEN r.pid = v_sb THEN 1
                   ELSE 2 + row_number() OVER (PARTITION BY (r.pid IN (v_bb, v_sb))
                                               ORDER BY r.crank) END)::smallint AS seat
        FROM (SELECT t.e, (t.e ->> 'player_id')::uuid AS pid, (t.e ->> 'caller_rank')::integer AS crank
                FROM jsonb_array_elements(v_pool) t(e)) r
    ) s;

  SELECT (x ->> 'player_id')::uuid INTO v_btn
    FROM jsonb_array_elements(v_seats) x WHERE x ->> 'position' = 'btn';

  v_hand := gen_random_uuid();

  -- =========================================================================
  -- THE ATOMIC BLOCK. Everything below either all happens or none of it does.
  -- An exception here rolls back to this block's implicit savepoint, and the
  -- instance, the reservations, the hand and the participants cease to have
  -- ever existed - which is a stronger form of specification 728-731 than
  -- releasing them would be, because there is nothing left to release, nothing
  -- to reap, and the players' pool state is restored by never having changed.
  -- The exception list is CLOSED: anything that is not one of these five
  -- classes propagates and aborts the caller, because a barrier that swallows
  -- every error is a pool that silently stops dealing with no row saying why.
  -- =========================================================================
  BEGIN
    INSERT INTO public.lightning_instance
      (cluster_id, cluster_epoch, state, target_size, max_size, created_at, deadline_at)
    VALUES (g.id, v_epoch, 'forming', v_target, v_max, p_now, p_now + v_window)
    RETURNING id INTO v_instance;

    -- STEPS 2 AND 3: the player reservation and the seat reservation are one
    -- row, because they are one claim. lightning_reservation_one_active_per_-
    -- player is what refuses a second matcher holding the same person;
    -- lightning_reservation_one_seat_per_instance is what refuses two people
    -- holding the same seat. Both are indexes, so both are decided by the
    -- database at INSERT time rather than by a read anybody can lose a race to.
    INSERT INTO public.lightning_reservation
      (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
       seat_number, state, created_at, expires_at)
    SELECT g.id, v_epoch, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           v_instance, (x ->> 'seat')::smallint, 'pending', p_now, p_now + v_ttl
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 7: the immutable hand id, and STEPS 8 AND 9: the instance and the
    -- epoch it is bound to. The hand is born UNLOCKED - the latch goes on
    -- after the participants are in, which is what makes step 10 a step.
    INSERT INTO public.lightning_hand
      (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at)
    VALUES (v_hand, g.id, v_epoch, v_instance, p_now);

    -- STEPS 4, 5 AND 6: positions, blind roles and the stack snapshot.
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, "position", blind_role, stack_before,
       fold_type, cluster_id, cluster_epoch)
    SELECT v_hand, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           (x ->> 'seat')::smallint, (x ->> 'position'), (x ->> 'blind_role'),
           (x ->> 'stack_before')::numeric, 'none', g.id, v_epoch
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 10. The latch and its count move in one statement, and
    -- trg_lightning_hand_is_immutable refuses the statement unless the count
    -- matches the rows that are actually there.
    UPDATE public.lightning_hand h
       SET participants_locked_at = p_now, player_count = v_n::smallint
     WHERE h.hand_id = v_hand;

    UPDATE public.lightning_reservation r
       SET state = 'committed', resolved_at = p_now
     WHERE r.lightning_instance_id = v_instance AND r.state = 'pending';

    UPDATE public.lightning_instance li
       SET hand_id = v_hand, state = 'reserved', deadline_at = p_now + v_window
     WHERE li.id = v_instance;

    -- P2 BOOKKEEPING, AND NOT ONE COLUMN OF IT IS MONEY. last_bb_at is what
    -- makes the next formation pick somebody else; without this stamp the same
    -- player is the big blind of every hand for ever. missed_bb_debt, bb_owed
    -- and sb_owed are obligations created when a blind is DUE and discharged
    -- when it is POSTED, and posting is barrier step 12, which is the engine's.
    UPDATE public.lightning_pool_slot sl
       SET last_bb_at     = CASE WHEN sl.player_id = v_bb  THEN p_now ELSE sl.last_bb_at END,
           last_sb_at     = CASE WHEN sl.player_id = v_sb  THEN p_now ELSE sl.last_sb_at END,
           last_button_at = CASE WHEN sl.player_id = v_btn THEN p_now ELSE sl.last_button_at END,
           hands_since_bb = CASE WHEN sl.player_id = v_bb  THEN 0 ELSE sl.hands_since_bb + 1 END,
           hands_since_sb = CASE WHEN sl.player_id = v_sb  THEN 0 ELSE sl.hands_since_sb + 1 END,
           updated_at     = p_now
     WHERE sl.id IN (SELECT hp.pool_slot_id FROM public.lightning_hand_player hp
                      WHERE hp.hand_id = v_hand);

    INSERT INTO public.lightning_blind_ledger
      (cluster_id, player_id, bb_count, sb_count, btn_count, utg_count, hj_count, co_count,
       first_seen_at, updated_at)
    SELECT g.id, hp.player_id,
           (coalesce(hp.blind_role, 'none') = 'bb')::integer,
           (coalesce(hp.blind_role, 'none') = 'sb')::integer,
           (coalesce(hp."position", '') = 'btn')::integer,
           (coalesce(hp."position", '') = 'utg')::integer,
           (coalesce(hp."position", '') = 'hj')::integer,
           (coalesce(hp."position", '') = 'co')::integer,
           p_now, p_now
      FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand
    ON CONFLICT (cluster_id, player_id) DO UPDATE SET
      bb_count   = public.lightning_blind_ledger.bb_count   + EXCLUDED.bb_count,
      sb_count   = public.lightning_blind_ledger.sb_count   + EXCLUDED.sb_count,
      btn_count  = public.lightning_blind_ledger.btn_count  + EXCLUDED.btn_count,
      utg_count  = public.lightning_blind_ledger.utg_count  + EXCLUDED.utg_count,
      hj_count   = public.lightning_blind_ledger.hj_count   + EXCLUDED.hj_count,
      co_count   = public.lightning_blind_ledger.co_count   + EXCLUDED.co_count,
      updated_at = EXCLUDED.updated_at;

    -- THE BARRIER'S OWN PRE-COMMIT RE-CHECKS, raised as check_violation so
    -- that they land in this block's own handler and take the whole formation
    -- with them rather than leaving a half-formed hand behind.
    IF (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand) <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % was formed for % players and holds %',
        v_hand, v_n, (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand)
        USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM public.lightning_reservation r
         WHERE r.lightning_instance_id = v_instance AND r.state = 'committed') <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % has % committed reservations for % seats',
        v_hand, (SELECT count(*) FROM public.lightning_reservation r
                  WHERE r.lightning_instance_id = v_instance AND r.state = 'committed'), v_n
        USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM public.lightning_hand_player hp
         WHERE hp.hand_id = v_hand AND hp.blind_role = 'bb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand AND hp.blind_role = 'sb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand AND hp."position" = 'btn') <> 1 THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % does not have exactly one big blind, one small blind and one button',
        v_hand USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_hand
                  AND (hp.stack_before IS NULL OR hp.stack_before <= 0)) THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % seated a player with no stack to post from',
        v_hand USING ERRCODE = 'check_violation';
    END IF;

  EXCEPTION
    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation
      OR exclusion_violation THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      -- Everything above is now rolled back. This INSERT is in the OUTER
      -- block, after the rollback, and is the only thing that survives it:
      -- specification 733's matcher_retry, carrying what refused and why.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
      VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_refused', 'sqlstate', v_sqlstate, 'message', v_msg,
        'players', v_n, 'target_size', v_target, 'at', p_now), v_epoch);
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_refused',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;

  -- F12'S SHAPE, ONE PHASE ON. The conversion asserts no chips moved when a
  -- Cluster becomes a pool; this asserts no chips moved when a hand is formed
  -- out of it. It is uncaught on purpose: money moving during formation is not
  -- a thing to retry.
  SELECT coalesce(sum(coalesce(ps.starting_stack, 0) + coalesce(ps.net_result, 0)), 0)
    INTO v_after FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.exited_at IS NULL;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: Cluster % pool chip total went from % to % while forming hand %, and forming a hand is a seating transition, not an economic transaction',
      g.id, v_before, v_after, v_hand USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (g.id, 'lightning_hand_formed', jsonb_build_object(
    'hand_id', v_hand, 'instance_id', v_instance, 'players', v_n,
    'target_size', v_target, 'max_size', v_max,
    'bb', v_bb, 'sb', v_sb, 'btn', v_btn, 'at', p_now), v_epoch);

  RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false,
                            'hand_id', v_hand, 'instance_id', v_instance,
                            'cluster_id', g.id, 'cluster_epoch', v_epoch,
                            'players', v_n, 'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
                            'seats', v_seats, 'state', 'reserved');
END
$fn$;

-- ===========================================================================
-- SECTION 9. NOTHING HERE IS REACHABLE BY A BROWSER (SPECIFICATION 532).
-- ===========================================================================
--
-- Every function is SECURITY INVOKER. service_role carries BYPASSRLS on this
-- database and the seven lightning tables are granted to postgres and
-- service_role alone, so there is nothing a SECURITY DEFINER would buy except
-- an owner-privileged surface for somebody to find later.

REVOKE ALL ON FUNCTION public.fn_lightning_pool_stack(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_stack(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_pool_slot_open(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_slot_open(uuid, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_pool_slots_sync(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_slots_sync(uuid, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_blind_order(uuid, integer, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_blind_order(uuid, integer, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_reap_formations(timestamp with time zone, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_reap_formations(timestamp with time zone, integer, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_instance_open(uuid, smallint, smallint, interval, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_open(uuid, smallint, smallint, interval, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_instance_abandon(uuid, text, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_abandon(uuid, text, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_instance_begin_dealing(uuid, interval, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_begin_dealing(uuid, interval, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_hand_player_is_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_hand_player_is_immutable() TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_hand_is_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_hand_is_immutable() TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_instance_is_disciplined() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_is_disciplined() TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_instance_releases_its_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_instance_releases_its_reservations() TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_reservation_is_disciplined() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_reservation_is_disciplined() TO service_role;

REVOKE ALL ON FUNCTION public.fn_lightning_pool_slot_holds_its_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_slot_holds_its_history() TO service_role;

COMMENT ON FUNCTION public.fn_lightning_form_hand(uuid, uuid[], smallint, smallint, uuid, interval, interval, timestamp with time zone) IS
  'THE HAND FORMATION BARRIER, specification 503-517, steps 1 to 10 and the binding that makes step 13 legal. Takes a candidate set in the matcher order and either returns a fully formed hand - instance opened and bound, seats reserved, positions and blind roles assigned along the P2 key, stack_before snapshotted from lightning_pool_session, an immutable hand_id, and lightning_hand.participants_locked_at set so that specification 519-524 bite - or returns formed:false having written nothing at all, because every write is inside one block whose rollback un-creates the instance, the reservations, the hand and the participants together. The only thing that survives a failure is the matcher_retry event, which is emitted after the rollback. Steps 11 and 12, the shuffle and the deal, are the engine''s and are deliberately not here: the authoritative RNG is not in this database and a hole card that were a row in it would be a hole card every replica could read.';

COMMENT ON FUNCTION public.fn_lightning_reap_formations(timestamp with time zone, integer, uuid) IS
  'Expires pending reservations past expires_at and abandons instances past the deadline they were born with, releasing their reservations through trg_lightning_instance_releases_its_reservations. Deliberately NOT gated on fn_platform_frozen(): giving a player back a claim they can no longer use is recovery, and the break is when recovery happens. It is the THIRD line of defence against an instance left forming for ever - the first is lightning_instance.deadline_at being NOT NULL, the second is fn_lightning_instance_open reaping the Cluster before it opens anything new.';

COMMIT;
