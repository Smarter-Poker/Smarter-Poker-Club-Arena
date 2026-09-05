# MILITARY-GRADE CONTINUATION HANDOFF

## Club Arena - Card Presentation Engine, Rabbit Hunt, and the VIP All-In Squeeze

Written 2026-09-05 by the outgoing agent. Paste this whole file into a new chat.
Everything below was verified against the live workspace, the GitHub API, the
production database and the running engine on 2026-09-05 between 17:00 and
19:00 UTC. Anything unverified is labelled.

---

# 1. EXECUTIVE CONTINUATION BRIEF

**What is being built.** Club Arena is the poker client at
`smarter.poker/hub/club-arena` (Vite + React 19 + TS SPA, server-authoritative
Node engine on Hetzner, Supabase for data/auth/realtime). Over the last three
phases a **Card Presentation Engine** was built: a presentation layer that owns
how community cards arrive on the felt (the "river squeeze"), plus the
end-of-hand pacing that gives players time to use **Rabbit Hunt**.

**Current phase.** Three PRs are merged and live. A fourth is open. The next
phase is a NEW feature Dan specified at the end of the last session and which
**has not been started**: making the board squeeze a **VIP-gated, all-in-only,
per-viewer** presentation.

**Most important thing to understand.** There are TWO different things in this
codebase that both get called "squeeze", and confusing them will waste your day:

|              | Hero hole-card peel                                                                     | Board / community "river squeeze"                             |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Where        | `src/components/table/SeatSlot.tsx`                                                     | `src/presentation/cardPresentation/**` + `CommunityCards.tsx` |
| Interactive? | **YES** - real drag/touch peel, `onPointerDown`/`onPointerMove`, `squeezeProgress` 0..1 | **NO** - animation only, zero pointer handlers                |
| Setting      | `card_slide` (default OFF)                                                              | none yet                                                      |

Dan's next feature is about the **board** one, and his questions imply he may
want it to become interactive too. **Ask him to confirm that before building.**

**First action for the next agent.** Section 22. In short: confirm PR #3165
merged, then start Phase A (the VIP all-in squeeze) on a fresh branch off
`origin/main`.

---

# 2. USER REQUIREMENTS AND WORKING PREFERENCES

Dan writes in caps. Treat every capitalised instruction as binding.

## 2.1 Verbatim instructions from this session

1. **"WE HAVEN'T IMPLEMENTED LIGHTNING YET... LEAVE IT ALONE."** Lightning is
   out of scope. The `lightningDesktop` profile exists and its numbers move only
   with shared arithmetic. Do not build Lightning behaviour.
2. **"THIS NEEDS TO BE BUILD AND OPTIMIZED FOR MOBILE, NOT JUST DESK TOP, 95% OF
   USERS WILL BE MOBILE."**
3. **"DO A DEEP DIVE ONLINE HOW THE OTHER ONLINE POKER ROOMS RUN AND PROGRAM
   THIS ANNIMATION SO WE HAVE THE INDUSTRY STANDARD AND AREN'T JUST GUESSING."**
   Research must be sourced, not invented. Two research documents now exist
   (section 6.6).
4. **"IF THERE ARE ANY THAT YOU CONSIDER 'HIGH RISK' FOR DAMAGING CODE OR OTHER
   PAGES, DO NOT BUILD THEM."** Standing rule. Say what you did not build and
   why.
5. **"GOT TO 1.75MS"** - meaning 1.75 SECONDS. He set
   `ALL_IN_STREET_REVEAL_MS` to 1750.
6. **"THIS SAME 1.75MS PAUSE SHOULD BE DONE ON ALL HANDS UPON COMPLETION, GIVE
   USERS A CHANCE TO USE THE RABBIT HUNT."**
7. **"IT NEEDS A DISABLE OR HIDE OPTION IN THE TABLE SETTINGS FOR USERS THAT
   DON'T WANT IT POPPING UP."**
8. **"before you CLAIM SUCCESS, you need to do a deep dive and verify that
   everything you've built ... is 100% fully built, coded, wired in and tested."**
   He asks for adversarial self-audit before every claim of completion. Do it.

## 2.2 THE NEXT FEATURE, verbatim (NOT STARTED)

> "1, IS THE 'RIVER SQUEEZE' JUST AN ANIMATIONS OR DOES IT ALLOW THE USER TO
> ACTUALLY CONTROL THE 'SQUEEZE' ON DESKTOP DRAGGING IT TO 'OPEN' AND MOBILE
> WITH TOUCHING AND SLOWLY SQUEEZING IT? OR IS IT CURRENTLY ALL JUST AN
> ANIMATION ONLY?
>
> 2, THIS FEATURE SHOULD ONLY BE PRESENTED AS AN OPTION AND DISPLAYED ON 'ALL
> INS' (BEFORE THE RIVER OBVIOUSLY) AND SHOULD NEVER APPEAR ON RUN IT 2X OR 3X.
> AND THIS SHOULD BE A VIP GATED PERK AND 'TURNED ON' BY DEFAULT. IF A NONE VIP
> MEMBER TRIES TO TURN IT ON THEY SHOULD BE INSTRUCTED THAT THEY NEED A VIP CARD
> TO USE THIS FEATURE. AND ONLY TO THE USERS THAT ARE 'ALL IN' THE BOARD AND RUN
> OUT SHOULD APPEAR 'NORMAL' AND NO DIFFERENT FOR ANY OTHER USERS AT THE TABLE.
> IF ANY OTHER 'ALL IN PLAYERS' DON'T HAVE VIP, OR HAVE IT 'TURNED OFF' IT
> SHOULD ONLY DISPLAY FOR THE USERS WHO HAVE ACCESS TO IS, AND HAVE IT ENABLED."

**Answer already given to (1): the board squeeze is ANIMATION ONLY.** Verified:
`grep -rn "onPointerDown|onTouchStart|onPointerMove|drag" src/presentation/cardPresentation/`
returns nothing. The hero hole-card peel IS interactive and lives in
`SeatSlot.tsx`.

**Requirement decomposition for (2)** - each is a separate acceptance criterion:

| #   | Requirement                                                                   | Notes / risk                                                             |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Squeeze presentation appears ONLY on all-in run-outs, before the river        | Today the squeeze runs on EVERY turn and river on every hand             |
| R2  | NEVER on Run It 2x or 3x                                                      | RIT already uses a different path (see 6.4) - verify, do not assume      |
| R3  | VIP-gated perk                                                                | Needs a VIP entitlement check; `vipService` exists                       |
| R4  | ON by default (for VIPs)                                                      | New user setting, default true                                           |
| R5  | Non-VIP toggling it on gets told they need a VIP card                         | Upsell toast/modal. **Popup copy rules apply: Title Case, no em dashes** |
| R6  | Shown ONLY to players who are themselves all-in                               | Per-viewer presentation                                                  |
| R7  | Every other player at the table sees a NORMAL board and run-out               | Per-viewer, so the felt must not diverge in any way that leaks           |
| R8  | Two all-in players, one VIP-enabled and one not: only the enabled one sees it | Per-viewer, independent                                                  |

**R6/R7/R8 are the hard part and the reason this is a phase, not a patch.**
The presentation is currently table-global. See section 21 Phase A.

## 2.3 Standing repo rules that bit during this work

- **Never commit on `main`.** Branch in your own worktree, push over SSH, **do
  not open the PR, do not merge, do not watch CI** (CLAUDE.md 10.8.3). Report
  the branch and stop. `agent-open-pr.yml` + `agent-autopilot.yml` do the rest.
- **Animation Law 10.6.** Every animation plays every time it is owed, for its
  full duration. **No new toggle may disable an animation outright.**
  `--animation-speed` is the only sanctioned control. Reduced motion collapses
  motion but never meaning; `data-motion="keep"` is the exemption for
  duration-carrying animation. **R3/R4 above need care here** - see 19.1.
- **10.5 Horses are players.** Never use `is_horse` to exclude a horse from
  anything a human gets. Timing is part of the treatment.
- **10.85** Never create tasks on the Claude scheduler.
- **11.5** Never spend real chips to test a rule; probe inside a self-aborting
  `DO` block, ONE Supabase MCP call.
- **Section 12** Never rebase `main`; `git merge origin/main` for branches.
- **4.5** Never hand-pick a migration version; run
  `node scripts/new-migration.mjs "what it does"`.
- No emoji in source. Never call AI players "bots" - they are **horses**.
- Mobile-first, 375px first.
- Changelogs go in **your own file**: `docs/changelog/YYYY-MM-DD-<slug>.md`.
- Every `*.law.test.*` needs a file in `docs/laws.d/`.
- Do not hand-edit `scripts/ci/supabase-schema-manifest.json`; declare new
  objects in `scripts/ci/schema-manifest.d/<your-branch>.json`.
- **Popups**: Title Case Every Word, em dashes forbidden, via `popupStyle.ts`.

---

# 3. PROJECT AND REPOSITORY IDENTITY

| Field                  | Value                                                     | Confirmed                                 |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Repo                   | `Smarter-Poker/Smarter-Poker-Club-Arena`                  | YES                                       |
| Main clone             | `/Users/smarter.poker/Documents/club-arena`               | YES (was at `63baa1511`, **behind main**) |
| Second connected clone | `/Users/smarter.poker/Documents/Smarter-Poker-Club-Arena` | YES                                       |
| Worktree root          | `~/Documents/.agent-trees/club-arena/<name>`              | YES                                       |
| Branch flow            | branch -> push -> autopilot opens+merges PR               | YES                                       |
| Framework              | Vite + React 19 + TypeScript, React Router v7             | YES                                       |
| Engine                 | Node, `server/`, Hetzner, PM2/Docker                      | YES                                       |
| DB                     | Supabase `kuklfnapbkmacvwxktbh`                           | YES                                       |
| Static origin          | `ca-static.smarter.poker`, served via a World Hub rewrite | YES                                       |
| Test runner            | vitest (happy-dom) + Playwright (chromium)                | YES                                       |

**Environment traps that cost real time:**

- `node` is NOT on the default PATH. Prefix everything:
  `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`
- `mcp__counselors__host_terminal` **kills the process group on timeout**. Long
  jobs must be detached. **`setsid` does not exist on macOS** - use:
  `python3 -c "import os,subprocess
if os.fork()==0:
    os.setsid(); subprocess.call(['/bin/bash','/tmp/job.sh'],stdin=subprocess.DEVNULL); os._exit(0)"`
- `gh` is NOT installed. Use `curl` + `GITHUB_TOKEN` from `~/Documents/club-arena/.env`.
- A new worktree has **no `node_modules`**. Provision with a copy-on-write clone
  (`cp -Rc`) from the main clone, for BOTH `/` and `/server`. `scripts/agent-workspace.sh`
  does this properly; if you create the worktree by hand you must do it yourself.
- **`git commit -F /tmp/msg.txt` picked up ANOTHER agent's stale file.** Use a
  uniquely named message file.
- The pre-push hook takes ~2-3 minutes. Never `--no-verify`.

---

# 4. REPOSITORY MAP (only what matters here)

```
src/presentation/cardPresentation/        THE CARD PRESENTATION ENGINE (new, this project)
  types.ts                CardAnimationProfile, presentation/telemetry types.
                          Header records the frame-by-frame video findings.
                          NEW 2026-09-05: `serverPaced?: boolean`.
  profiles.ts             THE SINGLE SOURCE OF DURATIONS. Every timing lives here.
                          Exports CARD_PRESENTATION_PROFILES, FLIP_CEILING_MS(400),
                          MOBILE_FLIP_MS(300), FLOP_FAN, flipMs().
  CardPresentationEngine.ts  presentCard/complete/cancel/cancelAll/phaseAt/subscribe.
                          Idempotent registry, stale-hand + out-of-order rejection,
                          per-board lane pre-emption, monotonic phase clock.
  resolveProfile.ts       hidden->off, reducedMotion->reduced, allIn, visible->background,
                          mobile, then game mode. detectPlatform() 768/1024 breakpoints.
  SqueezeCard.tsx         Shared markup + squeezeHostProps()/squeezeVars().
  cardSqueeze.css         The reveal stylesheet. Exactly ONE will-change, gated on
                          [data-rs-animating='on'].
  frameSampler.ts         rAF FPS sampler; abandons the sample when the tab hides.
  environmentInterrupts.ts resize/orientation/visibility -> cancelAll.
  engineSingleton.ts      The shared instance (also breaks an import cycle).
  useCardSqueeze.tsx      Hook for non-felt surfaces (replay).
  preload.ts, telemetry.ts, CardPresentationDebug.tsx (?rsDebug, DEV only)

src/components/table/
  CommunityCards.tsx      THE FELT BOARD. Registers every street with the engine.
                          Owns activeSqueezeRef / pendingRevealKeyRef / snapOwedRef.
                          <<< R1/R6/R7 WORK LANDS HERE >>>
  CommunityCards.css      Board styling; ccCardSheen etc.
  RabbitHunt.tsx / .css   The button + reveal request. Asks; renders what it is given.
  SeatSlot.tsx            HERO HOLE CARDS - the INTERACTIVE drag-peel lives here.
  TableSettingsPanel.tsx  Renders every row of TABLE_SETTINGS_META.

src/pages/TablePage.tsx   ~24k lines. hudSlotControl (timebank|rabbit|null),
                          rabbit offer/expiry/freeze state, boardPresentationMode.
src/pages/MultiTablePage.tsx  tile + single view; passes isVisible.
src/hooks/useUserTableSettings.ts  UserTableSettings, DEFAULT_USER_TABLE_SETTINGS,
                          TABLE_SETTINGS_META. THE single owner of the settings list.
src/services/PostgresSyncHooks.ts  USER_TABLE_SETTING_COLUMNS - cross-DEVICE relay
                          allowlist. A new column MUST be added here.
src/config/handCompletionSpec.ts   THE END-OF-HAND CADENCE. Mirrored byte-for-byte at
server/src/config/handCompletionSpec.ts   <- a test pins them equal.
server/src/engine/ServerTableEngineDealing.ts   the dealing loop + the post-hand phases.
server/src/engine/ServerTableEngineRunout.ts    paced all-in run-out + equity gate.
server/src/engine/ServerTableEngineSettlement.ts  rabbit offer capture + emit, 90s TTL.
docs/research/2026-09-05-card-reveal-industry-standards.md   sourced research
docs/changelog/2026-09-05-*.md                              three changelogs
```

---

# 5. APPLICABLE INSTRUCTIONS AND CONSTRAINTS

Read before editing, in this order:

1. `AGENT-PLAYBOOK.md` (repo root) - byte-identical across seven repos. How to
   ship without losing work; where every credential lives.
2. `CLAUDE.md` (repo root) - the binding rules. Sections that governed this
   work: 1.1 (deploy path), 4.5 (migrations), 5.8 (never push a red test),
   10.5 (horses), **10.6 (animation law)**, 10.8 (laws + never watch CI),
   10.85 (no Claude scheduler), 10.9 (you decide the money), 11.0 (which
   environment), 11.5 (never spend real chips), 12 (never rebase main),
   13 (the hourly :55 maintenance break).
3. `.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md` -
   wins over CLAUDE.md if they conflict.
4. `docs/changelog/README.md` - why changelogs are per-file.
5. `scripts/ci/schema-manifest.d/README.md` - how to declare new DB objects.

**Known ambiguity you will hit:** CLAUDE.md 10.6 forbids "a toggle that disables
an animation outright". Dan is now asking for a VIP-gated, per-user toggle on the
squeeze. These are reconcilable and the reasoning is in 19.1 - but **write the
reconciliation down in the PR**, because the next agent after you will read 10.6
and think you broke it.

---

# 6. COMPLETE DISCOVERY RECORD

## 6.1 How a card reaches the felt

The Hetzner engine is authoritative. It broadcasts state; the client only
decides HOW to show it. `CommunityCards.tsx` diffs the board against the last
render, and for each newly-visible slot calls
`cardPresentationEngine.presentCard(event, input)`. The engine returns a
`PresentResult` with a `durationMs` (the profile's duration **plus a 100ms
`MOUNT_WINDOW_MARGIN_MS`**) and drives a phase clock
(`prepare -> hold -> squeeze -> reveal -> settle -> complete`). The component
keeps the squeeze markup mounted for that window.

**The resting transform is FACE UP.** An interrupted or collapsed animation
therefore leaves a correct board. This is load-bearing; do not change it.

## 6.2 The end-of-hand cadence

`handCompletionSpec.ts` is the shared contract, mirrored into the engine because
`server/tsconfig.json` sets `rootDir ./src` so the engine cannot import the app's
copy. **A test pins the two files byte-for-byte equal.** Change one, change both.

`handCompletionHoldMs(opts)` has exactly one job: **be at least as long as the
animations it is holding for.** Every constant in it is derived from an
animation length. Do not put anything else in it.

The dealing loop (`ServerTableEngineDealing.ts`, around line 916-946):

```
setLoopPhase('post_hand_hold');
await sleep(resultDisplayMs);        // beats 1-4: showdown read, sweep, pot push, muck, 1s rest
broadcastCurrentState();             // <- clean state; isHandInProgress goes FALSE here
await sleep(boardClearMs(showdown)); // 500ms fold / 900ms showdown
setLoopPhase('post_hand_rabbit_window');
await sleep(HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS);   // 1750ms  <- NEW
// rebuy pause (5s) if anyone busted
// next hand
```

## 6.3 The Rabbit Hunt defect that was fixed (read this, it generalises)

The button had TWO generous guards - a 90s server offer TTL
(`RABBIT_HUNT_OFFER_TTL_MS`) and a 2s client minimum-visible floor
(`RABBIT_MIN_VISIBLE_MS`) - and **both were measuring a clock the player could
not see.** The button renders behind `!tableState.isHandInProgress`, and the
engine did not broadcast a hand-free state until the whole completion hold had
elapsed. The offer arrives at SETTLEMENT, near the top of that hold. So the
button was live and invisible for 4.5-7.4 seconds and then visible for
`boardClearMs` and nothing else - **500ms on a fold.**

The lesson: a guard on a piece of UI is worthless if a DIFFERENT gate controls
whether the UI is on screen at all. Check the render gate before trusting a timer.

## 6.4 Run It Twice does NOT use the all-in profile (verified)

`TablePage.tsx:21119`: `slowReveal = allInEquities.length > 0`, and
`allInEquities` is cleared 500ms after HAND_COMPLETE (`:15199-15201`). The RIT
reveal therefore runs on the cash/mobile profile at `RIT_STREET_MS` (1400ms per
street), not on the 1750ms all-in profile. **This is why R2 ("never on RIT") may
already be half-satisfied - but it is satisfied by an accident of state
ordering, not by an explicit rule. Phase A should make it explicit.**

Separately, RIT is **never offered a rabbit hunt at all**
(`ServerTableEngineSettlement.ts`, ~line 400): on a RIT hand the shared
`communityCards` prefix reads as a short board, so the naive check would offer
five cards of deck noise. There is an explicit guard.

## 6.5 The equity gate, and why animation speed is dangerous here

`ALL_IN_STREET_REVEAL_MS` exists to stop a spoiler. Dan 2026-08-28: **"EQUITY
CHANGES ONLY AFTER THE FLOP IS DISPLAYED, (NOT BEFORE OR DURING)."** The engine
opens the gate a fixed wall-clock interval after sending the street, and **the
server cannot know a client's `--animation-speed`.** So any client-side reveal
that must finish inside a server-timed window has to clamp its speed to `<= 1`.
The repo already states this for the RIT timeline in `handCompletionSpec.ts`
and already does it twice in `TablePage.tsx` via `Math.min(1, getAnimationSpeed())`.
As of PR #3165 the all-in card profile carries `serverPaced: true` and both the
JS window and the CSS are clamped.

**If Phase A adds an INTERACTIVE squeeze, this is the single biggest hazard:**
a player dragging a card open at their own pace cannot be allowed to outrun the
equity gate, or they will see the percentages before their own card. Plan for
it up front.

## 6.6 Research already done - do not redo it

- `docs/research/2026-09-05-card-reveal-industry-standards.md` (in the repo).
  Key: **nobody in poker publishes timings**; the numbers come from the
  Material 3 duration ladder - 400ms ceiling, **mobile 300ms vs desktop
  150-200ms** (mobile is the LONGER one).
- `docs/research/2026-09-05-rabbit-hunt-industry-standards.md` (in the repo).
  Every claim carries its URL and an OFFICIAL/MEDIA/COMMUNITY confidence tag.
  Summarised in section 6.7.

## 6.7 Rabbit Hunt competitive findings (sourced)

| Room                 | Has it                                                                       | Cost                                        | Who sees                             | Notes                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| GGPoker / Natural8   | YES                                                                          | none published                              | **EVERYONE at the table** (OFFICIAL) | Has a dedicated **HOTKEY** for it                                                                                    |
| WPT Global           | YES                                                                          | **flat $0.01** (OFFICIAL)                   | not published                        | Click a **rabbit-backed board card**, no button                                                                      |
| ClubWPT Gold         | YES                                                                          | chips, price on the button                  | not published                        | **Also usable later in the hand replayer**                                                                           |
| Winamax ("Reveal")   | YES                                                                          | free                                        | not published                        | Cards land **face down on the board, you click to flip**; window ends at the next deal; MTT+cash; Hold'em/Omaha only |
| PokerStars           | YES (beta 2024 -> cash Oct 2024)                                             | not published                               | not published                        | 2025: window **lengthened**, and restricted to **hands that reach the flop**                                         |
| partypoker           | YES                                                                          | Diamonds (earned)                           | not published                        | Click **your own hole cards**                                                                                        |
| 888poker             | **UNCONFIRMED** - one passing media mention, contradicted by 888's own pages |                                             |                                      | Two search-engine "quotes" proved to be confabulations                                                               |
| Americas Cardroom    | **NO EVIDENCE**                                                              |                                             |                                      | Its own glossary says "most online platforms don't allow it"                                                         |
| PokerBros            | "**Rabbit Cams**"                                                            | per-player consumable sent by club managers |                                      |                                                                                                                      |
| ClubGG               | YES                                                                          | subscription tier benefit                   |                                      |                                                                                                                      |
| PPPoker / X-Poker    | YES                                                                          | Diamonds / VIP card tiers                   |                                      | **X-Poker gates it behind a VIP card - the same model Dan is asking for**                                            |
| EvenBet (B2B vendor) | YES                                                                          | -                                           | -                                    | The ONLY vendor documenting a **dedicated inter-hand break** for rabbit hunting, and a per-table enable              |

**Findings that matter for us:**

1. **No room publishes a countdown duration.** Our 1750ms window is a design
   decision and cannot be defended as "parity" - but nothing contradicts it.
2. **We are AHEAD on two axes:** an explicit user hide/disable toggle (found at
   no major room except one unverified iPoker claim), and an unconditional
   inter-hand rest (only EvenBet documents anything similar, and theirs is
   conditional, which leaks).
3. **We differ from GGPoker on WHO SEES IT.** GG shows the cards to the whole
   table. Ours shows only the buyer - **Dan's explicit 2026-08-25 ruling:
   "These should ONLY APPEAR TO THE PLAYER WHO CLICKED."** Ours is also the
   safer choice: live poker bans rabbit hunting specifically because it leaks
   information. Do not "fix" this toward GG.
4. **Parity gap we do NOT have: a hotkey.** GGPoker's answer to the short-window
   problem for multi-tablers is a mappable Rabbit Hunt hotkey. Cheap, and the
   industry's actual solution. **Recommended, not built.**
5. **Differentiator we do NOT have: the replayer path.** ClubWPT Gold lets you
   rabbit hunt later from the hand replayer, so missing the window is not final.
   We already have a `HandReplay` component and a 90-second server offer TTL, so
   this is closer than it looks. **Recommended, not built.**
6. **Complaints that the window is too short: NOT FOUND anywhere**, despite
   targeted searching. Dan's report is ahead of the public record.

---

# 7. WORK COMPLETED DURING THIS CHAT

Three workstreams. All CONFIRMED COMPLETE unless stated.

## 7.1 Workstream A - mobile optimisation and the retime (PR #3149, squash `54bdd042f`, MERGED + PUBLISHED)

- **Every profile retimed off the Material 3 ladder.** The old table had desktop
  at a 480ms flip (over the published 400ms ceiling) and mobile at 320ms (the
  shortest in the file, on the platform 95% of players use). Both backwards.
  Now: cash desktop 300ms total, mobile 350ms, tournament 350ms, replay 500ms,
  spectator 300ms, background 180ms, reduced 150ms. `FLIP_CEILING_MS` and
  `MOBILE_FLIP_MS` exported and pinned.
- **`will-change` reduced to one gated rule.** `TablePage.css` was
  blanket-promoting `.community-cards__card` under
  `@media (max-width: 768px) and (pointer: coarse)` - a permanent compositor
  layer per board card, 20 of them in a four-up tile view, on the weakest
  devices. Removed. `cardSqueeze.css` now has exactly one `will-change`, gated
  on `[data-rs-animating='on']`.
- **`ccCardSheen` converted from animating `left` to `transform: translateX`.**
- **Dead `ccCardFlip3D` keyframe and `.community-cards__card--dealing` deleted**
  (they also animated `left`). Verified no dangling references remain.
- **rAF frame sampler abandons its sample on `visibilitychange`** when hidden -
  rAF pauses in a background tab, so a sample spanning a backgrounding reported
  a healthy phone as degraded.
- **Reduced motion converted from `animation: none` to a `ccCardCrossFade`.**
- **New `tests/e2e/card-squeeze-mobile.spec.ts`** under `devices['iPhone 13']`,
  wired into `ci.yml` and `post-deploy-e2e.yml`.
- **New `docs/research/2026-09-05-card-reveal-industry-standards.md`.**

## 7.2 Workstream B - the 1.75s rest and the Rabbit Hunt window (PR #3152, squash `4d0403042`, MERGED + PUBLISHED + **LIVE ON THE ENGINE**)

- **`ALL_IN_STREET_REVEAL_MS: 1250 -> 1750`** in both mirrors. The all-in card
  profile derives its face-down HOLD from the constant, so the extra 500ms lands
  entirely on the tension beat; the flip stays 300ms.
- **New `HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS = 1750`**, slept by the engine as
  a new loop phase `post_hand_rabbit_window`, AFTER the hand-free broadcast and
  the board clear. Visible window 500ms -> 2250ms (fold), 900ms -> 2650ms
  (showdown).
  - Deliberately NOT inside `handCompletionHoldMs` (that function's numbers are
    all animation-derived; this one is human-reaction-derived).
  - Deliberately UNCONDITIONAL: a rest that only happened when a rabbit hunt was
    purchasable would tell the whole table, from rhythm alone, that the deck
    still had cards in it. Same reasoning as the rebuy pause under 10.5.
- **New user setting `rabbit_hunt_button`**, default true, with a
  `TABLE_SETTINGS_META` row (so it appears in all three settings surfaces) and a
  `hudSlotControl` gate. Migration
  `20260905172514_user_table_settings_gain_the_rabbit_hunt_button_toggle.sql`,
  **applied to production and verified** (`boolean`, `NOT NULL`, `DEFAULT true`).
  Declared in `scripts/ci/schema-manifest.d/rabbit-hunt-window.json`.
- Two stale code comments in `TablePage.tsx` rewritten - the previous note had
  diagnosed the short window as an unavoidable cost and pointed the next agent
  at the wrong file.
- **New `tests/unit/rabbitHuntHasTimeToClick.test.ts`** (9 tests). Two were run
  against the pre-fix engine and both failed.

## 7.3 Workstream C - the adversarial audit and its four fixes (PR #3165, `a2e2ca668`, **OPEN AT TIME OF WRITING**)

An adversarial audit of A and B. Four defects, two of them ours:

1. **HIGH - the new setting never reached a second device.**
   `src/services/PostgresSyncHooks.ts` holds `USER_TABLE_SETTING_COLUMNS`, a
   hardcoded relay allowlist whose own comment says "the subscription below only
   relays columns named in this array". `rabbit_hunt_button` was missing, so
   turning the button off on a phone left it on on a laptop until a full reload.
   Direct miss against Dan 2026-08-28 ("THEY NEED TO SAVE GLOBALLY IN REAL TIME
   ON ALL TABLES, AND ALL PAGES"). **Fixed, and the pin now asserts EVERY key of
   `DEFAULT_USER_TABLE_SETTINGS` is on the allowlist so it cannot drift again.**
2. **MEDIUM - raising the all-in gap widened Dan's own equity-spoiler bug.**
   See 6.5. At Animation Speed = Slow (1.5x) the card was face up at 2344ms
   against a gate at 1750ms - 594ms of spoiler, up from 344ms at the old 1250.
   **Fixed** with `serverPaced: true` on the all-in profile + `Math.min(1, speed)`
   in the engine + `--animation-speed: min(1, var(--animation-speed, 1))` in
   `squeezeVars`. Both sides clamped; clamping only one would tear the markup
   out mid-turn.
3. **MEDIUM** - `tests/user-table-settings-defaults.test.ts` claims "Every
   boolean is pinned below" but iterates a hand-written map, so the omission
   passed silently. Key added.
4. **LOW** - reduced motion crushed the new cross-fade.
   `src/styles/reducedMotion.css` sets `animation-duration: 1ms !important` on
   everything not `[data-motion='keep']`, at higher specificity, so the fade
   finished instantly while the engine held the markup for 150ms. **Fixed** with
   `data-motion="keep"` - the exemption that stylesheet publishes and the one
   10.6 names for duration-carrying animation.
   Also: stale "1250ms" comment in `ServerTableEngineRunout.ts`; the
   "all 12 table settings toggles" header against a list of 14.

- **New `tests/unit/rabbitAuditFollowups.test.ts`** (5 tests). **All five were
  run against the pre-fix tree and all five failed.**

---

# 8. VISUAL AND PRODUCT DECISIONS

**Locked.** Derived frame-by-frame from Dan's `RIVER SQUEEZE ANIMATION.MOV`
(30fps) and recorded in the header of `types.ts`:

- The card materialises **FACE DOWN in an already-reserved slot** and holds
  there. **The board never shifts.** `.community-cards__slot-reserve`
  (`visibility: hidden`) holds the geometry.
- The reveal is a **rotateY flip, not a scaleX squash** - a dark edge appears on
  the left at the turn. Two-surface `preserve-3d` box, `backface-visibility: hidden`.
- Keyframes: 37.5% `rotateY(90deg)`, 75% `rotateY(180deg)`, 90% micro-overshoot.
- **Resting transform is FACE UP.** Non-negotiable: it is what makes every
  interrupt path leave a correct board.
- Sound is **owed at the street and paid at the reveal beat**, never at the deal.

**Timing table (base ms at animation speed 1), prepare / flip / total:**
cash-desktop 50/250/300 - tournament 50/300/350 - lightning 50/200/250 -
replay 100/400/500 - spectator 50/250/300 - **mobile 50/300/350** -
background 30/150/180 - reduced 0/150/150 - off 0/0/0.
All-in: prepare 100, squeeze 113, reveal 112, settle 75, **hold derived** =
`ALL_IN_STREET_REVEAL_MS - 400` = 1350, total 1750.

**Rejected / obsolete - do not restore:** the original spec's suggested defaults
(the spec itself called them "initial defaults only... tune after testing");
`ccTurnReveal`, `ccRiverReveal`, `--cc-turn-duration`, `--cc-river-duration`,
`ccCardFlip3D`, `.community-cards__card--dealing`, and the `skip_animations`
setting (dead and stays dead per 10.6).

---

# 9. FUNCTIONAL AND ARCHITECTURAL DECISIONS

| Decision                                                                            | State                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Presentation layer never touches poker state                                        | IMPLEMENTED, load-bearing                              |
| Board never shifts; slot reserved before the card lands                             | IMPLEMENTED                                            |
| Resting transform face up                                                           | IMPLEMENTED                                            |
| Profiles immutable, resolved by priority (hidden/reduced/allIn/visible/mobile/mode) | IMPLEMENTED                                            |
| Idempotent registry; stale-hand and out-of-order rejection                          | IMPLEMENTED                                            |
| Per-board lane pre-emption                                                          | IMPLEMENTED                                            |
| Cancel unmounts markup (resize, orientation, backgrounding)                         | IMPLEMENTED                                            |
| All-in reveal is server-paced and clamps to speed <= 1                              | IMPLEMENTED (PR #3165, open)                           |
| 1750ms unconditional post-hand rest                                                 | IMPLEMENTED + LIVE                                     |
| Rabbit Hunt cards go ONLY to the buyer                                              | IMPLEMENTED (Dan's ruling; differs from GGPoker)       |
| Rabbit Hunt never offered on a RIT hand                                             | IMPLEMENTED (explicit server guard)                    |
| `rabbit_hunt_button` user setting hides the button only                             | IMPLEMENTED                                            |
| The setting must NOT shorten the pause                                              | IMPLEMENTED + pinned by test                           |
| **Squeeze only on all-ins (R1)**                                                    | **NOT STARTED**                                        |
| **Never on RIT (R2)**                                                               | **ACCIDENTALLY TRUE via state ordering; not explicit** |
| **VIP gating (R3/R5)**                                                              | **NOT STARTED**                                        |
| **Per-viewer presentation (R6/R7/R8)**                                              | **NOT STARTED - the hard part**                        |
| **Interactive drag/touch squeeze on the BOARD**                                     | **NOT STARTED; Dan has not confirmed he wants it**     |
| Rabbit Hunt hotkey (GGPoker parity)                                                 | NOT STARTED, recommended                               |
| Rabbit Hunt from the hand replayer (ClubWPT Gold parity)                            | NOT STARTED, recommended                               |

---

# 10. EXACT CURRENT STATE (verified 2026-09-05 ~19:00 UTC)

- `origin/main` = `aa6b6387a fix(table): the offer engine holds no money...(#3162)`
- **Live bundle** `curl -s https://smarter.poker/hub/club-arena/build-info.json`
  -> `ca_sha aa6b6387a`, built `2026-09-05T18:46:07Z`. **Workstreams A and B are
  published.**
- **Engine** `curl -s https://engine.smarter.poker/health` -> `version 51f67092`,
  191 active tables. `4d0403042` is an ancestor of `51f67092c`, so **the 1750ms
  rest and the 1750ms all-in gap are LIVE on the engine.**
- PRs: **#3149 MERGED** (`54bdd042f`), **#3152 MERGED** (`4d0403042`),
  **#3165 OPEN** (`fix/rabbit-audit-followups`, head `a2e2ca668`).
- **The main clone `~/Documents/club-arena` is at `63baa1511`, well behind
  `origin/main`.** Do not audit code in it without fetching first - an earlier
  audit in this session nearly analysed code that did not exist.
- **`~/Documents/.agent-trees/club-arena/cpe-river-squeeze-2` is BROKEN**
  (`fatal: not a git repository: .../worktrees/cpe-river-squeeze-2`). It is a
  connected folder in the Cowork session, which is confusing. Ignore it or
  `git worktree prune`.
- Worktrees created this session (all pushed, all disposable):
  `cpe-mobile`, `rabbit`, `rabbit-fix`.
- No dev server, preview or background process left running by this work.

## 10.1 The engine deploy schedule - NOT a defect, do not "fix" it

The engine does **not** deploy on merge. Dan 2026-08-31: "THE ENGINE RESTARTS AT
7AM AND 7PM. NOT WHEN CODE MERGES", revised 2026-09-01 to **every hour inside
the announced `:55` maintenance break**. `auto-deploy-hetzner.yml` runs on
`cron: '35 * * * *'`. It also **coalesces** when the engine restarted less than
`MIN_RESTART_SPACING_SEC=1200` ago and is healthy - such a run finishes GREEN
having shipped nothing, and says so with a `::warning title=NOT DEPLOYED::`
annotation and a "DID NOT DEPLOY" step. **A green run is not a deploy.** Check
`/health.version` against `origin/main`, always.

---

# 11. CHANGED-FILE LEDGER

| File                                                                               | Status | Purpose      | What changed                                                            | Verified                 | Committed    |
| ---------------------------------------------------------------------------------- | ------ | ------------ | ----------------------------------------------------------------------- | ------------------------ | ------------ |
| `src/presentation/cardPresentation/profiles.ts`                                    | M      | durations    | full retime; FLIP_CEILING_MS/MOBILE_FLIP_MS; `serverPaced` on allIn     | tests                    | #3149, #3165 |
| `.../types.ts`                                                                     | M      | types        | added `serverPaced?: boolean` + rationale                               | tsc                      | #3165        |
| `.../CardPresentationEngine.ts`                                                    | M      | engine       | clamp `s` for server-paced profiles                                     | test                     | #3165        |
| `.../SqueezeCard.tsx`                                                              | M      | markup       | `data-rs-3d`/`data-rs-animating`; `data-motion="keep"`; CSS speed clamp | tests                    | #3149, #3165 |
| `.../cardSqueeze.css`                                                              | M      | stylesheet   | one gated will-change; cross-fade reduced-motion                        | e2e                      | #3149        |
| `.../frameSampler.ts`                                                              | M      | fps          | abandon sample when hidden                                              | test                     | #3149        |
| `src/components/table/CommunityCards.css`                                          | M      | board        | ccCardSheen -> transform; dead rules deleted                            | e2e                      | #3149        |
| `src/components/table/CommunityCards.tsx`                                          | M      | board        | speed-scaled flop stagger                                               | tests                    | #3149        |
| `src/components/table/TableSettingsPanel.tsx`                                      | M      | settings UI  | header no longer claims a count                                         | tsc                      | #3165        |
| `src/pages/TablePage.css`                                                          | M      | felt         | removed board card from blanket will-change                             | e2e                      | #3149        |
| `src/pages/TablePage.tsx`                                                          | M      | felt         | `rabbit_hunt_button` gate; two comments rewritten                       | tests                    | #3152        |
| `src/hooks/useUserTableSettings.ts`                                                | M      | settings     | new key, default, META row, load mapping                                | tests                    | #3152        |
| `src/services/PostgresSyncHooks.ts`                                                | M      | cross-device | added `rabbit_hunt_button` to the relay allowlist                       | test                     | #3165        |
| `src/config/handCompletionSpec.ts`                                                 | M      | cadence      | `RABBIT_HUNT_WINDOW_MS`; ALL_IN 1750                                    | tests                    | #3152        |
| `server/src/config/handCompletionSpec.ts`                                          | M      | mirror       | byte-identical copy                                                     | mirror test              | #3152        |
| `server/src/engine/ServerTableEngineDealing.ts`                                    | M      | dealing loop | new `post_hand_rabbit_window` phase                                     | tests                    | #3152        |
| `server/src/engine/ServerTableEngineRunout.ts`                                     | M      | run-out      | stale 1250ms comment                                                    | tsc                      | #3165        |
| `supabase/migrations/20260905172514_...sql`                                        | A      | schema       | `rabbit_hunt_button` column                                             | **applied to prod**      | #3152        |
| `scripts/ci/schema-manifest.d/rabbit-hunt-window.json`                             | A      | CI           | declares the new column                                                 | CI                       | #3152        |
| `tests/unit/rabbitHuntHasTimeToClick.test.ts`                                      | A      | pins         | 9 tests                                                                 | 2 proven pre-fix         | #3152        |
| `tests/unit/rabbitAuditFollowups.test.ts`                                          | A      | pins         | 5 tests                                                                 | **all 5 proven pre-fix** | #3165        |
| `tests/e2e/card-squeeze-mobile.spec.ts`                                            | A      | e2e          | iPhone 13 cascade                                                       | 5 pass                   | #3149        |
| `tests/user-table-settings-defaults.test.ts`                                       | M      | guard        | added the new key                                                       | test                     | #3165        |
| `tests/e2e/live-animations.spec.ts`                                                | M      | e2e          | retimed pins                                                            | e2e                      | #3149        |
| `tests/unit/cardPresentation/{profiles,riverSqueezeStylesheet,auditFixes}.test.ts` | M      | pins         | moved with the retime                                                   | tests                    | #3149        |
| `.github/workflows/{ci,post-deploy-e2e}.yml`                                       | M      | CI           | wire the mobile spec                                                    | CI                       | #3149        |
| `docs/research/2026-09-05-card-reveal-industry-standards.md`                       | A      | research     | sourced timings                                                         | -                        | #3149        |
| `docs/changelog/2026-09-05-*.md` (3 files)                                         | A      | record       | one per workstream                                                      | -                        | all          |

**Warning about unrelated churn.** A broad Prettier run at some point reformatted
**37 test files** this work never touched. They were reverted before committing.
If you see a diff spanning dozens of unrelated test files, it is formatting
churn, it is not yours, and committing it will conflict with every other agent's
branch. Revert it.

---

# 12. ASSET LEDGER

| Asset                         | Path                                     | Purpose                       | Approved     | Implemented                                 | Tracked                     |
| ----------------------------- | ---------------------------------------- | ----------------------------- | ------------ | ------------------------------------------- | --------------------------- |
| `RIVER SQUEEZE ANIMATION.MOV` | uploaded to the session (uploads folder) | THE reference for the squeeze | YES (Dan)    | findings transcribed into `types.ts` header | **NO - session-local only** |
| Rabbit Hunt button art        | via `useButtonImage`                     | the HUD button                | pre-existing | YES                                         | YES                         |

**RISK:** the reference video exists only in the outgoing session's uploads
folder. Its findings are preserved in the `types.ts` header (frame numbers and
timings), but **the file itself will be lost.** If the animation is ever
re-derived, ask Dan to re-upload it.

---

# 13. COMMANDS AND TOOLS USED

| Command                                                                            | Dir              | Purpose                     | Result                          | Rerun?                      |
| ---------------------------------------------------------------------------------- | ---------------- | --------------------------- | ------------------------------- | --------------------------- |
| `npx tsc --noEmit`                                                                 | repo + `server/` | typecheck                   | exit 0 both                     | yes, always                 |
| `npx vitest run`                                                                   | repo             | full client suite           | **14,042 passed / 1,017 files** | yes                         |
| `npx vitest run`                                                                   | `server/`        | engine suite                | **5,739 passed / 399 files**    | yes                         |
| `npm run build:ci`                                                                 | repo             | production bundle           | exit 0                          | yes                         |
| `npx playwright test <specs> --project=chromium`                                   | repo             | e2e vs a local build        | 55/55 then 44/44                | yes                         |
| `node scripts/new-migration.mjs "<what>"`                                          | repo             | reserve a migration version | reserved `20260905172514`       | **always, never hand-pick** |
| `git worktree add -b <branch> ~/Documents/.agent-trees/club-arena/<n> origin/main` | main clone       | isolated tree               | ok (~50s, detach it)            | as needed                   |
| `git merge origin/main --no-edit`                                                  | worktree         | stay current                | ok                              | before push                 |
| `git push origin HEAD:refs/heads/<branch>`                                         | worktree         | ship                        | autopilot opens the PR          | **your job ends here**      |

**Playwright pattern that works:** build, copy `dist` to `/tmp/<x>/hub/club-arena`,
serve with `npx http-server -p <port>`, run with
`ARENA_BASE_URL=http://localhost:<port>/hub/club-arena CI=1`.

---

# 14. VERIFICATION AND TEST RESULTS

| Verification                                | Method                                              | Result                              | Phase      | Follow-up                                                   |
| ------------------------------------------- | --------------------------------------------------- | ----------------------------------- | ---------- | ----------------------------------------------------------- |
| Client typecheck                            | `npx tsc --noEmit`                                  | **PASS**                            | all three  | -                                                           |
| Engine typecheck                            | `npx tsc --noEmit` in `server/`                     | **PASS**                            | B, C       | -                                                           |
| Client unit/integration                     | `npx vitest run`                                    | **PASS 14,042**                     | C (latest) | -                                                           |
| Engine tests                                | `npx vitest run` in `server/`                       | **PASS 5,739 / 399 files**          | B          | -                                                           |
| Production build                            | `npm run build:ci`                                  | **PASS**                            | all three  | -                                                           |
| e2e (6 specs incl. mobile)                  | Playwright chromium vs local build                  | **55/55 PASS**                      | A          | -                                                           |
| e2e (5 specs)                               | Playwright chromium vs local build                  | **44/44 PASS**                      | B          | -                                                           |
| Pre-fix failure proof (rabbit window)       | revert engine file, run pins                        | **2 of 9 failed as designed**       | B          | -                                                           |
| Pre-fix failure proof (audit fixes)         | revert 5 source files, run pins                     | **5 of 5 failed as designed**       | C          | -                                                           |
| Migration applied                           | Supabase MCP + `information_schema`                 | **boolean, NOT NULL, DEFAULT true** | B          | -                                                           |
| Published bundle                            | `build-info.json` vs `git merge-base --is-ancestor` | **PUBLISHED**                       | A, B       | -                                                           |
| Engine carries the change                   | `/health.version` vs main ancestry                  | **LIVE (`51f67092`)**               | B          | -                                                           |
| **e2e for PR #3165**                        | -                                                   | **NOT RUN**                         | C          | low risk (no CSS/DOM shape change); CI's e2e gate covers it |
| **Manual play-through on a real table**     | -                                                   | **NEVER DONE**                      | all        | **see 16 / P2**                                             |
| **Reduced-motion visual check on a device** | -                                                   | **NOT DONE**                        | A, C       | asserted in code, not seen                                  |
| **Cross-device settings sync check**        | -                                                   | **NOT DONE**                        | C          | fix is pinned by test, not observed live                    |

**Known environmental noise:** in a worktree without `sharp` installed,
`tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts` fails to
load. CI installs it. Also `tests/a-union-lead-needs-no-club.law.test.ts` can
time out at 5s under parallel load and passes in isolation - a flake, not a
regression.

---

# 15. SETBACKS, FAILED APPROACHES, AND LESSONS

1. **A broad Prettier run polluted the tree with 37 unrelated reformatted test
   files.** Caught at `git status` before committing. **Always read the full
   `git status` before `git add -A`.**
2. **`git commit -F /tmp/msg.txt` picked up another agent's stale message file**
   and committed with a completely unrelated subject. Fixed by amending. **Use a
   uniquely named message file.**
3. **`nohup setsid ... &` silently does nothing on macOS** - `setsid` is not a
   macOS command, so a detached verification run never started and left no log.
   Use the `python3` fork/setsid pattern.
4. **A new worktree has no `node_modules`** and vitest fails at config load with
   a confusing `Cannot find package 'vitest'`. Provision first.
5. **An e2e assertion used `document.getAnimations()` under reduced motion** and
   got `[]`, because the global rule collapses durations to ~1ms so the animation
   had finished. **Assert the computed `animation-name`, not the running list.**
6. **A test asserted `PresentResult.durationMs <= ALL_IN_STREET_REVEAL_MS` and
   failed at 1850 vs 1750** - `durationMs` deliberately carries a 100ms
   `MOUNT_WINDOW_MARGIN_MS`. Assert the **phase clock**, not the mount window.
7. **An earlier audit nearly analysed code that does not exist** because the main
   clone was behind `origin/main`. Fetch, or `git archive origin/main` to a
   scratch tree, before auditing.
8. **Search-engine result summaries fabricated specific, checkable, false facts**
   during the competitive research (a confabulated 888poker sentence attributed
   to two pages that do not contain it). Several key competitor pages are
   JS-rendered and invisible to plain fetching. **Render the page; do not trust
   the summary.**
9. **A green `auto-deploy-hetzner` run is not a deploy.** It coalesces and says
   "DID NOT DEPLOY". Verify `/health.version`.

---

# 16. KNOWN DEFECTS AND ARCHITECTURAL HOLES

| P   | Defect / hole                                                                  | Evidence                                                              | Impact                                                                             | Recommended fix                                                                                                 | Status                                                         |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P1  | **Rabbit reveal freezes the client snapshot for a blunt 3000ms**               | `handleRabbitReveal` sets `rabbitHuntFreezeEnd = Date.now() + 3000`   | A late click bleeds up to ~3s into the next hand and can cost the hero action time | Paint the ghost cards over a RETAINED copy of the finished board instead of freezing the live snapshot pipeline | **OPEN.** Pre-existing, unchanged by this work. Its own commit |
| P2  | **Nothing here has been played on a real table**                               | no manual verification recorded                                       | Timing/feel bugs invisible to unit and e2e tests                                   | Dan or an agent plays a session and watches the 1750ms rest, the all-in run-out, and the rabbit button          | **OPEN**                                                       |
| P3  | The 1750ms rest costs about **-7.6% hands/hour**                               | measured: 16,359 hand gaps, 607 tables, 45 min -> median gap 21,325ms | Rake follows hands dealt                                                           | None. Dan asked for it knowingly; the number is in the changelog                                                | **ACCEPTED**                                                   |
| P4  | **No Rabbit Hunt hotkey**                                                      | GGPoker publishes one, aimed at multi-tablers                         | Multi-tablers still miss the window                                                | Add a mappable hotkey                                                                                           | **OPEN, recommended**                                          |
| P5  | **No rabbit hunt from the hand replayer**                                      | ClubWPT Gold documents it; we have `HandReplay` and a 90s server TTL  | Missing the window is final                                                        | Wire the replayer to `POST /rabbit-hunt`                                                                        | **OPEN, recommended**                                          |
| P6  | `TableSettingsPanel` header drift                                              | it claimed "all 12" against 14                                        | doc-only                                                                           | fixed in #3165                                                                                                  | **FIXED**                                                      |
| P7  | The engine can restart off the `:55` schedule                                  | observed a restart at ~18:26 UTC                                      | interacts with the deploy coalescing gate and can starve a deploy                  | Not investigated. **Platform-level, not this project**                                                          | **UNKNOWN, needs inspection**                                  |
| P8  | `~/Documents/.agent-trees/club-arena/cpe-river-squeeze-2` is a broken worktree | `fatal: not a git repository`                                         | confuses tooling; it is a connected folder                                         | `git worktree prune`                                                                                            | **OPEN, trivial**                                              |

---

# 17. SECURITY, SECRETS, AND CREDENTIALS

Names only; no values were read, printed or logged.

| Name                        | Where                             | Used by                                               |
| --------------------------- | --------------------------------- | ----------------------------------------------------- |
| `GITHUB_TOKEN`              | `~/Documents/club-arena/.env`     | `curl` against the GitHub API (`gh` is not installed) |
| `SUPABASE_SERVICE_ROLE_KEY` | Hetzner engine env                | the engine (bypasses RLS)                             |
| `SENTRY_AUTH_TOKEN`         | `publish-club-arena.yml` **only** | source-map upload. Never put it in `ci.yml`           |
| `CRON_SECRET`               | Vercel + the Open Claw VM         | scheduled jobs                                        |
| SSH deploy key              | GitHub Actions secrets            | Hetzner deploy                                        |

No secret was exposed by this work. The Supabase migration was applied through
the MCP tool, which never surfaces the key.

---

# 18. DATABASE, MIGRATION, AND SEED STATUS

- Provider: Supabase Postgres, project `kuklfnapbkmacvwxktbh`.
- **One migration added and APPLIED:**
  `supabase/migrations/20260905172514_user_table_settings_gain_the_rabbit_hunt_button_toggle.sql`
  - `ALTER TABLE public.user_table_settings ADD COLUMN IF NOT EXISTS rabbit_hunt_button boolean NOT NULL DEFAULT true;` plus a `COMMENT`.
  - Verified live: `boolean`, `is_nullable = NO`, `column_default = true`.
  - Additive with a default -> metadata-only on Postgres 11+, no table rewrite.
  - **Rollback NOT tested.** Rolling back would be `DROP COLUMN`, which is
    destructive to a stored preference; prefer forward fixes.
- Declared in `scripts/ci/schema-manifest.d/rabbit-hunt-window.json`. **Never
  hand-edit the big manifests.**
- No seeds, no data migration, no money path touched. **No chips moved.**
- **Production DDL policy:** one migration = ONE transaction. Every DDL statement
  triggers a PostgREST schema reload that takes ~28s on this database.

---

# 19. CURRENT BLOCKERS AND DECISION POINTS

## 19.1 DECISION FOR DAN: does the VIP gate collide with Animation Law 10.6?

**This needs an explicit answer before Phase A ships.** 10.6: "no new toggle may
disable an animation outright". Dan is asking for a VIP-gated per-user toggle on
the squeeze presentation.

The reconciliation the outgoing agent believes is correct, **for Dan to confirm**:
the squeeze is an _enhanced presentation_ of a card that is shown either way. With
it off, the card still arrives, still animates its normal reveal, still takes its
full duration, and still makes its sound - it simply does not do the extended
face-down squeeze. **Nothing is skipped or silenced; a different profile is
chosen.** That is the same mechanism `resolveProfile` already uses for spectator,
background and mobile, none of which 10.6 objects to. **If instead the setting
made the card appear with NO animation, that would be a 10.6 violation.**

Write this reasoning into the PR body, and consider adding it to `docs/LAWS.md`
as a ruling, because the next agent will read 10.6 and worry.

## 19.2 DECISION FOR DAN: is the board squeeze meant to become INTERACTIVE?

His question 1 asks whether it is animation-only "OR" drag-controlled. He was
told: animation only. **He has not said whether he wants it changed.** The
difference is large - an interactive board squeeze needs pointer handling,
a progress model, and (critically) a rule stopping a slow dragger from outrunning
the server's equity gate (6.5). **Ask before building.**

## 19.3 DECISION FOR DAN: what exactly is "a VIP card"?

R3/R5 say VIP-gated and that a non-VIP is told they "NEED A VIP CARD". The repo
has `vipService`, `FEATURE_PRICING`, VIP monthly allowances, and X-Poker-style
"VIP card" tiers exist in the competitor set. **Confirm which entitlement gates
this** (a VIP level? an owned card? a subscription?) before writing the check.

---

# 20. REMAINING WORK

**CRITICAL**

- Confirm PR #3165 merged and published; if CI went red, fix forward.
- Phase A: the VIP all-in-only, per-viewer squeeze (R1-R8).
- Resolve 19.1, 19.2, 19.3 with Dan.

**HIGH**

- P1: make the rabbit reveal hand-safe (retained board copy, not a snapshot freeze).
- Play-test on a real table (P2).

**MEDIUM**

- P4 Rabbit Hunt hotkey (GGPoker parity).
- P5 Rabbit hunt from the hand replayer (ClubWPT Gold parity).
- Confirm 888poker actually has the feature (open the client) before putting it
  in any comparison table.

**LOW / OPTIONAL**

- P8 `git worktree prune`.
- Consider whether `RABBIT_MIN_VISIBLE_MS` (2000) should now rise, since the
  visible window is 2250-2650ms.
- Investigate P7 (off-schedule engine restarts) - platform, not this project.

---

# 21. PRIORITIZED NEXT-PHASE EXECUTION PLAN

## Phase 0 - Recover and verify state (15 min)

1. `cd ~/Documents/club-arena && git fetch origin -q && git log --oneline origin/main -5`
2. `curl -s https://smarter.poker/hub/club-arena/build-info.json`
3. `curl -s https://engine.smarter.poker/health | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['version'])"`
4. Confirm PR #3165 merged. If open and red, fix forward - do not revert.
5. Read `CLAUDE.md` sections 10.5, 10.6, 10.8, 12, 13 and `AGENT-PLAYBOOK.md`.

**Completion:** you can state main's HEAD, the live `ca_sha`, the engine version,
and #3165's state.

## Phase 1 - Protect completed work (10 min)

1. New worktree off fresh `origin/main`; provision `node_modules` for `/` and `/server`.
2. Baseline: `npx tsc --noEmit`, `npx vitest run`. **Both must be green before
   you touch anything**, so a later red is unambiguously yours.

## Phase 2 - Settle the three decisions (19.1, 19.2, 19.3) BEFORE coding

Ask Dan all three in one message. R6/R7/R8 and the interactivity question change
the architecture; guessing wastes a phase.

## Phase 3 - Per-viewer presentation (the hard part: R6, R7, R8)

**Objective:** the same street can present differently to different clients, with
zero information leak to anyone who does not get the squeeze.

- Inspect: `CommunityCards.tsx` (how a street becomes a `presentCard` call),
  `resolveProfile.ts`, `TablePage.tsx` `boardPresentationMode`.
- The presentation input already carries per-client context (`focus`,
  `reducedMotion`, `allIn`, platform). **The natural shape is a new input flag
  (e.g. `squeezeEligible`) computed per client from: is THIS viewer all-in in
  THIS hand, do they hold the VIP entitlement, is their setting on, and is the
  hand not RIT.** When false, resolve the ordinary profile.
- **Critical invariant:** the run-out must be indistinguishable for everyone
  else - same street timing, same equity beats, same sounds. The only thing that
  differs is the local card animation. Add a test that asserts a non-eligible
  viewer resolves the SAME profile it would have resolved before this feature.
- **Do not send anything new over the wire.** Everything needed is already
  client-side; a new broadcast field would be a leak and a protocol change.

## Phase 4 - Gating (R1, R2, R3, R4, R5)

- R1 all-in only: `resolveProfile` already takes `allIn`; the gate is that the
  squeeze profile is chosen ONLY when `allIn && street !== 'river'`.
- R2 never on RIT: make it **explicit**, do not rely on the `allInEquities`
  ordering accident (6.4). Add a pin.
- R3/R4: new user setting (default true) + VIP entitlement check. Migration via
  `node scripts/new-migration.mjs`. **Add the column to
  `USER_TABLE_SETTING_COLUMNS` in `PostgresSyncHooks.ts`** or it will not cross
  devices - the pin added in #3165 will catch you, which is the point.
- R5 upsell: Title Case, no em dashes, through the Toast layer.

## Phase 5 - Tests

- Unit: profile resolution for every combination of (all-in, VIP, setting, RIT,
  street). Per-viewer independence.
- Pin: a non-eligible viewer's presentation is byte-identical to pre-feature.
- e2e: the mobile spec pattern in `tests/e2e/card-squeeze-mobile.spec.ts`.
- **Prove each new pin fails on the pre-feature tree.**

## Phase 6 - Verify and ship

`npx tsc --noEmit` (both), `npx vitest run` (both), `npm run build:ci`,
Playwright. Changelog in your own file. Commit, `git merge origin/main`, push the
branch, **report the branch name and STOP.**

## Phase 7 - Then, separately

P1 (hand-safe rabbit reveal), P4 (hotkey), P5 (replayer). One commit each.

---

# 22. EXACT FIRST ACTIONS FOR THE NEXT AGENT

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
cd ~/Documents/club-arena
git fetch origin -q
git log --oneline origin/main -5
curl -s https://smarter.poker/hub/club-arena/build-info.json
curl -s https://engine.smarter.poker/health | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])"
```

1. Read `AGENT-PLAYBOOK.md`, then `CLAUDE.md` (10.5, 10.6, 10.8, 12, 13).
2. Confirm **PR #3165** merged.
3. Read `src/presentation/cardPresentation/types.ts` and `profiles.ts` headers -
   they carry the whole design rationale.
4. Read `src/config/handCompletionSpec.ts`.
5. **Ask Dan the three questions in section 19** before writing code.
6. **Do NOT** modify: the resting face-up transform; `handCompletionHoldMs`'s
   arithmetic; the byte-for-byte spec mirror; the unconditional 1750ms rest.
7. **Do NOT** commit on `main`. **Do NOT** open the PR or watch CI.
8. Create a worktree off fresh `origin/main` and provision `node_modules` for
   BOTH `/` and `/server`.
9. Resume at **Phase 2** (settle the decisions), then **Phase 3**.

---

# 23. ACCEPTANCE CRITERIA (for the next phase)

- A player who is all-in, holds the VIP entitlement, and has the setting on sees
  the squeeze on the turn (and any pre-river all-in street). Nobody else does.
- Two all-in players, one eligible and one not, each see the correct thing in the
  same hand, at the same time, with no timing difference visible to either.
- A non-eligible viewer's board presentation is **provably identical** to the
  pre-feature behaviour (pinned by test).
- The squeeze never appears on a Run It 2x/3x hand, by an explicit rule with a
  test, not by side effect.
- A non-VIP toggling it on gets a Title Cased, em-dash-free upsell and the
  setting does not turn on.
- The setting crosses devices in real time (it is on `USER_TABLE_SETTING_COLUMNS`).
- No new field is broadcast to other players; no information leak.
- The reveal still finishes inside `ALL_IN_STREET_REVEAL_MS` at every animation
  speed, including Slow (the `serverPaced` clamp still holds).
- 10.6 intact: with the feature off, the card still animates, still takes its
  full duration, still makes its sound.
- `tsc` clean (app + engine), full vitest green, `build:ci` clean, Playwright
  green, changelog written, branch pushed, and the branch name reported.

---

# 24. RECOMMENDED COMMIT STRATEGY

1. `feat(ca): the board squeeze is per-viewer` - the presentation plumbing and
   the eligibility input, with no gating yet. Tests: per-viewer independence +
   the identical-for-everyone-else pin.
2. `feat(ca): the squeeze is an all-in perk, never on a re-run` - R1 + R2 and
   their pins.
3. `feat(ca): the squeeze is a VIP card perk, on by default` - the setting, the
   migration, the relay allowlist entry, the VIP check, the upsell. Tests: the
   settings pins + the upsell copy rules.
4. `fix(ca): a rabbit reveal no longer freezes a live hand` - P1, separately.
5. `feat(ca): a hotkey for the rabbit hunt` - P4, separately. GGPoker parity;
   the industry's actual answer to multi-tablers missing the window. Bind a key
   to the same handler the button calls, and disable it exactly when the button
   is disabled.
6. `feat(ca): rabbit hunt from the hand replayer` - P5, separately. ClubWPT Gold
   parity, and the one thing that makes missing the window survivable. We are
   closer than it looks: `HandReplay` exists and the server already keeps the
   offer purchasable for 90s (`RABBIT_HUNT_OFFER_TTL_MS`), so the work is wiring
   the replayer to `POST /rabbit-hunt` and deciding whether that TTL lengthens
   for this path.

Never mix these. Each carries its own changelog file.

---

# 25. FINAL CONTINUATION SUMMARY

**Stopping point.** Three workstreams merged; two are published and live on both
the bundle and the engine. The fourth (PR #3165, the audit follow-ups) was pushed
minutes before this handoff and was OPEN. Dan then specified a new feature - the
VIP-gated, all-in-only, per-viewer board squeeze - which is **completely
unstarted**.

**Work on first.** Confirm #3165 merged, then ask Dan the three questions in
section 19 (the 10.6 reconciliation, whether he wants the board squeeze to become
interactive, and what "a VIP card" means as an entitlement). Then Phase 3.

**Locked requirements.** The board never shifts; the resting transform is face
up; the 1750ms rest is unconditional on every hand; Rabbit Hunt cards go only to
the buyer; Lightning is untouched; horses get identical treatment; animations
always play.

**Greatest technical risk.** Per-viewer presentation (R6/R7/R8). Getting it
wrong leaks information about who is all-in or who is a VIP, or makes the felt
diverge between players in a way that is visible in the table's rhythm.

**Greatest visual risk.** An interactive squeeze (if Dan wants one) letting a
slow dragger outrun the server's equity gate and see the percentages before their
own card - the exact spoiler `ALL_IN_STREET_REVEAL_MS` exists to prevent.

**Greatest data-integrity risk.** None outstanding. No money path was touched and
no chips were moved.

**Still requires the user.** All three decisions in section 19.

**How to continue without restarting discovery.** Everything discovered is in
this document and in the headers of `types.ts`, `profiles.ts` and
`handCompletionSpec.ts`, which were deliberately written as the durable record.
Verify the four state facts in section 22, read those three headers, ask Dan the
three questions, and start at Phase 3. Do not re-derive the timings - the sourced
research is already in `docs/research/`.
