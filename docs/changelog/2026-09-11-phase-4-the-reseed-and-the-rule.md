# Phase 4: the reseed that cannot fire, and the rule stated three ways

2026-09-11. Branch `feat/the-mini-is-seen`. BBJ programme phase 4 of 5.

Two items, both of the same shape: **something that looks authoritative and is
not.** One is a safety net that cannot be reached; the other is a copy of the
jackpot's rule that had quietly stopped matching the engine and was telling
players the wrong thing on a live variant.

Every number below was read from production on 2026-09-11.

---

## 1. The backup reseed cannot fire, and the thing it promised is already true

Dan, 2026-08-18, quoted in migration `20260827e`:

> the back-up jackpot exists so that when a hit takes 100% of main, the jackpot
> does not restart at zero. If main is now empty, TRANSFER the reserve into it.

`fn_bbj_reseed_main_from_backup` does exactly that, and does it well: it takes
the pool lock, subtracts parked shares, raises a drift incident when the
reserve is empty rather than failing silently, and moves the banks through the
conserving `fn_bbj_move_between_banks`. It is called from
`bbj_atomic_payout_v2` behind `IF v_main <= v_reserved` - once a payout has
taken every spendable chip of main.

**No payout can take every spendable chip.** The payout is a percentage of
spendable main, and the schedule is:

| tier | nano | micro | small | mid | high | nosebleeds |
| ---- | ---- | ----- | ----- | --- | ---- | ---------- |
| %    | 15   | 25    | 40    | 55  | 70   | **85**     |

What a hit leaves is `(1 - pct/100) x spendable`, which is positive at every
tier. Rounding closes the gap only once spendable main is down to a few
hundredths of a chip - a jackpot worth about three cents.

Production agrees, across every main hit there has ever been:

| measure                              | value    |
| ------------------------------------ | -------- |
| main jackpot hits, all time          | 34       |
| hits that took the whole pool        | **0**    |
| largest share of a pool ever taken   | 70.00%   |
| average share taken                  | 46.91%   |
| smallest pool at the moment of a hit | 2,665.17 |

So the premise is one the payout schedule cannot produce. And the guarantee Dan
asked for - _the jackpot does not restart at zero_ - **is already delivered, by
the schedule itself**: at 85% the worst case leaves 15% of main standing. The
reseed is a second belt on a fastened one.

### What was done, and what deliberately was not

The reseed is **not deleted**. `bbj_atomic_payout_v2` validates
`p_payout_total_percent` as `(0, 100]`, so 100 is a configuration the platform
already accepts; the day a tier is set to it, the reseed becomes live and
correct with no new code. Deleting a correct guard because today's
configuration does not reach it is how the next outage gets written.

What was wrong is that nothing said any of this, so the reseed read as active
protection. `tests/the-reseed-is-reachable-or-it-is-not-a-guard.law.test.ts`
now ties the two facts together: it reads the real schedule, asserts no tier
pays 100%, and asserts the reseed is still wired. **If a tier is ever set to
100 the test fails - and that failure means the reseed has become live**, which
is the moment somebody needs to know.

**Whether a 100% tier should exist is Dan's call**, not an agent's: it sets what
players are owed in future events (CLAUDE.md 10.9). This work does not decide
it. It stops the answer drifting without anyone noticing.

---

## 2. The qualifying rule existed three times, and the copies disagreed

`BBJ_QUALIFYING_HANDS` decides which hand wins a jackpot. It lives in three
places:

| where                                 | status                                 |
| ------------------------------------- | -------------------------------------- |
| `server/src/config/RakeConfig.ts`     | **the rule.** The engine enforces this |
| `src/config/RakeConfig.ts`            | what every player-facing surface shows |
| `public.bbj_qualifying_hands` (table) | read by **nothing at all**             |

Nothing compared any of them.

### Pineapple: the client showed the wrong rule on a live variant

The server has carried a `pineapple` entry - **Quad Kings or better must
lose** - and the client did not have the key at all.
`normalizeVariantKey` falls through to `'nlh'` for anything it does not
recognise, so every Pineapple table showed players the **hold'em** bar: _aces
full of jacks or better_, plus the Ace-in-the-hole and both-cards-must-play
technicalities.

Those are not the same rule. A Pineapple player holding aces full was reading a
qualifying hand that does not qualify, and one holding quad deuces was not told
they had one.

It is not a dormant variant:

| Pineapple, measured 2026-09-11 | value  |
| ------------------------------ | ------ |
| tables                         | 293    |
| BBJ-raked hands, last 7 days   | 11,606 |
| jackpot hits already paid      | **4**  |

The mini inherited it too: `miniRuleForVariantKey` picks its family from this
constant's `handRank`, so the client gave Pineapple the hold'em mini rule
(_aces full must lose_) while the engine applies the Omaha one (_any quads must
lose_). That is phase 2's code reading phase-old data.

**Fixed** by giving the client the server's entry verbatim, and giving the
server the client's `plo_hilo` entry, so the two constants are now identical
key for key and field for field.
`tests/one-qualifying-rule-for-one-jackpot.law.test.ts` compares them directly
and fails on any divergence, and pins the nine variants production actually
spreads so that adding a variant without adding its rule is caught here.

### The table was the only thing on the platform claiming PLO6 has a jackpot

`public.bbj_qualifying_hands` is read by nothing - the only references in the
whole tree are a cleanup `DELETE` (`20260901145900`) and a `GRANT` revoke
(`20260907161706`). Unread, it had drifted three ways:

- **`plo6` marked ELIGIBLE** with an 8-high straight-flush bar. Both code halves
  refuse PLO6, and production agrees with the code: 18,737 PLO6 tables exist and
  have contributed **zero** BBJ rake and taken **zero** hits.
- an **`ofc` row** neither code half has ever had.
- **six variants missing**: `flh`, `plo`, `plo8`, `flo8`, `plo_hilo`, and the
  live `pineapple`.

Migration `20260911153422` makes the table mirror the engine row for row and
aborts if it cannot (`RAISE EXCEPTION` on any differing, extra or missing row),
then puts a `COMMENT` **on the table itself** saying what it is: a descriptive
mirror, never the rule, maintained by that migration. The next agent who finds
it does not have to guess.

The table now holds 11 rows: nine eligible, `plo6` and `short_deck` refused.

**On the file versus what ran.** `reserve-migration-version.sh` handed me
`20260911153245`; the management API stamped its own `20260911153422` at apply
time, and the file was renamed to match. The COMMENT names its own migration,
so the first apply installed a comment pointing at a version that does not
exist - corrected in production by a second one-statement migration so the
database and the file say the same thing.
