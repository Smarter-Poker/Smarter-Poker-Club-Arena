# The auto-close law, and what the sweep turned out not to be

2026-08-31 — cowork-claude-table

Follow-up to `2026-08-31-panels-never-auto-close-and-the-tab-x-owes-a-results-card.md`
(PR #2058). Dan asked for the four improvements proposed at the end of that
session, with a standing instruction: build them fully and test them, and build
nothing considered high risk to other pages.

Two were built. Two were not, and one of those was not built because **the
problem I reported did not exist**.

---

## Built: `tests/nothing-auto-closes.law.test.ts`

PR #2058 fixed three separate auto-close mechanisms but pinned only one of them,
inside a component-scoped spec. This is the repo-wide law, in the shape the
other fourteen `*.law.test.ts` files use.

Five pins:

1. **HeroHubPanel has no turn-keyed close.** Any `useEffect` whose dependency
   array mentions the turn clock and whose body closes something is a failure.
2. **No component anywhere does.** The same scan across every `.tsx` under
   `src/`, so the next panel is covered the day it is written rather than the
   day someone remembers to add it here.
3. **The hub yields rather than closes** — `.hero-hub__overlay--yield` exists,
   drops `pointer-events`, reserves `--sp-action-reserve`, and keeps the panel
   itself interactive. A yield that also went inert would be an auto-close
   wearing a different hat.
4. **TableMenu stands down both dismissals** while the avatar picker is open.
5. **SettingsPanel's backdrop compares `target` to `currentTarget`**, plus the
   generalised form: every overlay backdrop that closes on click must be
   guarded against its own content bubbling. 38 of 38 comply today.

### The law tests itself first

A source-scanning law can pass because the codebase is clean or because the
scanner is broken, and from the outside those are identical. So the file opens
with a `describe('the detector is not vacuous')` that feeds the matcher the
exact code deleted from HeroHubPanel and asserts it is recognised, feeds it a
benign turn-reading effect and asserts it is not flagged, and checks that the
real guarded files parse to a non-zero number of effects. If the `useEffect`
matcher ever stops understanding this codebase, that block goes red before any
of the real pins can silently pass.

### Proven by mutation, not by assertion

Each pin was verified to actually fail on the bug it claims to catch, in a
sandbox copy only:

| Mutation | Result |
| --- | --- |
| Re-inject the deleted `if (isOpen && isHeroTurn) onClose()` | 2 pins red |
| Delete TableMenu's two `if (showAvatarGallery) return;` guards | 1 pin red |
| Revert SettingsPanel's backdrop to bare `onClick={onClose}` | 1 pin red |

Restored and re-run green after each.

### One carve-out, named and shape-scoped

The scan found a real hit: `ActionPanel.tsx`,

```ts
useEffect(() => { if (!isMyTurn) setIsRaiseMode(false); }, [isMyTurn]);
```

This is legitimate. It is not a panel the player opened being taken away; it is
the action bar's own transient mode returning to default at the moment there is
nothing left to act on — leaving a half-dragged raise amount armed across the
turn boundary is the bug, not the fix. Note the `!`: it fires when the turn
LEAVES, never while the player is deciding.

The exemption is **scoped to that effect's shape, not to the file**, so a
genuine auto-close added to ActionPanel later is still caught. A further test
asserts the inversion (`if (isMyTurn)`) does *not* match the exemption, so the
carve-out cannot quietly widen into a hole.

## Built: a staleness note in `scripts/agent-workspace.sh`

The reuse path already refuses to move a tree with uncommitted work — correct,
and it is also the path that quietly hands the agent a **stale base**. The fresh
path checks out from `origin/main`; this one deliberately does not.

PR #2058 was built in exactly that state: 20 commits behind, four modified files
belonging to a previous session. Its required checks failed, and the agent then
guessed at the cause, which was the expensive part.

**What a stale base can actually break here, verified against the workflows
rather than assumed.** Five of the six required checks use `actions/checkout`'s
default, which on `pull_request` is `refs/pull/N/merge` — the merge with main —
so those five already see main's current tests and sources no matter how old the
branch is. The sixth, **Silent Revert Guard**, deliberately checks out
`github.event.pull_request.head.sha` (see the comment at
`.github/workflows/silent-revert-guard.yml:42-47`: the merge commit collapses
`merge-base origin/main HEAD` to main and the range stops describing the PR). It
is the one required check that sees the branch as it really is — and its own
header names the cause it exists to catch: "an agent commits a working tree
checked out before someone else's change landed."

So staleness is a real and mechanical hazard on this repo, and this note is
aimed at it. Which specific check failed on #2058 is not recorded here, because
the local token lacks `checks:read` and I could not read the run. Saying so is
the point: the previous session's mistake was asserting a cause it could not
see.

The block now also prints the uncommitted file count with a warning that some
may not be yours, and the behind-count with the rebase command. It is a NOTE,
never a refusal: refusing here would strand the very uncommitted work the block
exists to protect, and rebasing is the agent's call once their work is
committed. `rev-list` failures degrade to silence — a courtesy message must
never break a workspace claim.

Live output against this tree:

```
# 16 uncommitted file(s) here. Run 'git status' before you stage:
# some of them may belong to whoever used this tree last, not to you.
# STALE BASE: this tree is 29 commit(s) behind origin/main.
# That is far enough back to fail CI on tests you never touched.
# Once your work is committed:  git -C '...' rebase origin/main
```

Every added line writes to **stderr**; stdout is the `eval` contract and is
untouched, as are the exit code and the branch logic.

## NOT built: the backdrop sweep — because it was not a real finding

At the end of the last session I reported "180 raw `onClick={onClose}`" and "a
dozen-plus overlay backdrops" needing an `e.target === e.currentTarget` fix, and
offered to sweep them.

Measured properly this time: there are **38** overlay backdrops that close on
click, and **all 38 already guard** — the panel child stops the bubble in every
one. My earlier 7-line scan window had missed `stopPropagation` sitting behind
the house comments in three files, and the "180" figure was counting close
BUTTONS. No overlay other than SettingsPanel renders a portaled child at all,
and that one was already fixed in #2058.

So the sweep would have been 38 files of churn across club, VIP, lobby,
tournament, admin, wallet and moderation pages, changing nothing. That is
precisely the "damaging other pages" risk with none of the benefit. Not built,
and the corrected count is recorded here so nobody re-derives the bad number.

The generalised pin in the new law file preserves the *intent* — the invariant
is now enforced for every backdrop written from here on.

## NOT built: a base-freshness refusal in `git-safe-push.sh` — high risk

`scripts/git-safe-push.sh` is the single deploy path for every agent in this
estate. A refusal added there that misfires blocks everyone, and the failure
would look exactly like the network and rebase problems section 1.2.5 already
documents. Meanwhile `agent-workspace.sh` **already** creates and moves branches
from `origin/main` (`git checkout -q -B "$BRANCH" origin/main`), so the base is
correct whenever the sanctioned entry point is used. The real gap was that the
reuse path never said the base had gone stale, and that is what the note above
fixes — at zero risk, because it only prints.

## NOT mine: the local PAT's `checks:read` scope

Dan's to make. The fine-grained token on this machine lacks `checks:read`, which
is why an agent cannot run `gh pr checks` locally and — in my case — guessed at
why a PR had not merged. It has no effect on the repository or on the autopilot
GitHub App, which runs server-side with its own App token and is healthy. An
agent handling credentials is the wrong shape regardless of scope, so this is
recorded as a recommendation and nothing else.

## Verification

- `tsc --noEmit -p tsconfig.app.json` — exit 0.
- `vitest run` across the new law plus every neighbouring spec it could disturb
  — **11 files, 163 tests, all passing**: `nothing-auto-closes.law`,
  `shipped-invariants`, `heroHubDialogBehaviour`, `heroHubQuickSettings`,
  `heroHubLastTab`, `hero-avatar-opens-hero-hub.law`,
  `no-auto-table-switch.law`, `action-bar-never-leaves.law`,
  `settingsHaveOneOwner`, `settingsDoNotChangeThemselves`,
  `sessionSummaryPendingSettlement`.
- Mutation testing of all three law pins, as tabled above.
- `bash -n scripts/agent-workspace.sh` clean; the changed block executed against
  the real tree with real values; the unresolvable-ref edge case degrades to
  silence; every added line verified to write to stderr.

No source file behaviour changed in this commit. One new test file, and one
stderr-only addition to a workspace script.
