# HANDOFF — Crazy Pineapple discard overhaul. Phases 1 and 2 shipped; start Phase 3 of 4.

**Date:** 2026-08-31
**Repo:** `Smarter-Poker-Club-Arena` (Club Arena). Some verification touches
`Smarter-Poker-World-Hub` and Supabase `kuklfnapbkmacvwxktbh`.
**Read first:** `AGENT-PLAYBOOK.md`, then `CLAUDE.md` (§10.5 horses, §10.6
animation law, §11.5 never spend real chips, §12 clone hygiene).

---

## 0. ONE PARAGRAPH OF ORIENTATION

Dan reported four bugs from a live Crazy Pineapple seat. Investigating them
turned up a money bug that was paying illegal hands in production. Everything
found was broken into **four phases**. **Phases 1 and 2 are merged, deployed and
verified in production.** You are starting **Phase 3 of 4**. Phase 3 and Phase 4
are fully scoped below with exact file paths, line anchors and the reasoning.
Nothing in Phases 1-2 is left half-done; §6 is an explicit audit trail of that
claim.

---

## 1. WHAT DAN ORIGINALLY REPORTED (verbatim)

> I JUST JOING A PINEAPPLE TABLE THAT HAD NO PLAYERS AND IT DEALT ME IN WITH NO
> OTHER PLAYER PLAYING SMH. 2ND HAND "AUTO FOLDED MY HAND, EVEN THOUGH IT
> DIDN'T, IT JUST MADE MY CARDS DISAPPEAR. THE DISCARD, POP UP SHOULDN'T TAKE
> OVER THE ENTIRE SCREEN, IT SHOULD BE A SIMPLE DISCARD POP UP WHERE YOU SELECT
> WHICH CARD YOU WANT TO DISCARD, IT CURRENTLY BLOCKS THE HOLE FLOP SO YOU CAN'T
> SEE WHAT YOU CONNECTED WITH OR NOT, AND IT DOESN'T REMOVE THE CARD FROM YOU
> HAND AFTER YOU DISCARD IT.

Later he asked for everything else that could be improved, which produced the
12-item list that became the four phases.

---

## 2. EVERYTHING SHIPPED SO FAR (all merged to `main`, all verified)

| PR        | What it fixed                                                                             |
| --------- | ----------------------------------------------------------------------------------------- |
| **#2033** | Wrong card discarded; felt never repainted; picker covered the board                      |
| **#2051** | Session changelog (`docs/changelog/2026-08-31-pineapple-discard-picks-the-right-card.md`) |
| **#2072** | **MONEY BUG** — three-card showdowns paying illegal hands                                 |
| **#2074** | Phase 1: server-authored per-seat discard clock + time bank on a discard                  |
| **#2131** | Phase 1 follow-up: duration wiring, documented the empty bank callback                    |
| **#2146** | Phase 2: forced discard keeps the best HAND; equity never priced from 3 cards             |

`#2061` was **closed as superseded** — #2074 was stacked on it and contains every
commit (`git merge-base --is-ancestor 14ca7dd 7bc78e5` passes). It could not go
green alone because its copy of the test file predated the CI-gate fixes.

### 2.1 #2033 — three defects in one

1. **The wrong card was discarded.** `submitDiscard(tableId, cardIndex)` indexes
   into `player.cards` (the ENGINE's delivery order). The picker was handed
   `hero.holeCards`, which `cards_pre_sort` (Bible V8 §11.1, **on by default**)
   has re-sorted rank-high-to-low. Two arrays, one index. On Dan's A-7-6 all
   three positions mapped to a different card.
   **Fix:** `heroEngineCardOrderRef` in `TablePage.tsx` records the unsorted
   delivery order **before** `sortCardsByRank` runs; `handlePineappleDiscard`
   translates the click back by card identity.
2. **The felt never repainted.** `insert_hole_cards` is an upsert
   (`ON CONFLICT (table_id, hand_number, user_id) DO UPDATE`,
   `supabase/migrations/20260312_secure_hole_cards_fix.sql`). The deal is an
   INSERT; the engine's re-push of the remaining two cards after
   `performDiscard` is an **UPDATE**. The client subscribed with
   `event: 'INSERT'` and was never told.
   **Fix:** `event: '*'`, plus optimistic local removal on acceptance.
   _(This was also silently swallowing every RESYNC/reconnect card re-push.)_
3. **It covered the board.** `inset: 0` + 72% scrim + blur, centred over the
   felt. **Fix:** compact bottom-docked panel, `pointer-events: none` wrapper.

Also corrected a lie: the hint said a timeout discards your last card. Since
2026-08-21 `foldForMissedDiscard` **folds** you. It says so now.

### 2.2 #2072 — THE MONEY BUG (most important thing in this document)

An all-in hand never opens the discard round, so the discard must be resolved on
the **deal**. There are two runout paths and only one did it:

- `runOutCommunityCards()` — had the call since AUDIT V2 (2026-07-23);
- `dealNextStreet()` — the per-street path taken whenever a table has
  **insurance or run-it-twice** enabled. **Never got the line.**

All three live pineapple tables have one or both enabled, so the unfixed path is
the one production takes.

**Proven with production data.** Hand `#3831745` (table `0be5fa47`, 2026-08-31
07:21 UTC), board `2h 3c 5d Qc 4h`:

```
seat A   Jh Ah Kh   -> awarded "Flush",    22.57 of a 34.00 pot
seat B   Ad Kc 5h   -> "Straight",          7.53
```

The board holds exactly **two** hearts. No legal two-card hold makes a flush —
seat A needed all three of its cards. It beat an honest straight that should
have scooped.

**Scale (query it yourself, it still runs):**

```sql
select count(*) as three_card_showdowns, min(created_at), max(created_at), sum(pot_size)
from hand_history h
where h.game_variant='pineapple'
  and h.hole_cards is not null and jsonb_typeof(h.hole_cards)='object'
  and h.created_at > now() - interval '7 days'
  and exists (select 1 from jsonb_each(h.hole_cards) e where jsonb_array_length(e.value)=3);
```

At the time: **1,975 hands, 491,187.36 chips in those pots**, earliest
2026-08-24 — which is only the `hand_history` retention floor for horse-only
hands, **not the start of the bug**.

> ⚠️ **OPEN, AND DAN'S CALL — NOT AN AGENT'S.** Those 1,975 hands were settled on
> illegal evaluations. All were evaluated illegally; only the subset where the
> extra card actually improved the hand were _mis-settled_, and establishing that
> subset needs a re-evaluation pass nobody has run. **Do not move chips without
> Dan's explicit instruction** (CLAUDE.md §11.5). Flagged on #2072 as a comment.

### 2.3 #2074 + #2131 — Phase 1: the discard clock

**The clock lied.** The round was one flat table-wide `setTimeout` and the engine
published nothing, so the client counted down from its own copy of
`action_time_seconds`, anchored with `prev ??` to the first frame it saw the
stage. Three failure modes, all ending in a fold on a clock that still read time:
a differently-configured table showed a number the engine never used; a
**reconnect** mid-round restarted from full over a half-spent server deadline;
switching tabs re-anchored it again. **This is almost certainly Dan's "2nd hand
auto folded my hand".**

**Now:** absolute **per-seat** deadlines, published as `discard_deadlines`
(keyed by user_id), `discard_deadline_ms` (round default), `discard_duration_ms`.
Client reads its own entry and counts against `serverNow()`. All null off-round
so a dead countdown cannot linger.

**The discard could not buy time.** A missed discard folds the hand, yet the
whole time-bank path is written against `currentPlayerSeat` and the discard round
has no turn — the press hit **"Not Your Turn"**. Now routed to the seat's own
deadline under identical rules (exhaustion first, same pool, same per-street cap,
grant = what the bank actually released).

The flat timeout became a **re-arming sweep** so one seat's extension cannot
touch anyone else's. The map is **reconciled against
`HandController.owesPineappleDiscard()`** before every sweep and every publish,
because a horse discards via `performDiscard` and an all-in seat via
`resolvePendingPineappleDiscards` — neither passes through `submitDiscard`.

### 2.4 #2146 — Phase 2: the choice, and the equity

1. **The forced discard threw away draws.** `resolvePendingPineappleDiscards`
   scored the flop-**made** hand — backwards on an all-in, where two cards are
   coming and there is no more betting. Measured divergence:
   `2s 2d Ah` on `Kh Jh Th` — the old rule threw the **ace**, keeping a pair of
   deuces drawing nearly dead and mucking the nut flush draw plus a Broadway
   gutshot.
   It also **disagreed with `HorseLogic.decideDiscard`**, which always priced by
   equity — CLAUDE.md §10.5 broken. **One chooser now:**
   `server/src/engine/pineappleDiscardChoice.ts` → `bestPineappleDiscard()`,
   used by both. Not the same answer, the same function.
2. **Equity was priced from a hand nobody may hold.** Three cards until the flop:
   `omaha:false` scores best-5-of-8 (the #2072 advantage);
   `omaha:true` falls through `evaluateOmahaHand`'s `holeCards.length < 4` guard
   and prices the **first two** cards. No honest third number exists, so the
   broadcast **waits for the flop** — where Dan's own rule already points
   ("equity only AFTER the street lands"). Omaha explicitly excluded.

---

## 3. YOU ARE HERE — PHASE 3 OF 4

### PHASE 3: "the discard you can see and hear"

Three defects, all Animation Law (§10.6) and horses-are-players (§10.5).

#### 3.1 Nobody can see anyone discard — THE BIG ONE

`HandController.ts:958` emits:

```ts
this.emit({ type: 'PLAYER_ACTION', seat, action: 'discard', amount: 0 });
```

The client's `case 'PLAYER_ACTION'` is at **`src/pages/TablePage.tsx:12605`**.
Its sound/animation switch (~12679-12684) has arms for
`all_in | bet | raise | call | check | fold` and **no arm for `discard`**. So a
discard renders _nothing_: no card leaving a seat, no cue, no card-count change
on villains.

Consequence under §10.5: horses discard on a **1.2s-5.2s humanlike delay**
(`ServerTableEngineRunout.handlePineappleDiscard`, `delay = 1200 + random*...`).
That delay was added to make horses indistinguishable — but since nothing
renders, the table just _pauses and jumps_. The pause exists and the thing it
was hiding does not.

**What to build:** a per-seat discard animation — one card leaving the hand
toward the muck — plus its own sound cue, fired on the `PLAYER_ACTION`/`discard`
event for **every** seat (hero and villain, human and horse, identically).
`SeatSlot.tsx` already has the muck machinery: `cardFoldOut` (see the note at
`SeatSlot.tsx:151` and `:382`) is the animation revealed cards use to fly to the
muck. Reuse it for a single card rather than inventing a second mechanism.

#### 3.2 The discard plays the FOLD sound

`src/pages/TablePage.tsx:2452` — `soundService.playFold();` at the end of
`handlePineappleDiscard`. Wrong action, wrong cue, and under §10.6 a discard is
owed its own sound.

`src/services/SoundService.ts` has `playDeal()` (737), `playCheck()` (884),
`playFold()` ("Card swoosh to muck", line ~22). **Add `playDiscard()`** and wire
it both places (hero's own submit, and the villain `PLAYER_ACTION` arm from 3.1).

> ⚠️ §10.6 corollary: a sound cue with a literal volume of 0 is a bug by
> definition. Do not ship a silent stub.

#### 3.3 The street snaps to the turn

`HandController.ts:1051`:

```ts
private checkPineappleDiscardsComplete(): void {
  if (this.pineappleDiscardsRemaining.size === 0) {
    this.advanceStage();   // no settle beat
  }
}
```

Every other cadence on this platform is a named constant in
`server/src/config/handCompletionSpec.ts` (`MUCK_MS: 600`, `DEAL_MS: 700`,
`BETS_SWEEP_MS: 700`, `BOARD_CLEAR_FOLD_MS: 500` ...). Add a `DISCARD_*` beat
there and let the last discard breathe before the turn opens, so the animation
from 3.1 is actually seen.

#### 3.4 Phase 3 acceptance

- Every seat's discard animates and sounds, every time, at the player's chosen
  Animation Speed (`--animation-speed`). No new toggle may disable it (§10.6).
- A horse's discard is **indistinguishable** from a human's (§10.5).
- Add pins to `tests/animations-always-play.law.test.ts` (731 lines — read the
  existing shape first; every pin in it is a bug that actually shipped).

---

### PHASE 4: history and naming (after Phase 3)

#### 4.1 The replay says "Discard" but not WHICH card

Already present: `src/utils/handReplay.ts:167` has the `'discard'` action type
and `:287` a `{ key: 'pineapple_discard', label: 'Discard', boardTo: 0 }` street.
`src/components/table/HandHistoryPanel.tsx:182` colours it. **74,631 discard
actions exist in production.**

Missing: the event carries `amount: 0` and **no card identity**, so reviewing a
Pineapple hand you cannot see what anyone threw away — the only decision the
variant adds. Carry the discarded card on the event and persist it, then render
it in the replay and `HandHistoryPanel`.

#### 4.2 The felt calls it the wrong game

Tables are named `Pineapple 1.00/2.00`; the engine implements **Crazy**
Pineapple (discard _after_ the flop). In plain Pineapple you discard _before_ it.
Anyone who knows the difference is being told the wrong game. Rename in the
lobby/felt/table naming. **Check with Dan before a mass rename of live table
rows** — it is player-visible copy and there are three live tables.

---

## 4. THE REST OF THE PINEAPPLE LIST (found, triaged, NOT in any phase yet)

- **`auto_start_players = 2` on every pineapple table.** Relevant to Dan's "no
  players" report: one human + one horse is a legal deal. It is a **config row,
  not code** — Dan's knob, do not change it unilaterally.
- **Client odds / hand strength ignore the variant.** `src/utils/pokerOdds.ts`
  and `src/utils/handEvaluator.ts` contain no mention of pineapple. During the
  discard — the one moment you need it — anything showing equity or hand
  strength is computing from 2 of your 3 cards or from all 3. Neither is your
  actual decision. **Server-side equity is fixed (#2146); the client is not.**

### 4.1 STILL UNRESOLVED from Dan's original report

**"Dealt me in with no other player" + "auto folded, cards just disappeared"**
— the clock half is fixed by #2074, but the _empty roster_ half is not
reproduced. Findings:

- No `table_seats` or `table_hole_cards` row exists for `kingfish`
  (`47965354-0e56-43ef-931c-ddaab82af765`) on **any** pineapple table that day.
- The three live pineapple tables ran 5-6 handed throughout, so
  `minPlayersToDeal()` was **not** bypassed.
- Both screenshots showed **"Reconnecting To The Table"**.

That points at the client painting a confident, wrong roster under the reconnect
pill, not at the engine dealing short. The snapshot merge in `TablePage.tsx` has
never-shrink guards for the **board** and the **stage** but none for the
**roster**.

> **I deliberately did NOT add a "never shrink the roster" guard.** It is the
> obvious patch and it would strand a ghost seat every time somebody legitimately
> stands up. It needs a repro with the socket state captured. If Dan hits it
> again, capture `engineWsStatus` and the raw snapshot at that moment.

---

## 5. ESTATE-LEVEL FINDINGS (outside Pineapple — Dan has seen these)

- **THE MERGE QUEUE IS JAMMED. 99+ open PRs on Club Arena.** Auto-merge armed on
  nearly all; ~42 confirmed `dirty`, most of the rest uncomputed, exactly one
  `clean`. 99 of them were 2-7 days old. **`main` took 142 commits in 24h — 26 in
  one hour**, i.e. it moves every ~2 minutes while six required checks take
  longer than that to run. Every PR races a target faster than its own CI.
  Top conflict sources measured from the dirty PRs:
  `MIGRATION-CHANGELOG.md` (7 — the file CLAUDE.md **froze** on 2026-08-26 and
  agents still append to), `scripts/ci/supabase-schema-manifest.json` (6) and
  `-columns-manifest.json` (5) — machine-generated files committed per PR.
  Already filed as World Hub **#682**.
  ⚠️ **Do not add a new blocking CI check while the queue is stuck** — every open
  PR would then need to satisfy it. Drain first, enforce second.
- **CA #1634** — a `SECURITY DEFINER` writer reachable from a browser. Oldest
  open issue; privilege-escalation shape.
- **CA #1498** — eight Club Arena flows still push to OneSignal, removed
  2026-08-19. Those notifications go nowhere.
- **CA #997** — delete the vestigial `club-arena` Vercel project.
- **WH #1064** — global footer broken in production (on every page).
- **WH #820** — Solver v2 re-solve pass stopped 2026-08-15; 6.6M spots
  outstanding, backlog growing.
- **WH #771** — six VIP entitlement defects behind the benefits page.
- **WH #613 / #237 / #223** — stale `ci-failure` issues; nobody can tell whether
  they are real.

---

## 6. AUDIT OF MY OWN WORK (what I broke and fixed, so you can trust the rest)

I re-audited Phases 1-2 before moving on. Found and fixed:

1. **The deadline map could drift.** `submitDiscard` was the only pruning point,
   but horses and all-in seats leave the round by other paths. Added
   `HandController.owesPineappleDiscard()` and reconciled before every sweep and
   publish. _(Shipped in #2131's commit range.)_
2. **A discard time bank borrowed the TURN presentation.** `timeBankActive`
   drives the hero seat ring and the tab strip's `1:<deadline>` string, and its
   owning effect cancels the moment `currentPlayerSeat !== heroSeat`. The
   discard round has no current player, so it painted a ring for one frame,
   published a bogus deadline, then cancelled itself. Now returns early.
3. **My first fix for (2) added a toast and turned an existing test red** —
   correctly. `tests/unit/timeBankSeatFeedbackAndCards.test.ts` pins Dan's
   2026-08-24 rule ("it gives you this generic pop up, instead of resetting the
   countdown clock on the hero's box"). I honoured the rule instead of gaming
   the test: the handler returns `{ armed }` and the picker's own button becomes
   the notice.
4. **`discard_duration_ms` was published and read by nobody.** Now drives the
   urgency threshold (was a hard-coded 5s — most of a 6s round, a blink of a 30s
   one; `action_time_seconds` is per-table so both exist). Clamped 3-8s.
5. **The time bank's empty expiry callback looked like a stub.** It is
   deliberate — the sweep is the single enforcer; folding from both would be the
   two-racing-deadlines bug in `TimeBankEngine`'s own history. Now documented.

### 6.1 CI GATES I TRIPPED — you will trip these too

- **`scripts/ci/report-source-grep-tests.mjs --ratchet`** — a text-only test pin
  on a **pure, importable `src/utils` module** is forbidden and ratcheted
  (currently **5/5, no headroom**). Import the module and assert what it DOES.
  `tests/unit/tabSlots.test.ts` is the shape to copy.
- **`tests/unit/noFixedSizeSourceWindows.test.ts`** — never bound a source-pin
  window with a byte count (`src.slice(i, i + 700)`). Use
  `tests/helpers/sourceWindow.ts`: `sliceCall`, `sliceMethod`, `sliceStatement`,
  `sliceCssRule`, `sliceEnclosingBlock`, `sliceBetween`. That rule exists because
  a drifting window caused a **39-minute publish outage**.

Run both locally before pushing:

```bash
node scripts/ci/report-source-grep-tests.mjs --ratchet
npx vitest run tests/unit/noFixedSizeSourceWindows.test.ts
```

---

## 7. ENVIRONMENT TRAPS THAT COST ME REAL TIME

Read this section before you touch anything. Every item bit me.

1. **`TMPDIR` points at a FULL disk.** `TMPDIR=/sessions/<you>/tmp` and
   `/sessions` sits at **100% (2.9M free)**. Vitest, tsc and the pre-push hook
   all die with `ENOSPC: no space left on device` while `df -h /` cheerfully
   reports ~1GB free on `/`. **Fix: `export TMPDIR=/tmp/tmpdir` (mkdir it first)
   for every test run and every `git push`.** Without it the pre-push hook
   reports "43 errors, no tests" and BLOCKS the push, which looks exactly like a
   real test failure and is not.

2. **The pre-push hook refuses a tree with no `node_modules`.** It cannot verify
   the test gate and blocks. If you borrow another clone's `node_modules`, make
   `node_modules/.tmp`, `node_modules/.vite` and `node_modules/.vite-temp` **real
   writable directories** or you get `TS5033: Could not write tsbuildinfo` and
   `EACCES .../vitest/results.json` — both of which masquerade as type errors and
   test failures.

3. **`AGENT_SHARED_CLONE_OK=1` is required** for `git commit`/`git push` in any
   clone the hook considers shared. Use it. **Do NOT use `--no-verify`** — it
   skips nine house guards, every one of which exists because something was lost.

4. **A failed Python heredoc TRUNCATED `TablePage.tsx` to zero bytes.** Recovered
   from the commit. **Use a write-to-temp-then-rename helper that refuses to
   write a suspiciously small file.** Mine is reproduced in §9.

5. **`/tmp/ca_fix` is owned by `nobody`** — another agent's tree. You cannot
   delete it. Do not try to reclaim its space.

6. **The GitHub token in `club-arena/.env` (`GITHUB_TOKEN`) cannot read
   check-runs** (403) or job logs (401 on the blob redirect). Use
   `GET /actions/runs?branch=<branch>` and `/actions/runs/<id>/jobs` instead —
   those work. GraphQL `statusCheckRollup` returns `FAILURE` with **zero
   contexts**, which is useless; do not trust it.

7. **The GitHub MCP (`mcp__github__*`) returned "Bad credentials"** the whole
   session. Use the REST API with the `.env` token via `python3` + `urllib`.
   Helper scripts I used are in §9.

8. **`git clone` needs the right repo name:** `Smarter-Poker-Club-Arena`, not
   `club-arena`. The remote is `git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git`.

9. **Never run git WRITE commands against the mounted worktree from the sandbox**
   (CLAUDE.md §12.4) — the mount cannot `unlink`, so a stranded `.git/index.lock`
   blocks git on Dan's Mac too. Work in a `/tmp` clone.

10. **Bash tool calls hard-cap around 178s.** Anything longer (full test suites,
    `sleep` + poll loops) must be backgrounded with `nohup ... &` and read from
    its log file, or split into chunks.

---

## 8. HOW TO VERIFY A DEPLOY (this repo's rules, and they are not optional)

- **CLIENT** (anything under `src/`): CA `main` → `build-for-world-hub.yml` →
  a `chore(club-arena): sync build <ca-sha>` commit on World Hub `main` → Vercel.
  Confirm the sync's CA sha is **at or ahead of** your commit
  (`GET /compare/<yours>...<sync-sha>` must not say `behind`), then fetch the
  real bundle and grep for a string only your change introduces:
  ```bash
  curl -sL https://smarter.poker/hub/club-arena/index.html -o idx.html
  # find index-*.js, then the largest TablePage-*.js it names, then grep it
  ```
- **SERVER** (`server/**`): `auto-deploy-hetzner.yml` runs on push to `main`.
  Deploys are in a **concurrency group that cancels superseded runs**, so many
  show `cancelled` — that is normal. Wait for a `success` on a sha that is
  `ahead`/`identical` to yours.
- **NEVER** use `https://engine.smarter.poker/health` to verify — it is
  CDN + fetch-cached and frozen (CLAUDE.md §11).
- **DO** confirm behaviourally in Supabase — a restart dip in per-minute hand
  counts:
  ```sql
  select date_trunc('minute', created_at) as minute, count(*) as hands
  from hand_history where created_at > now() - interval '25 minutes'
  group by 1 order by 1;
  ```
  Phase 2's restart was visible as 283 → 129 → **95** → recovering to 216.

**Only claim "deployed" after one of those confirms it.** "Merged" is not
"deployed"; "CI green" is not "deployed".

---

## 9. WORKING SETUP THAT ACTUALLY WORKS (copy-paste)

```bash
# 0. temp dir that is not full  ── DO THIS FIRST, EVERY SESSION
mkdir -p /tmp/tmpdir && export TMPDIR=/tmp/tmpdir

# 1. your own clone (never the mounted worktree)
GT=$(grep '^GITHUB_TOKEN=' /sessions/<you>/mnt/club-arena/.env | cut -d= -f2- | tr -d '"'"'"'\r')
git clone --depth 1 "https://x-access-token:${GT}@github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git" /tmp/ca
cd /tmp/ca
git config user.name "Smarter-Poker"
git config user.email "254329056+Smarter-Poker@users.noreply.github.com"   # REQUIRED: RULE 3, or Vercel BLOCKS the build

# 2. deps (npm ci is ~700MB; if disk is tight, symlink each package from an
#    existing clone but make .tmp/.vite/.vite-temp REAL dirs — see §7.2)
npm ci && (cd server && npm ci)

# 3. verify BEFORE pushing
npx tsc --noEmit -p tsconfig.app.json
(cd server && npx tsc --noEmit -p tsconfig.json)
npx vitest run                       # client: expect ~718 files / ~10,086 tests
(cd server && npx vitest run)        # server: expect ~273 files / ~3,092 tests
node scripts/ci/report-source-grep-tests.mjs --ratchet

# 4. ship
AGENT_SHARED_CLONE_OK=1 git checkout -b phase3/<slug>
AGENT_SHARED_CLONE_OK=1 git add -A
AGENT_SHARED_CLONE_OK=1 git commit -F /dev/stdin <<'MSG'
feat(pineapple): <what changed>
MSG
TMPDIR=/tmp/tmpdir AGENT_SHARED_CLONE_OK=1 git push origin HEAD:phase3/<slug>
```

Safe file editor (use this instead of raw `io.open(p,'w')` — see §7.4):

```python
import io, os, sys
def sub(path, old, new, expect=1):
    s = io.open(path, encoding='utf-8').read()
    n = s.count(old)
    if n != expect:
        sys.exit(f"ABORT {path}: found {n} of anchor, expected {expect}")
    out = s.replace(old, new)
    tmp = path + '.tmp'
    io.open(tmp, 'w', encoding='utf-8').write(out)
    if os.path.getsize(tmp) < 100:
        os.remove(tmp); sys.exit("ABORT: refusing to write a suspiciously small file")
    os.replace(tmp, path)
    print(f"OK {path}: {len(s)} -> {len(out)}")
```

Open a PR + arm auto-merge (GitHub MCP is broken — see §7.7):

```python
import json, os, urllib.request
tok = os.popen("grep '^GITHUB_TOKEN=' /sessions/<you>/mnt/club-arena/.env | cut -d= -f2-").read().strip().strip('"').strip("'")
H = {'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json',
     'User-Agent':'sp-agent', 'Content-Type':'application/json'}
B = 'https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena'
d = json.dumps({'title':TITLE,'head':BRANCH,'base':'main','body':BODY}).encode()
pr = json.load(urllib.request.urlopen(urllib.request.Request(B+'/pulls', data=d, headers=H)))
print(pr['html_url'])
def gql(q,v): return json.load(urllib.request.urlopen(urllib.request.Request(
    'https://api.github.com/graphql', data=json.dumps({'query':q,'variables':v}).encode(), headers=H)))
pid = gql('query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){id}}}',
          {'o':'Smarter-Poker','r':'Smarter-Poker-Club-Arena','n':pr['number']})['data']['repository']['pullRequest']['id']
gql('mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{number}}}', {'id':pid})
```

Read CI results (the only method that works with this token):

```python
r = json.load(urllib.request.urlopen(urllib.request.Request(
    B + f'/actions/runs?branch={urllib.parse.quote(BRANCH)}&per_page=8', headers=H)))
ci = [w for w in r['workflow_runs'] if w['name'].startswith('CI')][0]
jl = json.load(urllib.request.urlopen(urllib.request.Request(
    B + f"/actions/runs/{ci['id']}/jobs?per_page=40", headers=H)))
for j in jl['jobs']:
    if j['conclusion'] not in ('success','skipped',None):
        print(j['name'], [s['name'] for s in j['steps'] if s['conclusion']=='failure'])
```

---

## 10. HOUSE LAWS THAT WILL BITE YOU

- **§10.5 HORSES ARE PLAYERS.** If you type `is_horse` to leave horses OUT of
  something a human gets, you are writing a bug. Timing is part of the treatment
  — the tell is the RHYTHM, not one hand. This is why Phase 3 must animate a
  horse's discard exactly like a human's.
- **§10.6 ANIMATIONS MUST ALWAYS PLAY.** Every animation and its sound, every
  time it is owed, for its full duration, at the player's chosen Animation Speed.
  No new toggle may disable one. `tests/animations-always-play.law.test.ts` (45
  pins) — every pin is a bug that actually shipped. **Never weaken a pin**; if
  you replace a mechanism, move the pin in the same commit.
- **§10.6 NEVER AUTO-CHANGE TABLES.** Alerts yes; moving `activeIndex` without a
  user gesture never.
- **§5.7 POPUPS**: Title Case Every Word, **no em dashes**, go through the Toast
  layer. `check-ui-text` and `check-title-case` run in the pre-push hook.
- **§5.8 NEVER PUSH A RED TEST.** A red client suite stops `sync-to-world-hub`
  for the whole estate. Write the spec first if you like, but commit it
  `it.skip()` with a note and delete the `.skip` in the implementing commit.
- **§11.5 NEVER SPEND REAL CHIPS TO TEST A RULE.** Probe money paths inside a
  transaction you ROLL BACK. Helpers go in `pg_temp`, never `public`.
  **Never DELETE a `table_seats` row** — it skips the refund and destroys chips.
- **No emoji in source.** Breaks the SWC compiler.
- **Commit author MUST be `Smarter-Poker
<254329056+Smarter-Poker@users.noreply.github.com>`** or Vercel refuses to
  build the commit and the deployment goes to BLOCKED with no logs at all.
- **Write your changelog to your OWN file:**
  `docs/changelog/YYYY-MM-DD-<slug>.md`. **Never append to
  `MIGRATION-CHANGELOG.md`** — it is frozen and was the single biggest source of
  merge conflict in the repo.

---

## 11. YOUR FIRST FIVE MOVES

1. `export TMPDIR=/tmp/tmpdir` (§7.1). Clone fresh (§9). Confirm both suites are
   green **before** you change anything, so you know any red is yours.
2. Read `TablePage.tsx:12605` (`case 'PLAYER_ACTION'`) and
   `SeatSlot.tsx` (`cardFoldOut`, ~151 and ~382). That is where 3.1 lives.
3. Build 3.2 first (`playDiscard()` in `SoundService.ts`) — it is small,
   self-contained, and 3.1 needs it.
4. Build 3.1 (the per-seat animation), then 3.3 (the settle beat in
   `handCompletionSpec.ts` + `checkPineappleDiscardsComplete`).
5. Add pins to `tests/animations-always-play.law.test.ts`, run **both** full
   suites plus the two CI gates in §6.1, then ship one PR titled
   `[Phase 3/4]` and **verify the Hetzner deploy behaviourally** (§8).

**Then report to Dan in his format:**

> **Phase 3 of 4 is done** — <summary> — **Ready to start Phase 4 of 4.**

---

## 12. FILE INDEX (everything touched or worth reading)

**Server**

- `server/src/engine/HandController.ts` — `performDiscard` (~930),
  `foldForMissedDiscard` (~990), `owesPineappleDiscard`,
  `checkPineappleDiscardsComplete` (1051), `resolvePendingPineappleDiscards`,
  `dealNextStreet`, `runOutCommunityCards`
- `server/src/engine/pineappleDiscardChoice.ts` — **NEW (Phase 2)**, the one chooser
- `server/src/engine/ServerTableEngineBase.ts` — `pineappleDiscardDeadlines`,
  `armPineappleDiscardSweep`, `pruneSettledPineappleDeadlines`,
  `extendPineappleDiscard`
- `server/src/engine/ServerTableEngineRunout.ts` — `handlePineappleDiscard`
  (horse delay + round open), `submitDiscard`, `broadcastAllInEquity`
- `server/src/engine/ServerTableEngineTurns.ts` — `activateTimeBank` (discard branch)
- `server/src/engine/ServerTableEngine.ts` — `pineappleDiscardSnapshotFields`
- `server/src/engine/HorseLogic.ts` — `decideDiscard` (now delegates)
- `server/src/config/handCompletionSpec.ts` — cadence constants (Phase 3.3)

**Client**

- `src/pages/TablePage.tsx` — `heroEngineCardOrderRef`, `handlePineappleDiscard`
  (~2440), `heroPineappleCards`, the discard-clock effect,
  `handleActivateTimeBank`, `case 'PLAYER_ACTION'` (12605), hole-card
  subscription (`event: '*'`)
- `src/components/table/PineappleDiscard.tsx` / `.css` — the picker
- `src/components/table/SeatSlot.tsx` — `cardFoldOut` muck animation
- `src/utils/mapEngineSnapshot.ts` — `discardDeadline`, `discardDurationMs`
- `src/utils/serverClock.ts` — `serverNow()`, `recordServerTime()`
- `src/services/SoundService.ts` — add `playDiscard()`
- `src/utils/handReplay.ts`, `src/components/table/HandHistoryPanel.tsx` — Phase 4

**Tests**

- `server/src/engine/PineappleDiscardClock.test.ts` (10)
- `server/src/engine/PineappleDiscardChoice.test.ts` (7)
- `server/src/engine/PineappleAllInEquity.test.ts` (4)
- `server/src/engine/PineappleThreeCardShowdown.test.ts` (5)
- `server/src/engine/PineappleDiscardFold.test.ts` (6, pre-existing)
- `tests/pineapple-discard-picks-the-right-card.test.ts` (20)
- `tests/pineapple-discard.test.tsx` (7, pre-existing)
- `tests/animations-always-play.law.test.ts` (45) — **Phase 3 goes here**
- `tests/unit/timeBankSeatFeedbackAndCards.test.ts` — will catch you if you toast
- `tests/helpers/sourceWindow.ts` — use these, never byte counts

**Docs**

- `docs/changelog/2026-08-31-pineapple-discard-picks-the-right-card.md`
- `CLAUDE.md` §10.5, §10.6, §11.5, §12
