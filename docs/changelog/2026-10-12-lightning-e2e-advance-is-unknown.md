# 2026-10-12: a publish during the Lightning operator certificate is UNKNOWN, not red

## What failed

Post-Deploy E2E runs 38206133852 and 38244592617 went red in "Certify the
authenticated Lightning operator cold loads". The spec
(`tests/e2e/production-lightning-operator.spec.ts`) ended each test with

    expect(provenance.ca_sha ?? provenance.sha ?? provenance.commit).toBe(process.env.LIVE_SHA)

where `LIVE_SHA` was the SHA the job recorded before its first browser. In run
38244592617 it expected `a426015d` and received `11b06ffa`: a later commit on
protected main, published while the browsers ran. Nothing was wrong with the
live site. The publisher fires on every merge, so this comparison failed
whenever a merge landed during the run.

## Cause

The Lightning spec carried its own bare SHA equality. Every other release
question in this workflow is classified by `scripts/ci/production-e2e-provenance.mjs`
(`release-window` for the whole job, `bracket` for the Phase 1 journeys, the
lineage step for spec checkout after PR #6685), which separates a forward
publish on protected main (could not tell) from a rollback or an off-lineage
SHA (a real anomaly). This one check had been left behind.

## Change

- The Lightning step reads `build-info.json` immediately before and after its
  browsers (`release-bracket/lightning-before.json`, `lightning-after.json`)
  and preserves the Playwright exit code through the closing read.
- A new step, "Classify the release the Lightning operator certificate ran
  against", runs `production-e2e-provenance.mjs bracket` on those reads:
  - exit 0: both reads are the recorded SHA, `certified=true`;
  - exit 3, `superseded`: `::warning::UNKNOWN: production advanced during
certification (...)` plus a `NON-VERDICT` line in the step summary;
  - exit 3, `unknown`: an unreadable read, reported as UNKNOWN;
  - anything else (rollback, SHA off this lineage, SHA that resolves to no
    commit): `::error::Lightning operator release mismatch ...`, exit 1.
- The spec no longer compares SHAs. It asserts the served `build-info.json`
  names one full `ca_sha` and records it as a `served-release` annotation.
  `LIVE_SHA` is no longer passed to the step, so a spec taken from an older
  deployed commit by the spec-checkout step cannot reintroduce the bare
  comparison during the transition.

## Pinned by

`tests/production-e2e-provenance.law.test.ts`, describe "the Lightning
operator certificate classifies a release that moved under it": the step's
before/run/after order, no `LIVE_SHA` in the step or spec, and the extracted
classification script run against a throwaway git repository for exact
(certified), forward (UNKNOWN, exit 0), rollback (named error, exit 1) and
off-line (named error, exit 1). The fixture strips the `GIT_*` local
environment so a hook-run suite cannot touch the pushing repository.
