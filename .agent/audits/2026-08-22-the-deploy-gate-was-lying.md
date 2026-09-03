# Audit — the deploy gate was intermittently red, and one of the reasons was a real bug

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena · **Author:** Claude (Cowork session)
**Shipped as:** PR #254 · **Companion:** `.agent/audits/2026-08-22-null-multiplier-spins-and-the-double-ledger.md`

---

## 0. HOW THIS STARTED

PR #248 — a money fix touching no engine logic — failed the **Server Engine
(typecheck + tests)** job. The failure was in `HorseLogic.test.ts`, which #248
did not go near. A rerun passed and #248 merged, but "rerun it and it goes
green" is the definition of a gate that is not telling you anything.

Running the server suite in a loop locally: **2 failures in 6 runs, on two
different tests.** So the gate every agent ships through was red roughly a
third of the time, for reasons unrelated to whatever was being shipped.

Three findings. One is a real production bug.

---

## 1. A POT-LIMIT JAM ESCAPED ITS OWN CAP — real, reaches production

Dan 2026-08-21: _"in PLO you can never go all in if the pot is less than the
chips you have — the most you can ever bet is pot."_

`capPotLimitJam` enforces exactly that, and its own doc comment explains the
design: several branches short-circuit to `all_in` on their own, so rather than
patch each one it **wraps** `legalizeInner` and rewrites an over-cap jam into a
pot-sized bet — routed back through `legalizeInner` so the substitute picks up
chip-step snapping and engine-parity verification.

That return trip is the hole. `legalizeInner`'s bet branch ended with:

```ts
if (amt >= stack * 0.92) return { action: 'all_in', thinkTime: 0 };
```

no pot-limit guard. So when the pot sits between 92% and 100% of the stack, the
pot-sized bet the cap just produced is converted straight back into an
**uncapped all-in** — and the wrapper has already run, so nothing catches it:

```
ILLEGAL plo4/river: all_in undefined — Pot-limit max is 300 —
you cannot go all in for more than the pot
(toCall=0, minRaise=100, maxRaise=300, stack=322.2566035217615,
 bet=0, currentBet=0, pot=300)
```

The **raise** branch twenty lines below already carried the guard
(`maxRaiseTo <= potLimitTo`). The bet branch never did, and the earlier
"no legal non-all-in bet exists" shortcut did not either. Both are guarded now.

**This is not fuzz-only.** Deep-stacked pot-limit tables reach pot ≈ 92–100% of
stack constantly. The consequence is a horse action the engine **rejects** —
the worst outcome the decision layer can produce, and the thing
`verifyAmount`'s whole design exists to prevent.

Pinned by a deterministic test over plo4/plo5/plo6 and all five styles, and
**verified red against the unfixed `HorseLogic`** before the fix went in
(`plo5/lag: all_in undefined — Pot-limit max is 300`). A test that has never
been seen to fail is not a regression test.

---

## 2. THE WHOLE-DOLLAR FUZZ ASSERTION WAS UNSATISFIABLE

```
plo6/flop: raise 60.49 is not a whole dollar
(bb=2, currentBet=43.206112031764334, pot=8.099135491038798)
```

Not a regression. `minRaise = max(bb, currentBet x 0.4) = 17.2824448`, so the
minimum legal raise-to is `60.4885568`; the hero's stack capped the maximum
below 61. **The legal window contains no integer at all**, and 60.49 — the
minimum rounded up to the cent — is the only thing a horse can legally do.

`verifyAmount` says so out loud: the one-cent nudges are its documented last
resort, because _"an ugly-but-legal action still beats a rejected one"_. Dan's
whole-dollar rule was about not asking a player to call 3.85; it was never
meant to outrank legality.

A real table cannot reach that state — at a whole-dollar big blind every posted
bet is a whole dollar, so the window always contains one. Only the fuzz's
fractional `currentBet` produces it.

The rule is now asserted **whenever a whole dollar was actually legal**, asked
of `validateAction` rather than re-derived locally: a second copy of that
arithmetic could disagree with the engine's and wave through something
genuinely broken. Choosing cents while a legal whole dollar existed still
fails. A companion test states the impossibility in the engine's own words, so
the next person to find the guard learns why it is there instead of deleting
it.

---

## 3. `RunItTwice.multiway` WAITED 900ms BY THE CLOCK

```ts
await new Promise((r) => setTimeout(r, 900));
expect(events.find((e) => e.type === 'HAND_COMPLETE')).toBeDefined();
```

A bet that the machine finishes inside 900ms. In isolation it always won —
three for three. Inside the full 97-file suite it lost about half the time and
took the entire job down with `expected undefined to be defined`, on branches
that had touched nothing near it.

Now polls for the event with a 10-second deadline: normally faster than 900ms,
and not starvable by a loaded runner.

---

## 4. THE GENERAL LESSON

All three share a shape: **a check that was true when it was written and became
untrue later, without anyone being told.**

- the 0.92 shortcut was correct until pot-limit capping landed on 2026-08-21;
- the whole-dollar assertion was correct until the fuzz widened enough to reach
  a sub-dollar legal window;
- the 900ms sleep was correct until the suite grew to 97 files.

A flaky gate is not a nuisance to be rerun past — it is an alarm that nobody
can read any more, and it hides real bugs inside noise. Finding #1 had been
sitting in production behind #2 and #3.

---

## 5. VERIFICATION

| Check                                | Before                       | After                               |
| ------------------------------------ | ---------------------------- | ----------------------------------- |
| 6 consecutive full server-suite runs | 2 failed (2 different tests) | **6 green** — 97 files, 1,039 tests |
| Client suite                         | 2,942 passing                | 2,942 passing, 5 skipped            |
| `tsc --noEmit` on `HorseLogic.ts`    | clean                        | clean                               |
| New pot-limit test vs unfixed engine | —                            | **fails**, as it must               |

PR #254 merged 2026-08-22T18:54:24Z; CI green; Hetzner auto-deploy fired on
`server/**`.

### And the #248 fix, confirmed live

The last duplicate prize ledger row anywhere on the platform was written at
**2026-08-22 18:19:32Z** — before the #248 engine deploy completed. Since it:

```
23 tournaments completed · 27 prize groups · 0 duplicates · 0 phantom chips
```

Hourly duplicate counts through the same day, for contrast: 3, 0, 1, 0, 6, 4,
4, 1, 1 — then zero.
