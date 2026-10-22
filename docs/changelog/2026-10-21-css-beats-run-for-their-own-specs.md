# The CSS Beat Job Runs When Its Own Specs Change

`scripts/ci/classify-ci-changes.mjs` decides whether a pull request admits the
CSS Beat browser job through a hand-typed list of browser test paths. That list
had rotted: 21 of the 26 specs the job runs were missing, including
table-proportions, top-rail-seat, pot-above-chips and hero-card-row, and so was
`tests/e2e/fixtures/`. PR #7627 changed `table-proportions.spec.ts` and its
bundled artwork, was classified as not touching the app, and merged with the
browser job skipped. Its own regression never ran in CI.

The classifier now reads the job instead of restating it: every spec named in
the `css-beats-e2e` block of `ci.yml`, the spec each `npm run test:e2e:*` there
selects through its Playwright config, and the support, fixture, helper and
screenshot directories those specs read. Adding a spec to the job admits it with
no second list to keep in sync. Markdown notes still admit nothing, and
production-only specs the job does not run are unchanged.

It fails open. If the workflow, `package.json` or a config cannot be read, or
the job yields no spec, every `tests/e2e/` change admits the browser job.

Validation: `tests/unit/fixtureNativeCi.test.ts` parses the job independently
as YAML and requires every spec it runs to admit it, pins the PR #7627 inputs,
keeps production-only specs and notes off the build, and requires the
could-not-tell answer for an unreadable workflow. Eight of the new cases fail
against the previous classifier; all 707 pass with the fix.
