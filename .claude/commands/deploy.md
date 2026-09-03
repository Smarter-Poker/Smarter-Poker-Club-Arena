---
description: Deploy Club Arena engine to Hetzner VPS (Docker + SSH)
allowed-tools: Read, Bash, Edit, Write, Glob, Grep
argument-hint: [optional: "quick" for skip pre-checks, or commit message to describe what's being deployed]
---

# Deploy Club Arena Engine to Hetzner VPS

Deploying: $ARGUMENTS

Read the deploy skill first:

```
Read /sessions/intelligent-stoic-darwin/mnt/club-arena/.claude/skills/deploy-hetzner/SKILL.md
```

Then execute this deployment pipeline:

## Phase 1: Pre-Flight Checks

1. **Check git status** — confirm working tree is clean and all changes are committed + pushed:

   ```bash
   cd ~/Documents/Smarter-Poker-Club-Arena && git status && git log --oneline -5
   ```

2. **TypeScript check** — zero errors required before deploying:

   ```bash
   cd ~/Documents/Smarter-Poker-Club-Arena && npx tsc --noEmit
   ```

   If errors exist, STOP. Fix them before deploying.

3. **Baseline health check** — confirm server is currently alive:
   ```bash
   curl -sf "https://engine.smarter.poker/health" | python3 -m json.tool
   ```
   Record the current uptime and stats.

If argument is "quick", skip TypeScript check but still verify git and health.

## Phase 2: Deploy

4. **Execute the deploy** — pull, build, restart:

   ```bash
   ssh root@178.156.160.206 "cd /opt/club-arena && git pull origin main && cd server && docker build -t club-arena-engine . && docker stop club-arena-engine 2>/dev/null; docker rm club-arena-engine 2>/dev/null; docker run -d --name club-arena-engine --restart always -p 8080:8080 --env-file /opt/club-arena/server/.env club-arena-engine"
   ```

5. **Wait and verify**:
   ```bash
   sleep 5
   curl -sf "https://engine.smarter.poker/health" | python3 -m json.tool
   ```

## Phase 3: Post-Deploy

6. **Verify health** — confirm `"running": true` and uptime is near zero (fresh start).

7. **If health check fails**, immediately check logs:

   ```bash
   ssh root@178.156.160.206 "docker logs --tail 50 club-arena-engine"
   ```

   Then diagnose and fix.

8. **Report** — summarize:
   - What was deployed (commit hash + message)
   - Pre-deploy stats vs post-deploy stats
   - Any issues encountered

9. **Update MIGRATION-CHANGELOG.md** with deploy timestamp and summary.
