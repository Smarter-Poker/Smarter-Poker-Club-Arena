# Tournament audit — Cowork session 11 (2026-08-23)

Recorded here rather than in MIGRATION-CHANGELOG.md: every agent appends to
the top of that file, so a branch carrying an entry conflicts on every single
merge from main. This PR spent hours in that loop. Session records belong in
`.agent/audits/` anyway (World Hub CLAUDE.md section 1.2, point 3); the
changelog keeps the one-line pointer.

---

## Cowork session 2026-08-23 (11i) — THE COMPONENTS WERE ALREADY BUILT, THEY WERE JUST WIRED TO NOTHING

Dan, on an empty MTT tab: "tournaments are FAR FROM WORKING! WE DON'T EVEN
HAVE ANY LISTED." He was right, and the earlier "it works" reports were read
off a snapshot instead of the lobby.

THE EMPTY BOARD, FIXED WITHOUT A DEPLOY. At 04:25 UTC the board carried two
registering MTTs against thirty-eight active schedules. The engine and the
schedules were both fine - every schedule fired on time - but the spawner
only created an instance 30 MINUTES before its start, and a horse-filled
field starts on the minute and plays out fast. The code fix was sitting in an
unmerged PR, so it had helped nobody.

The same behaviour turned out to be reachable as pure DATA, because the
deployed spawner already honours two per-schedule config keys:
spawnAheadMinutes (proven live - the Sunday Major carries 10080 and had been
on the board a week) and horsesToRegister. Setting 1440 and 0 across all 38
schedules published a full day of card, opening every event EMPTY so no horse
is locked into a game that has not started; GameServer's past-start top-up
still fills short fields on the clock. Next poll: 2 -> 27 registering MTTs,
26 of them upcoming and empty, running from 12:00 today to 03:00 tomorrow.
No deploy, no code, no restart.

TWO RED CHECKS, BOTH MINE. The CSS-beat E2E pins the champion celebration by
animation NAME and DURATION (winnerGrandEntrance 900, trophyBounce 2000,
sparkleFloat 4000, prizeCounterSlideIn 800) and my overlay rewrite had
renamed all four out of existence. Loosening the test was the weak move, so
the new visuals were rebuilt INSIDE the contract. And check-migrations-applied
was reading a manifest that had not been regenerated since two functions were
applied straight to prod - the objects existed, the manifest was stale, which
is the second case its own message names. Regenerated from the live schema
through the documented MCP fallback.

THE PATTERN WORTH REMEMBERING. Two of the features Dan asked for as missing
were already written, documented, tested - and rendered NOWHERE:

- TournamentHUD: "a small, self-contained tournament status bar meant to sit
  on the poker table so a seated player always sees the current level, blinds,
  ante, the live countdown to the next level, players remaining and average
  stack." Exactly his request. Zero call sites. Now mounted on every
  tournament table.
- lazyWithRetry (11f): written for the stale-chunk crash, quoting that crash
  in its own docblock. Zero call sites.

A finished component wired to nothing is indistinguishable from a missing
feature, and it is worse than one, because everybody assumes it is working.
When a feature looks absent here, grep for it before building it.

ALSO SHIPPED: TournamentInfoPanel - the upper-right button on a tournament
table opened SESSION stats (stack, buy-in, VPIP), which answer a cash
question. It now opens the tournament: My Position / Entries / Prize Pool /
Bounty Pool / Level / Late Reg / Avg / Largest / Smallest over Ranking,
Prizes, Tables and Blinds, with your own row and your current level
highlighted. Cash tables keep session stats.

STILL OPEN: the 17 Heads-Up boards stuck at 2/2 and the ~14 games that played
to a finish but never left REGISTERING both need the engine fixes in PR #342
(start floor + played-but-registering watchdog). Data cannot reach them.

## Cowork session 2026-08-23 (11f) — THE CLUB PAGE WAS NOT EMPTY, IT WAS CRASHING

Dan: "they are displaying in midway union, but are not displaying inside the
clubs attached to midway union. neither club is showing any mtt's."

Chased this as a data-scoping bug and it was not one. Everything checked out:
union_clubs maps both clubs to Midway, crossClubTournaments is true, and
running the exact lobby queries UNDER RLS as Dan's own user returned the
union row, the union_id, and 56 live tournaments including 8 MTTs. The data
was reachable the whole time.

So I opened the page. /clubs/<jaqk>/tournaments rendered:

    SOMETHING WENT WRONG
    Failed to fetch dynamically imported module
    .../assets/CreateClubModal-C9SO3288-v6.js

That chunk is a 404. The browser was running an OLDER index.html whose chunk
hashes the latest deploy had pruned (the deployed tree carries
CreateClubModal-FODaI1aJ, and an orphaned .map from a third build). One
failed dynamic import, the error boundary swallows the entire page, and every
tournament on it is invisible. The union lobby survived because it is a
different route that did not need that chunk.

THE PART THAT STINGS: src/utils/lazyWithRetry.ts was written for exactly this
on 2026-08-19. Its docblock quotes the same error against
HamburgerMenu-<hash>.js. It retries the import, unregisters the service
worker, purges Cache Storage and re-navigates with a cache buster so the
stale HTML itself is invalidated. It has unit tests. And it was called ZERO
times: all 101 lazy routes and modals, across 9 files, used plain
React.lazy(), so a stale tab hit a permanent dead end instead of a reload. A
safety net that is written, tested, and wired to nothing is worse than no
safety net, because everyone assumes it is holding.

All 101 sites now go through lazyWithRetry (App.tsx alone had 89). Verified:
tsc clean, eslint 0 errors, 252 test files / 3183 passing, and a production
vite build succeeds with code splitting intact — 190 chunks, the lazy routes
still emitted separately, so this costs nothing in bundle terms.

FOR THE NEXT AGENT: a 404 on an asset hash is not always a build failure. It
is usually a client holding an old document, and the fix belongs in the
client's recovery path, not in the deploy. If you add a lazy route, use
lazyWithRetry — a plain React.lazy() is a future white screen.

## Cowork session 2026-08-23 (11e) — THE SCHEDULE WAS REAL, THE LOBBY WAS EMPTY

Dan: "there are currently no mtt's built, scheduled or running in the union
or inside any of the clubs... fix whatever is blocking this."

Checked the board before touching code, and the schedules were not the
problem. All 38 were active and every one had fired exactly on time: the
Silent Assassin spawned 02:30 for its 03:00, Midnight Freeroll 01:30 for
02:00, Night Owl 00:30 for 01:00. The DB held 6 running MTTs and 36
completed in six hours.

WHAT WAS ACTUALLY WRONG: an event only EXISTED for the thirty minutes before
it started. Add a field that fills and a game that plays out fast, and a
player looking at the lobby at any given moment saw TWO joinable MTTs out of
thirty-eight schedules — one of them 33 hours stale, the other a day away.
The schedule was real and the lobby was empty, which to a player is the same
thing. Club JAQK and SHARK CLUB were the same story from further away: the
union scope resolves correctly for them (verified — 66 rows, 8 MTTs, zero
private leakage), so they were seeing exactly the same two joinable games.

THE FIX, in two halves that only work together:

1. The look-ahead goes from 30 minutes to a FULL DAY, so tomorrow's card is
   on the board tonight with its buy-ins, guarantees and start times and a
   player can register whenever they like. That fits inside the lobby's
   existing 72-hour display window, and spawnAheadMinutes still overrides per
   schedule (the Sunday Major keeps its week so satellites resolve it).

2. Horses are seeded only when the start is within FIFTEEN MINUTES. Seeding
   at spawn was harmless at half an hour and harmful at a day: a horse
   registered into tomorrow's event cannot deal a cash table or fill a spin
   today, and it hands a full board to the humans the event is for. Events
   now open EMPTY and stay open; GameServer's past-start top-up fills
   whatever is short on the clock, the same mechanism that already rescues
   every short field.

One consequence had to be closed with it: a schedule with two start times
(Hot Turbo runs 15:00 and 21:00) now has both instances due in the same
poll, and the later collides with the earlier under
uq_scheduled_tournament_one_live_per_name. Holding the spawn key there was
right when a collision meant "this same instance already exists"; at a
day's look-ahead it would burn the 21:00 game for the day. The claim is
released so the poll retries and it spawns when the earlier one starts.

Pinned by tests/unit/ScheduledTournamentService.test.ts (updated in the same
change, per the never-push-a-red-test rule) and a new
server/src/services/scheduledLookAhead.test.ts — 9 tests covering the day of
look-ahead, the seed window, per-schedule override, and that spawn keys
still dedupe identically from any clock.

EXPECT AFTER DEPLOY: the next poll publishes roughly the next 24 hours of the
Midway card at once — dozens of REGISTERING MTTs, visible in Midway and in
both member clubs through the union scope, open and empty until their start
time. Verify by counting joinable MTTs, not by reading logs.

## Cowork session 2026-08-23 (11d) — THE SEAT THAT DESTROYED THE CHIPS THAT BOUGHT IT, and the full stuck-row chain

Same PR as 11b/11c. Two closing pieces: the root cause of 11c proved out
end to end, and one more money path caught before its first run.

THE STUCK-ROW CHAIN, CONFIRMED LINK BY LINK. 11c fixed the un-flipped
RUNNING status from both ends; reading the finish path afterwards showed
exactly why those eleven tournaments could never recover on their own:

1. start() flips REGISTERING -> RUNNING fire-and-forget. It fails (the
   statement-timeout window).
2. The game deals on from memory. Players bust; elimination stamps and
   positions are written normally.
3. finishTournament reaches its atomic claim — an UPDATE guarded
   `.eq('status', 'RUNNING')`. The row says REGISTERING, so the claim
   returns nothing, the method logs "Could not claim finish — already
   finishing/completed" and RETURNS.
4. That log line is indistinguishable from the benign case it was written
   for (a concurrent finisher won the race), so nothing escalates.
5. No watchdog reads pre-start rows, so nothing ever revisits it.

Every link is individually reasonable; together they park a finished
tournament forever with the pool unpaid. 11c's retry-and-confirm stops it
at link 1 and the new watchdog breaks it at link 5 by relabelling the row
so the ordinary machinery can finish the job. The strict CAS at link 3 is
deliberately left strict — a claim that accepts any status is how two
finishers pay the same pool twice.

SATELLITE SEATS DESTROYED THE MONEY THAT BOUGHT THEM. Awarding a seat was a
raw INSERT of a tournament_players row at chips 0. The winner got their
seat and nothing else moved: the target's prize_pool never grew, no rake
row was written, and the satellite's own collected pool was never disbursed
to anybody. Chips that players really paid simply left circulation, and the
target then paid out a pool one buy-in short for every seat it admitted.

fn_award_satellite_seat (migration 20260823010000, applied to prod with
assertions) now does the seat and the money in one transaction under a row
lock: prize_pool += the target's buy-in, a rake_records row for the target's
fee, current_players incremented — exactly where a direct buy-in lands,
funded by the ticket the satellite pool just bought, balancing to the chip.
It is idempotent by construction: the movement happens only when the seat
row is genuinely inserted, so a recovery re-drive seats nobody twice and
credits nothing twice. The engine calls it instead of the raw insert and
still falls back to a cash payout when a seat genuinely cannot be given.

Exposure at ship time: zero — no satellite has ever completed. The Sunday
Major Satellite runs daily at 19:00 UTC and would have hit this on its
first finish.

WHAT IS STILL HONESTLY NOT BUILT (do not read the flags as features):

- MULTI-DAY MTT is flag-only. is_multi_day/total_days are stored, sent and
  displayed, and the flights tables exist, but there is no Day 2 resume and
  no flight merge in the engine. An owner ticking Multi-Day today gets a
  normal one-day tournament. This needs a design pass with Dan, not a
  quiet half-implementation.
- BAN CHAT is client-enforced only; there is no inbound server chat handler
  to enforce it in. If one is ever added, enforce there too.
- SYNCHRONIZED BREAKS opting out only skips the global break; per-structure
  isBreak rows are still not honoured server-side.
- VIP ONLY reads profiles.is_vip (+ vip_expires_at), not a club VIP level.
- The seeded schedule GUARANTEES are large against horse-filled fields, so
  overlay is real house spend. Now that guarantees are actually paid (11b),
  these numbers are worth a deliberate review.

## Cowork session 2026-08-23 (11c) — THE ROW THAT NEVER SAID RUNNING, and the Heads-Up board that never dealt

Continuation of 11b, same PR. Asked to keep auditing to the end, the sweep
moved from the code to the BOARD — what is actually sitting in prod right
now — and found two silent outages plus a repo leak.

1. THE ENTIRE HEADS-UP PRODUCT HAD NEVER RUN A GAME. Sixteen Heads-Up SNGs
   (NLH and PLO4, every rung 1 through 100) sat REGISTERING at 2/2 for 47.7
   hours: fully seated, both buy-ins debited, zero tables ever built. Same
   root cause as 11b's start floor — a 2-seat duel is FULL at two players and
   the hard floor of 3 stood every one of them down on every pass, forever.
   11b's startFloorFor() releases all sixteen on the next engine deploy. The
   scheduled "Heads-Up Hyper Duel" was not one unlucky event; it was the
   visible corner of the whole board being frozen, and because each frozen
   duel holds two horses hostage, the pool that fills spins and MTTs was
   being drained by games that could never start.

2. A GAME CAN DEAL FOR 33 HOURS WHILE ITS ROW STILL SAYS REGISTERING. The
   REGISTERING -> RUNNING flip at the end of start() was fire-and-forget: no
   error check, no retry, no read-back. When it failed — and it did, during
   the DB-starvation window that was timing statements out — the game went
   on dealing from memory against a row that never learned it had started.
   Nothing heals that state: the stuck-COMPLETING watchdog reads COMPLETING,
   the decided-but-stalled watchdog reads RUNNING, fn_final_table_deal
   requires RUNNING. ELEVEN tournaments were sitting in that blind spot,
   22-33 hours old, PLAYED TO A FINISH (players carrying elimination stamps
   and positions), with 570 chips debited against 48 paid out — 522 chips
   owed to players who never got a result. Verified one by one: on "100 Chip
   Spin NLH" all three entrants were debited 100, two are 'eliminated', one
   is still 'playing', and no credit ever went back.

   FIX, two halves. The flip is retried three times and CONFIRMED by reading
   the row back (a row reading RUNNING or later is success, including when
   another process won the race), and a failure is now loud instead of
   invisible. And a new watchdog in the discovery loop — the mirror of the
   stalled-RUNNING sweep — relabels any pre-start row whose players carry
   elimination stamps: still contested goes to RUNNING for the resume path,
   already decided goes to COMPLETING and through the SAME recovery that
   pays stuck finishers. Registration alone can never produce an eliminated
   row, so that stamp is honest evidence the game dealt.

3. A FAILED SPAWN BURNED ITS SLOT FOREVER. ScheduledTournamentService claims
   a spawn key BEFORE inserting (correct — it is what stops two spawners
   racing), but on a failed insert it left the claim standing, so the next
   poll saw the key, stood down, and that instance simply never happened.
   Two orphan claims (tournament_id NULL) were sitting in prod from exactly
   this, one of them the Saturday Speedway 21:30. The claim is now released
   on a failed insert; if the release itself fails, the old behaviour is
   what remains, which is no worse.

4. AGENT SCRATCH WAS BEING COMMITTED TO MAIN. `_agent_tmp/` — where agents
   stage probes and patch sets — was never in .gitignore, so a routine
   `git add -A` swept it in. Nineteen files were tracked on main by today,
   including probe dumps, an orphan.js, and this session's own staging
   directory (via #345). Nothing in src/, server/, scripts/ or the workflows
   references any of it. Untracked and ignored.

VERIFICATION NOTE for whoever picks this up: items 1 and 2 are engine fixes,
so they take effect on the auto-deploy that follows this merge (server/\*\*
changed). Confirm behaviourally, not by exit code — the sixteen Heads-Up
boards should build tables and start within a poll or two, and the eleven
stuck rows should settle and pay out. The 522 chips are owed to real player
rows; the recovery path pays them under the standard prize idempotency keys,
so it can be re-driven safely if the first pass misses any.

## Cowork session 2026-08-23 (11b) — LINE-BY-LINE PARITY AUDIT: four live bugs, one panel the gate never had

Dan asked for everything pending finished and the whole tournament surface
audited line by line. The audit ran against prod behavior first (Supabase),
then the code. Four real bugs, all verified live before a line was written:

1. HEADS-UP LANE DEAD (engine): start() hard-coded a 3-player floor. A
   2-seat Heads-Up SNG is FULL at 2, so "Heads-Up Hyper Duel" (0504c8fb) sat
   REGISTERING 4+ hours at 2/2 while discovery started it and the floor stood
   it down, every pass — and the interval scheduler, seeing a live instance,
   never spawned another duel all day. Fix: startFloorFor(max_players) =
   min(3, max_players) clamped at 2, in the new pure module
   server/src/tournament/startRules.ts, unit-tested.

2. GUARANTEES WERE DISPLAY-ONLY for scheduler-spawned events (engine): the
   old recurring service pre-wrote prize_pool = max(entries, guarantee) at
   creation; the 2026-08-22 data-driven scheduler accrues per-entry through
   the register RPCs and NOTHING ever applied guaranteed_prize — Bounty
   Builder Turbo COMPLETED paying from a 12.5 pool against a 500 GTD, and the
   Sunday Midway Major was heading for the same against 10000. The lobby
   already displayed max(pool, gtd); only the money was wrong. Fix:
   effectivePrizePool(pool, gtd) written back to prize_pool at every point
   the pool stops moving — late-reg close, add-on end, and start() for
   events with no late registration — so payouts, lobby and the payout
   reconciler all read one number.

3. SATELLITE SEAT COUNT IGNORED (engine): processSatelliteAwards derived
   seats from floor(pool / ticketCost); the satellite_seats column the
   2026-08-22 template stores (Sunday Major Satellite advertises 5) was read
   by nothing. Fix: configured seats win; pool-derived remains the legacy
   fallback; no open target still falls through to the all-cash path.

4. ENTRY SPLIT INVENTED RAKE (DB, fixed live mid-session): the bounty branch
   of fn_tournament_entry_split defaulted the rake ratio to 10% when
   buy_in_fee = 0 — but zero IS the lawful fee for totals under 10 since the
   2026-08-21 floor rule. Every small bounty event was over-raked at
   registration and the pools picked up decimals (Blitz Bounty 6.8, observed;
   should be 8). fn now takes rake = fee, full stop. Applied to prod with
   passing shape assertions (3/0/1 → 2 to pool; 5/0/2 → 3; 18/2/9 → charge
   20 rake 2; 90/10 non-bounty unchanged);
   supabase/migrations/20260823000000_fix_entry_split_no_default_rake.sql is
   the repo record. History (completed pools) left as settled.

Plus, from the handoff's pending list (item 3): AUTHORIZED-TO-REGISTER
APPROVALS PANEL — the gate + table shipped 2026-08-22 with no owner surface.
RegistrationApprovalsPanel (TournamentDetails, detail tab) lists approvals,
searches club members, approves/revokes via direct RLS-backed writes
(trapp_admin_write), and renders only for club admins on gated events.

Defensive: restart-lane clones re-cut a legacy over-cap fee from the same
player-paid total before INSERT, so tournaments_rake_within_10_pct can never
hold a clone in a 24-hour retry loop.

Also this session, shipped separately: PR #320 (the rake-cap constraint had
frozen two mid-flight tournaments for 29 hours — data repair; both completed
within minutes) and PR #301 (the stranded session-10 changelog, rebased).

KNOWN LIMITS recorded: satellite seats into a BOUNTY target carry no funded
bounty head (do not point satellites at bounty events yet); multi-day remains
flag-only; ban_chat remains client-enforced (no server chat path exists);
schedule GTD configs are generous relative to horse-filled fields, so
overlays are real house spend — Dan should review the seeded guarantee
numbers if that matters.

---

## 11j — the fleet read as exhausted while a third of it sat idle (PR #462)

Found while sweeping the board after #342 published: 24 spins and 12 heads-up
games sitting 2 to 8 hours past their start with nobody in them. The obvious
read was "the horse pool is exhausted". It was not. Counted directly:

    584 horses total
    384 busy (tournament or seated)
    200 FREE — while 36 games waited for players

pickFreeHorses fetched the fleet with a bare `.limit(400)` against a pool of
584, so the last 184 could never be picked by that path at all. Its sibling
registerHorses has always sized the fetch as `count + busy.size`, and the
comment above pickFreeHorses even calls that "the convention this file
settled on" — this one had drifted off it.

The busy-set reads carried `.limit(2000)` as well. A TRUNCATED BUSY SET MARKS
BUSY HORSES FREE, which is the double-booking bug in its worst form, so those
ceilings now sit far above any plausible live count rather than just above
today's. The double-booking was already visible: 41 horses in a tournament
AND at a cash table, 24 seated at two cash tables at once — one AI identity
asked to act in two places.

Candidates are now shuffled before selection. Three callers run this — the
recurring service, the scheduler, and GameServer's past-start top-up — and
each was handed the same rows in the same order, with the busy set read
before the claim rather than atomically with it. Shuffling does not make the
claim atomic; it turns a near-certain collision into an unlikely one. A
proper fix is an atomic claim (a `claimed_by`/`claimed_at` on the horse row,
or a SECURITY DEFINER RPC that selects and marks in one statement) — worth
doing when someone next touches this path.

The shuffle uses nodeCrypto.randomInt. My first attempt used Math.random and
CryptoRandom.test.ts rejected it, correctly: a weak source that starts life
shuffling a horse list is one refactor away from deciding a payout.

VERIFIED AFTER DEPLOY: engine restart visible in hand_history (13:16-13:20),
running tournaments 16 -> 19 within two minutes, heads-up games starting
again. Pinned by pickFreeHorsesLimits.test.ts, which fails on a bare numeric
limit in the fleet read, on losing the busy-set sizing, and on losing the
shuffle.
