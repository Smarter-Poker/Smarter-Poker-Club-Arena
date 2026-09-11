---
description: Dispatch and certify the Club Arena-owned sealed Hetzner engine release
allowed-tools: Read, Bash, Glob, Grep
argument-hint: [optional exact merged commit SHA]
---

# Deploy Club Arena Engine Through Its Sealed Hetzner Workflow

Read `.claude/skills/deploy-hetzner/SKILL.md` completely, then follow it.

Hard boundaries:

- Never SSH to the engine host, build or restart a container by hand, edit its
  environment, or deploy from World Hub.
- Never skip checks or use a force/bypass input. The workflow deliberately has
  no force input.
- The target must be a full commit already reachable from Club Arena `main`.
- A successful dispatch is not a release. The exact target must pass the sealed
  cutover and appear in cache-busted public health while tables keep dealing.

If a target image is already staged, dispatch it immediately toward the current
certified maintenance break instead of waiting for another scheduled tick:

```bash
TARGET_SHA=<exact-merged-sha>
jq -n --arg sha "$TARGET_SHA" \
  '{event_type:"deploy-club-arena-engine",client_payload:{ref_sha:$sha}}' |
  gh api --method POST \
    repos/Smarter-Poker/Smarter-Poker-Club-Arena/dispatches --input -
```

Report the exact target SHA, workflow run, terminal conclusion, sealed-cutover
receipt, live health SHA, and runtime stability evidence.
