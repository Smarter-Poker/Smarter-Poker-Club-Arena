# HANDOFF — Spins & Gameplay Animations (2026-08-20)

**From:** Claude (Cowork) · **To:** the next agent · **Repo:** `club-arena` (+ `Smarter-Poker-World-Hub` for deploy)

Read this whole file before touching anything. Sections 1–3 are context you
need to not break things. Section 8 is the work queue. Section 9 is the traps
that will cost you hours if you rediscover them yourself.

---

## 0. TL;DR — WHAT IS DONE AND WHAT IS NOT

**DONE and live in production:**
- Gameplay animation/pacing overhaul (7 "superseded in its own tick" fixes)
- Knockout bounty animation + mystery-bounty click-to-open chest, both queued
- Spin multiplier wheel (server-decided, honest, no client randomness)
- Canonical Spin spec replacing 3 conflicting multiplier tables
- Reserve Pool: schema, ledger, gating, sweeper, health view — **seeded**
- Spin engine cutover: no fee, gated draw, every game booked to `rake_records`

**NOT done — start here:**
1. **The tournament NAME leaks the multiplier**, which destroys the wheel reveal (§8.1) — *highest user-visible impact*
2. `lockedMultipliers` is built but **never passed**, so locked tiers never render (§8.2)
3. **Multi-place payouts (10x/25x+) are UNVERIFIED in production** (§8.3) — *highest money risk*
4. The sweeper is **not scheduled** (§8.4)
5. Two stale multiplier tables still exist in client code (§8.5)

---

## 1. GROUND RULES — READ `CLAUDE.md` FIRST

`~/Documents/club-arena/CLAUDE.md` and
`~/Documents/Smarter-Poker-World-Hub/CLAUDE.md` are binding. Highlights that
will bite you:

- **RULE 13: commit small, often.** The host runs a `git reset --hard origin/main`
  loop. It **wiped 9 of 15 files** I had edited but not committed, mid-session,
  with no warning. See §9.1 for the survival pattern.
- **No emoji in source files** — breaks the SWC compiler, fails the Vercel build.
- **`.maybeSingle()` never `.single()`** — `.single()` throws PGRST116 on 0 rows.
- **Never call AI players "bots"** — they are *horses*.
- Commits must be authored `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`
  or Vercel refuses to build them (goes to BLOCKED with no logs).

---

## 2. HOW TO SHIP (the only route that works)

The sandbox has **no network route to GitHub**. Do not waste time on
`git push`, `curl api.github.com`, or npm installs from the sandbox.

### The pattern that works

```bash
# 1. Build the commit in the sandbox from a CLEAN origin/main tree.
#    NEVER `git add .` — the working tree contains other agents' WIP.
cd /sessions/<session>/mnt/club-arena
[ -f .git/index.lock ] && mv .git/index.lock "_to_delete/index.lock.$(date +%s)"
git fetch -q origin main
export GIT_INDEX_FILE=/tmp/my.index; rm -f "$GIT_INDEX_FILE"
git read-tree origin/main
for f in path/one.ts path/two.ts; do
  sha=$(git hash-object -w "$f")
  printf '100644 %s\t%s\n' "$sha" "$f" | git update-index --add --index-info
done
TREE=$(git write-tree); PARENT=$(git rev-parse origin/main)
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "message")
unset GIT_INDEX_FILE; echo "$COMMIT"
```

```bash
# 2. Push from the HOST via a throwaway worktree, with retries.
#    The repo is BUSY — other agents push constantly and you WILL race.
cd ~/Documents/club-arena
for i in 1 2 3 4; do
  rm -rf /tmp/wt; git fetch -q origin main
  git worktree add --detach /tmp/wt origin/main >/dev/null 2>&1
  cd /tmp/wt
  if git cherry-pick <COMMIT> >/dev/null 2>&1 && git push origin HEAD:main >/dev/null 2>&1; then
    echo "PUSHED"; cd ~/Documents/club-arena
    git worktree remove --force /tmp/wt; git worktree prune; break
  fi
  cd ~/Documents/club-arena; git worktree remove --force /tmp/wt 2>/dev/null
  git worktree prune; sleep 4
done
```

### Deploying the client to production

```bash
# Build from CLEAN worktrees on BOTH sides. The working trees are dirty with
# other agents' work and the preflight will (correctly) refuse them.
cd ~/Documents/club-arena
git worktree add --detach /tmp/ca origin/main
ln -s ~/Documents/club-arena/node_modules /tmp/ca/node_modules
cp ~/Documents/club-arena/.env /tmp/ca/.env
cd ~/Documents/Smarter-Poker-World-Hub
git fetch -q origin main && git worktree add --detach /tmp/wh origin/main
CA_SRC_OVERRIDE=/tmp/ca WH_OVERRIDE=/tmp/wh \
  bash scripts/sync-club-arena.sh "feat(ca): your message"
# then clean up both worktrees
```

**Server/engine deploys are automatic**: any push touching `server/**` fires
`.github/workflows/auto-deploy-hetzner.yml`. No SSH needed.

### Verifying a client deploy

```bash
curl -s "https://smarter.poker/hub/club-arena/build-info.json?cb=$(date +%s%N)" \
  | grep -o 'ca_sha": "[^"]*'
cd ~/Documents/club-arena && git merge-base --is-ancestor <your-sha> <live-sha> \
  && echo LIVE || echo queued
```

Production often lags several minutes behind — the repo is busy and Vercel
builds queue. **Check that WH's committed `build-info.json` has your `ca_sha`**;
if it does, your bundle is correct and Vercel will catch up.

---

## 3. THE SPIN SYSTEM — COMPLETE KNOWLEDGE

### 3.1 The one rule

```
E[multiplier] = seats × (1 − rake_rate)
```

Everything else is free design. Only the expectation is a constraint.

### 3.2 A Spin is NOT priced like an MTT

Dan, verbatim: *"SPINS ARE DIFFERENT THEN MTT OR SIT N GO TOURNAMENTS WHERE
THEY ARE STRUCTURED AS BUY IN + RAKE (10+1)... THEY ARE STRAIGHT JUST 10 BUY
IN... NO ADDITIONAL RAKE IS ADDED."*

The player pays the listed buy-in and **nothing else**. The rake is engineered
into the multiplier distribution. Proof from the frequency table:

```
E[multiplier] = 27,638,000 / 10,000,000 = 2.7638
buy-in only:        (3    − 2.7638) / 3    = 7.87%   ← the advertised 8%
buy-in + 8% on top: (3.24 − 2.7638) / 3.24 = 14.70%  ← nobody advertises this
```

**`buy_in_fee` MUST be 0 on a Spin.** Enforced by a database CHECK
(`tournaments_spin_has_no_fee`, case-insensitive, covers `tournament_type`).
An SNG *is* buy-in + rake — do not blur these.

### 3.3 Money flow, per game

```
collected   = seats × buy_in          every player pays exactly buy_in
house_rake  = rake_rate × collected   FIXED, booked EVERY game to rake_records
reserve_in  = collected − house_rake  everything else, into the pool
reserve_out = buy_in × multiplier     the whole prize, drawn FROM the pool
```

The pool absorbs 100% of prize variance; the house takes the advertised rake
win or lose. `E[reserve_out] = reserve_in` by construction, so the pool is
net-neutral over volume and **its balance is a direct solvency measure**.

Rake reaches clubs/unions through the normal `rake_records` path.

### 3.4 Canonical spec — `src/config/spinSpec.ts`

**Mirrored to `server/src/config/spinSpec.ts`. A test asserts they are
byte-identical.** If you edit one, `cp` it to the other.

| Multiplier | Freq /10M | Payouts | Stack | Level | Reserve gate |
|---|---|---|---|---|---|
| 2× | 4,772,497 | 100% | 300 | 1 min | — |
| 3× | 3,968,502 | 100% | 300 | 2 min | — |
| 4× | 900,000 | 100% | 400 | 2 min | — |
| 5× | 250,000 | 100% | 400 | 3 min | — |
| 10× | 100,000 | 80/20 | 500 | 3 min | — |
| 25× | 7,500 | 80/12/8 | 500 | 3 min | — |
| 50× | 1,000 | 80/12/8 | 500 | 4 min | — |
| 100× | 500 | 80/12/8 | 500 | 5 min | 1.5× jackpot |
| 500× | 100 | 80/12/8 | 500 | 5 min | 2.0× jackpot |

Rake bands: **8%** ≤$5 · **7%** ≤$10 · **6%** ≤$50 · **5%** >$50.
Blind ladder is shared (10/20 → 105/210, then ~1.4× per level). Only stack and
level length change per tier — that is what turns one structure into nine.

Game types: NLH, PLO4, PLO5, PLO6. Seats: always 3.

### 3.5 Reserve Pool

Tables: `spin_bonus_pools` (per club), `spin_reserve_ledger` (every movement).
`balance >= 0` is a CHECK constraint.

**RPCs** (all `SECURITY DEFINER`, revoked from anon/authenticated):

| RPC | Purpose |
|---|---|
| `fn_spin_reserve_state(club)` | read, creates pool lazily |
| `fn_spin_reserve_seed(club, amt, stake, ceiling)` | credit pool + ledger row |
| `fn_spin_reserve_seed_from_union(union, club, amt, stake, ceiling, wallet, key)` | **atomic union→pool transfer, both sides booked, idempotent** |
| `fn_spin_draw_multiplier(club, buy_in, tiers, rake_rate, seats)` | **gated draw** — returns `{multiplier, locked[], eligible_count}` |
| `fn_spin_settle_game(tourn, club, buy_in, seats, mult, rake_rate)` | books rake + pool in/out, **idempotent** |
| `fn_spin_sweep_unbooked(mins)` | backstop, settles anything missed |

View: `v_spin_reserve_health` — per club: balance, `can_draw_100x`,
`can_draw_500x`, `is_thin`, `shortfall_events`, `unbooked_24h`.

**The gate has TWO conditions** (both required):
1. **Affordability** — `balance + this_game_contribution >= buy_in × multiplier`
2. **Jackpot threshold** — 100× needs 1.5×, 500× needs 2.0× its own jackpot at
   the **highest stake running** (not this table's stake)

A tier failing either is **excluded from the draw entirely**, never drawn-then-
refused. That is what makes an unpayable jackpot structurally impossible.

### 3.6 Current seeded state (2026-08-20)

| Club | club_id | Balance | Ceiling |
|---|---|---|---|
| Club JAQK | `a0000000-0000-0000-0000-000000000001` | 5,000 | 20,000 |
| SHARK CLUB | `a41434bb-8d0c-400a-8f0d-e8b3d65afed4` | 5,000 | 20,000 |
| Midway house club | `fade0000-0000-0000-0000-000000000001` | ~10,000 | 20,000 |

⚠ **The club actually running spins shares the UNION's UUID** and is *named*
"Midway Union". It is a club row, not the union. Do not confuse them — I
initially seeded the two named clubs and missed the one doing all the work.

Funded from **Midway union `promo_wallet`** (a jackpot pool is a promotional
guarantee; `rake_wallet` is owed to clubs at settlement — do not use it).
Wallet went 36,520.14 → ~16,535.

### 3.7 Creation paths (there were THREE — know all of them)

1. `server/src/services/TournamentRecurringService.ts` `createSpin()` — **the
   live one.** All 7,130 production spins came from here.
2. `server/src/tournament/TournamentManagerBase.ts` — start path; re-draws if
   the multiplier is missing, then **settles**.
3. `src/services/HorseOrchestrator.ts` `launchSpin()` — latent, never used in
   production, now fixed to the canonical path.

---

## 4. THE ANIMATION SYSTEM — COMPLETE KNOWLEDGE

### 4.1 The bug class that dominated this work

**"Superseded in its own tick":** an event is emitted and immediately
superseded by the next event in the same synchronous tick, so its animation
gets no airtime. Seven instances found in the engine. The fix is a *settle* —
an `await this.sleep(...)` at the choke point.

`TURN_CHANGE` is the universal choke point: **every** action path (human
submit, horse think-timer, queued pre-action, turn timeout, time-bank expiry,
disconnect auto-action) ends by advancing the turn. One settle there paces all
of them and no caller can bypass it.

### 4.2 Pacing constants (`ServerTableEngineRunout.ts` / `Turns.ts` / `Dealing.ts`)

| Constant | Value | What it protects |
|---|---|---|
| `actionSettleMs` | 650 | any action → next player |
| `preActionVisibleMs` | 900 | queued pre-action (was firing at **0ms**) |
| `streetSettleMs` | 1400 | board dealt → next actor |
| `handStartSettleMs` | 1500 | hand dealt → first action |
| `showdownSettleMs` | 1600 | showdown → pot ship |
| `allInFirstPauseMs` | 2000 | ALL-IN banner vs first runout card |
| `allInStreetPauseMs` | 1400 | between runout streets |
| `BBJ_CELEBRATION_MS` | 9000 | Bad Beat Jackpot celebration |
| `HORSE_MIN_THINK_MS` | 2200 | horse think floor |

Measured effect: hands/min fell ~200 → ~85–120. **That is the intended trade** —
Dan: *"focus more on the user experience rather than getting more hands dealt."*

### 4.3 ⚠ THE MOST DANGEROUS THING TO KNOW

**`handleHandEvent` is dispatched FIRE-AND-FORGET** (`void this.handleHandEvent(...)`).
Handlers are **not serialized**.

> **An `await` inside an event handler does not just delay that handler — it
> lets every later event overtake it.**

I caused a production regression this way: I put `await sleep(showdownSettleMs)`
at the *top* of the `WINNERS` case, before the winner state was assigned.
`HAND_COMPLETE` overtook it and read unwritten state. Result:
`hand_history.winners` empty for **~52% of hands over 3 hours** (0.0% → 65-70%
→ 0.0% after fix). Money was unaffected (payouts run through
`HandController.applyStackDeltas`), but the history was destroyed.

**Before adding any `await` to a handler:** find every piece of state written
below it and every later event that reads that state. A guard test exists in
`server/src/engine/ActionPacing.test.ts` asserting source-position ordering
(assign < settle < pot_win).

### 4.4 ⚠ `@keyframes` IS A GLOBAL NAMESPACE

The app has **900+ keyframes**. Two definitions of one name with different
bodies resolve by **load order**, silently, for *both* consumers.

Casualties found and fixed: `screenShake` (killed the big-win shake entirely —
an out-of-scope CSS var produced an invalid transform), `card-deal`,
`winnerAvatarGlow`, `skeletonShimmer` (was sliding an entire card across the
home page instead of shimmering it), `leaderboardPageFadeInUp`.

**Swept 44 → 0. Currently 0 genuine collisions. Keep it there.**
New components must prefix every keyframe (`ko*`, `mbc*`, `sw*`).

`@keyframes` inside an `@media` block is a **legitimate** responsive override,
not a collision — 3 of those exist and are fine.

Collision check:
```bash
python3 - <<'EOF'
import re,os,collections
defs=collections.defaultdict(list)
for root,d,fs in os.walk('src'):
    for fn in fs:
        if not fn.endswith('.css'): continue
        p=os.path.join(root,fn); s=open(p,encoding='utf8',errors='replace').read()
        for m in re.finditer(r'@keyframes\s+([A-Za-z0-9_-]+)\s*\{', s):
            i=m.end()-1; depth=0
            for j in range(i,len(s)):
                if s[j]=='{':depth+=1
                elif s[j]=='}':
                    depth-=1
                    if depth==0: break
            before=s[:m.start()]; nested=before.count('{')-before.count('}')>0
            defs[m.group(1)].append((re.sub(r'\s+','',s[i:j+1]),nested))
g=[n for n,v in defs.items() if len(set(b for b,_ in v))>1 and sum(1 for _,nest in v if not nest)>1]
print("genuine collisions:", len(g), g)
EOF
```

### 4.5 A CSS-only search is NOT proof a keyframe is orphaned

I nearly deleted `spectatorFloating` — it is applied via an **inline style** in
`SpectatorBadge.tsx`, invisible to any scan reading only `.css` files. Of three
"orphans" I identified, only **one** was real.

### 4.6 Components built

| Component | Notes |
|---|---|
| `KnockoutAnimation.tsx/.css` | 3 beats: impact (head cracks & falls) → payout (counts up) → PKO split. `pointer-events: none` — fires while you may be in a hand, must never eat the fold button. |
| `MysteryBountyChest.tsx/.css` | 5 beats: land → locked (escalating tension) → opening (hinged lid) → explosion → reveal. **Click-to-open**, winner only. Broadcasts `mystery_chest_opened` on `mystery-chest-{tableId}` so all seats open in step. AFK auto-open 9s (winner's client only), spectator failsafe 14s. |
| `SpinWheel.tsx/.css` | Server-decided. **No `Math.random` anywhere — a test asserts this.** Tiers interleaved from both ends (2,500,3,100,4,50,5,25,10) so near-misses are real, not staged. |
| `useAnimationQueue.ts` | One celebration at a time, none skipped. A 3-way all-in busts 2 players → 2 broadcasts ms apart → a single `useState` dropped one. |

### 4.7 Sounds added

`playSpinStart`, `playSpinTicking(duration)`, `playSpinMultiplierResult(mult)`,
`playMysteryChestLand/Open/Explosion`, `playThrowableLaunch`.

⚠ There is a **pre-existing generic `playSpinResult()`** used by
EliminationOverlay, SpinItWheel and BBJCelebration. Do not collide with it —
that is why mine is `playSpinMultiplierResult`.

Ticking is scheduled on the **same easing curve** as the wheel rotation so it
decelerates *with* the visual. A metronome under a slowing wheel reads as broken.

### 4.8 Gates you must respect

- `getAnimationSpeed()` — `--animation-speed` multiplier; JS windows must honor it
- `prefersReducedMotion()` — remove motion, **never** remove information
- `ambientSoundsAllowed` — false on a background table (up to 4 mount at once)
- `src/utils/vibrationGate.ts` — **the only** place that decides if the phone buzzes; honors BOTH switches, coalesces a 60ms window
- `src/utils/soundGate.ts` — same for audio; **either** switch off silences everything

---

## 5. TESTS

```bash
npx vitest run tests/config tests/components tests/hooks tests/utils
# 348 passing as of handoff
npx tsc --noEmit                 # client — must be 0
cd server && npx tsc --noEmit    # server — must be 0
```

Key suites: `spinSpec.test.ts` (50), `spinEngineWiring.test.ts`,
`SpinWheel.test.ts` (24), `BountyAnimations.test.tsx` (40),
`useAnimationQueue.test.tsx` (11), `vibrationGate.test.ts` (14),
`HeroCardRowGeometry.test.tsx` (7), `ActionPacing.test.ts` (19, server).

---

## 6. HEALTH QUERIES — RUN THESE FIRST

```sql
SELECT * FROM v_spin_reserve_health ORDER BY balance DESC;
-- want: unbooked_24h 0, shortfall_events 0, is_thin false

SELECT 'unbooked' c, sum(unbooked_24h)::text v FROM v_spin_reserve_health
UNION ALL SELECT 'shortfalls', sum(shortfall_events)::text FROM v_spin_reserve_health
UNION ALL SELECT 'negative pools', count(*)::text FROM spin_bonus_pools WHERE balance<0
UNION ALL SELECT 'balance<>ledger', count(*)::text FROM (
  SELECT p.club_id FROM spin_bonus_pools p JOIN (
    SELECT club_id, sum(amount) s FROM spin_reserve_ledger GROUP BY club_id) g
    ON g.club_id=p.club_id WHERE abs(p.balance-g.s)>0.01) q
UNION ALL SELECT 'new spins with a fee', count(*)::text FROM tournaments
  WHERE lower(COALESCE(variant,''))='spin' AND COALESCE(buy_in_fee,0)>0
    AND created_at > '2026-08-20 19:20:00+00';
-- ALL must be 0

SELECT fn_spin_sweep_unbooked(240);   -- safe, idempotent
```

---

## 7. WHAT I FOUND AND FIXED (so you don't re-break it)

| # | Defect | Fix |
|---|---|---|
| 1 | 3 conflicting multiplier tables (EV 3.00 / 2.75 / 2.24) | one mirrored spec + byte-identical test |
| 2 | `prize_pool` overwritten, margin in **no ledger** (~1,160 across 2,091 games) | `fn_spin_settle_game` books every movement |
| 3 | **Gate only guarded 100×/500×** — a 4× on a thin pool aborted settlement and the game ran **unbooked** (3 live spins) | affordability condition added |
| 4 | Settlement had no retry — one transient failure lost the row forever | 3 retries + sweeper |
| 5 | `HorseOrchestrator.launchSpin` — stale table, charged fee, `prizePool = buyIn × seats × mult` (guaranteed house loss) | routed to canonical path |
| 6 | CHECK constraint defeated by `variant: 'SPIN'` uppercase | case-insensitive, covers `tournament_type` |
| 7 | Lobby ladder hardcoded, missing 4× and 500× | derived from spec |
| 8 | 7 "superseded in own tick" animation skips | settles at `TURN_CHANGE` |
| 9 | Winning-hand card pop **never fired** (container vs card class) | rewired |
| 10 | AudioContext per table mount — 4 tables + services = **7 vs Chrome's cap of 6**, table went silent | refcounted singleton |
| 11 | Hero card wrapper broke PLO sizing — PLO6 rendered **264px vs 159px** | geometry on `> *` |
| 12 | 6 haptic implementations, 3 ignoring the switches; 16 double-fires | one gate + coalescing |
| 13 | **Neither** sound switch actually muted the app | one gate |
| 14 | Throwable impact fired at launch, from the picker only (silent for everyone else) | moved to `FlyingEmoji` |
| 15 | Bounty animations dropped one of two simultaneous KOs | `useAnimationQueue` |
| 16 | My own regression: `winners` empty for ~52% of hands over 3h | settle moved after state commit + ordering test |

---

## 8. THE WORK QUEUE

### 8.1 🔴 THE TOURNAMENT NAME LEAKS THE MULTIPLIER — kills the wheel

`TournamentRecurringService.ts:1474`:
```ts
name: `${config.name} (${multiplier}x)`,     // "3 Chip Spin NLH (4x)"
```

The multiplier is in the tournament **name**, visible in the lobby, the table
title, the tab bar — everywhere — **before** the wheel dramatically reveals it.
The entire reveal is undermined; the player already knows.

**Fix:** name the tournament without the multiplier (`"3 Chip Spin NLH"`) and
let `spin_multiplier` carry it. Then audit every surface that renders a spin
name and make sure none of them display the multiplier before the wheel has
run. Consider not sending `spin_multiplier` to the client at all until the
table opens.

Grep: `spin_multiplier` in `TournamentPage.tsx`, `TournamentLobbyCard.tsx`,
`DynamicGameCard.tsx`, `SpinAndGoLobby.tsx`, `TableTabBar.tsx`.

### 8.2 🟠 `lockedMultipliers` is never passed — the locked-tier UI is dead

`SpinWheel` accepts `lockedMultipliers` and renders `.sw__seg--locked`, and the
CSS exists. But `TablePage.tsx:3499` `setSpinDraw({...})` **does not pass it**,
so nothing is ever locked on screen.

`fn_spin_draw_multiplier` already **returns** `locked[]` with `{multiplier,
reason, unlocksAt}`. Persist it (a column on `tournaments`, or re-query the
pool at table open) and pass it through. Consider showing `unlocksAt` — "500×
unlocks at 5,000" is genuine anticipation.

### 8.3 🔴 MULTI-PLACE PAYOUTS ARE UNVERIFIED IN PRODUCTION — money risk

Every completed post-cutover spin has been 2×/3×/4×, all winner-take-all, so
`payout_structure: [{place:1, percentage:100}]` was correct in every observed
case. **No 10× or higher has completed since the cutover**, which means the
80/20 and 80/12/8 paths have **never actually paid a second or third place**.

**Verify before trusting it:**
- Confirm the payout engine reads `tournaments.payout_structure` for spins
- Force a 10× and a 25× on a test club and confirm 2 and 3 players are paid
- Check rounding: `spinEconomics()` floors non-first places and gives 1st the
  remainder so parts can never exceed the pool — confirm the engine does the same

```sql
SELECT t.spin_multiplier, t.prize_pool, t.payout_structure,
       count(*) FILTER (WHERE tp.prize > 0) AS paid,
       round(sum(tp.prize)::numeric,2) AS total_paid
FROM tournaments t JOIN tournament_players tp ON tp.tournament_id=t.id
WHERE lower(COALESCE(t.variant,''))='spin' AND t.status='COMPLETED'
  AND t.spin_multiplier >= 10
GROUP BY t.id, t.spin_multiplier, t.prize_pool, t.payout_structure;
```

### 8.4 🟠 Schedule the sweeper

`fn_spin_sweep_unbooked(180)` exists and is idempotent but **runs only when
called manually**. Per `Smarter-Poker-World-Hub/CLAUDE.md` §11, all new
scheduled jobs go to **Open Claw on Hetzner**, never `vercel.json`:

1. Handler at `pages/api/cron/spin-sweep.js` (check `CRON_SECRET`)
2. Schedule entry in `scripts/openclaw-cron-dispatcher.py` (every 15 min)
3. `bash scripts/deploy-openclaw.sh`
4. Watch one fire-cycle

Also alert when `v_spin_reserve_health.is_thin` or `unbooked_24h > 0`.

### 8.5 🟡 Two stale multiplier tables remain in client code

- `src/services/TournamentService.ts` `SPIN_BONUS_TIERS` — the retired EV 3.0
  pool model with `bonusBuyIns`. Still **exported**, still consumed by
  `CreateTournamentModal` via the derived `SPIN_MULTIPLIERS`.
- `src/services/HorseOrchestrator.ts` `SPIN_MULTIPLIERS` (line ~914) — EV 2.75,
  no 4×/50×/500×. Now unused by `launchSpin` but still declared.

Both should derive from `spinSpec` or be deleted. `spinEngineWiring.test.ts`
asserts zero hardcoded `{multiplier, weight}` literals in *server* files —
extend it to client files once these are gone.

### 8.6 🟡 Spin UX gaps

- **`SPIN_GAME_TYPES` includes PLO6 but `gameTypeMap` in the recurring service
  maps `plo8`, not `plo6`.** Verify PLO5/PLO6 spins can actually be created.
- The wheel is gated on `sessionStorage` per tournament — a player who rejoins
  in a new tab sees the draw again. Consider a server-side "seen" flag.
- No spin lobby surface shows the reserve balance or "500× available now",
  which is the strongest marketing the format has.
- `is_premium_spin` is set at `>= 100` — confirm anything reading it expects
  500× too.

### 8.7 🟡 Animation items still open

- **Bomb pot pacing** — unreachable, 0 tables have `bomb_pot_enabled`. Verify
  before building.
- `MysteryBountyReveal.tsx` (the old envelope) is now unused by TablePage and
  TournamentPage. Confirm nothing else imports it, then delete.
- `SpinItWheel.tsx` + `src/types/engine/spinIt.ts` — the engine behind them
  (`SpinItEngine`) was removed; the component was imported-but-never-rendered
  and I removed the dead import. The files remain. Delete if truly dead.
- The knockout `eliminatedAvatar` is plumbed through the component but the
  **engine never sends it** — `TournamentManagerEliminations.ts` broadcasts
  names only. Add the avatar URL to the payload and the head becomes a real
  face instead of an initial.
- **Nobody has confirmed the pacing *feels* right in a seated session.** Every
  value is a named constant and trivially retunable. This needs a human.

### 8.8 🟢 Verification debt

- The bounty and spin animations have **never been seen by a human** in a real
  game. `tests/e2e/live-animations.spec.ts` runs real Chrome against live
  production CSS — extend it to cover the chest, the knockout and the wheel.
- No 500× has ever been drawn. Force one on a test club and watch the whole
  chain: draw → settle → pool debit → payout → wheel.

---

## 9. TRAPS THAT WILL COST YOU HOURS

### 9.1 The host DESTROYS uncommitted work
A `git reset --hard origin/main` loop wiped **9 of 15** files I had edited but
not committed. No warning. Survival: **idempotent re-apply scripts** (so a
partial wipe can be safely re-run) and **commit from a clean `origin/main`
worktree with explicit paths** (so a reset landing mid-commit cannot corrupt
it and you cannot pick up another agent's WIP).

### 9.2 The working trees are ALWAYS dirty
200+ modified files from other agents is normal. **Never `git add .`**. Always
`git hash-object` explicit paths against a clean `origin/main` tree.

### 9.3 The sandbox mount cannot `unlink`
`rm` fails; git leaves `.git/index.lock` stranded, which then blocks git on the
host too. `mv` locks into `_to_delete/`. Never run git *write* commands through
the sandbox against the shared tree.

### 9.4 Other agents are working in the same repo, right now
One was solving the *same* Spin margin problem in parallel — it wrote a
`spin_margin` row, found my commit superseded it, and cleaned up after itself
(migration `remove_superseded_spin_margin_row`). **Check
`supabase_migrations.schema_migrations` for recent work before assuming you are
alone.** Push races are constant; always retry.

### 9.5 A failure that produces no data produces no alert
The unbooked-games defect had **no error anywhere** — the absence of a row is
not something anything notices. I found it by *querying for the gap*. For any
invariant of the form "X must always be written", write the query that looks
for missing X, and schedule it.

### 9.6 Fixing files one at a time loses
Three of the four post-cutover defects were "the same bug in another file". The
fixes that held moved the invariant to a place no code path can miss:

| Invariant | Enforced by |
|---|---|
| A spin never carries a fee | database CHECK (case-insensitive) |
| The pool never goes negative | database CHECK |
| An unpayable tier is never offered | affordability gate |
| A game is never unbooked | retries + idempotent sweeper |
| The ladder never forks | one spec, mirrored, byte-identical test |

### 9.7 `execute_sql` autocommits
There is no transaction wrapper. If you rehearse on production, **clean up in
the same statement** — I used a `DO $$ ... $$` block that asserted and then
deleted its own rows, and verified 0 remained.

### 9.8 `rake_records` has FKs on both `club_id` and `tournament_id`
Fake UUIDs in a test will fail. Use real rows.

---

## 10. KEY FILES

```
src/config/spinSpec.ts                    ← CANONICAL. mirrored to server/src/config/
server/src/services/TournamentRecurringService.ts   ← creates spins (the live path)
server/src/tournament/TournamentManagerBase.ts      ← starts + settles spins
server/src/tournament/TournamentManagerEliminations.ts ← bounty broadcasts
server/src/engine/ServerTableEngineHandEvents.ts    ← TURN_CHANGE settle, WINNERS
server/src/engine/ServerTableEngineRunout.ts        ← pacing constants
src/components/tournament/SpinWheel.tsx/.css
src/components/tournament/KnockoutAnimation.tsx/.css
src/components/tournament/MysteryBountyChest.tsx/.css
src/hooks/useAnimationQueue.ts
src/utils/vibrationGate.ts  ·  src/utils/soundGate.ts
src/pages/TablePage.tsx                   ← wires all overlays (~8000 lines)

.agent/audits/2026-08-20-spins-economics-research.md          ← READ THIS
.agent/audits/2026-08-20-animation-pacing-and-winners-regression.md
supabase/migrations/20260820_spin_*.sql
```

---

## 11. FIRST FIVE MINUTES

```bash
cd ~/Documents/club-arena && git fetch -q origin main && git log --oneline -15 origin/main
npx vitest run tests/config tests/components tests/hooks tests/utils   # expect 348
npx tsc --noEmit && (cd server && npx tsc --noEmit)                    # expect 0 / 0
```
```sql
SELECT * FROM v_spin_reserve_health ORDER BY balance DESC;
SELECT fn_spin_sweep_unbooked(240);
```

Then start at **§8.1** — the multiplier is in the tournament name, and every
second the wheel spends dramatically revealing a number the player already read
in the lobby is a second spent undermining the feature.
