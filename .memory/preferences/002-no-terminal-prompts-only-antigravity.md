# PREFERENCE: No Terminal Prompts — Antigravity Only

**Type:** PREFERENCE
**Date:** 2026-04-17
**Scope:** All sessions, all agents (Claude / Cowork / AntiGravity / any AI), binding.

## The Rule

NEVER hand Dan a terminal command to run. Dan pilots via Antigravity, not Terminal.

No bash prompts. No "run this in your terminal." No SSH instructions. No `./deploy-hetzner.sh` directed at Dan. No `bash scripts/foo.sh` directed at Dan.

## What To Do Instead

If a task needs a shell step Claude cannot execute from its own sandbox (examples: SSH to Hetzner `178.156.160.206`, running `server/deploy-hetzner.sh`, `docker restart`, anything requiring local SSH keys), Claude MUST output an **Antigravity prompt** — a single self-contained instruction block formatted for an Antigravity agent to pick up and execute on Dan's behalf.

## Antigravity Prompt Format

- One contiguous code block so Dan can copy-paste it into Antigravity in one action.
- Self-contained: includes the task, the exact command(s), success criteria, and what to report back.
- No "please run" language directed at Dan — it is directed at the Antigravity agent.
- Assume the AG agent has full local shell access, SSH keys, and can read the repo.

## Example (the correct pattern)

Instead of saying to Dan: "Please run `bash server/deploy-hetzner.sh` in your terminal."

Output an Antigravity prompt like:

```
TASK: Redeploy Club Arena engine to Hetzner to recover BUG 022 (single-table fleet stall).

STEPS:
1. cd ~/Documents/Smarter-Poker-Club-Arena
2. bash server/deploy-hetzner.sh
3. Poll https://engine.smarter.poker/health every 3s for 30s
4. Report back the final /health JSON

SUCCESS: /health returns "activeTables": 2 or higher (confirms the stuck fleet-discovery loop restarted and picked up the newly-seated test table 59938155-11ba-440f-9017-66019a2d697e).

FAIL: if /health stays at activeTables:1 after 30s, run `ssh root@178.156.160.206 "docker logs --tail 80 club-arena-engine"` and paste the logs.
```

## Why

Dan is not in a terminal. He works through the Antigravity agent runner. Dropping terminal commands on him is friction — the AG agent can execute them directly with zero hand-off.

## Enforcement

This applies to every session going forward. Any agent that tells Dan to open a terminal or run a shell command gets corrected.
