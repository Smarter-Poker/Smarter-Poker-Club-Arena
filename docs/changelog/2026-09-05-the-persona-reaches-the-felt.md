# The persona reaches the felt, the table gets read, and RIT gets Dan's rates

2026-09-05. Six items from the situational-awareness audit, plus Dan's
run-it-twice rates.

## 1. The persona had zero readers, and the ledger said otherwise

`CashPersona` — grinder / regular / mixer / night_owl / weekend_heavy, 1,580
rows written nightly — had **zero occurrences anywhere in `server/src/engine`**,
while `HorseDataLedger` described the decision as _"base style x profile dials
x variant overlay x persona"_. The sentence was aspirational. What actually ran
when `horse_profile` named no style was:

```ts
const styles = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
style = styles[h % styles.length];
```

The fleet was diverse and **nobody had chosen anything**.

A persona is not a poker style and pretending one maps onto the other would be
inventing meaning. What it legitimately carries is how a horse approaches the
game, and that does correlate: someone who plays four tables for ten hours
grinds, someone who dips in for an hour on a Saturday gambles. So a persona now
names a **weighted preference** over the same five styles and the id hash
chooses inside it — deterministic, and every style still reachable from every
persona (no weight is zero, and there is a test that all five appear for each).

Two properties are pinned deliberately:

- **A horse with no persona lands exactly where the old hash landed.** The
  uniform weights _are_ the old fallback, which is what makes this safe to land
  without a league run.
- **The fleet is not quietly re-weighted.** Across an even spread of personas
  every style stays between 10% and 32% of the old uniform 20%.

**The bridge:** the engine decides from `profiles.horse_profile`; the persona
lives in `stable_hand_membership_tags`, which the engine must never read at
decision time. The tagger now mirrors the persona into `horse_profile` as a
**merge** — the self-tuner's dials, the nightly leak counts and an explicitly
chosen style all survive — and its header contract was updated to say so
instead of claiming it writes only the two `stable_hand_*` tables.

## 2. The horse now reads the table, not just the seats

`tableExploit` pools per-**villain** mods, each relative to that player's own
baseline, so it cannot express _"this whole game is loose"_. Five opponents at
22% VPIP and five at 45% pool to very different games.

`HorseMind.tableProfile` returns mean VPIP and postflop aggression across the
seats that have a real sample, with the same ten-hand gate `exploit()` uses. A
table of strangers reads neutral — which is correct: it is what a human sitting
down knows about it. The brain applies it at three sampled seats.

Behaviour is **default OFF** (`v42Table`). The receipt `v42_table_read` fires
either way, and the test asserts the receipt is counted _before_ the flag is
consulted — a receipt behind a default-off flag proves nothing, which is the
whole reason it exists.

## 3. The ICM cold-cache fallback was two constants

`TournamentBrainContext` is a 20-second cache and `ServerTableEngineTurns`
returns `{ format, tournament: {} }` on a miss — an **empty object still
satisfies `isTournamentMode`** — so the first ~20 seconds of every tournament
table, and every slow refresh after, decided ICM pressure from
`stackBB < 40 ? 0.04 : 0.02`.

It now derives the survival premium from the horse's **own table**: stack
relative to the table average, which needs no cache, no network and no
database, and which is the same signal the real model uses `avgStackChips` for.
Band 0.015–0.055, barely wider than the constants it replaces, because it is a
stand-in and must never out-shout the real model. Reported as
`icm_table_relative` so the audit can tell it from `icm_warming`.

**Scoped to a real cold cache, and that cost a test to learn.** The first
version fired wherever `isTournamentMode` was true, which includes the legacy
`bb >= 10` self-detection — and an NLH preflop sizing test went from 41 opens
to 37. `explicit` being present is exactly "the engine said tournament and the
context has not arrived"; absent means nobody said tournament at all. Reading
an ICM premium into those would invent a tournament.

## 4. The VPIP floor is inert because ordinary tables have no floor

I had this listed as a wiring gap. **It is not.** Measured against production:
of 157 open cash tables, **55 had `nit_game = true` AND
`maintain_percent_min > 0`, and zero had the minimum set without `nit_game`.**
Perfectly correlated, so `vpipFloor()` returning 0 on the other 102 is correct
— those tables genuinely have no floor to keep.

There is now a test saying so, because the gate reads like a bug when you find
it cold and the "fix" would impose a nit rule on every ordinary game.

## 5. Both default-off flags are on the league card

`v41_session` and `v42_table`, 12,000 pairs each. They earn their default the
way everything else here does — three significant positive runs — or the
hypothesis dies honestly. The note on the card records that league seats reach
the table-image gate almost immediately, which is the opposite of the live
floor and worth remembering when reading the result.

## 6. Dan's run-it-twice rates

> "HORSES SHOULD ALWAYS OFFER TO RUN IT TWICE (WHEN AHEAD 'RANDOMLY SELECTED)
> 75% OF THE TIME, AND AGREE TO RUN IT TWICE OR 3X 75% OF THE TIME."

Two decisions, two constants, both 75 — written separately because the next
time one moves it will not be both.

**"When ahead" needed no interpretation.** `checkAllInRunout` already picks the
chooser by evaluating every all-in hand against the board (or preflop strength
when the board is empty), so the chooser **is** the player who is ahead.

The old rule was `(h + handCount * 7) % 10 < 3` — a per-**ten** resolution that
can express 70 and 80 and nothing between. It resolves per hundred now, which
is what makes 75 sayable at all.

**One hand in four still runs once, and that matters.** `checkAllInRunout` asks
the RIT question first and only reaches `startInsuranceFlow()` on the
single-run branch — when the answer was a constant 'accept', insurance was dark
across the whole floor: `insurance_offer_events` held zero rows against 270
qualifying hands in 24 hours. A rate of 100 would turn it off again, and there
is a test that says so.

Still deterministic in (player, hand): `Math.random` is banned in the engine's
decision paths, a replayed hand must answer the same way twice, and a test must
be able to assert the distribution.

---

403 test files, 5,777 tests, all green. Four existing tests pinned the old
signatures and rates and were updated in the same commit with the reason
written in.
