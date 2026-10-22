# 2026-10-22: the strength leagues score their own runs

## What was wrong

Every Horse strength league (phases 10 to 13) uploaded one artifact per shard
attempt, often more than a hundred, and stopped there. Qualifying a run meant
downloading every artifact by hand, running the assembler locally and
committing the evidence. The agent workspace cannot download artifacts (its
proxy blocks the blob store), so the downloads fell to Dan, one browser save
dialog per artifact.

## What changed

`horse-phase10/11/12/13-strength-league.yml` each gain an `assemble` job that
runs after every shard job has finished, whenever the plan succeeded:

1. checks out the exact `inputs.source_sha`;
2. downloads every attempt this run uploaded (`p102-*`, `p112-*`, `p122-*`,
   `p132-*`) into one runs directory, one directory per artifact name, which is
   the layout `gh run download` writes and the assembler expects;
3. installs the root packages (the assembler formats with the repository's
   pinned prettier) and the server packages;
4. runs the existing `server/scripts/phaseNN-strength-assemble.mjs` with
   `--out=../docs/evidence/phaseNN/<sha8>/strength-<date>[-<variant>]` and
   `--qualification=../docs/evidence/phaseNN/<sha8>/phaseNN-qualification-<date>[-<variant>].json`;
5. writes the assembler's JSON verdict (or its refusal) to the run summary;
6. mirrors the qualification and `strength.json` (not the runs directory)
   under `server/release-evidence/`, as the generation 4 and 5 commits did;
7. commits and pushes to a new branch
   `horse-evidence/phaseNN-<variant>-<sha8>-run<run_id>` (with `-a<attempt>`
   added on a re-run attempt, so a re-run never collides with the first push).

Phase 10 uses the fixed variant `plo4` in the branch name.

## Boundaries

- The workflow stays `contents: read`; only the `assemble` job holds
  `contents: write`, and its single push names `refs/heads/horse-evidence/...`.
  It never pushes to main, never opens or merges a pull request, and a push
  made with the workflow token starts no other workflow.
- An assembler refusal (exit 2) fails the job, pushes nothing, and puts the
  named reasons in the run summary. A not-qualified verdict is evidence and is
  pushed like a qualified one.
- It writes no Phase 11, 12 or 13 completion record. Selecting a generation
  and adopting the evidence on main stays a reviewed pull request.
- The job starts only after the matrix ends, so it never adds to the shared
  eight-runner bound (`tests/unit/horseStrengthCapacity.test.ts`).

Pinned by `tests/unit/horseStrengthLeagueAssembles.test.ts`.
