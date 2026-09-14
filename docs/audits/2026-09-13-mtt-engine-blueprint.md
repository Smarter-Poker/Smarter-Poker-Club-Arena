# Club Arena MTT engine audit and acceptance blueprint

As of September 13, 2026. This is a working audit with implementation evidence, not a declaration that every feature has passed production certification.

## Immediate incident and release facts

The live database had 24 overdue registering MTTs and 84 running MTTs with no new recorded hand during the observed 30-minute window. Running MTT clocks continued to advance (levels 114–3,881), while 4,366 playing registrations had zero or negative chips. Some fields were split into single-player tables. Cash hands continued, so overall fleet health concealed the MTT failure.

The engine at observation served de406ca925f0b83c02a6c46c4dedc61b1010dd27. Initial engine releases failed their host memory-headroom check on the 4 GB host. After PR #4508, a later host build succeeded, but successive release requests were superseded while waiting for the maintenance gate. The pipeline owner is recovering existing PR #4388 to address that publication starvation; this audit is not running a competing deployment. A passing test or merged change is not proof of live recovery.

## Public reference baseline

There is no single universal starting chip count or blind ladder. Measure initial depth as starting chips / opening big blind; compare that separately from level duration, growth rate, ante burden, late-registration depth, expected field and target duration.

| Reference                                                                                             | Published behavior                                                                                                                                 | Application                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [PokerStars tournament speed](https://www.pokerstars.com/help/articles/tournament-speed/)             | Slow 15-minute levels; regular 10; turbo 5; hyper 2. Timebanks also differ by speed.                                                               | Useful online speed benchmark, not a mandatory common ladder.                                                                           |
| [PokerStars tournament types](https://www.pokerstars.com/poker/tournaments/types/)                    | Multiple speeds and entry/format variants; turbo commonly 5–6 minutes versus regular 10–15.                                                        | Formats and speed are independent dimensions.                                                                                           |
| [PokerStars Michigan daily events](https://www.pokerstarsmi.com/poker/tournaments/daily-tournaments/) | Examples advertise 10,000-chip starting stacks and 8–12-minute levels.                                                                             | Chip counts are product examples; opening blinds are needed for depth comparison.                                                       |
| [PokerStars tournament rules](https://www.pokerstars.com/poker/tournaments/rules/)                    | Scheduled starts, random seating, hand-for-hand procedures, synchronized breaks, table consolidation, finishing and knockout rules are documented. | The platform needs explicit, deterministic rules and tested recovery for each boundary.                                                 |
| [PokerStars satellite policy](https://www.pokerstars.com/help/articles/satellite-info/)               | Qualification can produce a target entry or tournament money depending on target availability and prior qualification.                             | Every outcome needs a declared policy, durable receipt and visible target. Club Arena need not copy another operator's currency policy. |
| [GGPoker tournament types](https://ggpoker.com/tournaments/tournament-types/?lang=en)                 | PKO typically pays half of the captured bounty and adds half to the winner's head. Target Stack, shootout and N-stack are separate formats.        | Basic bounty support alone does not establish complete format parity.                                                                   |
| [GGPoker Mystery Bounty](https://ggpoker.com/tournaments/mystery-bounty/)                             | Its published format activates mystery awards in the money and divides entry funding between regular prizes and mystery bounties.                  | Activation, pool funding and random award custody must be explicit and conserved.                                                       |

Proposed Club Arena defaults below are engineering/product recommendations derived from these comparisons, not numbers mandated by an industry body. Current funded contracts must remain immutable.

## Observed Club Arena structures

Inventory query included tournaments with start_time later than seven days before the observation, including published future events. It is not a seven-day completed-event count.

| Sample                            | Start chips | Opening blinds |  Depth | Actual level durations | Finding                                                                 |
| --------------------------------- | ----------: | -------------: | -----: | ---------------------- | ----------------------------------------------------------------------- |
| Sunday $200 Deep Stack            |      30,000 |          25/50 | 600 BB | 10 minutes, 32 levels  | Deep starting depth; not a 15-minute slow clock.                        |
| DSS Wednesday PLO4 Turbo          |      12,000 |          25/50 | 240 BB | 4→3→2 minutes          | Actual fast ladder, but is_turbo is false.                              |
| Turbo Tuesday PKO                 |      22,000 |          25/50 | 440 BB | 10→5 minutes           | Active schedule selects STANDARD; published turbo name disagrees.       |
| Tuesday Bounty Hunt               |      18,000 |          25/50 | 360 BB | 10→5 minutes           | Standard speed taper, very deep opening field.                          |
| DSS Tuesday Mystery Bounty        |      25,000 |          25/50 | 500 BB | 10→5 minutes           | Deep opening; activation and funding require separate audit.            |
| Noon $100 Freeroll                |       5,000 |          25/50 | 100 BB | 10→5 minutes           | Free Buy and rebuy enabled; entry economics are not ordinary freezeout. |
| Sunday Warm-Up heads-up satellite |         300 |          10/20 |  15 BB | 3 minutes              | Distinct short heads-up qualification product; breaks disabled.         |

Across the published inventory, 195 ordinary non-rebuy MTT rows ranged from 2,000–40,000 chips; 153 rebuy rows 2,500–30,000; 100 Free Buy rows 3,000–12,000; 80 MTT satellites 8,000–12,000; 49 PKOs 4,500–22,000; 46 fixed bounties 3,000–18,000; 46 mystery bounties 3,500–25,000. Another 1,395 heads-up satellite rows used 300 chips. All these sampled groups had is_turbo=false.

### Existing sources of structure truth

- server/src/services/ScheduledTournamentService.ts: SLOW starts at 12 minutes and tapers to 6; STANDARD 10→5; TURBO 4→2; HYPER 2→1. DEEP aliases SLOW.
- server/src/services/TournamentRecurringService.ts: another preset/factory path plus Free Buy-specific rules.
- server/src/tournament/blindLadder.ts: generated growth ladders, ante timing and chip-supply ceilings.
- src/config/blindStructures.ts: manual creation presets differ again (regular 8, turbo 3, hyper 2, deep 15 minutes).
- server/src/tournament/TournamentManagerBase.ts: runtime blind progression, persistent clock anchors, synchronized breaks and add-on clock ownership.

### Target policy for future unentered events

| Product                  |                           Proposed initial depth | Proposed clock                                      | Other requirements                                                                    |
| ------------------------ | -----------------------------------------------: | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Regular MTT              |                                       100–200 BB | Explicit regular ladder, ordinarily 10 minutes      | Display exact ladder and late-registration closing depth.                             |
| Deep stack MTT           | 200–400 BB; larger only intentionally advertised | 12–15 minutes or a clearly disclosed alternative    | Depth and slow speed must not be conflated.                                           |
| Turbo MTT                |                                        75–150 BB | 5 minutes, or explicitly disclosed 3–4-minute speed | Names, speed flags, previews and engine rows must agree.                              |
| Hyper MTT                |                                         25–75 BB | 2 minutes or explicitly disclosed faster ladder     | Separate timebank/entry window constraints.                                           |
| MTT satellite            |                 Explicit target-linked structure | Regular/turbo as advertised                         | Stop at the qualification threshold; never run an equal-seat satellite to one winner. |
| Heads-up short satellite |                 Preserve existing 15 BB contract | Existing 3-minute product                           | Separate from deep MTT defaults.                                                      |
| Bounty / PKO / mystery   |             Select depth and speed independently | Same canonical structure policy                     | Bounty funding and activation cannot silently alter the ordinary prize pool.          |

Required engine normalization: explicit speed and depth metadata, one canonical validator, immutable configuration once funded, identical creation/preview/runtime projections, and rejection of impossible or contradictory structures. Do not infer economic rules from display names. Change incorrect named schedules deliberately and only for future eligible events.

## Root-cause repair register

| ID  | Verified defect                                                                                                      | Engine repair                                                                                                                                                                                              | Evidence/status                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Unknown satellite settlement awaited stop inside the scheduler job that stop itself drains.                          | Synchronous unknown-outcome fence, tracked asynchronous teardown, retain exact ownership until physical completion.                                                                                        | Runtime self-wait regression reproduced and fixed; PR #4503. Not established as the cause of both live stalled slots.                           |
| R2  | Elimination helper could return on budget expiry before recording a continuation.                                    | Requeue unfinished stage once while lifecycle remains current.                                                                                                                                             | Runtime budget regression reproduced and fixed.                                                                                                 |
| R3  | Global discovery awaited retirement of an unrelated stalled manager.                                                 | One tracked retirement per exact manager; keep its lease/map slot while discovery handles other events.                                                                                                    | Isolation/coalescing tests pass.                                                                                                                |
| R4  | Break resume timed out after 90 seconds and advanced despite maintenance still frozen.                               | Keep clock paused until actual thaw; report prolonged thaw once; honor cancellation.                                                                                                                       | Fake-clock regression and live timing evidence.                                                                                                 |
| R5  | A 100x Spin presentation patch changed funded is_premium_spin and was rejected by immutable contract protection.     | Remove that economic field from presentation projection; keep receipt-derived prize/blind rules.                                                                                                           | Live repeated contract rejection plus booked-spin regression.                                                                                   |
| R6  | Balancing's void helper could consume its budget without proving its stage finished, then be skipped on retry.       | Preserve balance-stage cursor and coalesced continuation when budget expires.                                                                                                                              | Red regression reproduced; fix passes focused test.                                                                                             |
| R7  | Break release lacked a consolidation wake when all tables had parked and no next hand could trigger one.             | Request elimination/consolidation sweep after break and deferred add-on ownership resolve.                                                                                                                 | Break-resume regression now asserts wake.                                                                                                       |
| R8  | clearPersistedBreak ignored returned database errors; a fenced notification continuation could still release tables. | Retain break through acknowledged persistence, coalesce concurrent clears, retry within current lifecycle, and fence continuations after each wait.                                                        | Four runtime regressions reproduced before repair; 47 focused break/clock/ownership checks pass.                                                |
| R9  | Speed metadata/default definitions differ between creation paths and actual schedules.                               | Shared engine preset module; scheduled, recurring, union and Free Buy factories derive speed from the actual opening clock, including custom arrays and legacy seconds. Manual repeats recompute metadata. | 90 policy/service checks and 65 creation-path checks pass. Manual UI/DB creator parity, schedule corrections and strict validation remain open. |
| R10 | Overall hand activity permits healthy status while every MTT is inactive.                                            | Per-format progress health with reasoned idle states and overdue-start tracking.                                                                                                                           | Per-event reader installed and PR #4529 merged. Engine metrics and loaded alerts await release proof.                                           |

## Feature-by-feature engine acceptance matrix

R12: blind-level transition writes reported errors but still advanced and
announced success; concurrent calls could also skip a level. The engine now
retains one intended level and its clock anchor through retries, waits for
acknowledgments before publishing, preserves that pending work over a break,
and rearms after notification failure. Seven runtime cases cover these paths.
All 1,865 tournament checks across 152 files and the server typecheck pass on
the follow-up candidate. Atomic publication of the tournament level and every
table in one database transaction remains open; this engine repair does not
claim to make the existing individual table writes atomic.

R11: the scheduled engine writer rounded explicit fractional bounty amounts to
whole chips. A runtime regression showed 6.75 becoming 7.00 on a 13.50 entry
contribution plus 1.50 fee. The repaired writer preserves cents and caps the
head at the contribution after the fee. The existing whole-chip buy-in ladder
and fallback percentage policy remain intact. Two active Turbo Tuesday PKO
schedules additionally advertise 50% while carrying a 16.50 input price and
7.50 head; the published price ladder produces a 15.00 total, and the old
writer produced an 8.00 head. Those future schedule terms need explicit
normalization; already funded contracts must not be rewritten.

“Present” means code was located; it does not mean every financial or production boundary has been certified. Tests must execute actual production paths with durable database receipts; static source guards alone are insufficient.

| Area                       | Required behavior and failure cases                                                                                                           | Current evidence / remaining certification                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduled launch           | Due events launch once with minimum entrants; recover after missed timer/restart; isolate one failed event; no unbounded retry loop.          | Discovery, launch receipts and recovery exist; R3 addresses global blocking. Observe overdue backlog after deployment.                                                                                 |
| Seat-first start           | Persist allocations, engines and first-hand authority before declaring successful launch; retry same generation.                              | Existing launch flow and tests; funded end-to-end proof pending.                                                                                                                                       |
| Insufficient entrants      | Explicit postpone/cancel policy; refunds once through original funding channel; honest lobby state.                                           | Existing cancellation paths; test overdue below-minimum and restart.                                                                                                                                   |
| Registration               | Atomic debit/entry; duplicate request and concurrent seat capacity safe; correct stack and fees.                                              | Database entry procedures exist; verify HTTP/client wiring and ledger conservation.                                                                                                                    |
| Late registration          | Engine and registration RPC agree on level/time boundary; close once; seat full advertised stack; no stale client bypass.                     | Level-based authoritative paths exist; mixed legacy late_reg_mins requires consumer audit.                                                                                                             |
| Unregister/re-entry        | Refund or reject according to published cutoff; stable identity per entry; enforce re-entry counts.                                           | Existing services; verify races with start, elimination and ticket redemption.                                                                                                                         |
| Rebuy/add-on/Free Buy      | Exact window, eligibility, atomic debit/chip credit; add-on break owns pause; no repeated grant after timeout.                                | Significant existing add-on/rebuy logic and tests; native funding journey pending.                                                                                                                     |
| Blind levels               | One authoritative level per tournament; table blind updates acknowledged; no mid-hand rule changes; overflow safe.                            | Timers and ladder code exist; partial write and late acknowledgment audit pending.                                                                                                                     |
| Clock recovery             | Preserve remaining playable time across restart and repeated breaks; no lost due timer.                                                       | Resume clock tests pass including R4; production breakpoint proof pending.                                                                                                                             |
| Synchronized break         | Stop new deals, finish admitted hands, shared deadline, actual thaw, correct restart.                                                         | 110 sampled MTTs shared and cleared the 19:55 break; stalled-event recovery and all-format proof remain open.                                                                                          |
| Add-on overlap             | Exactly one pause owner until both holds clear; level timer restored once.                                                                    | Existing ownership tests; native overlap scenario pending.                                                                                                                                             |
| Table balancing            | Safe move after hand settlement, unique seat custody, no duplicated/lost chips; complete short-table consolidation.                           | Existing receipt/ownership design; R2/R6 fix lost progress. Native custody proof open.                                                                                                                 |
| Final table                | Declare only after actual one-table consolidation; maintain seat/button fairness.                                                             | Explicit one-live-table guard present. Test concurrent moves and final elimination.                                                                                                                    |
| Elimination                | Zero stack processed once from committed hand result; deterministic simultaneous ranks; no ghost playing entries.                             | Scheduler/receipts exist; incident has thousands of zero-stack playing rows, recovery pending.                                                                                                         |
| Hand-for-hand              | All tables finish same round; rank ties by published rule; pause survives break/add-on.                                                       | Barrier implementation exists; cross-table and interruption certification pending.                                                                                                                     |
| Fixed bounty               | Determine eligible knockout winner from relevant pot; split tied awards correctly; one ledger credit per obligation.                          | Durable bounty obligation path exists; pot/side-pot/Hi-Lo native cases required.                                                                                                                       |
| PKO                        | Correct initial allocation, immediate share, carried head, split cases, champion's remaining bounty.                                          | PKO engine/DB paths exist; reconciliation with exact entry funding required.                                                                                                                           |
| Mystery bounty             | Frozen pool funding, one activation generation, published trigger, random inventory custody, no replacement/double claim, terminal remainder. | Activation and award receipts exist; full pool/draw audit pending.                                                                                                                                     |
| Normal payouts             | Correct pay table and guarantee overlay; integer-unit remainder rule; no negative/duplicate awards.                                           | 52,979 recent payout rows had paid_at and idempotency keys; ledger reconciliation not yet proven.                                                                                                      |
| Terminal settlement        | Winner declared once, prizes settled atomically, result receipt persisted, source seats/tables/escrow closed.                                 | Canonical tournament_terminal_settlements path exists. Older legacy finish rows are not canonical proof.                                                                                               |
| Satellite target           | Exact target ID/contract, advertised seat value, cutoff eligibility; target linked in lobby/receipt.                                          | Live settlement deliberately refuses bounty, PKO, mystery and Spin targets. Their prize/bounty/fee funding needs a coordinated upgrade; removing the refusal alone would create unfunded bounty heads. |
| Satellite qualification    | Equal awards stop at correct survivors; every seat/ticket backed by exact settlement receipt.                                                 | Atomic satellite settlement path exists; R1 fixes unknown response deadlock.                                                                                                                           |
| Satellite tickets          | Unique holder, target eligibility, one redemption, clear duplicate qualification/closed-target policy.                                        | Last seven days: 214 ticket awards with ticket IDs and 367 direct entries with registration IDs. Redemption conservation still to verify.                                                              |
| Satellite remainder        | Deterministic residual award separate from principal seat; explicit duplicate/closed-target policy.                                           | All 117 sampled cash awards were qualification awards, not remainder. Existing policy permits cash substitution; target-entry requirement needs deliberate future-contract treatment.                  |
| Deals                      | All eligible final-table players consent to exact terms; withdrawal/race safe; applicable bounty/seat rules retained.                         | Final-table deal receipts exist; full format restrictions audit pending.                                                                                                                               |
| Cancellation               | Never both settle and cancel; refunds, tickets and bounty obligations reconcile; interrupted request retries same intent.                     | Existing cancellation receipts; native concurrent settlement/cancel cases required.                                                                                                                    |
| Disconnect/sit-out         | Blinds/antes continue as published; timebank correct; reconnect gets server truth, not local clock.                                           | Table engine path requires format-specific review.                                                                                                                                                     |
| Client/lobby               | Truthful due/starting/running/break/completed states; no permanent Starts in 0:00 with false certainty.                                       | Screenshot confirms symptom; corresponding runtime recovery and UI state acceptance pending.                                                                                                           |
| Lease/restart              | Single writer, stale response fence, no slot reuse before physical drain, exact receipt replay.                                               | R1/R3 tests and existing lifecycle suite; native old-owner failure scenarios pending.                                                                                                                  |
| Observability              | Per-format last progress, start delay, stalled jobs, unresolved obligations, unredeemed/expired tickets, receipt mismatch alarms.             | R15 adds per-event metrics and alerts. Database reader installed; served collector and loaded rules remain open.                                                                                       |
| Shootout                   | Round-based table winners, no ordinary balancing between tables, next-round seating/stack policy.                                             | No engine implementation found in initial server search. Must trace whole product before claiming support.                                                                                             |
| Target-stack satellite     | Qualify at chip threshold, account for excess chips and simultaneous qualification.                                                           | No engine implementation found in initial server search. Not certified.                                                                                                                                |
| Multi-day / multi-flight   | Durable day/flight state, bagged chips, merge/re-entry rule, resumed blinds and seat ownership.                                               | Live12:09 guard explicitly refuses all seven day/flight fields; zero such shapes exist. Day-end, next-day resume and flight merge are unimplemented, not certified features.                           |
| N-stack / reserved bullets | Per-player reserved stacks, controlled release and published cutoff.                                                                          | No verified Club Arena engine implementation yet.                                                                                                                                                      |
| Other advertised formats   | Inventory every public label and reject unsupported settings at creation and registration.                                                    | Whole-product format inventory still open; do not advertise parity from labels alone.                                                                                                                  |

## Financial certification protocol

Run isolated funded fixtures for ordinary, rebuy, Free Buy, bounty, PKO, mystery, MTT satellite and heads-up satellite. For each, capture starting balances and liabilities; enter actual registrations; play legal hands through start, level, break, elimination and completion; capture canonical receipts and immutable ledger postings. Assert conservation of entry prize, fee, bounty, guarantee overlay, cash awards, carried heads, outstanding tickets and refunds in integer units. Retry every mutating request with the same idempotency key after injected timeout, and concurrently duplicate the request. Assert identical receipt and exactly one economic effect.

Test target event registering, late-registering, closed, cancelled, deleted and already qualified; issued ticket redemption twice; simultaneous final eliminations; bounty side pots, shared wins and Hi-Lo; mystery activation crossing a break; terminal result followed by transport failure; takeover during each write; cancellation racing terminal settlement. Client displays must reconcile to the same receipts.

## Release and production acceptance

1. All touched engine code receives meaningful regression tests; run the full tournament suite and server typecheck on the final candidate. Preserve normal protected CI and deployment safeguards.
2. Merge through the repository's branch proposal/autopilot workflow; let the protected engine deployment publish the candidate. No manual retirement, force restart or fabricated payout is a substitute.
3. Verify served engine SHA against the successful deployment. Then measure overdue starts and running MTT hand progress by format, with explicit explanations for legitimate idle states.
4. Observe a full synchronized break and restart, late-registration closure, table consolidation, each format's final receipt, cash/bounty postings, satellite delivery/redemption and closure of source seats/tables.
5. Reconcile the stranded production events individually. Never infer a winner, cash refund or financial authority merely from missing seats or a stale status.
6. Leave open any feature without end-to-end evidence. “All complete” requires the matrix above and the audited advertised format inventory to be closed, not merely a green unit suite.

## Evidence files

The associated machine-readable inventory preserves the sampled configuration, including full blind ladders. Investigation logs and native test output are retained in the task work directory. Source changes are in the Club Arena engine repository: PR #4503 merged as 829cc9a83b401d3481b7ed7750fbc8bb6c63ee3f; break acknowledgment and structure follow-up is PR #4512 on fix/mtt-break-ack-structure-sep13. The first release was superseded by a newer protected-main engine request; deployed recovery remains to be verified.

## Additional financial evidence (September 13)

- All 698 sampled satellite awards have their required delivery record: no missing issued ticket/direct registration, wrong ticket holder, wrong direct-entry user or wrong target registration.
- Of 214 issued entry-only tickets, nine were redeemed and 205 remained issued at observation. Outstanding does not by itself mean overdue or broken.
- All 214 had exactly one matching ticket-escrow issuance ledger posting. All nine redeemed tickets had exactly one matching redemption posting and one registration refund entitlement; no still-issued ticket had been consumed. These are read-only production reconciliation results, not injected native retry/concurrency tests.
- All 2,203 recorded recent bounty obligations were settled: 896 PKO, 838 regular, 22 mystery chest and 447 mystery pre-activation. This does not prove that every unprocessed knockout created an obligation.
- For 2,012 tournaments completed within the past day, cash prize receipts and prize-liability-to-player-wallet ledger postings matched in every one of 2,095 tournament/recipient groups: 110,531.60 on each side, zero mismatches. This excludes noncash satellite tickets/direct entries and does not certify every bounty, fee or historical tournament.
- The separate integration file tests/integration/tournament-flows.test.ts uses mocked database calls. Its end-to-end title must not be treated as proof of native money movement or served engine execution.
- A fresh private PostgreSQL 17 rehearsal passed all 15 cash-ladder derivation groups, including cent residuals, shortened fields, bubble reserves and malformed-input refusal. It exercises the captured amount authority on synthetic input tables; it does not execute payments or terminal completion.
- The retained full_stage1 bounty rehearsal refused its first fixture insert because that older local schema lacks tables.seat_game_scope. Its before/after fingerprints confirmed complete rollback. That failed fixture is not production payout evidence and does not satisfy the native bounty acceptance gate.
- The trusted money-trigger reporter configuration is absent, but the repository ruleset does not currently require that reporter for this branch. Required normal CI and deployment checks still apply.

## September 13 follow-up: actual payout authority and receipt validation

PR #4503 merged as 829cc9a83b401d3481b7ed7750fbc8bb6c63ee3f, PR #4512 as
91a7483609f336294585c40fc694f8dfc48e3a29, and PR #4520 as
7d67d8c5d6d737eea259e6ea6746159c8bad70d6. These source changes have not yet
been certified as served production behavior. G8 owns the incremental retained
scheduler responsibility/fairness fix and the pipeline task owns publication.

**R13: final prize responses were only converted with Number and checked for
finiteness.** Null or empty text became a zero pool; negative, hexadecimal and
fractional-cent amounts could also be accepted. Entry closure accepted empty
or malformed ladder arrays. The engine now shares the guarantee path's strict
whole-cent decoder across guarantee, entry-close and add-on-close responses.
Unreadable responses retain the existing retry and do not reprice finishers or
release the add-on tail. The entry consumer checks a usable stored ladder
before adopting finalization. Fifteen entry-close regressions and nine add-on
regressions failed before repair; the focused set now passes 123 checks across
six files. Full regression/typechecking results are recorded with the commit.

**R14: obsolete engine payout generation and its tests described the wrong
runtime contract.** The unused payoutStructureForField calculated 15% with a
three-place minimum and allocated percentage rounding residue to the final
place. A stored historical event, f5d68238-6c24-4317-9ca5-61426eeba2a5,
paid 24th 84.65 (0.57%) and 25th 86.06 (0.58%). The stored ladder itself is
inverted. One nonmonotone stored ladder was found among the queried recent
non-Spin events; two apparent cash inversions disappeared when winner
reconciliation payments were included. This is not evidence that the current
percentage generator still produces that historical shape.

The current runtime calls fn_close_tournament_entry_window; its locked
finalizer uses fn_ca_payout_structure(integer,integer), body MD5
869a4e87108481934c4cdb985d489051. That installed function uses a selectable
10/15/20% paid depth (default 10%), rounds depth upward, and distributes
percentage fractions by largest remainder. A 334-player event defaults to 34
paid places, not the obsolete TypeScript function's 50. The obsolete generator
and its misleading coverage are removed. A native engine-repository probe
executes the unchanged captured installed definition: 22 groups cover every
paid depth 1–2,000, exact 100%, positive whole basis points, nonincreasing
shares, consecutive ranks, replay and depth/fallback boundaries. All passed
on PostgreSQL 17. This proves percentage generation only, not money payouts.
The probe is scripts/dev/probe-tournament-payout-structure-pg17.py.

**Separate monetary-allocation limitation remains open.** Current
fn_ca_prize_ladder(400, 34/33/33 basis-point weights, unit=100) returns 100,
100 and 200 cents. This helper assigns monetary rounding residue to the last
place. Altering it globally can change existing owed amounts; a contract
version and partial-payment compatibility decision is needed before repair.
No funded ladder or historical balance has been rewritten here.

The current amount authority fn_ca_tournament_place_amounts now has body MD5
552b5a93163b625b5b69ff1503a3f3ee, whereas the prior fifteen-case repository
fixture captured 8f6cde5f5b799949506259f3064568b9. A scratch rehearsal using
the current definition passed eight groups and then identified changed
zero-pool behavior (no amount rows instead of explicit zero rows). The older
fixture's passing result is not current amount-authority certification.

A separate private PostgreSQL 17 rehearsal passed the funded PKO entry/add-on
case: 200 entry cost = 175 prize + 5 bounty + 20 fee; the 15 add-on goes to
prize funding; duplicate requests grant nothing extra and preserve the head.
The broader native registration/purchase/refund/heads-up suite now passes
all 69 groups using the existing Node adapter. It covers real funding,
concurrent last-seat claims, purchases, refund custody, launch races and
actual cumulative heads-up cash payouts; synthetic hand records do not
constitute a full native MTT dealer-to-terminal rehearsal. A local psql pipe stall was isolated to the test transport; its two
private clusters were shut down cleanly, and the existing Node adapter let the
same tests advance. No production data was used by those fixtures.

Observed seven-day tournament-hand duration baseline: 2,101,203 completed
hands; p99 80.146 seconds, p99.9 123.504 seconds, maximum 214.389 seconds.
Per-event monitoring must still account for active hands, legitimate pauses,
manager ownership and overdue breaks, rather than treating global cash activity
as proof of MTT health.

## September 13: per-event monitoring and creation-contract finding

PR #4522 is merged as `7514629cdcf988efa75fed60eedad831bf460e5b`; required
CI run 34775756884 succeeded. Final tournament regressions pass 1,890 tests
across 153 files, with server typechecking.

**R15: individually stalled MTTs were invisible to aggregate fleet health.**
The service-only `fn_tournament_progress_metrics` now counts each silent MTT
and overdue break independently. A busy cash table or another healthy MTT
cannot clear the count. Active breaks, add-ons and recovery grace are bounded;
missing break timestamps cannot exempt an event indefinitely. The collector
retains stale evidence on malformed or failed reads and rejects responses
after shutdown. Alerts require fresh evidence and suppress maintenance.

The database reader is installed (definition MD5
48fbeb982336d4303a6eb503e999d064; only postgres/service_role EXECUTE). At
19:35 UTC it reported 65 stalled MTTs and zero overdue breaks. Runtime tests
pass 37 cases across three focused files; all service suites pass 3,225 tests
across 185 files; the private native reader probe passes 23 groups; server
TypeScript and nine-rule Prometheus parsing pass. Engine publication and the
loaded alert inventory remain unverified. See the progress-monitoring changelog.

**R16: creator silently ignored paid-depth selection; repaired in database and candidate source.** The current
fn_create_tournament wrapper (MD5 16305fb3739f13e64af6a1e8eb3bf165) looks for
`tournamentId` or `id`, but its delegated governed creator returns
`tournament_id`. Thus selected payoutPercent 15/20 is never applied, leaving
the default 10. The wrapper also swallows all post-creation errors. The client
TournamentConfig/buildRpcConfig exposes a payout table but no paid-depth
field, while the current lock finalizer regenerates non-Spin ladders from
payout_percent. The native probe reproduced this and passes31 groups after the transactional
receipt repair. Migration20260913194154 was applied at19:42UTC, database
history20260913194226, source MD5 b6335e81d6629f8971d2fa378aebe6b1.
The selected setting now reaches manual/scheduled payloads and every engine
creator, and repeats preserve it. Existing funded contracts remain untouched.

**R17: creation built a final-looking ladder from a technical capacity.**
The current form no longer offers a custom MTT payout-table editor; earlier
comments describing that editor were stale. It nevertheless ran the old
client top-15 generator against its one-million capacity. A direct execution
produced150,000 places,149,999 zero shares and4,688,898bytes. The repaired form
sends a bounded provisional ladder and offers the database's supported10/15/20
paid-depth choices (default10). Finalization derives final shares from actual
entries. Spin and satellite qualification keep their distinct prize rules.

The native31groups use exact wrapper SQL with controlled delegated creation
and authorization. Full service/structure regression3,251/186, client116/4,
rendered form4cases and both typechecks pass. See the creation-paid-depth
changelog for source fingerprints and limits. The database repair is installed;
engine/frontend source publication and live acceptance remain open.

Per-event monitoring source is PR #4529, candidate
cc6130bdd70612611a66179e458b89c6cfdb75b3. Its database reader is installed;
engine and loaded-rule verification remain with the pipeline publication owner.

## R18 — atomic field-wide blind publication (20:10 UTC)

Confirmed: sequential table writes could expose mixed levels after a partial failure, and a concurrent table birth could use a cached previous level. A failed fresh request could also consume the unplayed level through its retained request timestamp. The new engine path and service-only RPC publish the full field plus parent clock together, confirm actual rows, retain a replay's durable shifted clock, and lock table births onto the committed snapshot. Resume reads the snapshot. Current hands retain their original stakes.

Both prerequisite/authority migrations are installed and hash/ACL verified; no historical funded contract was altered. Engine publication remains open. Native33groups including the add-on pause boundary, service/tournament/hand tests5,171 across340files, final100/4 and TypeScript passed; native scope is synthetic rows/direct trusted context with actual lock/claim functions, not full HTTP/production-trigger/financial certification. See the atomic blind publication changelog for the corrected DDL lock ordering, installed hashes, history and rollback boundary.

Source #4533 (paid-depth creation) merged asb19bbea185a581935a38d2fbdfb79ca01be7c74e with successful CI34778843030. Source merge is distinct from served UI/engine proof.

Live20:03 break observation: all110 sampled multi-table events cleared their shared break; no sampled levels advanced during the paused interval. Engine81fe7fc95d64817866a7d6d9103d2421a72f3152 completed8/8waves and1,358table resumes by20:02:54.522. At20:06 only36of110 had new hands since20:02:40 (461hands). The old stalled-event backlog, M17 continuation, complete payout/bounty/ticket reconciliation and full native terminal acceptance remain OPEN. Passing this break cycle does not close those boundaries.

## R19 — an already-played MTT reaches its launch completion authority

At20:14UTC the remaining overdue MTT, September8 Breakfast Turbo, held two survivors of34dealt entrants after199hands but remained REGISTERING with no launch receipt. The database proof accepts its original microsecond first-hand anchor; the manager's fresh three-player gate prevented that proof from being reached. The existing proof also lacked service-role execution. New engine routing proves and records the existing game, then joins normal resume in the same lifecycle before any fresh setup. It preserves level21 and the finalized153.00pool rather than reconstructing a new field.

The read-only grant is installed and verified (history20260913202413, unchanged body27037b1d61898aef22fd476a44667cc9). Native12groups, engine-focused48/3, full tournament1,926/154 and TypeScript pass. Native proof limits and scope are in the played-launch changelog. Engine publication and live recovery are OPEN; no direct live state repair or inferred winner was written. M17 scheduler continuation and remaining terminal/bounty/ticket acceptance remain distinct.

## R20 — percentage bounty allocations keep their cents

The scheduled, recurring and union engines rounded percentage heads to whole chips:30%of a5-chip entry became2instead of1.50. Recurring creators also ignored explicit6.75amounts. A shared engine calculation now preserves cents, keeps the existing percent-of-total convention, caps the bounty below the fee, supports explicit amounts in all three paths and rejects malformed/unfunded inputs before insertion. New fixed/PKO/mystery configurations use this amount, including mystery range display; existing funded amounts and stored repeats are not rewritten.

Initial actual-creator tests reproduced11failures/12cases. Repaired focused102/2 and fullservice/creation3,370/189 plus TypeScript pass. A private native probe passes6groups across5,1.50and6.75heads: actual entry funding/add-on/replay and real current conservation refusal with rollback. The September13captured payment/conservation bodies are hash checked; original registration request/core match live. Fixture schema/auth/maintenance limits, untested bounty rebuy generation, Diamond denominations, KO/draw/terminal and HTTP limits are explicit in the fixture README. Source submission and served-engine adoption remain OPEN.

### Monetary allocation policy investigation

The shared prize allocator still assigns rounding residue to the last paid place. Its4-unit34/33/33example yields1/1/2. A read-only September13 20:33 sample of49recent finalized non-satellite/non-Spin MTTs found zero inversions when pricing their stored ladders; bubble-protected ladders were excluded from pricing. This sample does not disprove the boundary bug or certify all historical awards.

There is no single operator-wide rounding algorithm to copy: [GGPoker's house rules](https://ggpoker.com/house-rules/) describe downward rounding to cents; [PokerStars' Fifty50 rules](https://www.pokerstars.es/en/poker/tournaments/types/) describe small final adjustments so the full pool is paid. [PokerStars' payout explanation](https://www.pokerstars.com/help/articles/trn-payout-structure/44864/) places the largest shares at the top finishes. Club Arena's existing exact-pool accounting must remain conserved.

Required repair design: version the future tournament's rounding contract; keep every existing funded/partly paid event on its recorded rule. For new version2, use integer unit quotas, floor each quota and allocate remaining units by fractional remainder with finish-position tie breaking. Validate nonincreasing positive percentages, whole-denomination pools, exact total, ordering, bounded per-place error and deterministic replay. Include the version in immutable creator documents and route it through engine/client display, database cash payer, reconciliation and satellite reprice. Copies of the pure client/server arithmetic must match native SQL vectors. Preserve version1 for legacy and already promised events; enable new generation only after database and served client/engine support agree. No global allocator replacement or automatic financial correction has been applied.

## September 14 continuation: request-mode recovery and prize contracts

R18 atomic blinds merged4047691c, R19 played-launch recovery mergedb97e1680, and R20 cent-correct bounty generation merged51ce4727; their required CI passed. Live engine last verifiedb97e1680, so R20 adoption remains unverified. R22 request-mode correction merged9a4f150d with requiredCI34791657270success; its SQL postimageec1aaf15293f431798d48a0ad91c5e3d is installed.

The live failure was the pre-request guard treating every POST as a mutable transaction. PostgREST executes STABLE POST functions read-only, so the guard's row lock failed before the recovery proof ran. The correction retains exact lease/freshness checks and read-write mutation locks. Native18groups and actual live HTTP200 verify that boundary. Breakfast Turbo's normal engine then wrote its launch receipt at00:11:19, preserving its September8 microsecond first hand,153pool, stacks and existing level. It remains a terminal/bust follow-through case; a recovered status is not full completion. At00:24UTC:0overdue MTT starts,85stalled running events and29overdue breaks. Remaining M17/lease movement is owned by G8/Connected and publication by Pipeline.

R21 supports future version2 prize contracts and makes reconciliation consume the actual canonical Bubble-reserved cash amounts. It preserves every existing contract and keeps ALL current creators on version1 until served engine and client support are both verified. The exact current chip-funded probe pays three prizes from four real0.01entries with concurrent retries, late receipt rollback, exact custody and unchanged replay. This is bounded chip composition; Diamond wallets, all historical payouts, missing bounty obligations, real-dealer elimination, full satellite uplines and paid terminal/provider certificates remain open. See the prize-contract changelog and native fixture README.

## R23 — malformed creation structures and missing speed metadata

The actual scheduled creator accepted eight malformed shapes, including zero big blinds, invalid durations, negative antes, decreasing blinds and non-boolean break flags. The current manual database creator also accepted the malformed arrays because it only checked nonempty JSON; its new four-minute event retained standard speed metadata. These are reproduced creation defects, not inferred causes of all 85 stalled live events.

The engine now shares creation validation with the manual/saved-schedule payload builder. Migration20260914005233 adds the same check at the common MTT INSERT/changed-structure boundary and derives speed from the actual opening clock. Converting an exempt short format into an MTT is checked too. Unchanged historical contracts and progress writes are preserved. All 23 distinct current active MTT structure/stack combinations pass the new validation. No advertised stack, ladder, bounty or existing payment is rewritten.

Native qualification uses both unchanged current creation functions over captured column types, with explicit authentication/club/other-trigger fixture limitations. It is not a whole-provider, funded-game or live lifecycle certificate. Embedded break rows remain subject to the existing synchronized break policy. The separate R21 branch remains held at its legacy-reconciler publication guard; R23 is based on origin/main and contains none of that unpublished branch.

R21 publication update00:43UTC: source b3790ff04e remains retained with no remote push or PR because the legacy-reconciler retirement guard refuses that definition. Its support schema is installed with all creators/events still version1; no new policy is active. Both authorization and trigger-declaration checks pass. Source retirement/compatibility intake remains with G8/Pipeline; no guard bypass was attempted.

R23 installation01:03UTC: migration20260914005233 recorded as history20260914010322. New source hashes f1f0ec57f980e1df361abacfa9efa030 /79d841121011fb3fc55cb335ad8f3b21 /9b8471c860ac00afa814a6553135c95b match; trigger enabled and declared; existing creator source/owner/grants unchanged. Service access and browser denial verified. No historical tournament row was rewritten. Final native11groups/59vectors,111engine-focused/2files and112client/4files pass; full5421/350 and serverTypeScript retained. ClientTypeScript26diagnostics match the preexisting missing-native-package baseline byte for byte. Source/served acceptance remains open.

## R29: registration display uses the existing engine window

The lobby's OR/minutes fallback and tournament-list minutes-to-levels adapter disagreed with the installed engine entry-window authority. The shared display projection now preserves level precedence, null/zero, finalized-pool closure, actual start and the strict minute cutoff. Actual lobby, card, satellite, ticker and details inputs are wired. Entry and financial authority remain unchanged on the server. Twelve original counterexamples, 2,047 client tests/129 files and46 engine entry-window tests pass; full app typecheck/build retain26 identical baseline native-dependency diagnostics. Required CI, served behavior and complete MTT acceptance remain open. See the entry-window projection changelog.

## R30: running recovery must include the gateway tail

Live11:14:57UTC reader proof: only1000of1283RUNNING rows were returned; Union Morning Classic, with an expired lease and overdue break, was excluded. The engine recovery lane now pages by id with the existing bounded reader, validates completeness, then offers events in oldest-start order through the same admission owner. Partial reads retain unknown state and cooldowns. Late generations cannot schedule work after a stagger. Ten actual-method old-code failures,5,747broader engine tests/369files andserverTypeScript establish source evidence. A read-only live paginated query included the event at11:17; deployed recovery and broader fleet/financial completion remain unverified.

## R24: due MTTs reach admission independently of unrelated funding

The actual broad discovery method waits for horse top-ups before its next registering board read. A regression holds that real top-up pending and proves a different eligible MTT cannot reach admission through the old pass. The engine now supervises a separate five-second scheduled-start read, ordered by scheduled time, through the unchanged shared admission/lease/launch authority. It retains every pending operation and its capacity, all freeze/lifecycle checks, existing retries and one-minute pre-seat lead. Pagination includes the event beyond the gateway's first1,000rows before choosing the oldest due field.

Twelve new cases and the full affected5,409tests/359files pass, with server TypeScript. No SQL, funding change, manual event status repair or deployment is included. At01:15UTC the live reader still reports84stalled runningMTTs/29overdue breaks and seven sampled01:00events await launch; serving remainsb97e1680. The particular live pending funding request has not been identified. This source repair is a reproduced dependency fix, not proof that it accounts for every live stall.

R23 strict new-MTT ladder/stack validation is separately submitted asPR4560 and installed as database history20260914010322. R21 versioned prize support remains retained atb3790ff04e5fab7d3e3fa306a0e58980980ba414, blocked by the existing legacy-reconciler retirement guard; all creators still use version1. Those independent source, database and activation boundaries must not be conflated. See this task's current integration handoff and the R24 changelog for release/ownership limits. Full lifecycle, terminal, bounty, satellite and provider acceptance remains OPEN.

## R25: introduced seat-first caller regression identified and repaired

Live satellite heads-up creation repeatedly failedSEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY. PR4533's paid-depth change incorrectly extended the heads-up/satellite atomic payload withpayout_percent. The unchanged database contract rejects it; this is an introduced regression, not a database defect. The engine now sends paid depth only for fields, preserving seat-first fixed payout/ticket contracts and strict unknown-key refusal.

Eight actual caller failures reproduced;39focused/2files and5,350service/tournament tests/350files pass, serverbuild passes. Private nativeeightgroups use12actualcapturedpayloads againstunchangedbodyb40dd95b7a87019070a8abf0fcc4fff3: committed pairs/exact replay, oldpayload refusal, target mismatch, freeze/ACL and late rollback. Fullprovider/financial/gameplay/served creation remainopen. The R25 changelog and fixture README preserve precise limits; no production rows or SQL changed.

## R26: a global freeze also owns clocks on tournaments without a local break

Actual blind advancement submitted an atomic publication every second while global maintenance was known active and the tournament's own on_break flag was false. The database refused the request, so this was repeated rejected traffic rather than a successful blind change. Eight regressions reproduce the caller defect. The clock now waits locally, reads the authoritative shifted anchor after thaw, retains remaining playable time and replays any possibly committed publication through the unchanged exact lease authority. Final24focused and2,211tournament/maintenance cases pass, serverTypeScript passes. RequiredCI and serving remain open; this is not proof of the root cause of all93currently stalled MTTs.

R20/R25 are now ancestors of served engine d28993d9. New seat-first creation and real hands are observed, while the six recent satellite terminal deliveries remain unproven. The two future Turbo Tuesday PKO templates were atomically corrected at10:00UTC after actual engine payload checks; their existing15total, custom22kstack and other booked terms remain unchanged. R23/R24 passed earlierCI and were updated normally for newer main/document conflicts; successor qualification and release remain separate. The per-event evidence and all open financial/provider boundaries remain in the task handoff.

## R32: union ticket redemption matches issuance scope

Three installed ticket functions required both host equality and membership in union_clubs, while existing issuance and the shared resolver correctly accept the union host or a listed member club. Exact read-only evidence shows137issued union tickets/11,000 affected by these predicates, split54member-club and83host-club tickets. The guarded migration changes only these scope predicates, preserving membership, exact ticket/target/value proof and all financial operations. Six old-source failures and24native PostgreSQL17groups verify the actual selectors and admission up to its unchanged financial prelock.

All222issued direct tickets/16,960have matching issue receipts and posted escrow at11:39UTC. Of these217/16,860target closed-entry events and remain a separate historical entitlement issue. Installed once at11:48UTC/history20260914114821; exact readback and both original selector/hint counterexamples pass. Existing engine65/5 and ticket laws30/4 pass. No ticket remapping, cash conversion, funded-entry certificate or full lifecycle completion is claimed.

## R27: mystery settings commit before publication

Manual creation used a second settings request and silently accepted default terms when it failed. Its request builder and the scheduled, recurring, union and repeat engine paths also dropped selected metadata. One shared engine decoder now supplies original inserts and the authenticated creation transaction. Six canonical columns persist before the creation response; any failed, skipped or changed write rolls back the event. The client checks the exact receipt and no longer races a follow-up settings request against registration. A common row guard protects activated settings even when the retained legacy setter first reads pending status.

Defaults and all entry, bounty, inventory and payout formulas are unchanged. Future pool percentages are numeric, bounded to 0–100 with at most two decimals and an exact regular complement. Existing unchanged funded terms remain intact. Original caller counterexamples: 23. Affected engine suites: 5,614 tests/363 files; client: 167/7; server TypeScript: pass. Eleven private PostgreSQL 17 groups cover transaction rollback and actual activation contention using captured creator/contract guards and explicit auth/delegated-create stand-ins. Local application typechecking is blocked by missing mobile dependencies. Required CI, production schema installation, serving and full financial/provider acceptance remain separate. See the R27 changelog and native fixture README.

R27 current-main composition passes 5,714 engine cases/364 files and 233 client cases/nine files, server TypeScript and 12 native groups. Its database transaction is installed as history20260914104027, with exact source/ACL/trigger readback at10:40:41UTC. New engine/client source publication and real-event acceptance remain open. The latest per-event observation at10:35:41 remains91stalled runningMTTs and0overdue breaks on servedd28993d9; source merges do not close that live incident.

## R28: current state gates manager resume

The served engine resumed a completed satellite from stale discovery and kept submitting rejected blind changes every second. The actual resume method ignored the fresh row's status and read error. It now accepts only the exact current RUNNING row before any gameplay setup and returns all other states through the existing exact-manager retirement path. Ten actual-method counterexamples, the successful running path and existing GameServer cleanup are exercised; all5,709service/tournament cases across366files and serverTypeScript pass. No SQL, financial receipt inference, new ownership primitive or deployment is included. Source, release and full-fleet acceptance remain separate; see the R28 changelog.

## Advanced-format implementation blueprint — September 14, 12:09 UTC

Current source search covers engine/services, tournament UI/types and migrations. Live catalogue inspection confirms `trg_tournaments_refuse_unbuilt_multi_day` is enabled; its function hash is `428b31045fc54a32e6207a6c15200cf5`. No stored event has a day/flight shape. The guard expressly documents absent day-end, next-day resume and flight merge. Keeping this refusal is necessary until a complete implementation replaces it. Union/XMTT scope does not mean multi-day. No shootout, target-stack or reserved-stack engine implementation was found. These are open parity gaps.

GGPoker describes reserved stacks with a release cutoff, target-stack qualification with excess-chip redistribution, and shootouts that advance table winners through rounds. PokerStars also lists phased, multi-stack, shootout and heads-up bracket formats. These are distinct engine contracts, not regular-MTT labels. Their existence establishes a comparison set, not one universal rule for every operator. [GGPoker format rules](https://ggpoker.com/tournaments/tournament-types/?lang=en), [PokerStars tournament types](https://www.pokerstars.com/poker/tournaments/types/).

The following is the proposed Club Arena implementation and acceptance design. It is not executable support or a claim of current functionality. Existing funded events retain their original rules.

| Capability                     | Required durable contract and engine work                                                                                                                                                                                                                                                                                                                                                                                                                                   | Acceptance that must pass before creation is enabled                                                                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-day and multi-flight     | One parent competition owns funding, prize contract and qualification receipts. Each flight has explicit end criteria and an immutable bag receipt containing entrant generation, exact chips, bounty liability and clock position. Existing hand settlement must finish before bagging. Next-day admission consumes each bag exactly once, with no new entry charge. Published rules choose one surviving stack versus combining stacks; neither is inferred from a label. | Duplicate bag/advance requests; restart between bag and destination seating; concurrent flight completion; same account surviving two flights; bounty and mystery inventory carryover; exact parent pool conservation; cancellation of one flight and the parent; final payout occurs once. |
| Shootout and heads-up brackets | Explicit round and match ownership prevents ordinary table balancing. A round advances only after all required table results have canonical receipts. Match assignment and byes are recorded before play. Published rules choose round stack and blind resets. The final round uses ordinary verified terminal settlement.                                                                                                                                                  | Unequal entrants/byes; simultaneous table winners; retry of advancement; delayed last table; takeover mid-round; no cross-match seat move; one final result and correct prize liability.                                                                                                    |
| Target-stack satellites        | Qualification consumes a committed hand result and immutable threshold. One atomic authority removes the qualifier's threshold chips, records exact excess-chip redistribution under published rules, and creates the existing funded entry/ticket obligation. It cannot qualify from projected client stacks.                                                                                                                                                              | Two players crossing together; tied/split pots; exact integer-chip residuals; already-qualified recipient; insufficient target capacity; target closure during award; no duplicate qualification, seat, ticket or redistribution after retry.                                               |
| Reserved stacks                | Registration funds all purchased stacks once. A per-entrant inventory distinguishes active, reserved and consumed chips. Release occurs only at a safe hand boundary; the cutoff authority atomically consumes all remaining reserve. Elimination cannot outrun a still-available reserve permitted by the published rules.                                                                                                                                                 | Manual release racing cutoff/hand completion; disconnect; restart; zero active stack with reserve; duplicate release; add-on/rebuy format compatibility; constant active-plus-reserved chip supply outside legitimate hand transfers.                                                       |
| Satellites into bounty formats | Target entry funding must split the seat value into exact regular prize, bounty and fee amounts using the original target contract. The current refusal stays until ticket issue, redemption, unregister/refund, knockout liability and terminal settlement all understand that split.                                                                                                                                                                                      | Fixed bounty, PKO and mystery targets; both club and union wallets; exact original target and value; no wallet fallback on ticket-only retry; duplicate entry; closed target; correct initial bounty head and full liability/ledger conservation.                                           |

Implementation belongs in the existing Club Arena creation validators, `ScheduledTournamentService`, `TournamentRecurringService`, `TournamentManagerBase`, elimination/seat authorities and atomic database contracts. Each new rule requires matching lobby previews and immutable registration terms. Do not add a second scheduler, inferred payout path or unrecorded financial adjustment. Each format requires real funded entry, legal hand settlement, restart recovery, terminal receipt, ledger/ticket reconciliation and served client/engine proof; unit-test success alone leaves it open.
