# A Certificate That Can Certify Nothing Is Not A Certificate

**2026-09-29 · tests/e2e/production-table-management.spec.ts**

## What happened

The Table Management section redesign shipped on 2026-09-29 as `43ea12b928`,
and with it the first live layer that watches those surfaces on the real site:
`tests/e2e/production-table-management.spec.ts`, wired into the post-deploy
`Client browser verification` job.

On its first real run it certified nothing, and the run still looked like a
run. Five tests: one failed, three skipped, one passed. Nothing about the
spade board, the shark ticker, the riveted messages panel or the unframed
Add Table picker was proved against production.

Two separate faults, and both of them were in the certificate, not in the
page.

## Fault one: it was pointed at a club where the board cannot render

Every test aimed at `E2E_CLUB_ID` — SHARK CLUB,
`a41434bb-8d0c-400a-8f0d-e8b3d65afed4`. That club belongs to the fixture
union `fade0000-0000-0000-0000-000000000001`, and a union's member club
correctly refuses local game management: `fn_club_union_context` reports a
`member_union_id`, `fn_game_creation_access` answers `union_only`, and the
page draws "This Club Is Managed By Its Union" on the shark frame with one
Return plate. That is the right behaviour. It also means the board could
never appear there, so a suite aimed at that club can only ever report
nothing.

`production-e2e-account.mjs` already knew this. Its own comment says a union
member club "correctly refuses this creation route regardless of its local
admin membership", and the post-deploy job already provisions the reserved
account as an admin of the standalone template club as well
(`prepare-template-staff`, `E2E_TEMPLATE_CLUB_ID`,
`2a1132b9-5ba2-42e6-9f01-30a7fcffebe3` — no `clubs.union_id`, no
`union_clubs` row, active). The certificate was reading the wrong one of the
two clubs it had.

So the board, the ticker, club messages and the picker are now certified on
the standalone club, and the refusal gets a certificate of its own on the
union member club: shark frame, exactly one Return plate, no section strip.
A refusal is a shipped surface, and it is now watched like one.

## Fault two: a refusal was treated as an absence

Three of the tests carried `test.skip(await refused(page))`. A skip is how a
suite says "this could not be looked at". A refusal is the opposite: the page
answered, clearly, and the answer was no. Turning one into the other is what
let four fifths of this certificate disappear without failing anything — the
run's anti-skip guard asks only that each spec file execute at least one
test, and the one survivor satisfied it.

A refusal on the standalone club now fails, with a message that says which
fixture drifted and why skipping it is not an option. The only remaining skip
is being signed out, which is a genuine absence: `globalSetup` can fail to
obtain a session.

## Fault three: the wait was timed against a clock, not an outcome

The helper that opened each page slept 1200 ms and then waited for the
access-check copy ("Verifying Game-Management Access") to **detach**. On a
cold first load that copy has not rendered yet, so "detached" was already
true the moment it was asked. The helper returned onto a still-empty page,
the refusal probe found no Return plate and reported "not refused", and the
test then spent its entire 30 s budget waiting for a section strip on a page
that had already resolved to Locked. That is the one test that failed, and it
failed for a reason that had nothing to do with what it was testing.

It now polls for the page reaching one of its two real outcomes — the section
strip, or the Return plate — and throws a sentence that says what it was
still waiting for if neither arrives in 45 s. Never time a wait against a
clock when the outcome itself is observable.

## What stops it coming back

`tests/unit/liveTableManagementCertificationCannotGoBlind.test.ts` reads the
spec's own source and pins the three properties: the board is certified on
the standalone club and `E2E_CLUB_ID` is used only for the refusal; there is
exactly one `test.skip` and it is the signed-out one; and no wait is timed
against a clock. A certificate that can silently certify nothing is worse
than no certificate, because it is trusted.

## Not fixed here, but now diagnosed

`Live-table and engine verification` still fails on "Certify live-table
continuity against the exact serving engine", and has on all five of the last
five publishes with the same message. It is a different subsystem and it gets
its own change, but the cause is no longer a mystery, so it is written down
here.

The MTT case asks the engine health endpoint for per-table liveness in the
fixture scope and gets back **at most 32 tables**. On run 36643419105 all 32
belonged to ONE tournament - "$100 Freeroll 6:00 PM",
`bf10245c-94f3-4aea-988e-2db75437a6ed` - which was inside its add-on period
(23:06:43Z to 00:12:30Z) for the whole of the job's 23:10-23:17Z window. Every
one of those 32 tables was healthy by the engine's own reckoning: nine seated,
nine dealable, unpaused, dealing. `selectableHudClock` then correctly refused
all 32, because a field in its add-on period cannot yield the natural level-up
the case needs.

So the selection starved on a single ineligible field while other eligible
fields were running in the same scope at the same time. The refusal message
reads as "production exposed no already-running MTT table with 3+ dealable
players", which sent two earlier readings of this failure looking at seat
counts and at the engine; the seats were never the problem.

The fix is to spread the candidate budget across distinct tournaments -
qualify tournaments first, then ask the engine for liveness on a few tables
from each qualified field - so one add-on period or one break cannot consume
all 32 slots. That widens the pool; it does not soften a single assertion.
Lowering the seat floor or turning the refusal into a skip would be weakening
a release gate rather than repairing it, and neither is done here.
