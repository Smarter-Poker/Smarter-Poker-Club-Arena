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
