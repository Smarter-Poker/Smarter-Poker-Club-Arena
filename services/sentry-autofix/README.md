# services/sentry-autofix

Sentry webhook receiver. Runs on engine-01 as a Docker container,
listens on `127.0.0.1:8787`, and is fronted by Caddy at
`https://engine.smarter.poker/webhooks/sentry`.

See the top-level design doc at [`docs/sentry-autofix.md`](../../docs/sentry-autofix.md)
and the operator runbook at [`docs/runbooks/09-sentry-autofix.md`](../../docs/runbooks/09-sentry-autofix.md).

## Local dev

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENTRY_WEBHOOK_SECRET, GITHUB_DISPATCH_TOKEN
npm install
npm test                # unit tests for HMAC verify + policy gate
npm run dev             # watch mode on :8787
```

## Deploy (engine-01)

```bash
ssh root@engine.smarter.poker
cd /opt/sentry-autofix
# copy .env in place (mode 600)
docker compose up -d --build
docker compose logs -f
```

## Endpoints

| Method | Path             | Auth           | Purpose                 |
| ------ | ---------------- | -------------- | ----------------------- |
| GET    | /health          | none           | liveness probe          |
| POST   | /webhooks/sentry | HMAC signature | Sentry webhook receiver |

The webhook receiver does NOT call Anthropic directly — it only fires
`repository_dispatch` at GitHub. The fix runner lives in
`scripts/sentry-autofix/` and runs inside a GitHub Action.
