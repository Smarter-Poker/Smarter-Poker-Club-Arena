# Realtime Phase 3 - the deep audit before Phase 4 (2026-09-05)

Dan: "before you move onto phase 4 of 7, do a deep dive and verify that
everything you've built in the previous phase is 100% fully built, coded,
wired in and tested. CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE."

Phase 3 itself is live and proven on production (see the programme doc). This
records what a pass over it and everything around it found.

---

## First: the laws were mutation-tested, not just run

A law that passes against broken code is worse than no law, so each of the four
was checked by BREAKING the thing it guards and confirming it goes red:

| mutation                                      | law                             | result     |
| --------------------------------------------- | ------------------------------- | ---------- |
| auto top-up sends no `opId`                   | `a-top-up-is-charged-once`      | 2 failed ✓ |
| reload failsafe stops checking the auth cause | `a-reload-cannot-fix-a-sign-in` | 2 failed ✓ |
| `/action` handler stops replaying a known key | `theSameActionAppliesOnce`      | 2 failed ✓ |
| a 401 moves below the engine lookup           | `aRefusedRequestNeverRan`       | 1 failed ✓ |

All four green again on restore.

---

## Defect 1 (money): the automatic top-up carried no idempotency key

**The most serious thing in this pass, and it is older than Phase 3.**

`/addchips` is the one paid engine route where a repeat is indistinguishable
from a genuine second request. Every other paid route is idempotent by HAND
STATE - you cannot post the big blind twice, respond to one insurance offer
twice, or buy the same rabbit hunt twice, because the second call finds the
hand already changed. A top-up has no such state: topping up twice is
something a player may legitimately do.

So the Cashier audit (2026-08-27, P0-1) built a key for it. The handler takes
an `opId` and `ServerTableEngineSeating` keys the debit on
`addon:<table>:<user>:<opId || randomUUID()>`. **That fallback is the trap: a
caller that sends nothing gets a fresh key on every attempt and no
de-duplication whatsoever, silently.**

The manual cashier holds a key across its retries. The AUTOMATIC top-up
(`isAutoRebuyEnabled`) did not - so the one path that retries without a human
deciding to was the one path with no protection.

**The window is not the one people reach for.** A double tap is guarded by
`autoTopUpInFlightRef`; a 401 retry is safe because the handler refuses before
the debit (defect 3 below is about keeping that true). The window that costs
money is: the debit COMMITTED, the response was lost, the client threw, the
in-flight flag was released - and the very next snapshot still shows the stack
short, so the effect tops up again for a shortfall the first debit already
covered. That is precisely the case `opId` exists for.

Fixed to the shape its two siblings already use (`bustRebuyKeyRef`,
CashierModal's `opIdRef`): one key per attempt, keyed by amount so a retry for
the same shortfall is the same purchase and a different shortfall is a new one,
released only once the chips have actually moved.

## Defect 2 (money, latent): the prop type dropped the key on the way down

`TableModalsLayer` declared `onAddChips: (amount: number) => Promise<boolean>`
while `CashierModal` calls it with two arguments. It worked only because the
layer forwards the same function object rather than wrapping it, and
TypeScript accepts a one-parameter function where a two-parameter one is
expected.

So the manual cashier's idempotency key survived by accident. The most ordinary
edit imaginable - `onAddChips={(a) => onAddChips(a)}` - would have dropped it
silently, and every top-up would have gone back to a fresh server-side key.
Declaring `opId` makes that edit fail to compile instead of failing in a
wallet.

## Defect 3 (structural): nothing pinned "a 401 means nothing happened"

`engineFetch` retries EVERY engine call once on a 401. Nineteen endpoints ride
on it and several move real money. It is safe for exactly one reason, and the
reason lives in a different repository layer: every handler calls
`authenticateRequest` first and returns 401 before touching an engine, a table
or the database.

Twenty-one call sites, checked: all clean today. But the invariant existed only
as a comment in the browser about the shape of the server, and the day one
handler returns 401 after doing work - a permission check moved below a
mutation, an ownership test that reads a row first - `engineFetch` quietly does
that work twice. On `/addchips` that is a doubled top-up; on `/rabbit-hunt` a
double charge. Nobody would connect the two files.

`aRefusedRequestNeverRan.law.test.ts` now pins it across every handler, and
pins that the client retries a 401 once and retries nothing else.

## Defect 4 (reporting): the deploy told three stories about one skip

Landed separately in #3194 and recorded there: a run that shipped nothing said
"drain gate - hands are still in flight" in its summary, "the next break is
beyond this run's budget" in its log, and "the maintenance break never opened"
in the database. Only the middle one was true, and that step's own comment says
a wrong reason costs more than no reason.

---

## What was checked and found correct

- **Every client path that posts an action goes through `submitAction`** - one
  function, two callers (TablePage and MultiTablePage), so every action from
  every surface carries a key. No unkeyed path exists.
- **MultiTablePage mounts up to four `TablePage` instances**, so each carries
  the Phase 3 banner, auth-cause flag and reload suppression on its own socket;
  its only `location.reload()` is a button a player presses.
- **The other automatic reload** (`lib/supabase.ts`) is a one-time session
  migration behind a persistent flag, not a loop.
- **The other paid routes** (`/post-bb`, `/insurance`, `/timebank`,
  `/rabbit-hunt`) are idempotent by hand state, which is why they have never
  needed a key. Recorded so the next reader does not "fix" them.
- **No stubs, TODOs, `@ts-ignore` or `as any`** in anything Phase 3 wrote.

## Known and accepted bound

The `/action` key map is in memory and is lost on an engine restart. A restart
happens inside the announced break with every table parked and the platform
frozen, and a key lives 60 seconds, so the exposure is a retry that crosses a
restart while actions are refused anyway. The alternative - persisting keys to
Postgres - puts a database write on the hot path of every action, on a
one-core engine. Not worth it; written down so it is a decision rather than an
oversight.
