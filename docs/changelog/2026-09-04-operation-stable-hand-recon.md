# Operation Stable Hand - Section 3 Recon

Date: 2026-09-04. Read against LIVE production (Supabase `kuklfnapbkmacvwxktbh`)
and `origin/main` @ 0629014b7. Every number below was READ, not assumed.

## VERDICT: four premises in the OPORD are false against the live board.

Building Sections 5/11 on the OPORD's stated numbers would have shipped a bug
that doubles the intended horse population. Details in 1 and 2.

---

## 1. Identity math - CORRECTED

OPORD Section 1.1 assumed three overlapping club buckets. Measured:

| Set | OPORD said | LIVE | Note |
|---|---|---|---|
| Unique horses | ~1,000 | **1,000** | exact |
| Club JAQK horse memberships | 584 | **580** | |
| Shark Club horse memberships | 593 | **584** | |
| Deep Stack Society | 417 | **416** | |
| Midway Union DIRECT horse memberships | not mentioned | **323** | see 3 |
| JAQK intersect Shark | "large" | **580 - TOTAL. JAQK is a strict subset of Shark.** | |
| JAQK intersect DSS | implied >0 | **0** | |
| Shark intersect DSS | implied >0 | **0** | |
| all three | implied >0 | **0** | |

**584 + 416 = 1,000 exactly. The fleet is partitioned, not overlapping.**
DSS horses are a disjoint 416 bodies. They are not "417 of the same 1,000"
in the sense of being shared - no DSS horse has a JAQK or Shark wallet.

## 2. THE OCCUPANCY CAP MUST BE PER HOST, NOT PER CLUB

OPORD: "Occupancy uses unique horses per club bucket". With JAQK a strict
subset of Shark, a per-club cap counts the same body twice:

    peak_cap(JAQK)  = floor(0.40 * 580) = 232
    peak_cap(Shark) = floor(0.40 * 584) = 233
    232 + 233 = 465 unique bodies live, drawn from a pool of 584 = 80%.

Dan asked for 40% at peak. Per-club bucketing delivers 80%. The bucket is
therefore the HOST, which is also the unit the mutex already enforces:

| Host | Eligible bodies N | peak_cap floor(.40N) | night_cap floor(.10N) | live now |
|---|---|---|---|---|
| Midway Union (JAQK+Shark wallets) | **584** | **233** | **58** | 180 |
| Deep Stack Society | **416** | **166** | **41** | 150 |

`club_id` still selects the WALLET (JAQK vs Shark). It does not select the
occupancy bucket. Section 11's dual-member idle rule ("larger deficit")
therefore picks a WALLET, not a club to be counted against.

Derived per-host tags (cash 30% / tourney 30% / both / cash_fr 15% of cash):

| Host | cash | tourney | both | cash_freeroll |
|---|---|---|---|---|
| Midway Union | 175 | 175 | 234 | 26 |
| Deep Stack Society | 124 | 124 | 168 | 18 |

## 3. Midway Union has its own 323 horse wallets, and ZERO seats use them

    seat wallet -> table host        live seats
    Deep Stack Society -> DSS               396
    SHARK CLUB         -> Midway Union      158
    Club JAQK          -> Midway Union      155
    Midway Union       -> (none)              0

The OPORD's `sit(horse, club, table)` rule is ALREADY the live behaviour and
needs no change. The 323 Midway-Union-wallet memberships (min balance 25,000,
median 25,043) are unused by cash seating. They are NOT to be seeded, spent,
or reset. Flagged, untouched.

## 4. The 10,000 seed applies to NOBODY

Section 8.1 says seed 10,000 on never-funded wallets only.

    club          wallets  zero_balance  min_balance   under_40bb_micro
    SHARK CLUB      584         0          10,952.89        0
    Club JAQK       580         0          12,674.98        0
    Deep Stack      416         0           7,420.06        0
    Midway Union    323         0          25,000.00        0

Every horse wallet is funded. **No seeding migration will run. No chips will
be printed.** The rule is still implemented as law for future wallets, but it
is a no-op today. There are also ZERO broke horses, so the Section 8.8 repair
path has nothing to repair on day one.

## 5. Live occupancy is already close to target

    unique horses seated      330   (Union 180 + DSS 150, sums exactly)
    total live seats          709
    avg seats per active      2.15  (OPORD peak band 1.6-2.2 - IN BAND)
    horses on two hosts         0   (mutex already holds)
    horses over 4 seats         0   (MAX_TABLES_PER_HORSE = 4 already holds)
    seats above 1/2            76   (violates the phase clamp - see 7)

## 6. Exotic inventory - the trim is small

Exotic set per OPORD = pineapple, short_deck, plo8. Live cash tables:

| Host | pineapple | short_deck | plo8 | over 1/2 |
|---|---|---|---|---|
| Midway Union | 8 | 8 | 8 | 0 |
| Deep Stack Society | 12 | 12 | 10 | 4 |

Only **4 exotic tables exceed 1/2**, all on DSS, only 1 of them running:
pineapple 2/5 (1, idle), plo8 2/5 (1, idle), short_deck 2/5 (2, one running
with 2 seats). Close path per Section 6 is cheap and low risk.

Cap work is the bulk: each host runs 8-12 tables per exotic variant against
a cap of 2.

### OPEN QUESTION FOR DAN - `flh` and `flo8`

Two live variants are in NEITHER list. `flh` = Fixed Limit Hold'em,
`flo8` = Fixed Limit Omaha Hi-Lo. The OPORD's exotic set names
pot-limit `plo8` (PLO8o); its not-exotic list names NLHE/PLO/PLO5/PLO6.
Fixed-limit games are named nowhere.

There are ~20 of them live (Union 5 stakes of each, DSS 6 stakes of each,
one flh 9-max full at 0.05/0.10, one flh 0.25/0.50 full at 6).

**I have not touched them.** Closing them would be me inventing a design
decision, which is the exact failure mode CLAUDE.md 10.5 was written about.
They are treated as NON-exotic (out of scope for the trim) until Dan rules.

## 7. Stakes above 1/2 - clamp applies to NEW sits only

76 live horse seats sit above 1/2 (Union nlh 2/4, 2/5, 5/10, 10/20, 25/50;
DSS 2/5 across most variants). Section 8.3's phase clamp forbids SITTING
above 1/2; Section 6 orders CLOSURE only for exotics above 1/2; Section 17
forbids BUILDING tables above 1/2.

Nothing in the OPORD orders existing non-exotic high-stake seats to be torn
down, and force-standing 76 seated players mid-session to satisfy a clamp
would move real chips for no stated reason. Implemented as: **no new sits
above 1/2; the 76 existing seats ride until a normal Section 9.2 force-leave
reason fires.** Flagged rather than assumed.

---

## 8. Code paths (Section 3 checklist)

| Item | Path | State |
|---|---|---|
| Seating / launcher | `server/src/services/HorseFleetManager.ts` (2019 ln) | EXISTS. `seedAllTables`, `seatHorse`, `ensureAllTablesExist`, `spawnOverflowTables`, `retireSurplusTables` |
| Sit RPC | `atomic_table_buyin(p_user_id,p_table_id,p_seat_number,p_amount,p_auto_rebuy,p_club_id,p_idempotency_key)` | EXISTS, takes club_id. No change needed |
| Cash-out | `atomic_seat_cashout_locked` + `services/supabase/seats.ts::atomicCashout` | EXISTS |
| BRM | `server/src/services/HorseBankroll.ts` - `canSit`, `bankrollBuyIn`, `canOpenAnotherTable`, `canEnterTournament` | EXISTS, per-wallet keyed `club_id:user_id` |
| **BRM fails OPEN** | `HorseFleetManager.ts:1295` `seat_fail_open_roll_unknown` | **DEFECT** - unreadable membership row = seat allowed. Must fail closed for Section 11 |
| Occupancy | `server/src/services/HorseBehavior.ts::occupancyTargetFor` | EXISTS but is PER-TABLE 3h buckets at `CASH_FULL_FRACTION=0.75`. **No 24h curve exists.** Section 5+11 is net-new |
| 60/20/20 shape | - | **NOT FOUND.** Net-new |
| Stay-up 10 min | - | **NOT FOUND.** Net-new |
| 2-hour same-key window | - | **NOT FOUND.** Net-new |
| Human yield | `HorseFleetManager::humansWaitingByTable` reads `table_waitlist` | PARTIAL - reads the queue, no 2-5 min yield, no 90s hold |
| Waitlist | `table_waitlist` + `src/services/WaitlistService.ts` | EXISTS, direct-Supabase (no Node route) |
| Hand-play AI | `server/src/engine/HorseLogic.ts::decide` (5170 ln) | EXISTS - DO NOT REWRITE, seat it only |
| Rakeback | `server/src/services/RakebackSettlerService.ts` | EXISTS, 30-min aggregate + weekly Monday close. RATES UNTOUCHED |
| Freerolls | `TournamentRecurringService.ts` `HOURLY_SCHEDULE` | EXISTS but only **2 freerolls/day** (03-05 NLH, 15-17 PLO4), not the 4-hour cadence |
| Horse MTT register | `fn_register_horse_for_tournament` | EXISTS |
| Add-on / re-entry | `atomic_table_addon`, `process_tournament_rebuy`; `max_reentries` currently **1** | EXISTS, cap differs from Section 10's 3 |
| Feature flags | none - repo uses `process.env.X !== 'false'` inline + a `*.law.test.ts` pinning the constant | Follow house pattern for `stable_hand_controller` / `stable_hand_kill` |
| Chip writes from TS | **NONE** - all chip movement is SQL SECURITY DEFINER | Confirms "never print chips" is enforceable |
| grantChips/adminReload | **NOT FOUND** | nothing to forbid; Section 17 already holds |
| TZ | engine runs UTC; `isActiveNow` keys off `hourUTC` | Section 11 curve is America/Chicago - needs explicit conversion |

## 9. What must be BUILT vs WIRED

BUILD (net-new): 24h Chicago occupancy curve; 60/20/20 table shape; human
yield with jitter + 90s hold; stay-up; 2-hour window; per-key daily sit
counters; booking/force-leave ladder; exotic cap+trim; tag schema+job;
kill switch; dashboard.

WIRE (exists, do not rewrite): HorseLogic, atomic_table_buyin,
atomic_seat_cashout_locked, HorseBankroll, rakeback, waitlist,
fn_register_horse_for_tournament, add-on/rebuy RPCs.

FIX (defect found during recon): BRM fail-open at HorseFleetManager.ts:1295.

NOT BUILT, per Section 0/17: must-move, feeders, multi-main, cluster lobby.
