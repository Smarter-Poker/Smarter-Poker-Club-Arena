# The jackpot has not paid in seventeen days, and nothing could say why

2026-09-07. This closes the last open question of the BBJ programme — "do the
main jackpot rules stay this strict?" — and the answer is not the one the
question expected.

---

## The measurement

The main Bad Beat Jackpot last paid on **2026-08-21 06:04:16 UTC**. It has paid
nothing since. Over the same period the drop kept coming in at the highest
volume this platform has ever taken:

| week       | contribution rows |  chips in | main hits |  paid out |
| ---------- | ----------------: | --------: | --------: | --------: |
| 2026-07-20 |            35,861 | 18,234.40 |         3 |  9,839.79 |
| 2026-07-27 |            92,039 | 46,743.20 |         6 | 22,831.05 |
| 2026-08-03 |            77,478 | 39,355.60 |         6 | 28,822.19 |
| 2026-08-10 |            47,799 | 22,224.35 |         5 | 13,855.30 |
| 2026-08-17 |           175,939 | 78,322.84 |         9 | 25,642.57 |
| 2026-08-24 |           116,351 | 51,106.26 |     **0** |  **0.00** |
| 2026-08-31 |           277,332 | 85,724.31 |     **0** |  **0.00** |
| 2026-09-07 |            40,777 | 14,227.39 |     **0** |  **0.00** |

The week of 2026-08-31 took **more than half again** the volume of the week that
produced nine hits, and produced none. At the 08-17 rate that week alone expected
about fourteen. This is not variance: P(0 | expected 14) is roughly one in a
million.

The union pool now holds **109,200.26** and grows by about 14,000 chips a day.

## Why it stopped, as far as the rows can say

Three changes landed on the detector between the last hit and now, and the first
one is the interesting one:

| date       | commit      | what it did                                                                                                                                  |
| ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-18 | `387682cab` | **both-cards-must-play had been failing OPEN when there was no board** — 11,392 chips had been paid on board-made hands that never qualified |
| 2026-08-27 | `3f6d32e86` | enforce the rules we publish; stop scoring short deck as hold'em                                                                             |
| 2026-08-29 | `d2ce7b6dc` | the drop is collected on every flop with 3+ dealt; 10BB gates the **payout** only (Dan's ruling)                                             |

So the historical three-to-nine hits a week were **partly a bug**. A gate that
should have refused board-made hands was letting them through, and closing it
revealed what the published bar actually produces. The rules did not get
stricter on 2026-08-18. They started being applied.

That reframes the question Dan left open. It is not "should we relax rules that
someone tightened". It is "the published bar, now genuinely enforced, produces
zero hits in seventeen days on record volume — is that the jackpot we want?"

## What I could NOT tell, and why that is the defect I fixed

Nothing in this database could say whether those seventeen days contained no
qualifying hand at all, or contained qualifying hands that a gate refused. Those
two are completely different situations — one is a jackpot working as designed,
the other is a jackpot that is broken — and they were **the same observation**.

The detector was not missing. `detectBBJNearMiss` has run on every showdown
since 2026-08-18 and knew the answer every single time. It sent that answer to a
`console.log` and to a hub event that expires in seconds. `bbj_hand_evidence_log`
looks like where this would live and is written only by triggers on the _payout_
path — so it is empty by construction exactly when nothing pays.

That is CLAUDE.md 10.86 rule 3, a guard with no reader, and it is the half of
this that was mine to fix rather than Dan's to decide.

**`bbj_near_misses`** (migration `20260907201404`) now takes one row per hand
that reached the jackpot decision with a qualifying-sized losing hand, carrying
**which gate refused it**. The engine writes it fire-and-forget at the point the
near miss is already detected; it moves no money, gates nothing, and cannot
break settlement. It is deliberately not one row per hand — the comparable
population, the mini's qualifying set, measures 4.29 a day across the whole
estate, so ninety days is under 400 rows.

Pinned by `server/src/engine/aRefusedJackpotIsWrittenDown.law.test.ts`.

## What is Dan's, and what I recommend

CLAUDE.md 10.9 is explicit that **"anything that sets what players are owed in
FUTURE events: prices, rake, guarantees, payout structures"** is Dan's and only
Dan's. The qualifying bar for the main jackpot is exactly that, so I have not
touched it. What follows is the recommendation, with its cost, as 10.9 asks for.

**The mini already carries the cheaper half.** Phase 6 shipped a second tier at
hold'em aces-full-or-better / PLO quads, funded from the backup reserve, firing
about 4.3 times a day for 250–1,500 chips by stakes tier. So the near-misses the
main refuses are no longer refused by the whole platform — a player who loses
with aces full is paid today. That was the point of building it, and it is why
this question got cheaper rather than more urgent.

**What the main still needs is a decision about the pool, not about fairness.**
109,200 chips sitting still while 14,000 a day joins it is a jackpot that will
eventually pay someone a life-changing amount, which is a legitimate design — a
lot of rooms run exactly that. It is only wrong if it is unintentional. The two
honest options:

1. **Leave the bar alone.** The pool keeps building toward a headline number and
   the mini serves everybody in the meantime. Cost: nothing, and the reserve
   keeps growing too. This is the status quo and it is defensible.
2. **Move the main to the published `bbj_qualifying_hands` bar.** That table
   already says NLH qualifies at **AAAJJ, aces full** — which is _lower_ than
   what the engine enforces. Aligning them would fire the main far more often
   and pay much smaller amounts. Cost: the headline number stops building, and
   it makes the mini largely redundant.

My recommendation is **(1), with one caveat**: give it thirty days now that
`bbj_near_misses` exists. If the log shows qualifying-sized hands being refused
several times a week by `no_ace_in_hand` or `both_cards_did_not_play`, the bar
is doing something a player would call unfair and the answer changes. If the log
is nearly empty, the bar is simply rare, the pool is building on purpose, and
there is nothing to fix. **Thirty days from today that question has an answer
from rows.** It never has before.

The one thing I would not do is change the bar today on the strength of
seventeen days and no near-miss data. That is guessing with players' money in
the direction that feels generous, and 10.9 rule 1 exists to stop exactly that.

## Also worth knowing

`bbj_qualifying_hands` and the engine's `BBJ_RULES` **do not agree**. The table
publishes `AAAJJ / full_house` for NLH; the engine enforces quads. One of them is
wrong and it is not a coin flip — CLAUDE.md 10.8 says a written rule outranks
deployed code, which would make the table right and the engine too strict. I have
not acted on that, because acting on it _is_ changing what future hands are owed.
It belongs with the decision above and it is the strongest argument for option 2.
