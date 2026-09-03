# Handoff — Spins reveal, the bundle gate, and how to actually ship

**Date:** 2026-08-21 · **Repo:** Smarter-Poker-Club-Arena · **Author:** Claude (Cowork session)

This is a state-of-the-world briefing, not a request for anyone to do work I could
not do. Everything below is already on `main` unless it says otherwise.

---

## 1. HOW TO SHIP FROM A COWORK SESSION (read this first)

**The sandbox cannot reach GitHub.** `git push` / `git fetch` fail (no SSH key), and
the `mcp__github__*` server cannot see this repo at all — it is private and that
token lacks access. `search_repositories` works, `get_file_contents` on this repo
404s. Do not burn time on it.

**The route that works is `mcp__counselors__host_terminal`** — a real shell on Dan's
Mac, with network, SSH keys and the `gh` CLI.

```bash
export PATH=/opt/homebrew/bin:$PATH   # gh is NOT on the MCP shell's default PATH
gh auth status                        # already: Smarter-Poker (keyring)
```

**You almost certainly do not need a token.** `gh` is authenticated as
`Smarter-Poker` via the macOS keychain, and that is what pushed every branch and
opened every PR today.

**If you ever do need it** (Dan added it 2026-08-21):

| Where                                    | What                                |
| ---------------------------------------- | ----------------------------------- |
| `~/Documents/club-arena/.env`            | key `GITHUB_TOKEN`                  |
| `~/Documents/club-arena/github_token.md` | a pointer file describing the above |

Note that path is `club-arena`, **not** `Smarter-Poker-Club-Arena` — a different
checkout. Both files are gitignored (`.gitignore:15 .env`, `.gitignore:28
*token*.md`), so they will not be committed. Prefer the `gh`/keychain path anyway,
never echo the value into chat or a log, and if you finish with it, suggest Dan
delete `github_token.md` — a PAT in plaintext in a project folder is one `git add
-f` away from being auto-revoked by GitHub.

### The push pattern

**Never `git add -A` in the shared working tree.** Several agents work in it at once
and it routinely holds other people's half-finished work. Use a detached worktree:

```bash
REPO=~/Documents/Smarter-Poker-Club-Arena; WT=/tmp/ca-work-$$
cd "$REPO" && git fetch -q origin main
git worktree add --detach "$WT" origin/main
for f in <only your files>; do mkdir -p "$WT/$(dirname $f)"; cp "$REPO/$f" "$WT/$f"; done
cd "$WT" && git add -- <only your files>
git -c user.name='Smarter-Poker' \
    -c user.email='254329056+Smarter-Poker@users.noreply.github.com' \
    commit -m "..."
git push origin HEAD:refs/heads/my-branch
gh pr create --repo Smarter-Poker/Smarter-Poker-Club-Arena --base main --head my-branch ...
cd "$REPO" && git worktree remove --force "$WT"
```

Two hard rules this encodes:

- **Commit author MUST be `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`.**
  CHECK 15 enforces it because Vercel sets a deployment to **BLOCKED** — no build
  logs at all — for a commit it cannot attribute.
- **Never rebase `main`.** `.husky/pre-rebase` refuses it deliberately; see
  CLAUDE.md §12. Direct push to `main` is also refused by branch protection
  ("2 of 2 required status checks are expected") — everything goes through a PR.

**Merging may be refused.** The Cowork permission classifier blocked
`gh pr merge` for me. Do the work, open the PR, and hand Dan the one-liner.

---

## 2. TRAPS THAT COST REAL TIME TODAY

1. **The working tree served STALE file content.** Six files had silently lost
   _committed_ work — `TablePage.tsx` was missing the entire `SPIN_REVEAL` handler,
   `TablePage.css` had lost the `!important` that keeps the pot total readable under
   reduced motion, and `main.tsx`, both `ServerTableEngine*` files and `tests/setup.ts`
   were behind too. I had already edited two of them before noticing; committing
   would have deleted the shared-wheel feature from production.
   **Before trusting a file you are about to edit, run `git diff HEAD -- <file>`.**
   If the tree is behind, rebuild from `git show HEAD:<file> > <file>`. The stale
   copies I replaced are backed up at `/tmp/stale-worktree-backup-151200`.

2. **A PR can merge without your latest commit.** #160 merged three of its four
   commits; the fourth — the entire visual/audio/ordering rewrite — sat unmerged on
   a branch that happened not to be deleted. **After any merge, grep `main` for a
   symbol you know you added** rather than assuming.

3. `host_terminal` dies on `sleep` longer than ~150s ("Request timed out"). Poll in
   short calls instead of one long wait.

4. The sandbox's `/tmp` has ~100MB free. `git archive` of this repo fills it and
   fails halfway. Build and measure on the host.

5. The Supabase MCP times out intermittently for minutes at a stretch. Retry; it
   comes back.

6. The client build fails on other agents' uncommitted work. Build from a clean
   worktree off `origin/main`, not from the shared tree.

---

## 3. WHAT CHANGED

### Spins — the 500x is retired, 100x is the top of the ladder

Dan: _"REMOVE THE 500X WE WILL ONLY EVER DO 100X."_

Frequency was **moved, not deleted**, because the file's governing rule is an
equality: `E[multiplier] = seats × (1 − rake)`. Dropping the row would have taken
the expectation from 2.7638 to 2.7588 — an 8.04% edge on a product advertised at
7.87%, i.e. quietly taking 0.17% more from every player.

| tier | before    | after     |
| ---- | --------- | --------- |
| 100x | 500       | 1,008     |
| 2x   | 4,772,497 | 4,772,073 |
| 3x   | 3,968,502 | 3,968,518 |

Total freq (10,000,099) and Σ mult×freq (27,638,000) are both unchanged, so
`E = 2.763773` to six decimals. Consequences, intended: a 100x lands ~1 in 9,921
instead of 1 in 20,000, and `requiredSeed`/`reserveCeiling` both dropped 5x because
they derive from the top tier (at the current $100 top stake: seed $100k → $20k).

**Migrations applied:** `retire_500x_spin_tier` (dropped `can_draw_500x` from
`v_spin_tier_availability`) and `spin_availability_can_draw_500x_compat_shim`
(put it back as a literal `false`). See the debt in §4.

### The reveal — retimed, and one clock again

`SpinWheel.tsx` carried its own timing literals while the engine built its deal hold
from `SPIN_REVEAL`, and they had drifted: the client's result ran 4200ms against an
engine hold built from 2200ms, so for two seconds the engine was free to deal the
first hand **on top of the card announcing the prize**. Nothing compared the two
sources. Every client timing now derives from the spec and a test fails if a literal
returns.

Sequence is now 1s lead-in → 3s tree (1s per lamp) → 6s chase over five laps →
1.6s winner flash → 3.2s result = **14,800ms**, and the engine holds for
`spinRevealToDealMs()`.

### The reveal — visuals and audio

The disc was DOM divs with clip-path triangles, which is _why_ it looked flat: a CSS
triangle cannot carry a fill gradient. It is SVG paths now — dark carbon rim (one
flat colour), brand tokens only, red/yellow/green starting tree above the numeral,
and a landing that outlines **one** wedge in neon (wide gold halo under a hot white
core, tracing the whole shape). The gold wash, the halo behind the disc and the
drain-to-grey on losers are all gone; together they read as "the wheel lit up"
rather than "this multiplier won".

Audio: no pitch envelope survives anywhere (a rising glide _is_ a boing — that was
"the spring sound"). Clicks receive the chase's own schedule array, so one peg
strike per segment crossed. The landing is formant synthesis — saw voices through
bandpass filters at 730/1090/2440 Hz, the formants of "ah" — because a vowel is not
a chord.

### The order after the wheel

Dan: _"CHIP STACKS GET ADDED, BUTTON RANDOMLY ASSIGNED AND THE SPIN STARTS."_
Both halves were wrong. Stacks were credited at start, **before** the reveal
broadcast, so they landed while the wheel was still turning. And the first button was
`sortedSeats[0]` — the lowest occupied seat, which in a seat-first format hands a
positional edge to whoever clicked first. Now the credit is deferred and scheduled
after the reveal (idempotent, with a safety net, because a zero-chip seat can never
start a hand), and the button is drawn uniformly and consumed once.

### CI — the bundle gate was measuring the wrong thing

It summed every file in `dist/assets` and failed on the total, while its own comment
said it gated on "what users actually download":

|              | raw    | gzipped   | files |
| ------------ | ------ | --------- | ----- |
| Initial load | 888kB  | **244kB** | 4     |
| Whole app    | 6573kB | 1862kB    | 288   |

It was charging every push for **1,618kB gzipped no session fetches**, and it was
backwards: splitting a heavy feature into its own chunk scored identically to
shipping it eagerly. `scripts/ci/bundle-size.mjs` now gates **initial load** hard
(320kB gz, 245 today — a gate that did not exist before) and treats whole-app size
as a 2400kB gz bloat ceiling. Verified it fails a synthetic build with the 3D
replayer preloaded from the entry. Someone immediately used the new reporting to
take a real 65kB gz off the app in #180.

---

## 4. OPEN WORK, ROUGHLY IN PRIORITY ORDER

1. **Union-level reserve wallet — Dan's biggest outstanding ask, never started.**
   Verbatim: _"THE RESERVE POOL COMES FROM THE UNION NOT THE CLUBS. IT ONLY COMES
   FROM THE CLUBS IF THEY ARE A STAND ALONE CLUB WITH NO UNION AFFILIATION. AND YOU
   NEED TO CREATE THE WALLET TO HOLD THE SEEDED AND RESERVE FUNDS."_ Touches
   `spin_bonus_pools` (currently keyed by `club_id`), `fn_spin_draw_multiplier` and
   `fn_spin_settle_game`. Needs a new wallet built and the funding path rerouted.

2. **Tournament completion card at the end of a spin, for ALL finishers.** Asked for,
   not started.

3. **Spins 1:1 animation parity with cash games.** Dan asked for a verified clone of
   every cash-game animation; never audited end to end.

4. **Remove the `can_draw_500x` shim.** Re-apply `supabase/migrations/20260821g_*.sql`
   once no cached bundle still selects the column. _This one is mine and it is a real
   lesson:_ I dropped the column while the client that stops selecting it was stuck
   behind frozen CI, and the lobby's Spin badge went dark for real users. The hook
   swallowed the error, which made it non-crashing but not correct. **A column a
   deployed client selects belongs to that client's contract, and the deployed client
   is whatever is cached in browsers, not what is on main.** Two-step it: ship the
   client, wait, then drop.

5. **`VITE_RIVE_RIGS=on`** in the same commit that lands the first `.riv`. The runtime
   is gated out of the build (−182kB raw / −52kB gz) because no art exists; flipping
   the flag restores the lazy behaviour untouched. `tests/unit/riveAvatar.test.tsx`
   pins both flag states.

6. **Small gap:** `tests/e2e/hero-card-row.spec.ts` asserts hold-em cards clear the
   seat's right edge, but the **vertical** axis has no assertion — a row could float
   above or below the plate and pass. I proposed `rowCentreY` within the seat's
   vertical span; it did not survive into #183/#186.

---

## 5. STANDING RULES WORTH RE-READING

- `CLAUDE.md` §12 — never rebase `main`; use `scripts/git-unstick.sh` if a clone is
  stranded.
- `CLAUDE.md` §5.7 — popups are Title Case, no em dashes, enforced in
  `src/utils/popupStyle.ts`. Never hand-roll a popup outside the Toast layer.
- Never call the AI players "bots". They are **horses**.
- No emoji in source files — it breaks the SWC compiler and fails the Vercel build.
- `.maybeSingle()`, never `.single()`.
