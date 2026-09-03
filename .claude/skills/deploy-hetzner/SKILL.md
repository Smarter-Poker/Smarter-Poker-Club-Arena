---
name: deploy-hetzner
description: >
  Deploy the Club Arena poker engine server to Hetzner VPS via SSH + Docker.
  Use when the user says "deploy", "push to server", "deploy to hetzner",
  "deploy engine", "update VPS", "restart server", "ship it", "deploy to production",
  "push server changes", or anything about getting code changes onto the live
  engine.smarter.poker server. Also triggers on "hetzner", "VPS deploy", "docker deploy",
  or "server deploy". Use this even if the user just says "deploy" with no qualifier —
  Club Arena's server deployment always means Hetzner.
version: 1.0.0
---

# Deploy to Hetzner VPS — Club Arena Engine

This skill handles deploying the Club Arena poker engine to the production Hetzner VPS.
The engine runs at `engine.smarter.poker` and serves all real-time poker game logic.

## Infrastructure

| Component   | Detail                                       |
| ----------- | -------------------------------------------- |
| VPS IP      | `178.156.160.206`                            |
| SSH User    | `root`                                       |
| Repo on VPS | `/opt/club-arena`                            |
| Container   | `club-arena-engine`                          |
| Port        | `8080` (mapped through Docker)               |
| Env file    | `/opt/club-arena/server/.env`                |
| Health URL  | `https://engine.smarter.poker/health`        |
| Docker      | Container auto-restarts (`--restart always`) |

## Pre-Deploy Checklist

Before deploying, the agent should verify these conditions are met. If any fail, stop and fix before deploying.

1. **TypeScript compiles cleanly**: Run `npx tsc --noEmit` in the repo root. Zero errors required.
2. **Changes are committed and pushed**: Run `git status` — working tree must be clean. Run `git log --oneline -3` to confirm latest commit is what we want to deploy.
3. **Health check baseline**: Hit `https://engine.smarter.poker/health` to confirm the server is currently running and note the uptime/stats before deploy (so we can compare after).

## Deploy Sequence

The deploy uses SSH to execute commands on the VPS. Here's the exact sequence:

### Step 1: Pull latest code

```bash
ssh root@178.156.160.206 "cd /opt/club-arena && git pull origin main"
```

### Step 2: Rebuild Docker image

```bash
ssh root@178.156.160.206 "cd /opt/club-arena/server && docker build -t club-arena-engine ."
```

This takes 30-90 seconds depending on cache hits.

### Step 3: Stop and remove old container

```bash
ssh root@178.156.160.206 "docker stop club-arena-engine 2>/dev/null || true && docker rm club-arena-engine 2>/dev/null || true"
```

Brief downtime starts here (typically 2-5 seconds).

### Step 4: Start new container

```bash
ssh root@178.156.160.206 "docker run -d --name club-arena-engine --restart always -p 8080:8080 --env-file /opt/club-arena/server/.env club-arena-engine"
```

### Step 5: Health check (wait 3 seconds for startup)

```bash
sleep 3
curl -sf "https://engine.smarter.poker/health"
```

Expected response: `{"running":true,"uptime":N,"activeTables":N,...}`

### Step 6: Cleanup old images

```bash
ssh root@178.156.160.206 "docker image prune -f"
```

## One-Liner (for quick deploys)

If all pre-checks pass, the entire deploy can be run as a single SSH command:

```bash
ssh root@178.156.160.206 "cd /opt/club-arena && git pull origin main && cd server && docker build -t club-arena-engine . && docker stop club-arena-engine 2>/dev/null; docker rm club-arena-engine 2>/dev/null; docker run -d --name club-arena-engine --restart always -p 8080:8080 --env-file /opt/club-arena/server/.env club-arena-engine && sleep 3 && curl -sf http://localhost:8080/health"
```

## Rollback

If the health check fails after deploy:

1. Check container logs: `ssh root@178.156.160.206 "docker logs --tail 50 club-arena-engine"`
2. If the new code is broken, revert to previous commit:
   ```bash
   ssh root@178.156.160.206 "cd /opt/club-arena && git log --oneline -5"
   # Identify the last good commit, then:
   ssh root@178.156.160.206 "cd /opt/club-arena && git checkout <good-commit-hash>"
   ```
3. Rebuild and restart using Steps 2-5 above.

## SSH Access Notes

The VPS uses SSH key authentication. The agent's environment needs:

- An SSH private key in `~/.ssh/` that matches an authorized key on the VPS, OR
- `sshpass` installed for password-based auth, OR
- The user to run the commands from their local terminal (which has SSH keys configured)

If SSH is not available from the current environment, generate the one-liner command and present it to the user to run from their Mac terminal where SSH keys are already set up.

## Post-Deploy Verification

After a successful deploy, always:

1. Hit the health endpoint and confirm `"running": true`
2. Compare uptime — it should be near zero (fresh container)
3. Note active tables and tournaments — they should be restored from database state
4. Update `MIGRATION-CHANGELOG.md` with the deploy timestamp and what was deployed

## Environment Variables (on VPS)

The container reads from `/root/.env.club-arena` which contains:

- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key (bypasses RLS)
- `PORT` — 8080

These are already configured on the VPS. Do not modify them unless explicitly asked.
