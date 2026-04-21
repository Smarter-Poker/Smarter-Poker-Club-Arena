# Runbook — Sentry Autofix Loop

**When to use this runbook**

- A Sentry autofix PR is open and looks wrong.
- The autofix loop is mis-firing (too many PRs, repeated attempts on the
  same issue, PRs opening against denylisted paths).
- You want to pause the autofix loop temporarily.
- A merged autofix caused a regression.

**Prerequisites**

- SSH to engine-01 (`178.156.160.206`) — for the webhook service.
- GitHub repo admin on `Smarter-Poker/Smarter-Poker-Club-Arena`.
- Supabase SQL editor access — for inspecting `autofix_attempts`.

---

## Pause the loop (kill switch)

Flip the env var on engine-01 and restart the container. This makes the
webhook return `202` without dispatching, so new Sentry issues stop
triggering fixes within ~5 seconds.

```bash
ssh root@engine.smarter.poker
cd /opt/sentry-autofix
# Edit .env: set AUTOFIX_ENABLED=false
sed -i 's/^AUTOFIX_ENABLED=.*/AUTOFIX_ENABLED=false/' .env
docker compose restart
curl -fsS http://127.0.0.1:8787/health | jq
```

Re-enable by setting `AUTOFIX_ENABLED=true` and restarting again.

---

## Inspect recent attempts

```sql
select created_at, status, sentry_project_slug, short_id, title,
       claude_confidence, fix_pr_url, error_message
from autofix_attempts
order by created_at desc
limit 50;
```

Rollup view:

```sql
select * from autofix_attempts_summary where hour > now() - interval '24 hours';
```

---

## Close a bad PR and revert an autofix merge

1. Close the PR on GitHub with a comment explaining why.
2. If the PR was already merged:
   ```bash
   git checkout main
   git pull
   git revert <commit-sha>
   git push origin main
   ```
3. Mark the attempt as `errored` in Supabase so dedup frees up:
   ```sql
   update autofix_attempts
   set status='errored',
       error_message='human revert: <reason>'
   where fix_pr_url = 'https://github.com/.../pull/123';
   ```
4. If Claude keeps trying to re-fix the same root cause, add a tag
   `no-autofix=true` to the Sentry issue (Sentry UI → Issue → Tags).

---

## Loop detection — the fix didn't actually fix

If the same issue fingerprint reopens within 1 hour of a merged autofix,
that's a loop signal. The policy currently does **not** auto-detect this
— to add manual protection:

```sql
-- Recent reopen after merged autofix
select a.sentry_issue_id, a.fix_pr_url as bad_fix, b.created_at as reopened_at
from autofix_attempts a
join autofix_attempts b on a.sentry_issue_id = b.sentry_issue_id
where a.status = 'merged'
  and b.status = 'queued'
  and b.created_at between a.updated_at and a.updated_at + interval '1 hour';
```

For each hit: revert `a.fix_pr_url`, tag the Sentry issue `no-autofix=true`.

---

## Blocked PRs (denylist hit)

If a PR is labelled `sentry-autofix-blocked`, Claude proposed a fix but
the diff touched a denylisted path (engine, migrations, auth, ledger,
admin/debug/emergency APIs, etc.). The PR is diagnostic-only — do not
merge. Instead:

1. Read the `<explanation>` in the PR body to understand the root cause.
2. Manually implement the fix with the appropriate caution for the
   affected subsystem.
3. Close the autofix PR and delete its branch.

---

## Rate limits

Default: 3 PRs / hour, 10 PRs / day (org-wide). Exceeding these returns
`202` from the webhook with `reason: "hourly rate limit reached"`. To
bump limits for a specific window, edit `/opt/sentry-autofix/.env` and
restart:

```
AUTOFIX_RATE_LIMIT_HOURLY=6
AUTOFIX_RATE_LIMIT_DAILY=20
```

Never raise these above 10/hour or 50/day without a human approving —
Anthropic spend scales linearly.

---

## Service health

```bash
# Quick health check
curl -fsS https://engine.smarter.poker/webhooks/sentry/../health 2>/dev/null \
  || curl -fsS http://127.0.0.1:8787/health  # from engine-01

# Container status
ssh root@engine.smarter.poker 'cd /opt/sentry-autofix && docker compose ps'
# Recent logs
ssh root@engine.smarter.poker 'cd /opt/sentry-autofix && docker compose logs --tail=100'
```

---

## Escalation

- **Autofix bricked prod** → revert the bad merge, flip kill switch,
  file a post-mortem.
- **Anthropic spend spike** → set `AUTOFIX_RATE_LIMIT_DAILY=0` on
  engine-01, restart — this pauses all new dispatches.
- **Claude consistently wrong** → consider a) raising min confidence
  gate in `prompt.mjs` (add "if confidence<high, emit cannot_fix"), or
  b) rolling back to dry-run mode (Phase 5.2.0 → undo Phase 5.2.2).
