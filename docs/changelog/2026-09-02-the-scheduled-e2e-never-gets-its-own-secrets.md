# The scheduled E2E has been failing on its own missing env, not on the product

Date: 2026-09-02
Branch: `fix/the-scheduled-e2e-never-gets-its-own-secrets`

## What is red

`ci.yml`'s scheduled run is the ONLY thing that answers "is main green?" -
`ci.yml` is `on: pull_request`, so the last ten commits on main carry zero
checks. That scheduled run has **0 successes in 17 attempts**, 14 consecutive
failures from 2026-08-30 to 2026-09-02.

Every failure is the same job, `Live Production E2E`, at 8 failed / 278 passed.

## Three of the eight are not product failures

```
Error: Customization commerce certification is enabled but
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_ANON_KEY is missing.
```

`tests/e2e/support/temporaryCustomizationAccount.ts:63` throws when those three
are absent. The `live-e2e` step passes only `SP_EMAIL` and `SP_PASS`.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` **already exist as repository
secrets** and were simply never wired into this job. They are added here.

`VITE_SUPABASE_ANON_KEY` does not exist in either store yet. It is the
PUBLISHABLE key - it already ships inside the browser bundle every player
downloads - so it belongs in repository **variables**, not secrets. It is read
as `vars.VITE_SUPABASE_ANON_KEY || secrets.VITE_SUPABASE_ANON_KEY` so either
home works, and creating it is one field in repository settings.

## This change cannot make anything worse

When a referenced secret or variable does not exist, GitHub substitutes an
empty string. Until the publishable key is set, this step behaves byte for byte
as it does today. The job is scheduled-only (`if: github.event_name ==
'schedule'`), so it touches no pull request, gates no merge, and cannot reach
production.

## What is still genuinely red after this

Five failures remain and they are real, listed so nobody reads a partial fix as
a whole one:

- `financial-decision-human-path.spec.ts` x2 - insurance dialog, element not found
- `production-customization-realtime.spec.ts:278`
- `tournament-watch.spec.ts:144`
- `club-data-deep.spec.ts:60`

## The larger point, not fixed here

The daily "is main green" run **skips five of the six required checks**.
`TypeScript Check`, `Production Build`, `Stub Gate`, `CSS Beat E2E` and
`What changed` are all reported as skipped in every scheduled run; only the
unit and server suites actually execute. And `Auto-Revert Broken Commit` is
named `(DISABLED)` in the workflow.

So the safety net that exists because squash merges build trees no pull request
ever tested is itself running a third of the gate. That is a deliberate
restructuring with a cost discussion attached, not a line to change quietly, so
it is recorded here rather than done.
