# The documents an agent opens first still named the route that is gone

Date: 2026-09-04
Branch: `docs/the-handoff-names-the-live-route`

## The mechanism

Club Arena stopped publishing through the World Hub on 2026-09-03. It builds
here and rsyncs to `ca-static.smarter.poker`; the World Hub carries one rewrite.
`scripts/sync-club-arena.sh`, `scripts/build-club-arena.sh`,
`scripts/sync-to-world-hub.sh` and the vendored `public/hub/club-arena/` tree
are all deleted.

**Next.js serves `public/` BEFORE a rewrite.** So an agent following the old
instructions would not have created a harmless duplicate - it would have
SHADOWED the live bundle. Production keeps serving the committed copy, the
publisher keeps rsyncing where nobody reads, and nothing raises an alarm.

## What was found, and how

`tests/unit/theDeployDocsNameTheLiveRoute.test.ts` existed for exactly this,
and it guarded THREE hand-listed files. Two design choices made it miss
everything else:

1. **It required a literal `bash ` prefix.** So
   `bash ~/Documents/Smarter-Poker-World-Hub/scripts/build-club-arena.sh` (an
   absolute path) and "Deploy via `scripts/sync-club-arena.sh`" (prose) both
   evaded it. Both existed, in files an agent reads first.
2. **It was a list of three.** A hand-written list only ever guards the three
   somebody remembered.

It now sweeps every tracked `.md` and `.sh` in the repo and matches the script
PATH rather than an invocation shape. That found eight more files, all of them
present-tense instructions:

| File                                          | What it said                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `docs/HANDOFF_CURRENT_STATE.md`               | "autopilot merges -> build-for-world-hub publishes". CLAUDE.md line 3 sends every engine-restart agent to this file **first** |
| `.memory/context/001-architecture.md`         | A four-step "DEPLOYMENT PIPELINE" ending in "Push World Hub to GitHub -> Vercel auto-deploys"                                 |
| `.memory/context/004-vercel-deploy.md`        | A four-step deploy pipeline, and a table row giving `public/hub/club-arena/` as the "Club Arena Path"                         |
| `docs/STATS-PAGE-BUILDOUT-PLAN-2026-08-21.md` | "Deploy via `bash scripts/sync-club-arena.sh`" - in the plan whose first phase merged yesterday (#2941)                       |
| `.agent/workflows/build-verify.md`            | `git push origin main` then `vercel --prod --yes`, **with no supersession banner at all**                                     |
| `.agent/workflows/deploy.md`                  | Bannered 2026-09-03; 100 lines of the old procedure still under it                                                            |
| `.agent/workflows/deploy-troubleshooting.md`  | Bannered; 240 lines of failure modes for a pipeline that no longer exists                                                     |
| `.agent/workflows/completion-protocol.md`     | Bannered; the end-of-task protocol still said push to `main` then run the sync script, marked ZERO EXCEPTIONS                 |

## Why the three bannered files were rewritten rather than left

The World Hub's `AGENT-DEPLOYMENT-GUIDE.md` proved the point on the same day:
294 lines of dead procedure under a MANDATORY READING banner. **A banner over a
body that still reads as present-tense law does not help a reader who skims
into the middle of it**, and an agent looking for a command scrolls to the
command. Dan's instruction was to remove the old routes, not to label them, so
the dead bodies are gone and each file says in one paragraph what it used to
say and why that is wrong.

`.agent/workflows/deploy-troubleshooting.md` went from 261 lines to 62, and is
more useful: it now works down from "what does `build-info.json` actually say",
which is the first question in every case.

## What stops it recurring

The widened sweep, and two rules with reasons:

- **Match the path, not the invocation.** Every way an instruction can be
  written names the script.
- **A correction is exempt only within one line of what it corrects.** A wider
  window let the World Hub's `completion-protocol.md` off, because an unrelated
  "FORBIDDEN" in a CAUTION block twelve lines above sat in the same paragraph
  as a live instruction to run `npx vercel --prod`.

History is exempt by path (`docs/_archive/`, `docs/changelog/`,
`docs/handoffs/`, `docs/HANDOFF-*`, `.agent/audits/`, `.agent/handoffs/`,
`.memory/decisions/`, `MIGRATION-CHANGELOG.md`,
`MASTER-MIGRATION-DOCUMENT.md`) and by name (anything beginning `YYYY-MM-DD`).
An account of the 2026-08-21 publish deadlock has to be able to name the script
that deadlocked; sanitising it would destroy the only record of why these rules
exist, and nobody opens a dated file looking for today's deploy command.

## The same pass on the World Hub side

`Smarter-Poker-World-Hub`, branch `fix/the-deploy-docs-name-the-live-route`:
`.agent/workflows/club-arena-rebuild.md` and `AGENT-DEPLOYMENT-GUIDE.md`
replaced, `scripts/hooks/pre-commit-core.sh` CHECK A rewritten with no escape
hatch, `.agent/AGENT-OPERATIONS-GUIDE.md` resynced from this repo's (correct)
copy, and CLAUDE.md corrected where it promised a daily deploy-hook safety net
that was retired on 2026-09-03. Same law, ported.

---

## Addendum: 102 worktrees are still reading the old rule, and pruning cannot fix it

`scripts/prune-stale-worktrees.sh` was run to completion: **211 Club Arena
worktrees down to 160**, 51 removed, every one of them clean, pushed and idle
for more than 72 hours. Nothing was lost by construction - those are the
script's own preconditions, and `git worktree remove` without `--force` refuses
a dirty tree even if they were wrong.

Then the population was measured, and the number that matters did not move
nearly as much:

|                                                                                            | count   |
| ------------------------------------------------------------------------------------------ | ------- |
| Club Arena worktrees on disk                                                               | 160     |
| whose `CLAUDE.md` differs from `origin/main`                                               | 154     |
| **still carrying `bash scripts/sync-club-arena.sh` or the heading "The Only Deploy Path"** | **102** |
| clean, pushed, and 500+ commits behind                                                     | 0       |
| dirty (nothing may touch these)                                                            | 24      |
| whose HEAD is on no remote branch                                                          | 74      |

**Pruning harder is the wrong instrument, and the last two rows say why.** These
trees are days old, not months - none is even 500 commits behind. Doctrine
simply moved faster than they did: the sync script was deleted on 2026-09-02,
which at this repo's merge rate is a few dozen commits ago. Twenty-four have
uncommitted work and seventy-four sit on a HEAD no remote branch contains
(squash-merged under a different sha, or a branch since deleted). Removing
those is exactly the destruction the pruner's three preconditions exist to
prevent.

So the fix is at the moment the staleness can do harm, not at the directory.

### `scripts/ci/check-doctrine-freshness.mjs`, wired into `.husky/pre-push`

CLAUDE.md 10.8.1 already says laws are read from `origin/main` and never from
your local tree. Nothing checked. This does, and it **warns on an ordinary push
and blocks only when the diff touches doctrine** - CLAUDE.md, `docs/LAWS.md`, a
`*.law.test.*`, a workflow, `.agent/**`, `.husky/**`, `docs/HANDOFF*`.

That split is the whole design, not a hedge:

- **Blocking every push from a stale tree** would stall a hundred in-flight
  branches behind a `git merge origin/main` that can conflict. Merge surgery in
  a stale tree is what CLAUDE.md section 12 exists because of; the cure would
  be worse than the disease.
- **The harm is specific.** A stale CLAUDE.md only bites when the agent acts on
  doctrine - writes a law, edits CLAUDE.md, reverts someone's guard. That is
  the exact motion of the hamburger revert war (#2321 -> #2401 -> #2429 ->
  #2432), where each agent reverted the last one back to the rule its own copy
  still carried. Ordinary feature work in a stale tree is not that failure.

Three properties make it safe to put in every agent's hook, and
`tests/unit/doctrineIsReadFromMain.test.ts` pins all three:

1. **It is wired.** A guard nobody calls is a shape this estate has shipped
   before - sixteen invariants once printed "all passed" and ran none.
2. **It fails open.** Any internal error, or an unreadable `origin/main`
   (offline, fresh clone), exits 0 with a note. A freshness advisor that can
   wedge every push in the estate is a worse bug than the staleness it detects.
3. **It calls nothing retired unless `origin/main` agrees.** Each pattern is
   tested against the canonical file first. Without that, the guard becomes its
   own stale law the day doctrine changes back - which is precisely how the
   revert war sustained itself.

It reports four retirements today: the sync script, "The Only Deploy Path",
`build-for-world-hub` as the publisher's name, and the 7am/7pm engine restart
that section 13 replaced with the hourly `:55` break.
