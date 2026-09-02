# Credentials Map

No raw values are recorded here.

| System | Purpose | Variable / secret name | Storage | Consumer / notes |
|---|---|---|---|---|
| Supabase | Public client API URL | `VITE_SUPABASE_URL` | local `.env`; Vercel project env | Vite client and Supabase bootstrap |
| Supabase | Public anonymous client key | `VITE_SUPABASE_ANON_KEY` | local `.env`; Vercel project env | Browser client; this is public configuration, not a service-role key |
| Vercel | Deployment authentication | Vercel CLI/account token managed by Vercel tooling | local Vercel auth store / account | CLI and deployment API; never commit |
| PostHog | Client analytics | `VITE_POSTHOG_KEY` | deployment env | Analytics initialization when enabled |
| Sentry | Browser error reporting | `VITE_SENTRY_DSN` | deployment env | Client observability |
| OneSignal | Notifications | `VITE_ONESIGNAL_APP_ID` | deployment env | Notification bootstrap |
| Engine/game server | Runtime endpoints | `VITE_ENGINE_URL`, `VITE_GAME_SERVER_URL`, `VITE_USE_ENGINE_WS` | deployment env | Engine/WebSocket clients |
| Media | Media base URL | `VITE_MEDIA_BASE` | deployment env | Runtime asset resolution |

Templates exist at `.env.example`, `server/.env.example`, `infra/monitoring/.env.example`, `services/sentry-autofix/.env.example`, and `scripts/windows_piosolver/.env.example`.

The isolated preview required `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; they were configured in the Vercel project without placing values in Git. Server-side/service-role credentials were not needed for the visual preview and must never be exposed to the client.
