# Sentry → Claude → PR Autofix

**Status**: Phase 5.2.0 — dry-run mode. Every fix produces a draft PR
that a human reviews and merges. No auto-merge yet.

## What it does

When Sentry captures an error in Club Arena, a webhook fires that
invokes Claude (via `POST api.anthropic.com/v1/messages`) with the
issue's stack trace and relevant source files. Claude proposes a
minimal patch; the pipeline applies it, opens a PR, links the Sentry
issue, and (eventually) auto-merges after CI passes.

```
Sentry issue
   │
   ▼
┌─────────────────────────┐
│  /webhooks/sentry       │   services/sentry-autofix/
│  HMAC verify            │   → Docker container on engine-01
│  policy gate            │   → fronted by Caddy at
│  dedup + rate limit     │      engine.smarter.poker/webhooks/sentry
│  repository_dispatch ───┼──────────────────────┐
└─────────────────────────┘                      │
                                                 ▼
                                      ┌──────────────────────┐
                                      │ GitHub Action        │
                                      │ sentry-autofix.yml   │
                                      │                      │
                                      │ fetch issue + event  │
                                      │ build Claude prompt  │
                                      │ POST /v1/messages ───┼──► api.anthropic.com
                                      │ parse <patch>        │
                                      │ git apply            │
                                      │ denylist check       │
                                      │ open draft PR        │
                                      │ update Supabase      │
                                      └──────────┬───────────┘
                                                 ▼
                                         PR in main repo,
                                         labelled sentry-autofix-draft
                                         → CI runs → human merge
```

## Components

| Component           | Location                                                                       | Purpose                                           |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Webhook receiver    | `services/sentry-autofix/`                                                     | HMAC-verifies Sentry, dedupes, dispatches         |
| Fix runner          | `.github/workflows/sentry-autofix.yml` + `scripts/sentry-autofix/`             | Calls Claude, applies patch, opens PR             |
| Dedup + audit table | `supabase/migrations/20260420120000_autofix_attempts.sql`                      | One row per attempt, partial-unique on open issue |
| Policy (paths)      | `scripts/sentry-autofix/policy.mjs` + `services/sentry-autofix/src/policy.mjs` | Denylist + allowlist                              |
| Runbook             | `docs/runbooks/09-sentry-autofix.md`                                           | Kill switch, revert, escalation                   |

## Safety gates

**Denylist (hard block — Claude never touches these)**

- `CA/src/engine/**`, `server/src/engine/**`
- `supabase/migrations/**`
- `middleware.ts`, `**/auth/**`, `**/ledger/**`
- `pages/api/admin/**`, `pages/api/debug/**`, `pages/api/emergency/**`
- `vercel.json`, `.github/workflows/**`
- `package.json`, lockfiles, `.env*`
- `lib/supabaseAdmin*`
- Own tooling (`services/sentry-autofix/`, `scripts/sentry-autofix/`) — no self-rewrite

**Allowlist (Phase 5.2.2 auto-merge eligibility)**

- `pages/hub/**`, `components/**`, `styles/**`
- `public/hub/club-arena/**`, `docs/**`
- `src/components/**`, `src/pages/**`, `src/hooks/**`, `src/lib/**`

**Pre-dispatch gates (in webhook receiver)**

- Kill switch (`AUTOFIX_ENABLED=false` → 202)
- Sentry project allowlist
- Action filter (only `created`/`unresolved`/`triggered`)
- Level filter (`fatal` → on-call runbook, not autofix)
- Issue-type filter (skip performance/sampling issues)
- Explicit denylist tags (`no-autofix=true`, `alert=pagerduty`)

**Runtime gates (in GH Action)**

- HMAC-verified upstream
- Rate limits: 3 PRs/hour, 10 PRs/day org-wide
- Denylist check BOTH pre-call (on Sentry stack) and post-apply (on diff)
- Structured XML response required; parse fails → attempt marked errored
- `<cannot_fix>` response handled cleanly (no PR opened)

## Secrets inventory

| Secret                      | Location                                  | Notes                                                         |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `SENTRY_WEBHOOK_SECRET`     | engine-01 `.env`, Sentry webhook settings | HMAC, generate with `openssl rand -hex 32`                    |
| `SENTRY_AUTH_TOKEN`         | GH Actions secrets                        | scopes: `project:read org:read event:read`                    |
| `ANTHROPIC_API_KEY`         | GH Actions secrets                        | `sk-ant-api03-...`                                            |
| `AUTOFIX_GITHUB_TOKEN`      | GH Actions secrets (optional)             | PAT to open PRs from the runner; defaults to `GITHUB_TOKEN`   |
| `GITHUB_DISPATCH_TOKEN`     | engine-01 `.env`                          | fine-grained PAT, `repository_dispatch: write` on target repo |
| `SUPABASE_SERVICE_ROLE_KEY` | engine-01 `.env` + GH Actions secrets     | for autofix_attempts writes                                   |

## Deploy checklist (Phase 5.2.0 bring-up)

1. **Supabase migration**

   ```bash
   cd smarter-poker-club-arena
   # Apply via Supabase SQL editor or the migration CLI:
   psql "$SUPABASE_DB_URL" -f supabase/migrations/20260420120000_autofix_attempts.sql
   ```

2. **engine-01 deploy**

   ```bash
   ssh root@engine.smarter.poker
   mkdir -p /opt/sentry-autofix && cd /opt/sentry-autofix
   rsync -a /opt/club-arena/services/sentry-autofix/ ./
   cp .env.example .env
   $EDITOR .env   # fill in all secrets
   chmod 600 .env
   docker compose up -d --build
   docker compose ps
   curl -fsS http://127.0.0.1:8787/health
   ```

3. **Caddy**
   Extend the `engine.smarter.poker {}` vhost with:

   ```
   handle /webhooks/sentry {
       reverse_proxy 127.0.0.1:8787
   }
   ```

   Then `systemctl reload caddy`. Smoke test from any network:

   ```bash
   curl -fsS https://engine.smarter.poker/webhooks/sentry \
     -X POST -H 'content-type: application/json' -d '{}' \
     -H 'sentry-hook-signature: x' -i
   # Expect 401 (bad signature) — confirms the route is wired.
   ```

4. **GitHub secrets** on `Smarter-Poker/Smarter-Poker-Club-Arena`:
   Settings → Secrets and variables → Actions →
   - `ANTHROPIC_API_KEY`
   - `SENTRY_AUTH_TOKEN`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - (optional) `AUTOFIX_GITHUB_TOKEN`

5. **Sentry webhook**
   - Go to the Sentry project settings → Alerts → Create Alert Rule:
     When: _An event is seen_ (or _An issue is first seen_ for quieter)
     Then: _Send a notification via a custom webhook URL_
   - URL: `https://engine.smarter.poker/webhooks/sentry`
   - Shared secret: same `SENTRY_WEBHOOK_SECRET` as engine-01.
   - Select projects: `club-arena-client`, `club-arena-engine`.

6. **Verify end-to-end**
   - In the Sentry project, send a test event (bot.issue.send_test).
   - Webhook log on engine-01 shows `msg=dispatched`.
   - GitHub → Actions tab → Sentry Autofix workflow run appears.
   - After ~1–3 min, a PR labelled `sentry-autofix-draft` opens against
     main with the patch and Sentry issue link.

## Stage roadmap

- **5.2.0** (this) — dry-run. Draft PRs only. Ship week 1.
- **5.2.1** — mirror pipeline into `Smarter-Poker-World-Hub` for WH +
  Commander + all API errors.
- **5.2.2** — review dry-run accuracy. If ≥80% of PRs are correct and
  merged, flip auto-merge for allowlist paths (components/hub pages/
  styles/docs). Keep denylist untouched.
- **5.2.3** (future) — loop detector: if same fingerprint reopens
  within 1 h of a merged autofix, revert + tag `no-autofix=true`.

## Non-goals

- No retry logic on a failed Claude call. A single fetch/call failure
  marks the attempt `errored` and frees the dedup slot; the next Sentry
  event for the same issue gets a fresh attempt.
- No auto-rebase. If the PR goes stale, human merges or closes.
- No Dependabot-style batching. One issue → one PR.
