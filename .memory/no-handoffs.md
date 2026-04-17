# PREFERENCE: No AntiGravity Handoffs

**Type:** PREFERENCE
**Date:** 2026-04-17
**Priority:** CRITICAL

## Rule

Never generate AntiGravity handoff prompts. Always execute git, build, and deploy commands directly using bash. Only hand off if bash is genuinely broken after attempting it.

Dan wants the agent to DO the work, not describe the work.

## Context

Dan has repeatedly been frustrated by agents generating handoff prompts instead of executing the commands themselves. This is a permanent rule — no exceptions unless bash is verified non-functional.

## Related

- CLAUDE.md deployment pipeline
- git-safe-push.sh workflow
