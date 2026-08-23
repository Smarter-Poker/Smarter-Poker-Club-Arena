# The type said 'all-in' and nothing ever said 'all-in'

Date: 2026-08-23
Author: cowork-replaysurface
Scope: the live hand-history surface — `HandHistoryPage`, `HandHistoryService`,
`handHistoryAdapter`, `HandHistoryPanel`, `HandReplayerPage` — plus the replay
component consolidation promised in the previous audit.

## 1. One wrong string, three live defects

`HandAction.action` was typed `'fold' | ... | 'all-in'`. The engine stores
`all_in`. `mapHandHistoryRow` cast straight through the union
(`a?.action as HandAction['action']`), so the type asserted a spelling that
appears nowhere in 11.8M action rows, and the compiler enforced that assertion
against nobody.

Correcting the union to the stored values turned the silence into three
compiler errors, each of which was a real bug already shipping:

1. **`handHistoryAdapter.ts:56` — the conversion never fired.**
   `a.action === 'all-in' ? 'allin' : a.action`. The panel's union is `allin`;
   the value arriving is `all_in`. So every all-in reached `HandHistoryPanel`
   as a raw `all_in`, missed `getActionColor`'s `case 'allin'` and rendered
   unstyled — **and was written verbatim into the exported/shared hand text**.
2. **`HandReplayerPage.tsx:100` — a dead ternary that worked by accident.**
   `a.action === 'all-in' ? 'all_in' : (a.action as ...)`. The test never
   matched; the fallthrough happened to produce the right value. Removed.
3. **`HandReplay.tsx` — its own local union repeated the same lie**, so the
   value it carried could never be compared successfully either.

`discard` (74,631 rows — draw and pineapple games) was missing from every one
of these unions. It is now a first-class verb with its own colour.

**The test suite was complicit.** `tests/unit/HandHistoryAdapter.test.ts` had a
fixture reading `action: 'all-in'` and an assertion that the adapter renamed it
to `allin`. It passed. It tested a fiction against fictional data, which is
exactly why the defect survived a test that appeared to cover it. Fixture and
test name both corrected to `all_in`.

**Lesson: a type that is never compared against is not a type, it is a
comment.** The moment the union told the truth, three bugs surfaced in one
compile.

## 2. The share invented per-winner amounts

`HandHistoryPage` built the shared hand's winners as:

    amount: hand.main_pot / (winnerSeats.length || 1)

An even split. Wrong on every split pot and on every hand with a side pot, and
presented to whoever received the shared hand as fact. It sat **directly
beneath** the 2026-08-20 comment fixing exactly this invention for `buttonSeat`
and `stack` — the third instance of the pattern, inside the block that fixed
the first two.

`hand_history.winners[]` has always carried `{ amount, potIndex, hand.name }`
per winner. `HandRecord` simply never surfaced it. It now does, and the share
uses the real figures.

Also fixed alongside: `game_type.includes('PLO') ? 'PLO4' : 'NLH'` labelled
PLO5, PLO6 and every non-PLO variant as something they are not.
`ShareableHand['variant']` already had `PLO5` and `PLO6` members.

## 3. The page claimed an empty history over a failed one

Two paths, same disease as everywhere else in this surface:

- `loadHands` caught its error, fired a toast, and left `hands` empty. The toast
  disappears after a few seconds; **"No Hands Recorded Yet" stays forever**.
- A 5-second safety timeout dropped `loading` unconditionally, so a slow but
  perfectly healthy fetch rendered that same empty state _while the request was
  still in flight_.

Both now resolve to a distinct, retryable "Could Not Load Your Hand History —
This Is A Loading Problem, Not An Empty History."

## 4. Consolidation — 7 replay components down to 2

The previous audit promised this its own PR. Done here. Every one of these was
provably unreferenced: barrel exports and prose comments only, never rendered.

Removed, with CSS and barrel entries:

- `table/HandReplayPlayer` (+ .css) — referenced only in comments
- `table/ReplayActions` (+ .css) — barrel only
- `history/HandHistoryViewer` (+ .css) — barrel only
- `club/HandHistoryModal` (+ .css) — barrel only
- `gameplay/HandReplayViewer` (+ .module.css) — redundant with `replay/HandReplay`

What remains: **`replay/HandReplay`** (DB-backed, the modal on
`/hand-history`, `/history`, `/hands` and "replay last hand" at the table) and
**`table/HandHistoryPanel`** / **`table/HandDetailModal`** (in-session engine
records). Two paths, each with a clear reason to exist.

`src/utils/handHistoryShape.ts` is kept deliberately and is **not** dead code,
though the component it was extracted from is gone: it is the executable
statement of what `hand_history` holds, its tests assert those names against
real production rows, and `HandHistoryService.mapHandHistoryRow` — the live
mapper — reads the same JSONB under the same names. Its header now says so, so
the next sweep does not mistake it for an orphan.

## 5. Known gap, deliberately not guessed at

`handHistoryAdapter` filters actions into `['preflop','flop','turn','river']`.
Actions with `stage = 'pineapple_discard'` are therefore **dropped** from the
panel entirely. Fixing it means deciding where a pineapple discard belongs in
street order, and the query to establish that from real rows times out against
a 10 GB table. Recorded here rather than resolved by assumption — inventing an
ordering would be the same mistake as inventing a winner amount.

Also unchanged: `stats` and Export operate on the currently-loaded page, not the
full history, while reading as lifetime figures ("Biggest Pot"). Honest, but
scoped smaller than it looks.

## 6. Verification

tsc clean. 3,189 tests / 254 files pass, 5 skipped. Nine CI gates run locally,
all pass. `PR #367` (the fabricated-hand fix) confirmed merged and serving
before this branch was cut.
