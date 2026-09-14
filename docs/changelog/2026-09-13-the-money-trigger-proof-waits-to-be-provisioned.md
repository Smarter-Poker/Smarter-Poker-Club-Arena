# 2026-09-13 - The money trigger proof waits to be provisioned

Branch `fix/money-trigger-proof-waits-to-be-provisioned`. One workflow, one
`if:`.

## What was wrong

`money-trigger-recovery.yml` shipped on 2026-09-12 as a bootstrap: its own
header says the reporter app must be provisioned "before the separate
activation change". But its `pull_request_target` trigger was already live,
so on every pull request in the repo the `Mint check-only reporter` step ran
`actions/create-github-app-token` with an empty `MONEY_TRIGGER_REPORTER_APP_ID`
and died at "client-id must be set". Six pull requests in one afternoon, all
red on a check that nobody could act on and that reported nothing about the
code in them. That is the 10.83 / 10.86 shape: a signal that answers when it
cannot tell, and a red that trains everyone to ignore red.

## What changed

The `verify` job's `if:` now requires `vars.MONEY_TRIGGER_REPORTER_APP_ID` to
be set on the pull-request path. Until it is, a pull request run is SKIPPED -
which is the honest outcome: the proof did not run. Skipped is neither a
success that `money-trigger-proof.mjs` would accept as a proof (it requires
`conclusion === 'success'`), nor a failure that `check-main-is-green` would
page on. The `workflow_dispatch` path from `main` is unchanged: it mints no
reporter and runs as before.

## What activates it

Not an agent (CLAUDE.md 10.84). The repository variable
`MONEY_TRIGGER_REPORTER_APP_ID` and, in the `money-trigger-recovery-trusted`
environment, the secret `MONEY_TRIGGER_REPORTER_PRIVATE_KEY`, for a GitHub App
with `checks: write` and nothing else. The moment the variable exists the
`if:` is true and the pull-request path runs exactly as the bootstrap wrote it.
