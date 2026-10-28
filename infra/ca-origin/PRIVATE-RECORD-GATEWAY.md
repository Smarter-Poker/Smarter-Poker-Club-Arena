# Independent record gateway preparation

This is an offline candidate. Nothing here has been installed or activated.
Paid Supabase record delivery remains enabled. The ordinary client and native
publisher configurations deliberately keep the new endpoint empty.

## Verified host prerequisites, October 27

Read-only provider inventory and trusted SSH established separate origin and engine machines. The origin snapshot had about 93 GiB free disk and 6.9 GiB available RAM; this is capacity evidence, not sustained gateway qualification. Node 20.20.2 meets the locked dependency minimum but differs from the planned Node 22 build. Installed Caddy is 2.11.4; local route qualification used 2.11.7. Required attestation verification flags are available in installed gh 2.99.0.

Gateway admission is blocked. The runtime account, service, socket/release paths, root helper, configuration and trust roots are absent. The public health path returns SPA HTML. The current `ci` identity has effective unrestricted passwordless sudo. Adding the candidate narrow sudoers file is additive and cannot establish publisher isolation. Do not activate this publisher under a claim that `ci` cannot change root-owned controls. A qualified separate least-privilege identity and canonical credential binding, or a separately scoped privilege correction, is required; preserve existing estate access. Other root-capable publishers remain part of the host trust boundary.

The inspected native publication job has no environment binding; the repository owner is a user, so there is no organization variable inheritance. `CAPGO_OTA_ENABLED`, `CAPGO_CHANNEL` and `CAPGO_TOKEN` are absent, and the last inspected successful publisher skipped its native job. This proves the inspected publication path is off, not which versions existing devices run. Capgo/App Store authentication and existing Google Play distribution access were unavailable in the dedicated audit tabs. No account setup, credential or OTA change was made. Paid delivery remains required for older cached/native compatibility.

## Host and route

Use the existing Club Arena static-origin host, which the deployment architecture
identifies separately from the engine host. Verify that separation from actual
provider inventory and machine identities before installation; different DNS
names alone do not establish different machines. Verify spare capacity for two
bounded gateway generations while connections drain. No new paid VPS is assumed.

The maintained origin Caddyfile adds only `/private-record/*` to the existing
site. It strips that prefix and proxies to the Unix socket
`/run/ca-private-record-gateway/active.sock`. The later qualified client endpoint
is `https://ca-static.smarter.poker/private-record`; `/ws/channel` is appended by
the existing socket client. Origin/JWT/session/topic authorization still applies.
Browser and current Capacitor origins are explicitly enumerated, not wildcarded.
The gateway has no public TCP listener in this host configuration.

The systemd template runs an exact immutable revision under `ca-record-gateway`,
with group `caddy`, no capabilities, a read-only system, private temporary storage,
and writes limited to its own revision socket directory. Limits are 256 MiB,
50% of one CPU, 64 tasks and 1,024 descriptors. It has no dependency on an engine
unit, engine container, engine release, lease-renewal worker or engine pause.

The default Caddy logger removes credential-bearing WebSocket subprotocol,
Authorization and Cookie fields, including proxy errors. The real local Caddy
qualification checks this on an actual 502. Keep existing host log configuration
and unrelated sites when installing the maintained change; never replace an
unknown aggregate Caddyfile with a single-site file. Validate the final host
configuration before reloading it. The active socket can change afterward
without a Caddy reload or interrupting existing sockets.

## Prepared provider route

There is still one publisher: `publish-club-arena.yml`, with its existing static
concurrency group and default-branch event authority. A later repository event
may select `component: private-record-gateway` together with the exact full
current-main `ref_sha`. Ordinary pushes still select the client. A gateway event
cannot publish the static/native client, retain a client runtime receipt or
claim a client browser certificate. The post-deploy gate recognizes the separate
component only when its actual gateway activation step succeeded; gateway
failures stay failures.

The gateway builder compiles only its dependency graph with the dedicated
TypeScript configuration. The tested validation payload is about 11 MiB including
locked production dependencies; gateway-owned compiled code is about 408 KiB.
It excludes the game engine graph and all compiled test payloads. Local artifacts
are explicitly `validationOnly`, and the host rejects them.

Hosted artifacts are built without origin secrets, sealed by exact file hashes,
packed, and attested with GitHub OIDC on hosted runners. The attestation action
is pinned to its verified v4.2.2 commit. The install job uses the dedicated `ca-record-publisher` account and
`CA_RECORD_GATEWAY_SSH_KEY`, with the existing pinned origin host key. It uploads only the archive and verification
bundle, then invokes the preinstalled restricted root helper. It never copies an
engine environment file or grants the publisher a general root shell/systemctl.

The host copies the transfer into a root-owned private staging directory, verifies
its signature using root-owned trusted Sigstore roots, requires this repository's
numeric identity 1132369872, the exact protected publisher identity and main ref,
and refuses self-hosted-runner provenance. It then safely extracts only regular
files/directories with bounded count/size and verifies the signed manifest's
revision, producer run and every file. Unsigned/self-asserted hash manifests are
not sufficient authority to install a service that can read server credentials.
Hosted signing and verification are prepared but have not run under the live hold.

## One-time host prerequisites, not performed

Install through the configured, authorized infrastructure administration route;
ordinary origin publishing credentials do not imply this bootstrap already exists.
Do not weaken sudo rules or use an unrelated credential if access is missing.

- Root-owned `/srv/ca-private-record-gateway` and `releases/`, not group/world
  writable. `incoming/` alone is writable by the existing `ci` publisher.
- Root-owned `/run/ca-private-record-gateway`, not writable by the app or publisher.
  A root-managed tmpfiles rule must recreate this parent on boot. Revision socket
  directories are created by the activation operation and assigned to the app.
- Dedicated non-login service account `ca-record-gateway`; existing `caddy` group.
- Root-owned systemd template and enabled boot unit from this directory (do not enable
  individual revision units), and installed root-owned Node
  activation/artifact modules under `/usr/local/lib/ca-private-record-gateway/`.
- Root-owned restricted shell wrapper at
  `/usr/local/libexec/ca-private-record-gateway-activate`, and its narrow sudoers
  entry validated by `visudo -cf`. The wrapper discards caller environment.
- Supported `/usr/bin/node`, `/usr/bin/python3`, `/usr/bin/gh`; the GitHub CLI must
  support the prepared offline attestation flags. Linux-only systemd unit checks
  run in the required hosting CI step; they were not executable on this Mac.
- Root-owned, publisher-immutable GitHub/Sigstore trusted root metadata at
  `/etc/club-arena/github-actions-trusted-root.jsonl`, obtained through the
  documented GitHub trusted-root mechanism, not from the incoming publisher.
- Root-owned mode0600 `/etc/club-arena/private-record-gateway.env` containing the
  canonical Supabase Auth/API settings and its dedicated session-mode/direct
  `PRIVATE_RECORD_GATEWAY_DATABASE_URL`. Supply values through the canonical
  secret store; no credentials were retrieved or created here. Do not put port,
  revision or socket overrides in that file. Raw DB identity needs CONNECT/LISTEN,
  not financial writes; preserve TLS verification and never use transaction pooling.
- Root-owned mode0600 `/etc/club-arena/private-record-gateway-host.json` with actual
  `originMachineIdSha256`, `engineMachineIdSha256`, and `independentHostVerified`.
  The origin ID is checked against the actual local machine and must differ from
  the qualified engine ID. Retain the dated provider evidence for both; refresh
  it after any host replacement/move. Source configuration alone does not prove
  separation, capacity, TLS, or current installed credentials.

The root helper rejects missing prerequisites. Existing configured secret-name
metadata was checked; that is not proof these new host prerequisites exist.
No bootstrap, signing run, route reload, service start, secret write or source
switch was attempted.

## Activation, failure and retirement

One host-owned operation locks the component and records its exact revision,
producer run, predecessor and phases durably. It verifies and installs a fresh
root-owned read-only release. It starts that revision's unit, proves its private
source readiness, compares the predecessor again and atomically swaps the socket
symlink. It then verifies public HTTPS identity/readiness. Failure restores only
that operation's pointer and stops its candidate. Unknown/incomplete operations
retain their ledger/lock and require explicit recovery; no automatic retry loop
or second publisher is introduced.

After successful activation, SIGUSR2 asks the predecessor to stop accepting new
peers. Existing authorized peers retain updates; their final close owns shutdown.
A dedicated boot unit restores only the root-owned committed `active-release.json`;
individual revision units are not enabled, so retired generations do not restart
on reboot. The verified record is committed only after public route proof.
That event closes its listener/socket/process, and `Restart=on-failure` does not
restart a normal drained exit. An explicit failure to begin retirement is retained
as a recovery item, not hidden as cleanup success. Old immutable source releases
are not deleted by a sweeping job. Remove a retired release only after actual
inactive-unit/no-peer and rollback-retention evidence, using its original owner.

This activation does not certify an authenticated consumer or disable Supabase.
Required later proofs include real scoped authentication, revocation, browser and
native origin/CSP behavior, primary outage/listener recovery, exact client build
identities, and complete legacy coverage. Never fault active production games.

## Legacy-client release boundary

Independent hosting solves the new client's engine-outage path. It does not teach
already running or cached legacy bundles that endpoint. Keep the paid source on
through the initial gateway and compatible-client releases. Global source-off
requires both a complete current connection/topic census and a persistent tested
returning-client compatibility boundary; the dated acceptance matrix is in
`../../docs/changelog/2026-10-27-private-record-hosting-and-legacy-coverage-boundary.md`.
Neither is currently verified. The local coverage command only triages evidence;
it is not a subscriber collector or an authority to switch traffic. A failed or
unavailable census must never be converted to an empty subscriber list.

The exact held rollout, operation identity bindings, failure/rollback decisions
and hosted/browser/physical-native acceptance matrix are in
[Gateway rollout and verification](PRIVATE-RECORD-ROLLOUT.md). These are prepared
steps for a later authorized operation; paid delivery remains enabled.

## Protected first-install bootstrap candidate, October 28

The existing publisher now admits an explicit `private-record-bootstrap` component
through the same default-branch/current-main authority and concurrency. It requires
the separately provisioned canonical secrets `CA_RECORD_GATEWAY_SSH_KEY` and
`PRIVATE_RECORD_GATEWAY_DB_PASSWORD` before any host mutation. The runtime
`PRIVATE_RECORD_GATEWAY_DATABASE_URL` is derived from canonical endpoint metadata,
the dedicated role and this new password; no URL secret or copied engine credential
is required. `CA_RECORD_GATEWAY_SSH_KEY` was provisioned through the canonical GitHub store
on October 28 at 15:35:45 UTC (public fingerprint
`SHA256:Qx+ijr7nz3HJM5eyd+Fiznabh1AXS4RDPO7RuHVa0TY`). The new canonical `PRIVATE_RECORD_GATEWAY_DB_PASSWORD` was provisioned on October 28
at 15:48:41 UTC. No existing identity was rotated. The protected NOLOGIN role
migration and explicit credential installation remain pending. It never aliases an engine connection or origin private key.
The existing `ci` administration identity supplies the one-time infrastructure
operation; its estate access is preserved and remains in the host trust boundary.
Only the dedicated publisher receives the activation-helper sudo grant.

The bootstrap refuses an active gateway, same-machine topology, existing dedicated
publisher/configuration, unknown prior operations, unverified TLS, or any aggregate
Caddy bytes differing from the reviewed `private-record-gateway.caddy-preimage`.
A mismatching host configuration must be retained and reviewed in source before
this operation can proceed; it is never replaced with a guessed single-site file.
Source/systemd/sudoers validation precedes route changes; route CAS, static build
identity proof and exact-predecessor rollback protect existing origin serving.
Failed/unknown bootstrap records require explicit recovery; rerunning is not repair.
It installs only inert prerequisites and enables committed-state boot restoration.
It does not start a gateway generation, expose the client endpoint or change paid
delivery. This source and fake-adapter regression proof do not certify real Linux
bootstrap, credentials, signing, deployed routing or authenticated failover.

The dedicated connection role is `ca_record_gateway` (or the Supavisor
`ca_record_gateway.kuklfnapbkmacvwxktbh` identity), not `postgres` or an engine
role. Canonical API configuration is pinned to PokerIQ-Production's project.
The protected migration `20261028154533` creates this role NOLOGIN, without
application grants. The explicit `private-record-credentials` publisher component
then checks effective permissions, installs only its first-login SCRAM verifier
and verifies a fresh TLS LISTEN connection. Bootstrap itself never rotates
credentials. Those source paths have not been applied to production.

Bootstrap and activation now share normalized machine-ID hashing, including the
normal trailing newline; the mismatch discovered during source review is fixed
and pinned. Required hosting qualification now invokes disposable Linux
containers exercising real root files, users, sudo denial, Caddy route CAS and
rollback. It has no external network during scenarios. Its service-manager
adapter uses real unit verification/enable and real Caddy reload, but it does
not represent a systemd PID1/reboot certificate. Docker is unavailable locally,
so those Linux scenarios are pending hosted CI, not claimed passing.

## Dedicated credential qualification

A canonical newly generated password and the existing canonical admin URL are
separate inputs. Only endpoint/project metadata is retained when constructing
the dedicated connection: both username and password are replaced, documented
Supavisor session port 5432 is selected, and inherited URL options are discarded.
The provider sends a SCRAM verifier instead of plaintext password SQL. An owned
marker/fingerprint and one transaction prevent adopting or rotating an existing
enabled role; unknown acknowledgment or post-commit connection failure keeps
the committed identity for explicit readback/verification. No secret is printed.

NOINHERIT is not treated as a denial of PUBLIC permissions. Admission examines
effective table and column DML, schema/database creation, ownership, membership
and every accessible application SECURITY DEFINER. The six existing inherited
PUBLIC routines were read in full on October 28 and pinned by exact definition
hashes: read-only leaderboard/rank/staff/challenge functions and a trigger that
only transforms its NEW row. Any additional/changed privileged routine refuses
admission; no global PUBLIC grants are revoked. The listener retains existing
PUBLIC harmless capabilities, such as temporary objects; CONNECT-only is not
a claim that PostgreSQL PUBLIC inheritance disappears.

The isolated PG17 qualification passed real role creation, PUBLIC table/column
write denial, unreviewed definer refusal, verified TLS/SCRAM authentication,
wrong-password/untrusted-CA refusal, a committed LISTEN notification, replay
refusal and no-rotation re-entry. Production role installation and credential
provider outcomes remain pending. Bootstrap now verifies that dedicated session
and its effective privileges before touching the origin.
