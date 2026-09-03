# Handoff: branch protection on Club Arena main

**Why this is a handoff and not work I did:** RULE 0 permits a handoff only for
things an agent genuinely cannot do. This qualifies twice over — the available
PAT is fine-grained and lacks `administration` scope (`403 Resource not
accessible by personal access token` on
`repos/Smarter-Poker/Smarter-Poker-Club-Arena/branches/main/protection`), and
the repo is private, so rulesets require GitHub Pro. Both are account-level.

## Why it matters

On 2026-08-21 main was rewound to `ada755ab3` and four commits were dropped —
all four already built, synced, and serving in production. `main-rewind-guard`
and `silent-revert-guard` now _detect_ that within a minute, and a new drift
step catches production running code main has lost. None of them can **prevent**
it: by the time a workflow runs, the push has landed. Protection is the only
preventive control.

## What to turn on

Settings → Branches → add a rule for `main`:

- **Do not allow force pushes** ← the one that matters
- **Do not allow deletions**
- Require status checks to pass: `Silent Revert Guard`, `Main Rewind Guard`,
  and the client-test job in `build-for-world-hub.yml`
- Leave "Require a pull request" **off** — several agents push straight to main
  by design, and requiring PRs would stop all shipping.
- Include administrators, or the rule protects nobody who can rewind.

## Alternative if Pro is not wanted

Grant a token `administration: write` on this repo and an agent can apply the
same settings via the API in one call.

## Then fix the stale documentation

`Smarter-Poker-World-Hub/CLAUDE.md` §11.4 lists `branch-protection-watchdog.yml`
as a permitted scheduled workflow that "auto-corrects main branch protection".
That workflow does not exist on main in either repo. Either restore it or strike
the line — as written it advertises a safety net that is not there.
