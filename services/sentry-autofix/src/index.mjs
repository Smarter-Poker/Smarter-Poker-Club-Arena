// Entry point for the Sentry autofix webhook receiver.
//
// Boots an Express server on PORT (default 8787), bound to 127.0.0.1 by
// docker-compose — reachable externally only through the Caddy vhost at
// https://engine.smarter.poker/webhooks/sentry.
//
// Responsibilities:
//   1. Verify Sentry HMAC signature (`Sentry-Hook-Signature` header).
//   2. Filter to an allowlist of Sentry project slugs.
//   3. Dedupe / rate-limit via Supabase `autofix_attempts`.
//   4. Fire a GitHub `repository_dispatch` event the autofix workflow
//      listens on.
//   5. Always respond quickly (<2s) so Sentry doesn't retry.
//
// This service NEVER calls the Anthropic API directly and NEVER modifies
// code. Those steps happen inside the GitHub Action, which runs in a
// sandboxed CI environment with repo-scoped GITHUB_TOKEN.

import { createServer } from './server.mjs';

const port = Number(process.env.PORT || 8787);
const app = createServer();

app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    msg: 'sentry-autofix webhook listening',
    port,
    enabled: process.env.AUTOFIX_ENABLED !== 'false',
    allowedProjects: (process.env.SENTRY_ALLOWED_PROJECTS || '')
      .split(',').map(s => s.trim()).filter(Boolean),
    repo: process.env.GITHUB_REPO,
    time: new Date().toISOString(),
  }));
});

// Graceful shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(JSON.stringify({ level: 'info', msg: `received ${sig}, shutting down` }));
    process.exit(0);
  });
}
