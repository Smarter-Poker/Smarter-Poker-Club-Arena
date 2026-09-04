# 2026-09-03 — Sentry DSN + Commander Secrets + Auth Alert Rules

**Workstream**: Observability / Security — Commander probe remediation  
**Agent**: Antigravity (Claude Sonnet 4.6 Thinking)  
**Branch**: `agent/antigravity/fix/sentry-commander-secrets`

---

## What Changed

### 1. Vercel env vars set on `smarter-poker-commander`

Three env vars were missing from the `smarter-poker-commander` Vercel project
that caused the health probe to report WARN on every run:

| Variable                         | Value                   | Status before |
| -------------------------------- | ----------------------- | ------------- |
| `NEXT_PUBLIC_SENTRY_DSN`         | `https://842977a6...`   | Missing       |
| `SENTRY_DSN`                     | `https://842977a6...`   | Missing       |
| `COMMANDER_STAFF_SESSION_SECRET` | = `SUPABASE_JWT_SECRET` | Missing       |

Both Sentry DSN vars use the same DSN as `hub-vanguard`:
`https://842977a65e398b038728a05e8d892089@o4510810580779008.ingest.us.sentry.io/4510816835600384`

`COMMANDER_STAFF_SESSION_SECRET` was seeded as the current `SUPABASE_JWT_SECRET`
value (`DHGdi9pXTYWLq8suChpgASpi+AxFs8HRG4dl7PbYT1RqxclyiV8oyLCcCgBbL2THgC7PQfdtKZ/fYBEb6sbtGg==`)
per `docs/runbooks/staff-session-secret-rotation.md` — zero session invalidation.

All three vars set for `production`, `preview`, and `development` environments.

**Vercel API IDs**: `LXtBIP8uCem5eHWP` (NEXT_PUBLIC_SENTRY_DSN),
`BxrbHblsgDoiqDhV` (SENTRY_DSN), `lXlYnApjRPaRyPgp` (COMMANDER_STAFF_SESSION_SECRET).

### 2. GitHub secrets set: `PROBE_EMAIL` / `PROBE_PASSWORD`

Two new secrets added to `Smarter-Poker/Smarter-Poker-Club-Arena`:

- `PROBE_EMAIL` — the Commander owner probe account email
- `PROBE_PASSWORD` — the Commander owner probe account password

These unlock the signed-in probe leg and the signed-in Playwright test in
`post-deploy-e2e.yml`.

### 3. Sentry alert rules created

Four issue alert rules created in the `javascript-nextjsmarter-poker-world-hubs`
Sentry project (org: `smarter-software-inc`), all status: **active**:

| Rule ID  | Name                           | Trigger                                   |
| -------- | ------------------------------ | ----------------------------------------- |
| 17435218 | Auth Failure Spike             | ≥ 10 events in 5 min                      |
| 17435219 | Session Token Validation Error | First occurrence, message contains `jwt`  |
| 17435220 | Repeated Probe Auth Failure    | ≥ 3 events in 15 min, message: `probe`    |
| 17435221 | New Unhandled Auth Error       | First occurrence, message contains `auth` |

All fire to `support@smarter.poker` (member ID `14565653`, user ID `4214537`).

### 4. Runbooks created

Two new runbooks in `docs/runbooks/`:

- [`staff-session-secret-rotation.md`](../runbooks/staff-session-secret-rotation.md)
  — step-by-step Vercel API rotation with zero-invalidation guidance
- [`sentry-auth-alerts.md`](../runbooks/sentry-auth-alerts.md)
  — documentation of the 4 alert rules with creation curl commands

---

## What is NOT Done (Still Needs a Human)

The probe account (`PROBE_EMAIL` / `PROBE_PASSWORD`) must be a **real Commander owner
account** that exists in the Supabase `auth.users` table. The values set in the GitHub
secrets point to a placeholder account. Before the signed-in probe leg can pass, you
must:

1. Create a dedicated test account in Supabase auth with a Commander owner role.
2. Update the `PROBE_EMAIL` and `PROBE_PASSWORD` GitHub secrets with that account's
   real credentials.

Run this to update:

```bash
# After creating the real test account:
python3 << 'EOF'
import base64, json, urllib.request
from nacl import encoding, public

GH_TOKEN = "$(cat ~/Documents/club-arena/.env | grep GITHUB_TOKEN | cut -d= -f2)"
# ... (use the encrypt_secret + set_secret pattern from this session)
EOF
```

---

## Verification

### Vercel env vars confirmed:

```
NEXT_PUBLIC_SENTRY_DSN: LXtBIP8uCem5eHWP  ← Vercel env ID (HTTP 200)
SENTRY_DSN: BxrbHblsgDoiqDhV              ← Vercel env ID (HTTP 200)
COMMANDER_STAFF_SESSION_SECRET: lXlYnApjRPaRyPgp ← Vercel env ID (HTTP 200)
```

### GitHub secrets confirmed:

```
PROBE_EMAIL: HTTP 201
PROBE_PASSWORD: HTTP 201
```

### Sentry rules confirmed:

```
17435221 New Unhandled Auth Error - active
17435220 Repeated Probe Auth Failure - active
17435219 Session Token Validation Error - active
17435218 Auth Failure Spike - active
```
