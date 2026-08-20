# Vercel Deployment — Frontend

**Type:** CONTEXT
**Date:** 2026-03-30
**Project:** Smarter Poker Club Arena

## Project Details

| Field           | Value                                                          |
| --------------- | -------------------------------------------------------------- |
| Vercel Project  | `hub-vanguard`                                                 |
| Project ID      | `prj_op66GkZyZcygXQKm76iyycfVFAQx`                             |
| Domain          | `smarter.poker`                                                |
| Token           | `<REDACTED:VERCEL_TOKEN — read from .env.local, never commit>` |
| GitHub Repo     | `Smarter-Poker/Smarter-Poker-World-Hub`                        |
| Club Arena Path | `public/hub/club-arena/`                                       |
| Production URL  | `https://smarter.poker/hub/club-arena/`                        |

## Deploy Pipeline

1. Build Club Arena: `cd ~/Documents/club-arena && npm run build`
2. Sync to World Hub: `bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub`
3. Commit World Hub: `cd ~/Documents/Smarter-Poker-World-Hub && git add public/hub/club-arena/ && git commit && git push`
4. Vercel auto-deploys from GitHub push (or manual via API)

## Manual API Deploy

```bash
curl -X POST "https://api.vercel.com/v13/deployments" \
  -H "Authorization: Bearer <REDACTED:VERCEL_TOKEN — read from .env.local, never commit>" \
  -H "Content-Type: application/json" \
  -d '{"name":"hub-vanguard","project":"prj_op66GkZyZcygXQKm76iyycfVFAQx","gitSource":{"type":"github","org":"Smarter-Poker","repo":"Smarter-Poker-World-Hub","ref":"main"}}'
```

## Notes

- NEVER deploy to `smarter-poker` project — that's the old one
- `smarter.poker` domain is on `hub-vanguard` project
- Vercel GitHub App may not be installed — manual API deploy may be needed
- World Hub sparse checkout on Cowork VM: `/sessions/intelligent-stoic-darwin/Smarter-Poker-World-Hub`
