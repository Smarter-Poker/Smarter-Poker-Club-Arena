# Preference: Agents Complete The Release

**Type:** PREFERENCE

**Date:** 2026-04-17

**Revalidated:** 2026-09-10

**Scope:** All sessions and agents.

Never hand Dan a terminal command to finish an agent's work. The responsible
agent completes the repository workflow, follows it to a terminal result, and
reports the evidence.

For Club Arena specifically:

- Publish frontend builds only through
  `.github/workflows/publish-club-arena.yml` in the Club Arena repository.
- Deploy the engine only through
  `.github/workflows/auto-deploy-hetzner.yml` in the Club Arena repository.
- Use an exact SHA already reachable from Club Arena `main` and the workflow's
  non-forced path. It deliberately has no force input.
- Never instruct another agent or Dan to SSH to a host, run a local deploy
  script, restart Docker, copy a bundle into World Hub, or invoke Vercel.
- Do not stop at dispatch. Verify the workflow's terminal success and the
  exact live SHA from the owning Hetzner endpoint.

When local execution is unavailable, report the concrete blocker instead of
manufacturing an alternate publication path.
