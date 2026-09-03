CONTEXT: Platform Architecture
DATE: 2026-03-29

THREE-SERVICE ARCHITECTURE:

1. Vercel — Frontend at smarter.poker (World Hub repo, auto-deploys)
2. Hetzner VPS — Poker engine server (server/ directory, Node.js + PM2)
3. Supabase — PostgreSQL + Auth + Realtime (kuklfnapbkmacvwxktbh.supabase.co)

KEY URLS:

- Production: https://smarter.poker/hub/club-arena/
- Engine: engine.smarter.poker (Hetzner VPS)
- Supabase: kuklfnapbkmacvwxktbh.supabase.co

DEPLOYMENT PIPELINE:

1. Make changes in Club Arena repo
2. npm run build (Vite → dist/)
3. bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub
4. Push World Hub to GitHub → Vercel auto-deploys

SERVER DEPLOYMENT:

- Push to Hetzner VPS via git pull + PM2 restart
- Uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS)

GIT CONFIG:

- Hooks bypassed: git config core.hooksPath /dev/null
- Always run npx tsc --noEmit before committing

SUPABASE CREDENTIALS:

- Login: daniel@bekavactrading.com / 215SlalomCt!
