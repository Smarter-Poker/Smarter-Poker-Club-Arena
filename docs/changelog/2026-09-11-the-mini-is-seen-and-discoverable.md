# The mini jackpot is seen, discoverable, and a club's to switch off

2026-09-11. Branch `feat/the-mini-is-seen`. BBJ programme phase 2 of 5.

Dan, 2026-09-09: **"MINI BBJ NEEDS TO BE SEEN AND DISCOVERABLE LIKE THE BBJ
CURRENTLY IS."** Then, on the 11th with the popup in front of him: **"THE BBJ
FRAME NEEDS TO BE THINNER, ITS TOO THICK, AND UNDER IT SHOULD BE A 'MINI BBJ
AMOUNT THAT IS DYNAMIC AND ADJUSTS WITH THE TABLE. (IT SHOULD DISPLAY WHAT IT
PAYS OUT UNDER IT). 2, INSIDE THE BBJ POP UP, YOU NEED TO SEPERATE BBJ WINERS,
AND MINI BBJ WINNERS. THERE SHOULD BE A CLICKABLE TAB FOR THE MINI (SHOULDN'T
BE A MAIN FEATURE). SAME THING WITH THE 'BASIC AND THE QUALIFYING HANDS PAGES,
THEY NEED TO BOTH BE UPDATED WITH NEW 'MINI BBJ' INFO AND DATA."** And:
**"mini bad beat also needs to be a 'toggleable' on / off feature inside clubs
(that have no union affiliation) but should be 'added by default' when a new
club is started."**

---

## What a player could see before today

Measured 2026-09-11. The mini had been live two days, had paid **19 times for
11,600 chips**, and appeared on exactly **three** surfaces, every one of them
_after_ a hit: the celebration on the hitting table, the ticker's `MINI` chip,
and a badge in the winners list.

Nothing before a hand said a second jackpot existed, what it paid at these
stakes, what qualified for it, or that the "Backup Pool" number on the jackpot
page is the bank it pays from. The engine knew, `fn_bbj_mini_payout` knew and
the ledger knew. The surfaces did not, because **no read path existed for a
surface to ask.** An operator had no count, no spend line and no control at
all: the only switch was `bbj_mini_tiers.enabled`, which is global, so turning
it off turned the mini off for every club on the platform.

## The read path

Four migrations, all applied (the fourth is the guard-driven correction below).

| version          | what                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260911133435` | `fn_bbj_mini_for_club` - the mini as a player sees it; `fn_bbj_hand_detail` says which jackpot a hand was; `fn_bbj_analytics` gains the mini's own numbers |
| `20260911133927` | `fn_bbj_recent_hits` gains `p_kind`, so the winners list can be asked for one jackpot at a time and `total_hits` counts what the list counts               |
| `20260911140713` | `bbj_pools.mini_enabled`, the payout honours it, `fn_bbj_set_club_mini_enabled`, and the feed reports whose switch it is                                   |
| `20260911142515` | the switch names its own actor - `auth.uid()` in the function, not one call down - after `check-definer-authorization` blocked the push                    |

**On the files versus what ran.** Each file's version is the one production
recorded, not the one `new-migration.mjs` reserved: the management API stamps
its own timestamp at apply time, and the reserved name was renamed to match so
the file and `schema_migrations` agree. The executable SQL is **identical** -
verified by normalising both sides with the same algorithm (strip `/* */` and
`--`, collapse whitespace) and comparing md5s, which match for all four. The
on-disk files carry FULLER header reasoning than the text that was submitted;
that is the only difference, and it is the direction CLAUDE.md asks for.

Checking that turned up a real divergence rather than only formatting: the live
`COMMENT` on `fn_bbj_set_club_mini_enabled` named the four roles
(`owner, co_owner, admin, manager`) and the file still had the earlier wording
that did not. The live text is the better one, so the file was corrected to it -
34 characters that would otherwise have been a quiet lie in the repo about what
the database says.

**A SHOWN MINI IS A PAYABLE MINI**, and that is the one rule the whole feature
hangs on. `fn_bbj_mini_payout` refuses when
`backup - parked - amount < floor`; `fn_bbj_mini_for_club` computes `payable`
by inverting that test term for term, from the same `fn_bbj_parked_reserve`,
and every surface gates on it. So the felt cannot promise a mini the engine is
about to refuse - which is the failure this feature would otherwise have
shipped the first time a reserve touched its floor.

`lib/bbjMiniFeed.ts` is the client half: one poll per CLUB per minute, not per
surface, only while the tab is visible, and an immediate re-read when a hit
lands (`lib/bbjHitFeed` calls `refreshBbjMini`) because that is the one moment
the answer changes under a player's eyes. A failed read keeps the last snapshot
and reports; it never publishes a zero.

## Where the mini is now

| surface                  | before        | now                                                                         |
| ------------------------ | ------------- | --------------------------------------------------------------------------- |
| Felt plate               | nothing       | a `MINI BBJ` row under the nameplate with the flat amount for this table    |
| Lobby tile               | nothing       | the range the mini pays across this club's stakes                           |
| Popup - Winner           | mixed in      | a Mini row; one list per jackpot, each with its own count                   |
| Popup - Basic            | nothing       | the mini's flat schedule, its 50/25/25 in chips, and Pays / Paused          |
| Popup - Qualifying Hands | nothing       | the mini's bar per game, with its own card strip                            |
| Jackpot page             | "Backup Pool" | says it funds the mini; a Mini tile; a Mini Jackpot rules tab; mini winners |
| Pending / paid toasts    | "Bad Beat"    | names the mini                                                              |
| Recipient notification   | "Bad Beat"    | names the mini, and carries `kind` in its metadata                          |
| Hand drilldown           | identical     | "Mini BBJP Winners"                                                         |
| Operator panel           | nothing       | Mini Hits, Mini Paid, Mini Headroom against the reserve floor               |
| Union dashboard          | "Backup"      | "Backup Jackpot - Funds The Mini"                                           |
| Club settings            | nothing       | the switch (below)                                                          |

**The frame is thinner**: `.bbj-widget` border 5px -> 2px, inner bezel 1.5px ->
1px. The mini row is a second small plate hung under it rather than a third
line inside it, because the phone plate is a DECLARED 22px single row and the
felt's top reserve is measured against it. That contract now splits in two -
`--sp-bbj-plate-h` (the nameplate) and `--sp-bbj-mini-h` (the row) - and
`--sp-bbj-h`, which `TablePage.css` reserves, is their sum. The row's half is
`0px` until `TablePage` stamps `data-bbj-mini="1"`, so **the felt reserves the
row only when the row is drawn**. Both the stamp and the render ask one helper,
`components/table/bbjPlateVisibility.ts`, so they cannot drift; the old inline
condition is gone and its pin moved to the helper in the same commit
(`tests/unit/tournamentTableFixes.test.tsx`, CLAUDE.md rule 8).

The Mini row in the popup is a small pill pair under the three page tabs, not a
fourth tab beside them - "shouldn't be a main feature". The three pages keep
their names and their order.

## The club's switch

`bbj_pools.mini_enabled boolean NOT NULL DEFAULT true`. The default is a
property of the COLUMN, not of any creation path, so **every pool ever created
gets the mini** - neither of `fn_resolve_bbj_pool`'s two INSERTs nor
`fn_complete_club_opening_setup` names the column, and a new club therefore has
the mini from its first raked hand without another line of code.

The switch lives on the pool because the pool is what the mini is paid from:

- a club with **no union** has its own pool row, so that row is its switch;
- a club **inside a union** shares the union's pool - one reserve across every
  member club - so one member flipping it would turn the mini off for all of
  them. `fn_bbj_set_club_mini_enabled` refuses such a club by name
  (`union_club_follows_the_union`) rather than writing somewhere nothing reads.

Who may set it: `fn_is_club_admin_uid`, which is `owner`, `co_owner`, `admin`,
`manager` with an active membership - Dan, same day: _"club admin, owner or co
owner have access to all features and details like that, create a table, edit
settings etc."_ That was **read from the function, not assumed**, and it is the
same gate the rest of the club settings page uses, so this control cannot end
up stricter or looser than the ones beside it.

The settings panel draws a control only where the database would accept the
write (`can_toggle`), tells a union club why it has none, and reflects what the
database says **after** the write rather than what was clicked.

### Proved against production, in transactions that were rolled back (11.5)

Three probes, each one `DO` block ending in `RAISE EXCEPTION` - an error is the
success case:

| probe                             | result                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| switch OFF, then call the payout  | `applied=f refused=mini_disabled_for_club`, backup unchanged at 13,528.41   |
| switch ON, same call              | `applied=t total=700.00` (the Small tier), rolled back                      |
| the surfaces while off            | `enabled=f club_switch=f can_toggle=t is_union_pool=f payable[small]=false` |
| union club's own admin            | `union_club_follows_the_union`                                              |
| solo club's admin on its own club | `ok:true mini_enabled:false`, and the row stored `f`                        |
| a plain player, and a non-member  | `not_a_club_admin` for both                                                 |

### The guard caught the version of this that was one call too clever

`check-definer-authorization` **blocked the first push**, correctly: a
`SECURITY DEFINER` function that writes, that a browser role can execute, and
that never names `auth.uid()` itself. The actor _was_ derived from the session -
inside `fn_is_club_admin_uid`, one call down - so this was indirection rather
than an open door. But a guard that has to follow a helper to clear a
browser-reachable definer writer will eventually follow it wrong.

`20260911142515` names the actor in the function. That was not paperwork: the
function is granted to `service_role`, a service-role caller has no
`auth.uid()`, and before the fix such a caller fell through to
`not_a_club_admin` - a refusal that named the wrong reason. It now answers
`not_signed_in`, which is what is actually true. Re-probed, rolled back: no
session -> `not_signed_in`; the club's own admin -> `ok:true`, stored `f`; a
union club -> `union_club_follows_the_union`.

The order is deliberate and pinned: **authorize before explaining**, so a
stranger cannot learn a club's union shape from a refusal. The idempotency
branch sits BEFORE the switch, so a club that switches off after a hit was
queued still has that hit's parked shares settled - the switch decides whether
a NEW mini is owed, never whether an owed one is paid.

A mini refused by the switch is written down: `processMiniBBJPayout` passes the
RPC's `refused` through unchanged and settlement records
`mini_refused:mini_disabled_for_club` in `bbj_near_misses`, so a club can see
what its own switch turned away. No new engine branch was needed - the phase 6
law already required exactly this.

## What did NOT change

- **A mini still does not take over every screen.** It fires about four times a
  day; `bbjHitFeed` still returns before `BBJ_HIT_GLOBAL` for a mini, and the
  only thing added to that branch is a re-read of the reserve.
- **No client copy of the amounts.** Every figure comes from `bbj_mini_tiers`
  through the feed, so a tier Dan retunes is on every surface with no deploy.
  The law forbids a hard-coded tier amount anywhere in the client.
- **`fn_bbj_analytics`' existing columns still mean what they meant** - every
  hit of either kind. The `mini_*` columns say how much of that was the mini.
- **The World Hub was not touched.** Its BBJ display is imported only by
  `src/components/poker/MultiTableView.jsx`, which no page imports: the retired
  pre-Club-Arena poker UI. Changing it would have put a Vercel rebuild in the
  path of a Club Arena feature for zero players. Club Arena publishes to its
  own origin (CLAUDE.md 1.1) and that is the only path this work takes.

## Pinned

`tests/the-mini-is-seen-and-discoverable.law.test.ts` - 50 tests: the read path
reproduces the payout's refusal term for term; the client's rule mirrors
`detectMiniBBJHit` family for family and label for label; every surface above;
the thinner frame and the split height contract; the switch's default, its
authorization order, and that it reaches the surfaces through the one feed.
Registered in `docs/laws.d/`.

Three tests elsewhere went red and were fixed rather than weakened, all three
mine: the moved BBJ-exclusion pin (above), two fixed-size source windows in the
new law (`noFixedSizeSourceWindows`), and title case on the new copy - where
the `&apos;` entity defeats the checker's possessive handling, so the new copy
uses a real apostrophe.

---

## The deep-dive pass, same day, before this landed

The first push of this phase went up with all four gates green and was then
audited line by line against every surface. Eleven defects came out of that
pass and are fixed in the same pull request. Every one is a way of saying
something untrue about money, and none was hypothetical - each was reachable
from the code as pushed.

| what was wrong                                                                               | why it matters                                                                                                                    |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `BBJInfoModal` ranged over tiers filtered on `enabled` alone                                 | **The phase's governing rule, broken on one surface.** Opened from the lobby it printed "250 - 1,500" while every tier was paused |
| The same popup called a club's own switch "Reserve At Its Floor"                             | The wrong reason, printed under a header already reading "Off"                                                                    |
| "Off" was shown for a pool whose reserve is merely empty                                     | Reads as "this club turned it off". Three of the five live pools are in exactly that state                                        |
| `data-bbj-mini` tested `payable`; the row additionally tested `amount > 0`                   | A payable tier with a zero amount reserved 14px of felt for a row never drawn                                                     |
| The whole plate-height contract lived inside `@media (max-width: 768px)`                     | Above 768px the three properties did not exist, the stamp was inert, and the row hung at a hard-coded `top: 48px; height: 16px`   |
| PLO5 was told the mini "counts any four of a kind, not only Quad Kings"                      | PLO5's main bar is an 8-high straight flush. The sentence described a rule that game does not have                                |
| `refusalText` handled three of the RPC's five reasons                                        | A signed-out operator was told the save failed, not that they were signed out                                                     |
| Four mini subscribers never cleared state on a club change                                   | Club A's backup balance, floor and hit count rendered under club B's heading until the RPC answered                               |
| The union sentence said "Only The Union Can Turn It On Or Off"                               | No union-side control exists anywhere in `src/`. It pointed at a control that was never built                                     |
| "50%" / "25%" were literals beside figures computed from `BBJ_MINI_SPLIT`                    | Retuning the split would have left the captions describing the old one                                                            |
| `SeatSlot.css` justified the top-avatar cap with "the banner is a fixed 22px at every width" | No longer true once the mini row exists. The clearance arithmetic is right; the reason written beside it was not                  |

Two mechanisms came out of it, both so the defect cannot return by drift rather
than by intent:

- **`miniPlateAmount(snapshot, bigBlind)`** in `lib/bbjMiniFeed` is now the ONE
  answer to "does the row draw, and at what figure". `TablePage`'s stamp and
  `TableModalsLayer`'s render both ask it, so the reserved height and the row
  that fills it are the same decision by construction.
- **`miniPauseReason` + `BBJ_MINI_PAUSE_TEXT`** in `config/bbjMini` unfold
  `payable` - which is `pool.mini_enabled AND tier.enabled AND <floor test>`
  collapsed into one boolean - back into the three separate causes, so no
  surface has to guess which one it is looking at.

Four existing pins in the law test were MOVED to those mechanisms in this same
commit rather than weakened (CLAUDE.md rule 8), and the law grew from 39 tests
to 50.

### The CSS beat that could not tell, and failed loudly about it

`CI - Build & Type Safety` went red on the first push, on
`multi-table.spec.ts > reduced motion is honoured across the multi-table
surface`. Nothing in this branch caused it. The spec loads the CSS the bundle
is actually serving, and its loader did three unbounded `fetch` calls inside
one `page.evaluate`, two of them with no error handling at all. A slow read ate
the entire 30s budget and surfaced as `Test timeout of 30000ms exceeded`
pointing at the `page.evaluate` line - a message that names the symptom and
nothing about the cause.

The other direction is worse and is why this was fixed rather than re-run: an
unmatched entry script yields `js = ''`, every chunk 404s into the per-chunk
`catch`, and the loader returns happily having installed **zero stylesheets**.
The spec then asks "is this animation collapsed under reduced motion?" of a
document with no CSS, finds no animation, and **passes**. The red and the
silent green were the same defect - a reader that answers when it cannot tell
(CLAUDE.md 10.86) - and five specs carried a byte-identical copy of it.

`tests/e2e/lib/live-css.ts` is now the single loader, built from the shape
`card-squeeze-mobile.spec.ts` already had right: reads over Playwright's own
request API so they cannot consume the test budget, checks `res.ok()` on both
loads that matter, retries three times, and enforces a 2,000-byte floor on what
it installed. It has **three** outcomes, and `skipUnlessLiveCss` turns the third
into a skipped test carrying the reason - never a pass against an empty
document, never a bare timeout. The five copies are gone.

### What production says, read 2026-09-11

Five pools, and the column default did its job: **all five have the mini on**,
including the two created since. Nineteen mini hits, 11,600 chips, two in the
last twenty-four hours, the most recent at 05:47:46Z. No `mini_refused:` row in
`bbj_near_misses` - nothing has been turned away yet.

**Three of the five pools hold 0.00 backup against a 5,000 floor.** Their mini
is switched on and structurally cannot pay. Every surface correctly says
"Paused" for them - that is the `payable` gate doing exactly what it exists for

- but a flat floor against an empty reserve is a mini that never fires, and
  that is phase 3's problem, not a defect in this one.
