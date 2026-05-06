# Hetzner VPS — Game Engine Server

**Type:** CONTEXT
**Date:** 2026-03-30
**Project:** Smarter Poker Club Arena

## Connection Details

| Field          | Value                                 |
| -------------- | ------------------------------------- |
| IP Address     | `178.156.160.206`                     |
| SSH User       | `root`                                |
| Remote Path    | `/opt/club-arena`                     |
| Container Name | `club-arena-engine`                   |
| Health Check   | `https://engine.smarter.poker/health` |
| Port           | `8080`                                |

## Deploy Process

1. SSH: `ssh root@178.156.160.206`
2. Pull: `cd /opt/club-arena && git pull origin main`
3. Build: `docker build -t club-arena-engine -f server/Dockerfile server/`
4. Restart: `docker stop club-arena-engine; docker rm club-arena-engine; docker run -d --name club-arena-engine --env-file /opt/club-arena/server/.env -p 8080:8080 --restart unless-stopped club-arena-engine`
5. Verify: `curl https://engine.smarter.poker/health`

## Quick Deploy Script

```bash
bash /Users/smarter.poker/Documents/club-arena/server/deploy-hetzner.sh
```

## Notes

- SSH key-based auth (ed25519) set up from Cowork VM
- Docker container runs Node.js game engine
- Auto-restarts via `--restart unless-stopped`
- Health endpoint returns: running, uptime, activeTables, activeTournaments, totalHandsDealt
- Engine serves: POST /action, /timebank, /heartbeat, /preaction, /sitout, /straddle, /state, /rit, /insurance, /showhand, /discard; GET /actions, /health
