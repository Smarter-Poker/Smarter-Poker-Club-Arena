# The Step That Was Too Big To Load

2026-09-22. `.github/workflows/publish-club-arena.yml`,
`.github/scripts/publish-origin-activate.sh`,
`tests/a-workflow-step-fits-what-github-will-run.law.test.ts`.

Club Arena's only publisher stopped loading at 19:24 UTC and nothing reached
production for over an hour. The workflow was not broken by anything a reader
would call a bug: one step grew past a documented platform ceiling, and past
that ceiling GitHub does not fail the step, it refuses to load the file the
step is in.

## What GitHub says, and what it does

From the workflow syntax reference, on `jobs.<job_id>.steps[*].run`:

> "Runs command-line programs that do not exceed 21,000 characters using the
> operating system's shell."

#5090 gave every guard in the publisher a voice, which was right and fixed a
real defect. It also took `publish-to-origin / Publish through the host-owned
immutable transaction` from **17,304 characters to 24,626**. Past the limit:

- the run is named after the **file path** instead of `Publish Club Arena`;
- it is created with **zero jobs** and `created_at == updated_at`, and reads
  as `failure` with no annotation, no log and no failing step to open;
- it is created **for pushes to branches the triggers exclude**, because the
  triggers live in the file GitHub could not read. Two such runs appeared on
  the authoring branch before the merge and were the only warning anyone got;
- `repository_dispatch`, the one documented repair path, produces **no run at
  all**;
- the Actions API's stored workflow name becomes the path.

Not one of those is a message. That is CLAUDE.md 10.86 in its purest form: a
signal that answers when it cannot tell. The check that would have said so is
the workflow that stopped loading.

## Measured

|                                                   | last loading publisher        | after #5090                                            |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| largest `run` step                                | 17,304                        | **24,626**                                             |
| next largest in the whole repository              | 6,160 (`post-deploy-e2e.yml`) | unchanged                                              |
| publisher runs on `main`                          | success `d6c8ed39ea` 19:11    | failure `2785042e4f` 19:24, failure `995999c109` 19:25 |
| `https://ca-static.smarter.poker/build-info.json` | `d6c8ed39ea`                  | `d6c8ed39ea`, for 80 minutes                           |

No other workflow in the repository has a `run` step within 15,000 characters
of the limit, so nothing else was at risk and nothing else has to move.

## The fix

The activation transaction is a file: `.github/scripts/publish-origin-activate.sh`.
The step pipes it to the origin exactly as the heredoc did:

```
timeout 180s ssh "${SSH_OPTIONS[@]}" "$ORIGIN_USER@$ORIGIN_HOST" bash -s -- \
  "$ORIGIN_ROOT" "$SHA" "$EXPECTED_SHA" "$STAGE_NAME" "$KEEP_RELEASES" \
  "${{ github.repository }}" \
  < "$GITHUB_WORKSPACE/.github/scripts/publish-origin-activate.sh"
```

**The origin receives byte-identical input.** The file was extracted from the
parsed `run` string, which is exactly what `bash -s` read, and the two were
compared: 20,963 bytes each, identical. `bash -s` reads the script from stdin
either way and the `--` arguments are unchanged, so the transaction itself is
untouched. The publishing job already checks the repository out at the exact
SHA it is publishing, so the transaction that activates a release is always
the one that release carries.

The publisher's largest step is now **7,431 characters**, with 13,569 of
headroom.

## The guard that was missing

`tests/a-workflow-step-fits-what-github-will-run.law.test.ts` measures every
`run` step in `.github/workflows/` and fails when one passes 21,000. It also
**reports a step past 90% of the limit**, because this defect arrived as one
pull request adding a few hundred characters at a time, and because the cost
of finding out at the ceiling is an unloadable workflow rather than a failed
check. It refuses to be vacuously green: a scan that measures no steps, or
cannot parse a workflow, fails.

Its reader is `Client Unit Tests (vitest)`, a required context in the `main
protection` ruleset (CLAUDE.md 10.86 rule 3).

Mutation tested:

| put back                                 | what the law said                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| main's inlined transaction               | `publish-club-arena.yml publish-to-origin / Publish through the host-owned immutable transaction: 24626 characters` |
| 160 padding lines, still under the limit | `... 20176 of 21000`                                                                                                |

## The pins moved with the mechanism

Five test files read the transaction out of the workflow. Each now reads it
where it lives, and every assertion is unchanged:

- `tests/the-publisher-says-what-it-refused.law.test.ts` (#5090's own law)
  scans the workflow and the script, so every guard still has to say what it
  refused;
- `tests/unit/runtimeAssetRetention.test.ts` reads the script in place of the
  heredoc body, returned with the ten spaces the heredoc carried;
- `tests/unit/deployAndPublishAreHonest.test.ts`,
  `tests/unit/stampBuildProvenance.test.ts` and
  `tests/stamp-build-provenance.test.ts` splice the script back in at the
  pipe, so their ordering assertions read the publisher in the order the
  origin runs it.

## What this does not do

It does not relax one guard, delete one refusal message, or revert any part of
#5090. The fonts defect it fixed stays fixed, and every sentence it added to
the publisher still prints. The only change to what runs is where the bytes
are stored.
