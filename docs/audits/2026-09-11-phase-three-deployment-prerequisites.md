# Phase Three Deployment Prerequisites

Tracked-source review for the 109-item accounting programme, CA-03-01 through CA-03-12. This note identifies release gates. It is not production deployment, migration application, browser, or engine-adoption evidence.

## Ordered Boundaries

1. Verify and apply the tested entry and terminal-v2 expansions through their reserved migrations. Preserve their exact source and metadata gates.
2. Prove compatible frontend and engine adoption. Read fresh public build-info and the database engine leader, resolve each observed version to a full commit, and verify required implementation commits are ancestors.
3. Run the complete `scripts/deploy/phase-three-strict-tournament-cutover.sql` only after its native acceptance and current production prerequisites pass. Reserve a new migration through `node scripts/new-migration.mjs "description"`. Production DDL remains one transaction and respects the current database break-window exclusion. No forced restart or lock retry loop.
4. Activate versioned final-deal consent separately with `scripts/deploy/phase-three-activate-versioned-final-deal.sql` after its expansion, native acceptance, and compatible frontend/engine adoption. Stage B does not install this proposal trigger.
5. Publish through normal hooks, CI, automatic PR merge, and the existing publisher. Verify both `https://ca-static.smarter.poker/build-info.json` and `https://smarter.poker/hub/club-arena/build-info.json` contain the accepted merge. Source, database, frontend, and engine evidence are separate.

## Stage B Prerequisites

| Authority                               | Accepted Body MD5 In Current Prepared Script                            |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Stage A private request hook            | `ab227471f29f2944ebd64909622b6af7`                                      |
| Already contracted private request hook | `d21a055b448febe83c1637371b150100`                                      |
| `claim_tournament_lease_v2`             | `d1b5100c2b9f92bec5fd1680b0b4f230`                                      |
| `heartbeat_tournament_leases_v4`        | `5e6c99545e07c21efcb50e5cb3441c14`                                      |
| Mystery reveal                          | `5578ec53c8a531eeba47d448ae9af1b1`                                      |
| Terminal public wrapper                 | `96a61ea5e16560735bcb70b355aa79ab`                                      |
| Terminal private core                   | `90f7506df2f1a94fe22952714fcd9f85`                                      |
| Terminal receipt reader                 | `bb4b0e1d1c758943fca29f9a83d064e4`                                      |
| Place writer, before / contracted       | `d0262f4928b12eea1cc5e9175cbf2737` / `2fb9eb9761e248315f36df617e519512` |

The script additionally requires exact owner, security-definer, search-path and ACL contracts; complete final-deal-v2 functions; the atomic seat-first creator; absence of both legacy seat-first repair doors; all exact protocol-2 lease/launch/hand authorities; and exact-seat expansion markers. Its relation locks serialize the retirement boundary.

It refuses a fresh protocol-1 tournament lease (heartbeat within 30 seconds), any capacity origin without a canonical receipt, and active final-deal settlement/payment evidence in RUNNING or COMPLETING events. The protocol-1 lease check does not independently prove engine source ancestry. Do not treat it as an adoption substitute.

The transaction activates all seven financial guards, contracts the public obligation payer, installs the private PostgREST hook and four row-scope guards, and retires the legacy payout repair functions, dispatch rows, cron paths, lease doors, and nine/eleven-argument hand doors. Its postflight checks these boundaries before commit. Historical financial findings remain unchanged.

## Engine Dispatch And Evidence

The current `.github/workflows/auto-deploy-hetzner.yml` accepts `ref_sha`; it has no `force` input. A normal GitHub Actions dispatch uses this body:

```json
{ "ref": "main", "inputs": { "ref_sha": "<accepted merged full SHA>" } }
```

Submit to the repository Actions endpoint for `auto-deploy-hetzner.yml/dispatches` only when an equivalent active deployment does not already cover the target. It stages immediately and waits for the normal maintenance certificate. Do not send the older `force:false` input.

The authoritative adoption witness is a fresh `public.engine_leader.engine_version` heartbeat, matched to public engine health and source ancestry. The workflow's strict proof requires the database witness; a green workflow or staged image alone proves no adoption. `scripts/ci/prove-engine-version-moved.mjs` can send in-app notifications on failure, so it is not a read-only diagnostic command.

## Separate Consent Activation

The consent activation installs `require_exact_final_deal_proposal`, removes direct app-role vote writes, and retires the one-argument vote RPC. Its current bare `CREATE TRIGGER` is fresh-install-only. For any repeat-application rehearsal, first add exact, gated idempotence; do not skip or weaken the proposal requirement. The current engine calls the terminal/proposal RPCs and heartbeat v4, but only observed deployed ancestry certifies production compatibility.
