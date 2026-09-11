# Hetzner Club Arena Engine Authority

**Type:** CONTEXT

**Rewritten:** 2026-09-10

**Project:** Smarter Poker Club Arena

The Club Arena repository is the sole source and release authority for the
production game engine at `https://engine.smarter.poker`.

Engine releases use `.github/workflows/auto-deploy-hetzner.yml` only. The
workflow resolves an immutable commit already reachable from Club Arena
`main`, builds and stages the corresponding image, waits for the engine's
maintenance certificate, performs the sealed cutover, and proves the exact
live SHA. It deliberately exposes no force input.

Do not SSH to the host, mutate its checkout, build or restart Docker by hand,
edit runtime credentials, or delegate deployment to World Hub or Vercel.
Local deploy scripts and mutable tags are not recovery paths.

The workflow consumes these write-only Club Arena repository secrets:

- `HETZNER_SSH_PRIVATE_KEY`
- `HETZNER_HOST`
- `HETZNER_HOST_KEY`

Never place their values in Markdown, a tracked environment file, a command,
or another repository. Completion requires the exact target SHA in a terminal
successful workflow and cache-busted live health, followed by the required
runtime stability observation.
