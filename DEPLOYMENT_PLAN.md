# Club Arena Deployment Plan

Status: current. Club Arena owns both of its production release paths. The
World Hub is not a Club Arena publisher.

## Player Frontend

1. Work on an isolated branch and merge current `origin/main` into it when
   needed. Never push directly to protected `main`.
2. Run the relevant tests and production build, commit normally, and push the
   branch with hooks enabled.
3. `agent-open-pr.yml` opens the pull request. Autopilot merges only after the
   required gates pass.
4. `.github/workflows/publish-club-arena.yml` builds the exact tip of Club
   Arena `main`, rsyncs it to the Hetzner origin under
   `/srv/club-arena/releases/<ca_sha>/`, and atomically switches `current`.
5. The World Hub contains only the public rewrite from
   `/hub/club-arena/*` to `https://ca-static.smarter.poker`; no Club Arena
   bundle is built, copied, committed, or published there.

The frontend publisher uses the Club Arena repository secrets
`CA_ORIGIN_SSH_KEY`, `CA_ORIGIN_HOST`, and `CA_ORIGIN_HOST_KEY`. Credential
values never belong in this file or a local `.env`.

## Realtime Engine

Server changes use `.github/workflows/auto-deploy-hetzner.yml`. The workflow
builds an immutable image from the exact committed `server/` tree, stages it
immediately, and allows cutover only under the sealed maintenance authority.
Never start, restart, or mutate the Club Arena engine from the World Hub.

The engine workflow uses the Club Arena repository secrets
`HETZNER_SSH_PRIVATE_KEY`, `HETZNER_HOST`, and pinned `HETZNER_HOST_KEY`.
There is no legacy key-name or cross-repository fallback.

## Release Proof

A branch push, merged pull request, or green build is not publication proof.
Before declaring a release complete, verify:

- Club Arena `main` equals the intended merge SHA.
- `https://ca-static.smarter.poker/build-info.json` reports that exact SHA.
- `https://smarter.poker/hub/club-arena/build-info.json` reports the same SHA.
- Any server-changing merge has a successful exact-SHA Hetzner deployment and
  cache-busted `https://engine.smarter.poker/health` reports that version with
  healthy, stable runtime evidence.

See `.github/DEPLOYMENT.md`, `.agent/architecture/deploy-paths.md`, and
`CLAUDE.md` section 1.1 for the detailed contracts.
