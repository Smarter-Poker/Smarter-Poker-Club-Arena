# The jackpot says what it does

2026-09-11. Branch `fix/bbj-the-rules-page-and-the-engine-agree`. The sweep
after the five-phase BBJ programme, and the last three decisions Dan handed
back.

The programme built the mini, measured its economics, made the promo bank
honest and closed the reseed. This is what an independent read of the whole
surface found afterwards: not missing features, but **places where a number or
a sentence disagreed with the thing underneath it.** Every item here is one of
those.

---

## 1. The rules page promised players a split that has never happened

`BBJQualifyingHands` printed, to every player, on the surface that tells them
how the jackpot is decided:

> If More Than One Player Loses With A Qualifying Hand, The Prize Is Divided
> Between Them.

It printed it because `BBJ_RULES.splitIfMultipleQualify` read `true` in both
halves of the config. **`detectBBJHit` has never divided anything.** It
evaluates every loser and pays the STRONGEST qualifying hand, and the comment
sitting directly above that loop said so:

> `BBJ_RULES.splitIfMultipleQualify` remains a documented aspiration

An aspiration in a comment is fine. An aspiration in a flag that a
player-facing surface reads is a promise the platform cannot keep.

Two of the four flags in that object - `excludeDoubleBoard`, `onlyFirstRunout` -
already had a law proving the engine enforces them, written after the same
defect was found in them. This was the third, and it was the only one of the
four a player could read.

**Decided: the flag becomes `false` and the copy states the real rule** ("The
Strongest Losing Hand Takes It"), rather than building the split to match the
promise. That is a decision and not a shortcut. Dividing a bad-beat share needs
`fn_bbj_payout_atomic` to accept two bad-beat holders - a money path with no
observed case anywhere in this database to build against - and the
strongest-hand rule is not a worse deal for anybody: it is the rule that pays
the player who took the worse beat, which is the whole purpose of a bad beat
jackpot. If a split is ever built, the law moves with it.

## 2. Every mini told the player it was the main jackpot, twice

On `bbj_payout_complete`, `TablePage` wrote its own notification:

```
title:   'Bad Beat Jackpot Hit!'
message: `The BBJ paid out a total of $${totalPayout} at ${tableName}!`
```

It is not kind-aware, so **every MINI announced itself as the Bad Beat
Jackpot** - the exact defect the server side fixed on 2026-09-11 ("a mini
recipient was told a 'Bad Beat Jackpot' had hit"), with the client copy missed.
And it reports the table TOTAL, so a player owed 12.40 was told the jackpot
paid 4,075.

It is also a duplicate. `processBBJPayout` already inserts one row per
recipient, naming the right jackpot, carrying that recipient's own share, and
saying whether it is credited or pending - and it reaches players who were
dealt in and have already closed the tab, which a browser never could.

**Removed.** A second answer written from the only place that cannot see the
whole payout is not a safety net.

## 3. The mini's payouts were counted as the main jackpot failing

`engineInstruments.ts` documents its BBJ counters as a set whose useful reading
is the DIFFERENCE: _"detected == paid is health. A detected that never becomes
paid or queued is the failure the whole of phase 2 exists to make impossible."_

The mini broke that arithmetic in both directions at once:

| event           | what it incremented                               |
| --------------- | ------------------------------------------------- |
| mini detected   | nothing                                           |
| mini paid       | nothing                                           |
| mini **queued** | `poker_bbj_payouts_queued_total` - **the MAIN's** |
| mini refused    | nothing                                           |

So every queued mini widened the main jackpot's `detected - queued - paid` and
read exactly like the main failing to deliver, while a mini that had stopped
paying altogether moved no series anywhere on the platform.

Four counters now, `poker_bbj_mini_*`, seeded at zero from boot so that "no
minis" and "no instrument" cannot read alike. They are separate counters rather
than a `kind` label because the two jackpots are separate products with
separate economics, and because a dashboard already reading the main's series
must keep meaning what it meant.

`poker_bbj_mini_payouts_refused_total` is the one that matters most. A reserve
sitting on its floor refuses EVERY mini at those tables by design, and the only
other evidence is an absence of hits - and the code's own measurement says 12
of the first 14 minis came out of one club's reserve at 3,642 chips a day.
**A refusal is a number** (CLAUDE.md 10.84).

### And a replay was being written down as a refusal

`already_paid` came back through the refusal branch and was recorded as
`mini_refused:already_paid` - the one instrument built to answer _"why did the
mini not pay"_ reporting a mini that DID pay. Settlement can run twice for one
hand; that is what the idempotency key is for, and the second run finding the
payout already there is the key working. `queued` was already excluded for this
reason; the other not-a-refusal beside it was not.

## 4. "Could not read the jackpot" was being shown as "this club has no jackpot"

`BadBeatJackpotPage` already contained the right screen:

> Could Not Load The Jackpot. The Jackpot Could Not Be Read Just Now. Nothing
> Is Lost - Try Again.

**It was unreachable.** Both reads that resolve which pool the page is about
were written `const { data } = await ...`, and supabase-js RETURNS its errors
rather than throwing them, so a failed read never reached the `catch` that sets
`loadFailed`. The page fell through to _"No Jackpot Pool For This Club Yet"_ -
and for a union club, a failed `clubs` read silently queried the CLUB pool
instead of the union's, showing an empty jackpot under the club's own name.

The same two discarded errors in `setupRealtime` built the winners
subscription's filter on an unread answer: a union club fell to
`club_id=eq.<club>`, a filter its jackpot rows never carry, and the
subscription then reported itself healthy while the club silently stopped
hearing its own jackpot land. That binding is now skipped rather than guessed;
the ten-second poll still drives the figure.

Three outcomes, not two (CLAUDE.md 10.86). `discardedErrorReadRatchet` moves
this file from 2 to **0** in the same commit.

## 5. A wrong constant waiting for its first reader

The client's `getFullRakeConfig` returned:

```
bbjPayoutTotal: 100, bbjPayoutLoser: 50, bbjPayoutWinner: 25, bbjPayoutTable: 25
```

**No stakes tier pays 100% of the pool.** They pay 15 / 25 / 40 / 55 / 70 / 85,
which the client already carries per tier as `bbjPayoutTotalPercent` and which
the server returns from the same four fields. Nothing read these yet, which is
the only reason it was latent rather than live - and is exactly why it had to
go: a wrong constant in a config gives its first reader no reason to doubt it.
Derived from the tier now, the way the engine does it.

The 50/25/25 shape underneath it was typed as bare arithmetic and bare "50%"
text across six client surfaces. `BBJ_MAIN_SPLIT` / `BBJ_MAIN_SPLIT_PERCENT`
now exist beside the mini's equivalents, which were created on precisely this
reasoning - _"a caption quietly disagreeing with the number under it"_ - and the
rules panel, which printed the mini's split as literals beside a figure
computed from the constant, reads the constant.

---

## Pinned

- `tests/one-qualifying-rule-for-one-jackpot.law.test.ts` - both halves agree on
  `splitIfMultipleQualify`, it is false, the engine picks one strongest loser,
  and the surface has words for the rule that is actually applied.
- `server/src/engine/theMiniNeverOverrulesTheMain.law.test.ts` - the mini's four
  counters exist and are seeded at zero, the mini payout step touches no main
  counter, paid / refused / detected each move their own series, and a replay is
  not a refusal.
- `tests/unit/discardedErrorReadRatchet.test.ts` - `BadBeatJackpotPage.tsx` at 0.

Both laws assert against the source with comments stripped. These files
deliberately explain which counter they used to increment and which sentence
they used to print; asserting on raw text would make the explanation itself
illegal and teach the next author to delete the reasoning to get the law green.

## Still open, and honestly named

The sweep found more than this commit fixes. Written down rather than quietly
dropped:

- **`bbj_near_misses` is write-only.** Three features insert into it - main near
  miss, mini near miss, `mini_refused:*` - and nothing in the tree selects from
  it. Its own docstring cites 10.86's "a guard must have a reader". The four new
  counters give the refusal half a reader; the near-miss half still has none.
- **Union pools have no mini operator control.** `fn_bbj_set_club_mini_enabled`
  refuses a union club and `can_toggle` is false for union pools, so the mini
  switch, the reserve floor and the runway built in phase 3 are unreachable for
  the pools where the production jackpot actually lives.
- **The drill is main-only.** `claimBBJDrill` makes the main branch taken, so a
  hand that genuinely qualified for the mini at a drill table never reaches mini
  detection.
- **`BBJTicker` is unmounted** and three other files carry comments reasoning
  about it as though it were live.
- **`fn_sweep_bbj_promo` moves money continuously with no cron row in this repo
  and no entry in `docs/BAND-AIDS-REGISTER.md`.**
