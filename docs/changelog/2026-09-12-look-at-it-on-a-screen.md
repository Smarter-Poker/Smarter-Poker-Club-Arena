# Look at it on a screen

BBJ programme, post-audit phase 5 of 5. 2026-09-12.

## The task that had been open the whole time

> **"Look at it: nothing in this audit has been verified on a screen."**

That item was filed early and stayed open through every phase. Everything this
programme changed had been proved by rolled-back probe, unit law, typecheck and
SQL read. Nobody had opened the page.

Phases 3 and 4 merged as `805cd70b43`; `main` is `367a6adecd` and
`https://ca-static.smarter.poker/build-info.json` reports the same `ca_sha`, so
for the first time the near-miss reader was live and could actually be looked
at.

## What the screen showed

**It works.** The `Jackpot Health` panel renders at 375px, and under it the
refusal list reads straight off the live log. Checked on both pool shapes,
signed in as the owner of Deep Stack Society - the same club admin the phase 3
probe ran as:

| pool                            | on screen               | in `bbj_near_misses` |
| ------------------------------- | ----------------------- | -------------------- |
| Deep Stack Society (club-owned) | 15 + 9 + 5 + 1 = **30** | 30                   |
| Midway Union (union-owned)      | 18 + 5 + 2 + 2 = **27** | 27                   |
| **total**                       | **57**                  | **57**               |

Every gate carried its label, its date, its biggest pot, and the engine's own
sentence underneath - _"So close! Full House lost - but the jackpot needs the
winning hand to be Quads or better."_ That sentence is the `example` field,
which shipped selected-but-rendered-nowhere and was only caught by the phase 3
deep dive. Seeing it on the page is the proof that the fix landed.

Zero console errors. No `BBJTicker` string anywhere in the published
`BadBeatJackpotPage` chunk, and `fn_bbj_near_miss_summary`, `Why It Has Not
Paid` and `Could Not Be Read` all present in it - so phase 4's deletion and
phase 3's reader both reached players, not just `main`. (That was the bundle
**as it stood when it was looked at**. `Why It Has Not Paid` is the string this
phase then went on to change, for the reason below, so it is deliberately not
in the next bundle - it is quoted here as evidence of what shipped, not as a
thing to preserve.)

## What looking at it found

### The heading was a claim, not a label

`Why It Has Not Paid` sat four rows under the **LAST HIT** tile, which read
**`0.3d` on both live pools**. The section announced that the jackpot had not
paid, directly below the number saying it had paid that morning.

Every row underneath was correct. The heading asserted a premise nobody had
checked against the tile above it - and no test could have caught it, because
each half is right on its own. It only reads wrong when both are on screen at
once, which is the entire argument for this phase existing.

It now reads **`Hands The Rules Turned Away`** / _Last 30 Days_, which is true
whichever way the pool is running. The list is worth reading when the jackpot
is cold and when it is paying, and it says the same thing in both cases.
`tests/the-near-miss-log-has-a-reader.law.test.ts` gained a pin: the heading
may not claim the pool has not paid. The pin was **mutation-tested** rather
than assumed - the old heading was put back, the law went red, the file was
restored and it went green. A law nobody has watched fail is a law nobody has
watched.

It also became an `h4`, matching this panel's own `h3` twelve lines above it.
It had shipped as a bare `span`, so the one section on the panel that exists to
be found when something is wrong was the one section a screen reader could not
find by heading.

### A union-shaped club id 404s on the jackpot route

Navigating `/clubs/fade0000-0000-0000-0000-000000000001/jackpot` - the club row
that represents Midway Union - redirects to `/unions/midway-Union/jackpot` and
lands on **ROUTE NOT FOUND**. There is no `unions/:unionId/jackpot` route;
unions have overview, operations, table-management, data, statements,
settlement and games.

**Reported, not fixed, and here is the reasoning.** Nothing in the tree links
to `/unions/:id/jackpot` - the path is reachable only by hand-typing a
union-shaped club id, which is how I arrived at it. Every real member club of
that union reaches the union pool correctly; SHARK CLUB was checked and renders
the full panel against pool `f9806a7f`. The union's own BBJ controls live on
`UnionDashboardPage`. So no operator is blocked, and a redirect change is a
navigation-wide edit with side effects well outside a BBJ phase. It is written
down here with the evidence rather than fixed on the way past or dropped.

(The slug it built, `midway-Union`, also carries a capital letter mid-slug.
Same note, same reasoning.)

### A law that had been passing on luck

The full suite went red on a case this phase never touched:
`tests/stage-b-retired-unapplied-migrations.law.test.ts` reported
**`Test timed out in 5000ms`** - which names no cause, and means the assertion
never ran.

It `readFileSync`s every file under `tests/`, `server/src/`, `scripts/` and the
migration directory, several thousand files with the migrations alone in the
thousands, then substring-scans each against every retired token. Measured:
**380 ms alone, 6,415 ms inside the full suite**, against vitest's default
5,000 ms. It had passed in all three earlier full runs this session, so it was
not newly broken - it was passing on luck and the load tipped it over.

Fixed with a 30-second budget, and the headroom is the point. CLAUDE.md 10.86
rule 4 is about exactly the wrong version of this fix: two agents de-flaked a
wait and set the budget to the ceiling they had just measured, so the wait got
robust and the headroom went to zero. 30 s is ~5x the worst observation and
~78x the solo run. Full suite after: **1,430 files, 19,445 tests, zero
failures.**

Not this phase's defect, but "never push a red test" does not care whose it is,
and a branch that can go red for an unrelated reason is a branch whose CI
result means nothing.

## What this phase did not do

It did not verify the states that need a different account or a stalled
service: the panel rendering nothing for a non-admin, the `unavailable` branch
when the RPC errors, and the empty-but-readable branch on a pool with no
refusals. Those are proved by probe and by law, not by eye. Naming them is
better than implying the screen covered everything.

## The programme

Five phases, closed. The last one changed one heading, and that heading had
been wrong on every operator's screen since the reader shipped, on a panel
whose entire purpose is to be readable when something is wrong.
