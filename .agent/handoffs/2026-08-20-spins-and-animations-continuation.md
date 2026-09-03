# HANDOFF — Spins & Gameplay Animations

**From:** Claude (Cowork) · **Date:** 2026-08-20 · **Repos:** `club-arena` (code) + `Smarter-Poker-World-Hub` (deploy)

Every claim in this document is backed by the query or grep that produced it, so
you can re-verify rather than trust me. Every work item has an exact location, a
concrete fix, and a **DONE WHEN** you can actually run.

---

## PART 0 — ORIENTATION (5 minutes)

```bash
cd ~/Documents/club-arena && git fetch -q origin main && git log --oneline -20 origin/main
npx vitest run tests/config tests/components tests/hooks tests/utils   # expect 348 pass
npx tsc --noEmit && (cd server && npx tsc --noEmit)                    # expect 0 and 0
```

```sql
SELECT * FROM v_spin_reserve_health ORDER BY balance DESC;
SELECT fn_spin_sweep_unbooked(240);     -- safe, idempotent
```

**Baseline — this is what "healthy" looks like right now.** If any of these has
moved, understand why before doing anything else.

| Metric                                 | Value at handoff                                    |
| -------------------------------------- | --------------------------------------------------- |
| Pools                                  | 3 (JAQK 5,000 · SHARK 5,000 · Midway house ~10,000) |
| `unbooked_24h`                         | 0                                                   |
| `shortfall_events`                     | 0                                                   |
| Pools where `balance <> sum(ledger)`   | 0                                                   |
| Spins created since cutover with a fee | 0                                                   |
| Settled games with rake booked         | 10 / 10                                             |
| Clubs able to draw 500×                | 3 / 3                                               |
| Total spins ever                       | 7,130 (2,126 ran)                                   |
| Live client `ca_sha`                   | `ad98cbc75`                                         |
| Genuine keyframe collisions            | 0 (of ~900)                                         |

---

## PART 1 — HOW TO SHIP

**The sandbox has no network route to GitHub.** Don't retry `git push`, `curl
api.github.com`, or npm installs from it. They will all fail.

### 1.1 Build the commit (sandbox)

Never `git add .` — the working tree holds 200+ files of other agents' WIP.

```bash
cd /sessions/<session>/mnt/club-arena
[ -f .git/index.lock ] && mv .git/index.lock "_to_delete/index.lock.$(date +%s)"
git fetch -q origin main
export GIT_INDEX_FILE=/tmp/my.index; rm -f "$GIT_INDEX_FILE"
git read-tree origin/main                        # clean base, not the dirty tree
for f in path/one.ts path/two.ts; do
  sha=$(git hash-object -w "$f")
  printf '100644 %s\t%s\n' "$sha" "$f" | git update-index --add --index-info
done
TREE=$(git write-tree); PARENT=$(git rev-parse origin/main)
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "message"); echo "$COMMIT"
unset GIT_INDEX_FILE
```

⚠ Avoid unescaped backticks in `-m` — bash will execute them. I lost a commit
message body that way (`variant: command not found`).

### 1.2 Push (host, with retries — you WILL race other agents)

```bash
cd ~/Documents/club-arena
for i in 1 2 3 4; do
  rm -rf /tmp/wt; git fetch -q origin main
  git worktree add --detach /tmp/wt origin/main >/dev/null 2>&1; cd /tmp/wt
  if git cherry-pick <COMMIT> >/dev/null 2>&1 && git push origin HEAD:main >/dev/null 2>&1; then
    echo PUSHED; cd ~/Documents/club-arena
    git worktree remove --force /tmp/wt; git worktree prune; break; fi
  cd ~/Documents/club-arena; git worktree remove --force /tmp/wt 2>/dev/null
  git worktree prune; sleep 4
done
```

### 1.3 Deploy the client

```bash
cd ~/Documents/club-arena && git worktree add --detach /tmp/ca origin/main
ln -s ~/Documents/club-arena/node_modules /tmp/ca/node_modules
cp ~/Documents/club-arena/.env /tmp/ca/.env
cd ~/Documents/Smarter-Poker-World-Hub && git fetch -q origin main
git worktree add --detach /tmp/wh origin/main
CA_SRC_OVERRIDE=/tmp/ca WH_OVERRIDE=/tmp/wh bash scripts/sync-club-arena.sh "feat(ca): msg"
# clean up both worktrees afterwards
```

Server/engine deploys are **automatic** on any push touching `server/**`
(`.github/workflows/auto-deploy-hetzner.yml`). No SSH.

### 1.4 Verify it is actually live

```bash
S=$(curl -s "https://smarter.poker/hub/club-arena/build-info.json?cb=$(date +%s%N)" \
    | grep -o 'ca_sha": "[^"]*' | cut -d'"' -f4)
cd ~/Documents/club-arena && git merge-base --is-ancestor <your-sha> "$S" && echo LIVE || echo queued
```

Production lags — the repo is busy and Vercel queues. **If WH's committed
`public/hub/club-arena/build-info.json` shows your `ca_sha`, your bundle is
correct** and Vercel will catch up. Verify at bundle level for anything
important; `console.*` is stripped in production, so grep for CSS class names
or string literals, not log lines.

---

## PART 2 — SPINS: EVERYTHING YOU NEED

### 2.1 The one rule

```
E[multiplier] = seats × (1 − rake_rate)
```

Which multipliers exist and how they're weighted is free design. **Only the
expectation is a constraint.**

### 2.2 A Spin is NOT priced like an MTT

Dan, verbatim: _"SPINS ARE DIFFERENT THEN MTT OR SIT N GO TOURNAMENTS WHERE THEY
ARE STRUCTURED AS BUY IN + RAKE (10+1)... THEY ARE STRAIGHT JUST 10 BUY IN... NO
ADDITIONAL RAKE IS ADDED."_

The reference material Dan supplied contradicted this in one line ("each player
pays $1.08"). **Dan's framing is correct and the frequency table proves it:**

```
E[multiplier]        = 27,638,000 / 10,000,000 = 2.7638
buy-in only:        (3    − 2.7638) / 3    =  7.87%   ← the advertised 8%
buy-in + 8% on top: (3.24 − 2.7638) / 3.24 = 14.70%   ← nobody advertises this
```

`buy_in_fee` **must be 0** on a Spin. Enforced by CHECK
`tournaments_spin_has_no_fee` — case-insensitive, covers `tournament_type`.
An **SNG genuinely is buy-in + rake**; the constraint deliberately allows that.

### 2.3 Money flow, per game

```
collected   = seats × buy_in         every player pays exactly buy_in
house_rake  = rake_rate × collected  FIXED, booked EVERY game → rake_records
reserve_in  = collected − house_rake into the pool
reserve_out = buy_in × multiplier    the whole prize, FROM the pool
```

The pool absorbs 100% of variance; the house takes the advertised rake win or
lose. `E[reserve_out] = reserve_in` by construction ⇒ the pool is net-neutral
over volume ⇒ **its balance is a direct solvency measure**. That is what makes
threshold gating meaningful.

Rake reaches clubs and unions through the normal `rake_records` path.

### 2.4 The ladder — `src/config/spinSpec.ts`

**Mirrored to `server/src/config/spinSpec.ts`; a test asserts byte-identical.
If you edit one, `cp` it to the other or the test fails.**

| ×   | Freq /10M | Payouts | Stack | Level | Reserve gate |
| --- | --------- | ------- | ----- | ----- | ------------ |
| 2   | 4,772,497 | 100     | 300   | 1 min | —            |
| 3   | 3,968,502 | 100     | 300   | 2 min | —            |
| 4   | 900,000   | 100     | 400   | 2 min | —            |
| 5   | 250,000   | 100     | 400   | 3 min | —            |
| 10  | 100,000   | 80/20   | 500   | 3 min | —            |
| 25  | 7,500     | 80/12/8 | 500   | 3 min | —            |
| 50  | 1,000     | 80/12/8 | 500   | 4 min | —            |
| 100 | 500       | 80/12/8 | 500   | 5 min | 1.5× jackpot |
| 500 | 100       | 80/12/8 | 500   | 5 min | 2.0× jackpot |

Rake: **8%** ≤$5 · **7%** ≤$10 · **6%** ≤$50 · **5%** >$50.
Blinds 10/20 → 105/210 then ~1.4×/level, shared by every tier. Seats always 3.
Game types NLH · PLO4 · PLO5 · PLO6.

~87.4% of games are 2×/3× and pay one player; only ~1.1% pay more than first.
**That concentration is the format** — spreading it flattens the variance people
show up for.

### 2.5 Reserve Pool

Tables `spin_bonus_pools` (per club) and `spin_reserve_ledger` (every movement).
`balance >= 0` is a CHECK.

| RPC                                                                              | Purpose                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `fn_spin_reserve_state(club)`                                                    | read; creates pool lazily                                 |
| `fn_spin_reserve_seed(club, amt, stake, ceiling)`                                | credit + ledger row                                       |
| `fn_spin_reserve_seed_from_union(union, club, amt, stake, ceiling, wallet, key)` | atomic union→pool, **both sides booked, idempotent**      |
| `fn_spin_draw_multiplier(club, buy_in, tiers, rake_rate, seats)`                 | **gated draw** → `{multiplier, locked[], eligible_count}` |
| `fn_spin_settle_game(tourn, club, buy_in, seats, mult, rake_rate)`               | books rake + pool in/out, **idempotent**                  |
| `fn_spin_sweep_unbooked(mins)`                                                   | backstop                                                  |

View `v_spin_reserve_health`: balance · `can_draw_100x` · `can_draw_500x` ·
`is_thin` · `shortfall_events` · `unbooked_24h`.

**The gate has TWO conditions — both required:**

1. **Affordability** — `balance + this_game_contribution >= buy_in × multiplier`
2. **Jackpot threshold** — 100× ≥1.5×, 500× ≥2.0× its own jackpot **at the
   highest stake running**, not this table's stake

A tier failing either is **excluded from the draw**, never drawn-then-refused.
That is what makes an unpayable jackpot structurally impossible.

### 2.6 Seeded state

| Club              | `club_id`                              | Balance | Ceiling |
| ----------------- | -------------------------------------- | ------- | ------- |
| Club JAQK         | `a0000000-0000-0000-0000-000000000001` | 5,000   | 20,000  |
| SHARK CLUB        | `a41434bb-8d0c-400a-8f0d-e8b3d65afed4` | 5,000   | 20,000  |
| Midway house club | `fade0000-0000-0000-0000-000000000001` | ~10,000 | 20,000  |

⚠ **The club actually running all the spins shares the UNION's UUID and is
_named_ "Midway Union".** It is a club row, not the union. I initially seeded
the two obviously-named clubs and missed the one doing 100% of the work.

Funded from Midway union **`promo_wallet`** (36,520 → ~16,535). A jackpot pool
is a promotional guarantee; **`rake_wallet` is owed to clubs at settlement — do
not use it.**

**To seed or top up:**

```sql
SELECT fn_spin_reserve_seed_from_union(
  'fade0000-0000-0000-0000-000000000001'::uuid,   -- union (payer)
  '<club_id>'::uuid, <amount>, <highest_stake>, <ceiling>,
  'promo_wallet', '<unique-idempotency-key>');
```

Required seed = `2 × 500 × highest_stake`. Ceiling = `8 × 500 × highest_stake`.
Give ~2× headroom above the 500× threshold or the top tier flickers in and out.

### 2.7 The three creation paths

1. `server/src/services/TournamentRecurringService.ts` → `createSpin()` — **the
   live one.** All 7,130 production spins.
2. `server/src/tournament/TournamentManagerBase.ts` — start path; re-draws a
   missing multiplier through the same gate, then **settles**.
3. `src/services/HorseOrchestrator.ts` → `launchSpin()` — latent (never produced
   a production row), now routed to the canonical path.

### 2.8 How a Spin gets paid — VERIFIED

`TournamentManagerEliminations.ts`:

- **places 2..N** — line ~313: reads `payout_structure`, finds `place ===
position`, `prize = round(prize_pool × pct / 100, 2)`
- **place 1** — line ~834: same, using `place === 1`

Both are generic and proven by MTTs. ⚠ **Two fallbacks award 100% of the pool**
(lines ~851 and ~858) when `payout_structure` is missing or has no place 1. For
a 10×+ spin where eliminations already paid 2nd/3rd, that would overpay by 20%.
Current exposure: **0 spins** are missing a structure or a place 1 (verified).

---

## PART 3 — ANIMATIONS: EVERYTHING YOU NEED

### 3.1 ⚠⚠ THE SINGLE MOST DANGEROUS FACT IN THIS CODEBASE

**`handleHandEvent` is dispatched FIRE-AND-FORGET** (`void this.handleHandEvent(...)`
in `ServerTableEngineDealing`). **Handlers are NOT serialized.**

> An `await` inside an event handler does not merely delay that handler — **it
> lets every later event overtake it.**

I caused a production regression exactly this way. I put
`await sleep(showdownSettleMs)` at the _top_ of the `WINNERS` case, before the
winner state was assigned. `HAND_COMPLETE` overtook it and read unwritten state.
`hand_history.winners` was empty for **~52% of hands over ~3 hours**
(0.0% baseline → 65–70% → 0.0% after fix). Money was unaffected — payouts run
through `HandController.applyStackDeltas`, independent of that state — but the
history was destroyed for ~10k hands.

**Before adding any `await` to a handler:** enumerate every piece of state
written below it and every later event that reads that state.
Guard: `server/src/engine/ActionPacing.test.ts` asserts source-position ordering
(`assign` < `settle` < `pot_win`). It provably failed against the broken code.

### 3.2 The bug class: "superseded in its own tick"

An event is emitted then immediately superseded in the same synchronous tick, so
its animation never gets airtime. **Seven instances found and fixed.**

`TURN_CHANGE` is the universal choke point — every action path (human submit,
horse think-timer, queued pre-action, turn timeout, time-bank expiry, disconnect
auto-action) ends by advancing the turn. **One settle there paces all of them and
no individual caller can bypass it.**

| Constant             | Value | Protects                                  |
| -------------------- | ----- | ----------------------------------------- |
| `actionSettleMs`     | 650   | action → next player                      |
| `preActionVisibleMs` | 900   | queued pre-action (was firing at **0ms**) |
| `streetSettleMs`     | 1400  | board dealt → next actor                  |
| `handStartSettleMs`  | 1500  | hand dealt → first action                 |
| `showdownSettleMs`   | 1600  | showdown → pot ship                       |
| `allInFirstPauseMs`  | 2000  | ALL-IN banner vs first runout card        |
| `allInStreetPauseMs` | 1400  | between runout streets                    |
| `BBJ_CELEBRATION_MS` | 9000  | Bad Beat Jackpot                          |
| `HORSE_MIN_THINK_MS` | 2200  | horse think floor                         |

In `ServerTableEngineRunout.ts` / `Turns.ts` / `Dealing.ts`. Measured effect:
hands/min ~200 → ~85–120. **That is the intended trade** — Dan: _"focus more on
the user experience rather than getting more hands dealt."_

### 3.3 ⚠ `@keyframes` IS A GLOBAL NAMESPACE

~900 keyframes in this app. Two definitions of one name with different bodies
resolve by **load order**, silently, for **both** consumers.

Real casualties: `screenShake` (killed the big-win shake — the winning
definition used a CSS var out of scope, producing an invalid transform, so
_nothing happened_), `card-deal`, `winnerAvatarGlow`, `skeletonShimmer` (was
sliding an entire card across the home page instead of shimmering it),
`leaderboardPageFadeInUp`.

**Swept 44 → 0. It is 0 today. Keep it there.** Prefix everything (`ko*`,
`mbc*`, `sw*`). `@keyframes` inside `@media` is a legitimate responsive
override, not a collision — 3 exist and are fine.

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

### 3.4 A CSS-only search is NOT proof a keyframe is orphaned

Of three I flagged as orphans, **only one was real**. `spectatorFloating` is
applied via an **inline style** in `SpectatorBadge.tsx`; `activeAvatarPulse` is
used in `Avatar.css`. Deleting either would have silently killed a live
animation. Grep `.tsx` too, for both the name and `animation:` strings.

### 3.5 Animation inventory (components carrying their own keyframes)

| Component                           | Keyframes | Importers | Note                                  |
| ----------------------------------- | --------- | --------- | ------------------------------------- |
| `SeatSlot`                          | 37        | 5         | hero cards, timer ring, squeeze, fold |
| `ThrowAnimation`                    | 33        | 1         | owns a `screenShake` — do not collide |
| `MysteryBountyChest`                | 23        | 2         | NEW                                   |
| `KnockoutAnimation`                 | 17        | 1         | NEW                                   |
| `PotDisplay` / `CommunityCards`     | 12 / 12   | 3 / 3     | pot ship, board deal                  |
| `TournamentWinnerOverlay`           | 9         | 2         |                                       |
| `SpinWheel`                         | 9         | 1         | NEW                                   |
| `ChipPhysics`                       | 9         | 2         | chip slide-in                         |
| `BadBeatJackpot` / `BBJCelebration` | 8 / 5     | 2 / 3     | 9s celebration                        |
| **`FlashTransition`**               | **6**     | **0**     | 🗑 dead                               |
| **`SpinItWheel`**                   | **3**     | **0**     | 🗑 dead — engine removed              |

### 3.6 Components I built

| Component            | Design notes                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KnockoutAnimation`  | 3 beats: impact (head cracks + falls) → payout (counts up) → PKO split. **`pointer-events: none`** — fires while you may be in a hand, must never eat the fold button.                                                                                                                                              |
| `MysteryBountyChest` | 5 beats: land → locked (escalating tension 0-6s) → opening (hinged lid) → explosion → reveal. **Click-to-open, winner only.** Broadcasts `mystery_chest_opened` on channel `mystery-chest-{tableId}`. AFK auto-open 9s (**winner's client only**, so N spectators can't fire N broadcasts); spectator failsafe 14s. |
| `SpinWheel`          | Server-decided. **No `Math.random` — a test asserts this.** Tiers interleaved from both ends (2,500,3,100,4,50,5,25,10) so near-misses are a property of the layout, not staged.                                                                                                                                    |
| `useAnimationQueue`  | One celebration at a time, none skipped. A 3-way all-in busts 2 players → 2 broadcasts ms apart → a single `useState` dropped one.                                                                                                                                                                                  |

### 3.7 Sounds added

`playSpinStart` · `playSpinTicking(durationMs)` · `playSpinMultiplierResult(m)` ·
`playMysteryChestLand/Open/Explosion` · `playThrowableLaunch`.

⚠ A **pre-existing generic `playSpinResult()`** is used by `EliminationOverlay`,
`SpinItWheel` and `BBJCelebration`. That is why mine is
`playSpinMultiplierResult` — do not collide.

Ticking is scheduled on the **same easing curve** as the wheel rotation so it
decelerates _with_ the visual. A metronome under a slowing wheel reads as broken.

### 3.8 Gates every animation must respect

| Gate                         | Rule                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `getAnimationSpeed()`        | `--animation-speed` multiplier — **JS windows must honor it too**                        |
| `prefersReducedMotion()`     | remove _motion_, never remove _information_                                              |
| `ambientSoundsAllowed`       | false on a background table (up to 4 mount simultaneously)                               |
| `src/utils/vibrationGate.ts` | the **only** place deciding a buzz; honors BOTH switches; coalesces 60ms, strongest wins |
| `src/utils/soundGate.ts`     | same for audio; **either** switch off silences everything                                |

⚠ `useTabKeepAlive` creates an AudioContext. It is now a **refcounted
singleton** — before, 4 tables + SoundService + PremiumSFX + VoiceRecorder = **7
contexts against Chrome's cap of 6**, and the table went silent. Do not
un-singleton it.

---

## PART 4 — THE WORK QUEUE

Ordered by (user impact × money risk) ÷ effort.

---

### 🔴 W1 — The multiplier is spoiled in TWO places before the wheel reveals it

**EVIDENCE**

```
server/src/services/TournamentRecurringService.ts:1474
  name: `${config.name} (${multiplier}x)`      → "3 Chip Spin NLH (4x)"
src/pages/TablePage.tsx:7629-7634
  <div className="spinMultiplierBadge …"><span>{tableState.spinMultiplier}x</span>
src/pages/TournamentPage.tsx:1070-1074
  {selectedTournament.spin_multiplier ? `${…}x` : 'TBD'}
```

The tournament **name** carries the answer into the lobby, the tab bar and the
table title. And `TablePage` renders a **persistent badge in the same view as
the wheel** — so even with the name fixed, the number sits on screen while the
wheel dramatically "reveals" it.

**WHY IT MATTERS** The draw is the entire product. Every second the wheel spends
revealing a number the player already read is a second spent undermining it.

**FIX**

1. Name the tournament without the multiplier. `spin_multiplier` already carries
   it; nothing needs the name to.
2. Suppress the `TablePage` badge until `spinDraw === null` (i.e. the wheel has
   finished) — the wheel's own result becomes the reveal, the badge the
   persistent reminder afterwards.
3. In the lobby, show `TBD` (or a teaser ladder) until the tournament starts.
   Consider not sending `spin_multiplier` to the client at all pre-start.

**DONE WHEN**

```sql
SELECT count(*) FROM tournaments
 WHERE lower(COALESCE(variant,''))='spin' AND name ~ '\(\d+x\)'
   AND created_at > now() - interval '10 minutes';   -- expect 0
```

…and opening a fresh Spin table shows no multiplier anywhere until the wheel
lands.

**RISK** Low. Cosmetic + one broadcast field. Check `TableTabBar` and
`HandReplay` don't depend on the name format.

---

### 🔴 W2 — Multi-place payouts have never actually paid a 2nd or 3rd place

**EVIDENCE**

```sql
-- 62 spins at 10x+ have COMPLETED, but:
SELECT spin_multiplier, count(*), max(places_paid), min(payout_structure::text) …
--  10x → 60 tourneys, max_places_paid 1, structure [{"place":1,"percentage":100}]
--  25x →  2 tourneys, max_places_paid 1, structure [{"place":1,"percentage":100}]
```

They were all created **before** the cutover, with the old winner-take-all
structure. The 80/20 and 80/12/8 splits I introduced have therefore **never been
exercised end to end**.

**GOOD NEWS** The machinery is generic and proven by MTTs:
`TournamentManagerEliminations.ts:313` pays places 2..N from `payout_structure`;
`:834` pays place 1 the same way. And **0 completed spins have ever over-paid**
their pool.

**THE HAZARD** Lines ~851 and ~858 fall back to **awarding 100% of the pool** if
`payout_structure` is missing or lacks place 1. On a 10×+ spin where
eliminations already paid 2nd/3rd, that overpays by 20%. Current exposure is 0
spins, but the fallback is a live landmine for the new structures.

**FIX**

1. Force a 10× and a 25× on a test club, complete them, confirm 2 and 3 players
   are paid and the parts sum to ≤ the pool.
2. Make the fallback **spin-aware**: if `variant='spin'` and `payout_structure`
   is missing, derive it from `spinTier(spin_multiplier).payouts` rather than
   handing the winner everything.
3. Consider matching `spinEconomics()`'s rounding — it floors non-first places
   and gives 1st the remainder, so parts can never exceed the pool. The engine
   rounds each place independently, which at a tiny pool can overpay by a cent.

**DONE WHEN**

```sql
SELECT t.spin_multiplier, t.prize_pool,
       count(*) FILTER (WHERE tp.prize>0) AS paid,
       round(sum(tp.prize)::numeric,2) AS total_paid
FROM tournaments t JOIN tournament_players tp ON tp.tournament_id=t.id
WHERE lower(COALESCE(t.variant,''))='spin' AND t.status='COMPLETED'
  AND t.spin_multiplier>=10 AND t.created_at > '2026-08-20 19:20:00+00'
GROUP BY t.id, t.spin_multiplier, t.prize_pool;
-- 10x → paid 2, total_paid = prize_pool
-- 25x → paid 3, total_paid = prize_pool
```

**RISK** 🔴 **Money.** Test on a throwaway club first.

---

### 🟠 W3 — `lockedMultipliers` is built, styled, tested — and never passed

**EVIDENCE** `src/pages/TablePage.tsx:3499` `setSpinDraw({…})` omits it.
`SpinWheel` accepts `lockedMultipliers`, renders `.sw__seg--locked`, the CSS
exists and tests cover it. The feature is **dead on arrival**.

**FIX** `fn_spin_draw_multiplier` already returns `locked[]` as
`{multiplier, reason, unlocksAt}`. Either persist it on the tournament row at
creation, or call `fn_spin_reserve_state` at table open and compute via
`eligibleSpinTiers()`. Pass it through. **Show `unlocksAt`** — "500× unlocks at
5,000" is real anticipation and honest about the ceiling.

**DONE WHEN** With a deliberately under-seeded test club, the wheel renders
100×/500× dimmed with their unlock thresholds, and the engine never draws them.

**RISK** Low, display only.

---

### 🟠 W4 — The sweeper is not scheduled

**EVIDENCE** `fn_spin_sweep_unbooked(mins)` exists, is idempotent, and runs
**only when a human calls it.**

**FIX** Per `Smarter-Poker-World-Hub/CLAUDE.md` §11, **all new scheduled jobs go
to Open Claw on Hetzner — never `vercel.json`** (CI fails the build):

1. `pages/api/cron/spin-sweep.js`, checking `Authorization: Bearer $CRON_SECRET`
2. Schedule entry in `scripts/openclaw-cron-dispatcher.py` (suggest every 15 min)
3. `bash scripts/deploy-openclaw.sh` — **the repo file and the Hetzner file must
   never drift**
4. Watch one fire-cycle before calling it shipped

Add an alert when `is_thin` or `unbooked_24h > 0`.

**DONE WHEN** `journalctl -u openclaw` shows the job registered and firing, and
a deliberately unbooked spin is settled within one cycle.

---

### 🟡 W5 — Two stale multiplier tables remain in client code

**EVIDENCE**

```
src/services/TournamentService.ts:240  SPIN_BONUS_TIERS  (retired EV 3.0 pool model,
                                        still EXPORTED, consumed by CreateTournamentModal)
src/services/HorseOrchestrator.ts:914  SPIN_MULTIPLIERS  (EV 2.75, no 4x/50x/500x,
                                        now unused by launchSpin but still declared)
```

**FIX** Derive both from `spinSpec` or delete. Then extend
`tests/config/spinEngineWiring.test.ts` — it currently asserts zero hardcoded
`{multiplier, weight}` literals in **server** files; widen it to client files so
a fifth table can't appear.

---

### 🟡 W6 — Spin correctness gaps

- **PLO6 may be uncreatable.** `SPIN_GAME_TYPES` includes `PLO6`, but
  `gameTypeMap` in `TournamentRecurringService` maps `plo8`, not `plo6`. Verify
  a PLO5 and a PLO6 spin can actually be created.
- **Wheel re-shows on rejoin.** Gated on `sessionStorage` per tournament; a new
  tab replays the draw. Consider a server-side seen-flag.
- **`is_premium_spin` triggers at `>= 100`.** Confirm every consumer expects
  500× too.
- **No surface advertises the reserve.** "500× available now" is the strongest
  marketing this format has and nothing shows it.

---

### 🟡 W7 — Animation cleanup and gaps

- 🗑 **`FlashTransition`** (6 keyframes, 0 importers) and **`SpinItWheel`**
  (3 keyframes, 0 importers, engine removed) are dead. Also
  `src/types/engine/spinIt.ts` and `MysteryBountyReveal.tsx` (the old envelope,
  now superseded by the chest on both surfaces). Confirm, then delete.
- **The knockout head is always an initial.** `KnockoutAnimation` accepts
  `eliminatedAvatar`, but `TournamentManagerEliminations.ts` broadcasts names
  only. Add the avatar URL to the payload and the head becomes a real face.
- **Bomb-pot pacing** — unreachable, 0 tables have `bomb_pot_enabled`. Verify
  before building anything.
- **Nobody has confirmed the pacing _feels_ right in a seated session.** Every
  value is a named constant and trivially retunable. This needs a human at a
  table, not another test.

---

### 🟢 W8 — Verification debt

- The bounty and spin animations have **never been seen by a human in a real
  game**. `tests/e2e/live-animations.spec.ts` drives real Chrome against live
  production CSS and reads `document.getAnimations()` — extend it to cover the
  chest, the knockout and the wheel.
- **No 500× has ever been drawn.** Force one on a test club and watch the whole
  chain: draw → settle → pool debit → 3-way payout → wheel reveal.

---

## PART 5 — TRAPS (each cost me real time)

**5.1 The host DESTROYS uncommitted work.** A `git reset --hard origin/main`
loop wiped **9 of 15** files I had edited but not committed, mid-session, no
warning. Survive it with **idempotent re-apply scripts** (so a partial wipe can
be safely re-run) and **commits built from a clean `origin/main` tree with
explicit paths**.

**5.2 The working trees are always dirty** — 200+ files of other agents' WIP.
Never `git add .`.

**5.3 The sandbox mount cannot `unlink`.** `rm` fails; git strands
`.git/index.lock`, which then blocks git **on the host too**. `mv` locks into
`_to_delete/`. Never run git _write_ commands through the sandbox.

**5.4 Other agents are in this repo right now.** One was solving the _same_ Spin
margin problem in parallel — wrote a `spin_margin` row, found my commit
superseded it, and cleaned up after itself (migration
`remove_superseded_spin_margin_row`). **Check
`supabase_migrations.schema_migrations` for recent work before assuming you're
alone.** Push races are constant; always retry.

**5.5 `execute_sql` autocommits.** No transaction wrapper. If you rehearse on
production, clean up **in the same statement** — I used a `DO $$ … $$` block
that asserted, then deleted its own rows, and verified 0 remained.

**5.6 `rake_records` has FKs on both `club_id` and `tournament_id`.** Fake UUIDs
in a test will fail. Use real rows.

**5.7 `console.*` is stripped in production builds.** Verify a deploy by
grepping the bundle for CSS class names or string literals, never log lines.

### 5.8 THE TWO LESSONS THAT GENERALISE

**A failure that produces no data produces no alert.** The unbooked-games defect
threw no error anywhere — the _absence_ of a row is not something anything
notices. I found it by querying for the gap. **For any invariant of the form
"X must always be written", write the query that hunts for missing X, and
schedule it.**

**Fixing files one at a time loses.** Three of the four post-cutover defects were
the same bug in another file. The fixes that held moved the invariant somewhere
no code path can miss:

| Invariant                          | Enforced by                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| A spin never carries a fee         | database CHECK (case-insensitive, covers `tournament_type`) |
| The pool never goes negative       | database CHECK                                              |
| An unpayable tier is never offered | affordability gate in draw + spec                           |
| A game is never left unbooked      | retries + idempotent sweeper                                |
| The ladder never forks again       | one spec, mirrored, byte-identical test                     |

---

## PART 6 — WHAT I FIXED (don't re-break it)

| #   | Defect                                                                                                     | Fix                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | 3 conflicting multiplier tables (EV 3.00 / 2.75 / 2.24)                                                    | one mirrored spec + identity test          |
| 2   | `prize_pool` overwritten; margin in **no ledger** (~1,160 over 2,091 games)                                | `fn_spin_settle_game` books every movement |
| 3   | Gate guarded only 100×/500×; a 4× on a thin pool aborted settlement → game ran **unbooked** (3 live spins) | affordability condition                    |
| 4   | Settlement had no retry — one transient failure lost the row forever                                       | 3 retries + sweeper                        |
| 5   | `launchSpin`: stale table, charged fee, `prizePool = buyIn × seats × mult`                                 | routed to canonical path                   |
| 6   | CHECK defeated by `variant: 'SPIN'` uppercase                                                              | case-insensitive + `tournament_type`       |
| 7   | Lobby ladder hardcoded, missing 4× and 500×                                                                | derived from spec                          |
| 8   | 7 "superseded in own tick" animation skips                                                                 | settles at `TURN_CHANGE`                   |
| 9   | Winning-hand card pop **never fired** (container vs card class)                                            | rewired                                    |
| 10  | AudioContext per table mount: 7 vs Chrome's cap of 6 → table went silent                                   | refcounted singleton                       |
| 11  | Hero card wrapper broke PLO sizing — PLO6 **264px vs 159px**                                               | geometry on `> *`                          |
| 12  | 6 haptic implementations, 3 ignoring the switches; 16 double-fires                                         | one gate + coalescing                      |
| 13  | **Neither** sound switch actually muted the app                                                            | one gate                                   |
| 14  | Throwable impact fired at launch, from the picker only                                                     | moved to `FlyingEmoji`                     |
| 15  | Bounty animations dropped one of two simultaneous KOs                                                      | `useAnimationQueue`                        |
| 16  | **My own regression:** `winners` empty ~52% of hands over 3h                                               | settle after state commit + ordering test  |

---

## PART 7 — ROLLBACK

Every money change is reversible. Full SQL in the migration headers under
`supabase/migrations/20260820_spin_*.sql`.

```sql
-- Un-seed a pool (reverses fn_spin_reserve_seed_from_union)
UPDATE union_wallets SET promo_wallet = promo_wallet + <amt>
 WHERE union_id = 'fade0000-0000-0000-0000-000000000001';
UPDATE spin_bonus_pools SET balance = balance - <amt>, seeded_amount = seeded_amount - <amt>
 WHERE club_id = '<club>';
DELETE FROM union_wallet_transactions WHERE tx_type='spin_reserve_seed' AND club_id='<club>';
DELETE FROM spin_reserve_ledger WHERE kind='seed' AND club_id='<club>';

-- Drop the no-fee constraint
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_has_no_fee;
```

Reverting the engine to pre-cutover means reverting commits `11633f4ce` →
`ad98cbc75`. **Do not** — that reinstates the leak.

---

## PART 8 — KEY FILES

```
src/config/spinSpec.ts                              ← CANONICAL, mirrored to server/
server/src/services/TournamentRecurringService.ts   ← creates spins (live path)
server/src/tournament/TournamentManagerBase.ts      ← starts + settles spins
server/src/tournament/TournamentManagerEliminations.ts ← payouts + bounty broadcasts
server/src/engine/ServerTableEngineHandEvents.ts    ← TURN_CHANGE settle, WINNERS
server/src/engine/ServerTableEngineRunout.ts        ← pacing constants
src/components/tournament/{SpinWheel,KnockoutAnimation,MysteryBountyChest}.tsx/.css
src/hooks/useAnimationQueue.ts
src/utils/{vibrationGate,soundGate,animationSpeed}.ts
src/pages/TablePage.tsx                             ← wires every overlay (~8k lines)

.agent/audits/2026-08-20-spins-economics-research.md              ← READ FIRST
.agent/audits/2026-08-20-animation-pacing-and-winners-regression.md
supabase/migrations/20260820_spin_*.sql
```

**Start at W1.** The multiplier is spoiled in two places, and until that's fixed
the wheel — the most expensive thing built this session — is theatre for a
number the player already read.
