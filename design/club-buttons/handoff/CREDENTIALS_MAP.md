# Credentials Map

No raw values are recorded here.

| System | Purpose | Variable / secret name | Storage | Consumer / notes |
|---|---|---|---|---|
| Supabase | Public client API URL | `VITE_SUPABASE_URL` | Club Arena build configuration | Vite client and Supabase bootstrap |
| Supabase | Public anonymous client key | `VITE_SUPABASE_ANON_KEY` | Club Arena build configuration | Browser client; public configuration, never a service-role key |
| Hetzner static origin | Frontend publication | `CA_ORIGIN_HOST`, `CA_ORIGIN_SSH_KEY`, `CA_ORIGIN_HOST_KEY` | Club Arena repository secrets | `publish-club-arena.yml` only |
| Hetzner engine | Engine publication | `HETZNER_HOST`, `HETZNER_SSH_PRIVATE_KEY`, `HETZNER_HOST_KEY` | Club Arena repository secrets | `auto-deploy-hetzner.yml` only |
| PostHog | Client analytics | `VITE_POSTHOG_KEY` | Club Arena build configuration | Analytics initialization when enabled |
| Sentry | Browser error reporting | `VITE_SENTRY_DSN` | Club Arena build configuration | Client observability only |
| OneSignal | Notifications | `VITE_ONESIGNAL_APP_ID` | Club Arena build configuration | Notification bootstrap |
| Engine/game server | Runtime endpoints | `VITE_ENGINE_URL`, `VITE_GAME_SERVER_URL`, `VITE_USE_ENGINE_WS` | Club Arena build configuration | Engine/WebSocket clients |
| Media | Media base URL | `VITE_MEDIA_BASE` | Club Arena build configuration | Runtime asset resolution |

Templates exist at `.env.example`, `server/.env.example`, and `infra/monitoring/.env.example`. The retired Windows solver worker no longer carries a database-credential template; certified solver hosts use distinct HMAC gateway secrets and never a Supabase key. The Sentry autofix receiver and its credential template were retired; normal Sentry error reporting remains observability only and cannot dispatch code changes.

Vercel credentials and World Hub publication tokens are intentionally absent:
neither system publishes Club Arena. Server-side/service-role credentials must
never be exposed to the client or to pull-request workflow code.
