# HANDOFF — Tournament Lobby: what is NOT finished

**From:** Cowork/Claude, 2026-08-26
**Repo:** `club-arena`
**Status of the main work:** shipped. PRs #845, #879, #911, #915, #939 are merged
and verified live in production. #959 is open with auto-merge armed.

Read `AGENT-PLAYBOOK.md` and `.agents/rules/00-agent-playbook.md` first. Claim
your own worktree — never work in `~/Documents/club-arena`:

```bash
cd ~/Documents/club-arena
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<slug>)"
```

Every item below is real, evidenced, and deliberately left undone. Nothing here
is speculative polish.

---

## 1. NOBODY HAS OPENED THIS IN A BROWSER — do this first

**This is the single biggest gap.** Every claim made about the tournament lobby
rests on production data, unit tests and frame analysis of a screen recording.
The sandbox had no route to a real browser. The mechanisms are proven; the
pixels are not.

Open `https://smarter.poker/hub/club-arena/` → any club → an MTT row → the
tournament lobby, **at 375px width on a real phone**, and check:

- **Detail fits one screen with no scrolling.** The shell measures its own space
  into `--details-h` rather than using `100dvh` (AppLayout renders a header,
  optionally two banners, and `<main>` padding above it). If the footer sits
  below the fold, that measurement is wrong — start at the `ResizeObserver`
  effect in `TournamentDetails.tsx`.
- **The footer is flush to the bottom**, no gap under Share / Late Register. It
  is a flex child now, not `position: fixed`.
- **The Blinds clock actually ticks** and does not read `0:00`. It anchors to
  `tournaments.level_started_at`.
- **Ranking**: the hero row is pinned, a row that moves lights its rim, the
  Mine Only filter works for an agent.
- **Tab strip**: Left/Right arrows move between tabs and wrap. This was just
  built; nobody has pressed the keys.

Report what is actually wrong rather than assuming it is right.

---

## 2. The lobby mystery-bounty chest is dead code

`src/pages/TournamentPage.tsx:858` gates its chest animation on:

```js
if (data?.playerName && data?.amount)
```

That broadcast payload has **never carried `playerName`**, so the lobby chest
has never once played. PR #959 added `amount` to the chest reveal (for the
celebration toast), which leaves the gate still failing on `playerName`.

**Decide and finish it.** Either:

- add `playerName` to the chest reveal in
  `server/src/tournament/TournamentManagerEliminations.ts` (~line 1929) and let
  the lobby chest play — but note the **table** already plays a full chest
  animation, so confirm with Dan you want two; or
- delete the dead gate and its animation.

Do not leave it half-wired.

---

## 3. The client is a redundant second writer of `current_level`

The Hetzner engine is authoritative (`TournamentManagerBase.ts:2876`).
`TournamentTimerService` **also** writes `tournaments.current_level`.

I fixed the value it writes — it was `levelIndex + 1` into a **0-based** column,
which compounds once per second because the reader is fed its own output
(read N → write N+1 → read N+1 → write N+2). It is currently harmless because
`initializeAllTimers` has zero callers in `src/`.

**The real end state is that the client should not write that column at all.**
That is a design decision, not a bug fix, which is why I stopped. Verify the
engine is the only writer that matters, then remove the client write and the
`initializeAllTimers` dead path with it.

Evidence that the column is 0-based, so you do not re-derive it:
`current_level == floor(elapsed / level_duration)` exactly across every RUNNING
event; `blind_structure[current_level].level == current_level + 1` in all
33,066 rows; `current_level` is never null.

---

## 4. A pko + mystery-bounty event has no prize rank

`fn_collect_bounty`'s CASE returns `'pko'` when a tournament is flagged **both**
pko and mystery, and `paid_cash` is then only **half** the head. Ranking half a
payment against a ladder of whole heads would report a rung nobody pulled, so
`prizeRank` is deliberately not computed for that mode and the celebration will
not fire for it.

**Ask Dan whether such an event will ever be configured.** If yes, decide what a
"top 3 pull" means when the payment is half a head. If no, nothing to do —
record the answer.

---

## 5. Dead comment pointers

Three comments cite files deleted in #959, by line number:

- `src/components/tournament/details/EntriesTab.tsx:29` and `:146` → "see
  LiveChipCounts.tsx:71" / "its line 88"
- `src/pages/tournament/TournamentDetails.tsx:678` → "see its line 88"

Harmless, five-minute cleanup.

---

## 6. Suggested next audits (not yet done)

Nobody has audited these with the same rigour the seven tabs just got:

- **`GameLobbyPanel`** — the pre-commit drawer cash/Spin/SNG rows still open.
  It is the buy-in surface; it has not been checked for the defect classes the
  tab audit found (null dereferences on `any`-typed columns, division by zero,
  a failed query rendering as empty).
- **`LobbyTable` / `lobbyEntries.ts`** — the row view-model. `mergeFastRows`
  now protects the lobby lists from partial rows, but the row renderers
  themselves were not audited.
- **The Spin surfaces** — `spin_multiplier` is one of the five columns
  `get_club_home` omits, so Spin badges had the same flicker the MTT cards did.
  Fixed at the source, but the Spin-specific rendering was never reviewed.

---

## HOUSE RULES that bit me — save yourself the time

- **`--no-verify` is forbidden and you will not need it.** The pre-push guards
  grep **file contents**, so a code COMMENT quoting a banned string trips them.
  I lost three pushes to this: a comment naming the raw GoTrue auth call, and a
  comment quoting the removed search placeholder. Reword the comment.
- **Long commit messages must go through `git commit -F <file>`.** Passing them
  inline breaks the shell on parentheses and backticks. And do not `git add -A`
  right after writing that file, or you commit the message itself.
- **Two tests shell out to `git ls-files`** (`currentLevelIsAnIndex`,
  `chipsAreTheDefaultNotBB`) and fail **only** inside a Linux sandbox, because a
  worktree's gitdir is a macOS path. They pass on the host and in CI. If only
  those two fail, it is the environment — do not "fix" them.
- **The shared clone gets `git reset --hard`'d** by another agent, repeatedly. I
  lost a full session of work to it before moving to a worktree, and two
  sub-agents lost work the same way mid-task. Commit early, commit often.
- **Rule 11.5 applies to `fn_collect_bounty`** — it moves chips. Read its
  definition, or probe inside a transaction you ROLL BACK. Do not call it.

---

## WHAT IS ALREADY DONE — do not redo it

Seven tabs (Detail, Blinds, Ranking, Entries, Unions, Tables, Rewards) under
`src/components/tournament/details/`, sharing `types.ts` and the `tl-` layer in
`src/styles/tournament-lobby-3d.css`. Chips became Ranking; the old Ranking tab
is gone. MTT rows route to the lobby at any status. The card flicker, the frozen
Blinds clock, the footer gap, the search field, four superseded components
(2,439 lines), the tablist accessibility, the payout-range parser (the money
bubble was being announced seven places early) and the level-timer write are all
fixed and covered by roughly 300 new assertions — including a palette hue test
that rejects saturated colour in the 20-70 degree band, so gold cannot return.
