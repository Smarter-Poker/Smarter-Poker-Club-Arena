# Gateway rollout, rollback and hosted/native proof

Status: prepared, not executed. The owner holds all live changes. Every mutating
step below is for a later authorized release; this document does not lift that
hold. Keep `supabase_enabled=true` throughout, including rollback. Do not dispatch,
merge, install, reload, start a service, publish an OTA, or change credentials now.

The candidate is on `fix/supabase-cost-01a17eaf`, based on
`a3ab63ce3d534f5584ac047946f653c840b4fbe4`, with uncommitted changes. This base is
not a gateway release target. The existing audit checkpoint and per-file candidate
receipt retain the exact prepared bytes. Bind future release identities only after
protected integration; do not invent SHAs, host identities, run IDs or app versions.

The subsequent read-only host check found that `ci` has unrestricted passwordless sudo and none of the gateway bootstrap files/accounts are installed. The narrow candidate sudoers grant does not restrict existing authority. Gateway admission remains blocked until the publisher privilege boundary is qualified. See the dated prerequisites in [the host contract](./PRIVATE-RECORD-GATEWAY.md). Independent roster/diagnostic delivery is tracked separately in the existing checkpoint; it does not activate this gateway.

## 1. Bind the operation and check access

Use one dated operation record in the existing audit evidence directory. Record:

| Field          | Required binding                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Gateway source | Full protected-main SHA containing the reviewed gateway and controls                                     |
| Build/control  | Publisher workflow SHA, run ID, attempt, signed subject digest and attestation                           |
| Predecessor    | Exact `active.sock` target, committed release record and active units, or verified first-install absence |
| Origin/engine  | Actual separate provider machines, machine-ID hashes, dated inventory and spare capacity                 |
| Route          | `https://ca-static.smarter.poker/private-record` and final aggregate Caddy configuration digest          |
| Client         | Separate full web/native build SHA, publisher result and actual served/installed identity                |
| Native         | iOS/Android OS, binary version/build, embedded/OTA revision, bundle version and selected channel         |
| Compatibility  | Dated readback of paid flag and source fingerprints before/after each component                          |
| Verification   | Each case below: observed result, evidence reference and passed/failed/unknown                           |

Verify existing `CA_ORIGIN_HOST`, `CA_ORIGIN_SSH_KEY`, `CA_ORIGIN_HOST_KEY` metadata
for the one-time protected infrastructure administrator. Gateway activation requires
the separate canonical `CA_RECORD_GATEWAY_SSH_KEY` bound to `ca-record-publisher`,
and bootstrap also requires `PRIVATE_RECORD_GATEWAY_DB_PASSWORD`. The dedicated
key and new password were provisioned on October 28 at 15:35:45 and 15:48:41 UTC;
role migration/credential installation remain pending; never alias an origin key or engine DB URL. Verify the configured infrastructure
administration route separately: the publisher's restricted sudo grant does not
authorize bootstrap or a general root shell. Use canonical secret storage, never
read/copy an engine environment file or supply credentials in chat or commands.

Read current policies, repository `PUBLISHING.md` and the existing checkpoint.
Classify the mixed candidate before any later integration: it also contains a
client correction and a diagnostic-retention migration. A gateway dispatch installs
neither migration nor engine. Do not accidentally install unrelated components or
bypass their required checks. No engine replacement is needed to host this gateway;
existing engine compatibility still needs its affected proof.

## 2. Qualify and bootstrap the independent host

Follow [the host contract](PRIVATE-RECORD-GATEWAY.md). The following are explicit
installation mappings for the authorized infrastructure operation, not proof that
these paths or privileges already exist:

| Reviewed repository file                         | Root-owned destination                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `ca-private-record-gateway@.service`             | `/etc/systemd/system/ca-private-record-gateway@.service`                       |
| `ca-private-record-gateway-boot.service`         | `/etc/systemd/system/ca-private-record-gateway-boot.service`                   |
| `ca-private-record-gateway.tmpfiles`             | `/etc/tmpfiles.d/ca-private-record-gateway.conf`                               |
| `ca-private-record-gateway.sudoers`              | `/etc/sudoers.d/ca-private-record-gateway` (0440)                              |
| `ca-private-record-gateway-activate`             | `/usr/local/libexec/ca-private-record-gateway-activate` (0755)                 |
| `scripts/ci/private-record-gateway-activate.mjs` | `/usr/local/lib/ca-private-record-gateway/private-record-gateway-activate.mjs` |
| `scripts/ci/private-record-gateway-artifact.mjs` | `/usr/local/lib/ca-private-record-gateway/private-record-gateway-artifact.mjs` |
| `scripts/ci/private-record-gateway-boot.mjs`     | `/usr/local/lib/ca-private-record-gateway/private-record-gateway-boot.mjs`     |

Install modules as root-owned regular files, not group/world writable. Provision
`ca-record-gateway` as a non-login user, validate the existing `caddy` group,
create the root-controlled release/runtime roots, and restrict only `incoming/`
to publisher writes. Supply the private mode0600 environment and host-identity
JSON, and root-controlled GitHub/Sigstore trust roots exactly as the host contract
requires. Verify Node 22-compatible runtime, Python, GitHub CLI attestation flags,
verified TLS and a dedicated direct/session-mode LISTEN connection. Do not guess
production role grants, use transaction pooling or print credential values.

Obtain trusted-root contents independently with the supported
`gh attestation trusted-root` mechanism; record retrieval time/digest and install
through the root administration operation. The publishing account/incoming archive
must never supply or replace its own trust roots. This command was checked via
its installed CLI help; trust-root retrieval/installation has not been run.

On the actual Linux host, validate systemd template and boot units with
`systemd-analyze verify`, and validate sudoers with `visudo -cf` before admission.
Register the units and tmpfiles rule; enable only the boot unit, never individual
revision units. The boot unit restores only an already committed release. On a
first install with no committed record, do not manufacture that record or start a
revision outside the signed publisher. Do not reboot a production host to test it.
Qualify boot restoration on an isolated equivalent host; record actual production
unit configuration separately.

Merge only the reviewed route and logger changes into the host's actual aggregate
Caddy configuration. Preserve every unrelated site and its logging configuration.
Validate that exact complete configuration with the installed Caddy binary before
its supported reload. Confirm existing static routes and both client build-info
identities remain unchanged by this infrastructure operation. A first-install
`/private-record/health` 502 before activation is not readiness; clients still
have the endpoint unset at this stage.

Admission stops if machine separation, capacity, credentials, trust roots, route
validation, prior operation state or paid-source readback is unknown. Inventory
active gateway generations before each activation. Allow capacity for the new
unit plus its predecessor; do not add a third generation while an earlier one is
still draining. This is an explicit operation preflight, not an implemented global
generation-count guard. Do not force existing peers off to make capacity appear.

## 3. Publish the gateway only

After a later authorized protected merge and required exact-source checks, bind
`GATEWAY_SHA` to the full current-main SHA containing this candidate. The command
below prepares the exact event body; it does not publish by itself. `ROLLOUT_WORK`
must be a new task-owned external-SSD directory. Never reuse an operation's folder.

```bash
set -euo pipefail
: "${ROLLOUT_WORK:?bind the fresh owned external-SSD operation directory}"
[[ "$ROLLOUT_WORK" == /Volumes/SmarterWork/agent-work/* ]] || exit 1
test -d "$ROLLOUT_WORK"
set -o noclobber
GATEWAY_SHA=$(/opt/homebrew/bin/gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/commits/main --jq .sha)
[[ "$GATEWAY_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
jq -n --arg sha "$GATEWAY_SHA" '{event_type:"publish-club-arena",client_payload:{component:"private-record-gateway",ref_sha:$sha}}' > "$ROLLOUT_WORK/gateway-dispatch.json"
```

Inspect the actual bytes, protected ancestry, required checks and prerequisite
record. Only in the later authorized operation, send that exact file once:

```bash
: "${ROLLOUT_WORK:?bind the same reviewed operation directory}"
/opt/homebrew/bin/gh api --method POST repos/Smarter-Poker/Smarter-Poker-Club-Arena/dispatches --input "$ROLLOUT_WORK/gateway-dispatch.json"
```

Use the existing `publish-club-arena.yml`, not `workflow_dispatch`, an arbitrary
workflow ref or a workstation installer. If main moved before admission, inspect
and requalify the new containing target; do not send an older ancestor to force a
rollback. Read back the owning run from the Actions API, bind its exact component,
selected SHA, event and dispatch time, and follow that run. A successful dispatch
HTTP response is not a successful release. Do not duplicate an unknown dispatch.

Required run evidence:

1. `publish-needed` resolves `component=private-record-gateway` and the admitted
   full SHA. `build-record-gateway` succeeds with locked dependencies, minimal
   TypeScript build and the named gateway/listener/ACL tests.
2. Artifact `private-record-gateway-<SHA>` contains `runtime.tar.gz` and its
   `attestation.jsonl`. Retain the digest and verification result before the
   publisher's seven-day artifact expiry. Local `validationOnly` builds cannot
   substitute for this signed hosted artifact.
3. `publish-record-gateway` succeeds on its fresh hosted runner. The host verifies
   repository ID 1132369872, exact existing publisher/main identity, hosted-runner
   provenance and the sealed inventory using independent root-owned trust roots.
4. The host's `activation-<runId>.json`, exact unit, `active.sock` and
   `active-release.json` agree on the committed revision. Read private records
   through authorized infrastructure access; mode0600 ledgers are not readable
   merely because the `ci` account can invoke the helper.
5. Public health returns HTTP 200, `service=private-record-gateway`, exact
   revision and `sourceReady=true`, with `Cache-Control: no-store`. Require a
   valid HTTPS certificate and no redirect. Use the exact `/health` URL: the
   current server does not accept a cache-busting query string. Request no-cache
   and retain response status/headers and small health JSON without credentials.
6. Read back the paid flag and source readiness. A gateway-only post-deploy gate
   may stand down correctly; it does not provide authenticated client proof.

Use this exact read-only SQL through the configured production database tool at
each compatibility checkpoint; require one row and both boolean fields true:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT now() AS observed_at, supabase_enabled,
       public.fn_private_record_transport_ready() AS source_ready
FROM public.ca_private_record_transport_state
WHERE singleton;
COMMIT;
```

On the origin, the authorized administrator can inspect the nonsecret state with
`readlink /run/ca-private-record-gateway/active.sock`, the two root-private JSON
records, and `systemctl show "ca-private-record-gateway@${GATEWAY_SHA}.service"
--property=ActiveState,SubState,MainPID,Result`, with the operation's validated full
SHA bound in that administration session. Inspect all gateway unit generations
using `systemctl list-units 'ca-private-record-gateway@*.service' --all`.
Never dump the service environment. On first install, absence is expected only
before commitment; after commitment it is a failure, not an empty healthy result.

Current private health startup qualification uses a 45-second retry horizon,
2-second individual probes and 500 ms backoff; the final attempt may finish beyond
that horizon. Public proof has a 5-second timeout. Read actual outcome
and ledger on failure rather than increasing timeouts or looping publication.

## 4. Hosted authentication and failure verification

First use an approved isolated qualification account and empty/zero-balance test
club, with no active games or money probes. Record scope and cleanup ownership.
Never use the owner's personal session. Do not capture JWTs, auth subprotocols,
Cookie/Authorization headers or raw provider credentials in HARs, screenshots or
retained logs. Use sanitized message types, topic aliases and nonsecret receipts.

Verify the public route with the existing protocol: authenticated WebSocket
`/private-record/ws/channel`, bearer subprotocol, `JOIN_PRIVATE_RECORD` for both
exact topic families, authorized `PRIVATE_RECORD_STATUS ready:true`, then actual
`PRIVATE_RECORD_CHANGED` from a normal nonfinancial committed product update.
The source events invalidate readers; confirm the authoritative page read and
visible result, not merely receipt of a frame. Never issue a live financial write
or direct SQL mutation as a test signal.

| Case                      | Procedure confined to qualification sessions                                                        | Required result                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Allowed topics            | Join roster and own authorized member topic, then make a supported cosmetic test-profile update     | Fresh JWT/topic ACL; READY, invalidation and correct authoritative visible read             |
| Topic denial              | Use a real qualification identity lacking that topic                                                | No unauthorized payload; refusal/retirement is distinct from a network outage               |
| Membership revocation     | Remove the isolated qualification membership through supported admin UI, with no funds/seats        | No subsequent private delivery; gateway closes 4403 on fresh authorization refusal          |
| Session invalid           | Revoke only the qualification session through the supported local-session path                      | Invalid session is refused; no other account/session is logged out                          |
| Auth provider unavailable | Exercise against isolated equivalent infrastructure, not a production Auth outage                   | Transient validation failure is unavailable/503, not invalid-session/logout                 |
| Gateway lifecycle         | On an isolated hosted equivalent, disconnect LISTEN and restore it, then drain/replace a generation | Unavailable then fresh READY; authoritative resync; predecessor peers continue during drain |
| Log filtering             | Induce proxy failure on isolated equivalent using nonsecret credential-shaped markers               | Neither request nor response auth/subprotocol markers appear in the resulting logs          |

Do not terminate the production engine, revoke real users or interrupt the live
LISTEN service to complete this matrix. Qualify failures on an isolated hosted
equivalent or by a test-device-only network restriction. Record which evidence
came from that equivalent and which came from production; do not conflate them.

## 5. Publish and verify the compatible client

Only after hosted gateway proof, make a separate protected source change setting
`VITE_PRIVATE_RECORD_FALLBACK_URL` to
`https://ca-static.smarter.poker/private-record` in the web and native build inputs
of the existing publisher. Both are currently literal empty strings. Do not use a
mutable repository variable to bypass reviewed build provenance. No global
protocol-minimum bump, forced reload, cache purge or asset deletion belongs here.

Run affected source/client checks and publish through the same existing route.
Verify exact containing client SHA and provenance at both
`https://ca-static.smarter.poker/build-info.json` and
`https://smarter.poker/hub/club-arena/build-info.json`; preserve the selected gateway
identity separately. Run applicable client browser/live-table verification against
the engine actually serving, without demanding an unrelated engine replacement.
A published new web shell does not prove adoption by any already open window.

Before native distribution, inspect effective `CAPGO_OTA_ENABLED`, selected
`CAPGO_CHANNEL`, account access and exact bundle identity. The publisher uploads
only if its OTA switch is true and origin verification succeeded; the channel
falls back to `production` when unset. Read-only checks on October 27 found neither
variable at repository scope. Organization/effective Actions scope and installed
native distribution remain unverified. Do not interpret repository-level absence
as proof there are no installed apps, or enable/change OTA settings as part of
this preparation. Follow the maintained `docs/APP-STORE-RUNBOOK.md`; no signing key,
store upload, new channel or binary build is created by this document.

Use a verified existing qualification distribution for candidate-device proof.
If a qualification channel/build cannot be identified, record native evidence as
UNKNOWN and resolve the actual distribution route before claiming native readiness.
Do not silently redirect the production channel to create a canary. A successful
web publish or Capgo upload is not an installed-device certificate. Record app ID
`poker.smarter.clubarena`, platform/OS, binary build, actual embedded/OTA SHA,
bundle version, selected channel and successful app-ready receipt.

## 6. Web, cached-client and physical-device acceptance matrix

Run on a fresh compatible web client, one retained bridge-only cached document,
one supported pre-bridge document where available, and the actual supported iOS
and Android distributions. Missing representatives remain UNKNOWN. Preserve one
old installed/native cohort; do not upgrade or reinstall every test device first.

| State                             | Device/session-only action                                                    | Required observation                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal service                    | Open member/roster readers with engine healthy                                | Bridge/new clients: authorized primary READY; pre-bridge clients retain paid. Only an authorized preferred READY retires that client's fallback; visible reads stay current |
| Engine unavailable to this client | Block only the isolated device's engine path; keep gateway/Supabase reachable | New client reaches exact hosted gateway READY and current readers; bridge-only client retains paid compatibility                                                            |
| Gateway unavailable too           | Block gateway only for that same device/session                               | New client retains/rejoins paid path and receives actual invalidations; no forced reload/logout                                                                             |
| Preferred path returns            | Remove the device-local restriction                                           | Fresh READY/resync; retiring fallback callbacks cannot mark the page stale; no duplicate visible effects                                                                    |
| Background and return             | Suspend/app-switch or restore BFCache after supported nonfinancial changes    | Existing wake/join callbacks refresh authoritative readers; no assumption of message replay                                                                                 |
| Token refresh                     | Exercise normal token renewal on the qualification account                    | Fresh authorized intent; no old-identity delivery, permanent stale state or global logout                                                                                   |
| Multiple windows/account switch   | Use separate qualification windows, then A/B/A and local sign-out             | Per-window state and generation fences; no cross-account topic/data delivery                                                                                                |
| Old cached/native return          | Restore the retained old cohort after compatible release                      | Existing exact paid topics still work without forced adoption; this is compatibility, not proof of universal upgrade                                                        |

Use client-local failure controls on a dedicated device/network, preserving normal
TLS verification. Do not apply a firewall/DNS rule shared with players or change
public routing to simulate an outage. If the available tooling cannot isolate the
fault, run it on the hosted equivalent and mark production failure proof unobserved.

For new clients, retained transport evidence must identify which actual endpoint
became READY; a generic "Live" label is insufficient. Paid compatibility fixtures
record `realtime.send` handoff; they do not certify hosted legacy WebSocket receipt.
A native-origin WS test is not a physical-device/CSP/background test. Retain exact
failed/unknown cases and stop exposure of the unqualified new path if they fail.

## 7. Rollback and interruption decisions

| Observed state                                          | Supported next action and proof                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build/signature/preflight failed, no activation         | Existing route must be unchanged. Fix the source/prerequisite and requalify. Do not retry unchanged inputs.                                                                                                                                                                                                                                                                                            |
| Candidate started but not committed                     | Owning installer restores its exact predecessor (or removes its own first-install pointer), stops candidate, records `rolled-back`. Independently read route, unit and ledger.                                                                                                                                                                                                                         |
| Route/stop outcome unknown or `activation.lock` remains | Read the same operation's phase, socket, committed record and exact unit first. No re-dispatch, rerun or lock deletion until explicit recovery is resolved.                                                                                                                                                                                                                                            |
| Public proof failed before commitment                   | Require predecessor identity/health, candidate stopped, no contradictory committed record; first install must return to verified absence. Paid source stays true.                                                                                                                                                                                                                                      |
| Committed new route, retirement failed                  | Keep the verified committed route. Ledger says `requires-explicit-recovery`; recover predecessor retirement through authorized infrastructure operation. Do not roll back the healthy route merely to hide cleanup failure.                                                                                                                                                                            |
| Committed gateway later fails functional proof          | Prepare a protected forward revert/fix of the gateway component, preserving unrelated work and installed migrations; do not blanket-revert the mixed candidate. Build/sign/activate its new current-main SHA through the same gateway publisher. Paid fallback remains available.                                                                                                                      |
| Client fallback exposure fails                          | Protected forward change restores literal empty fallback build inputs and prior compatible behavior; same static/native publisher and actual served/installed readback. Already running documents need functioning gateway or paid failover; new shell publication alone is not their recovery.                                                                                                        |
| Native OTA fails app-ready/device proof                 | Read actual provider/device rollback receipts first; automatic app-ready rollback is not assumed. Otherwise use the protected forward fix/revert and the same native publisher/channel with its new monotonic bundle version. Verify the actual recovered bundle on both platforms; unavailable provider/device readback remains UNKNOWN. Do not invent a rollback CLI or redirect unrelated channels. |

A GitHub rerun keeps its run ID. The host ledger is keyed by that ID and refuses
reactivating an existing operation, even when an attempt number changes. An exact
already-active revision can return a private-health-only no-op before the ledger
check; that is not fresh public activation, retirement or authenticated proof. Inspect the
original durable outcome first. A later corrected dispatch needs its own new run
ID after recovery/preflight, not deletion of the old receipt. Never manually swap
`active.sock`/`active-release.json`, repoint to an older SHA through a stale dispatch,
stop an engine, or bypass signature/root prerequisites as a rollback shortcut.
The current helper has no general `rollback` or `recover` CLI; do not invent one.

After a committed forward recovery, verify new signed subject, exact socket/unit/
public revision, source READY, paid flag true and affected authenticated readers.
Confirm the older unit has actually drained and become inactive before classifying
retirement complete. Do not delete live/draining units, rollback material, incoming
unknown operations or immutable client assets to save disk. Cleanup only the
original operation's proven disposable files after evidence retention.

## 8. Completion record

Close gateway activation only with signed hosted build, committed host readback,
public TLS/source proof, authenticated topic/ACL proof and actual retirement state.
Close client/native adoption only with their separate served/installed identities
and required matrix results. Keep preparation, hosted qualification, production
installation, client exposure, physical-device proof and cleanup as distinct fields.
All unexecuted items in this document are pending, not passing.

The prepared offline evidence already covers native PostgreSQL producer handoff,
real local Caddy routing/reversal/redaction, gateway ACL/reconnect behavior and the
paid-dependency refusal regression. Reuse those receipts for unchanged inputs.
No new broad application suite is needed just to read this runbook. Hosted Linux,
actual public TLS/authenticated failover and installed-native results still need
later authorized execution. Keeping paid compatibility is the current path;
retiring paid Realtime and realizing message-bill savings are outside this rollout.

## October 28 executable bootstrap source

The explicit `private-record-bootstrap` component now exists in the candidate's
existing publisher. Invoke it only after the candidate is on protected main and
the dedicated key/connection have been provisioned through canonical stores. The
component uses the same current-main event admission as the gateway component;
change only the component value in the dispatch example. An ordinary source push
never bootstraps a host.

The first-install bootstrap compares the entire actual Caddyfile with the tracked
`private-record-gateway.caddy-preimage` before any root configuration change. The
preimage currently represents inspected source, not a new production readback. If
the aggregate differs, retain it and review an exact new source preimage and
replacement; do not update a mutable hash variable to bypass review. A successful
bootstrap creates inert prerequisites and a dedicated activation publisher; it
never starts the gateway or changes the client fallback/paid source. Its private
`bootstrap-<runId>.json` receipt records the result. Existing prerequisite files
or a publisher account cause refusal and need explicit original-operation recovery.

The canonical connection must use direct/session mode and omit URL SSL parameters:
the maintained `enginePgSsl` supplies verified certificate roots and
`rejectUnauthorized: true`; URL SSL parameters can override that driver's CA
configuration. No transaction pooler, TLS bypass or copied engine environment is
accepted. Nine isolated admission/rollback/identity tests plus four compatibility tests
pass; actual Linux system/user/Caddy/credential installation remains unverified.

## Dedicated role and credential order

Merge/qualify migration `20261028154533` and install it through Apply Merged
Migration before credential activation. It creates only NOLOGIN role and CONNECT,
refusing any existing identity. Dispatch `private-record-credentials` against exact
current protected main through the same existing publisher. This operation uses
the already-created new canonical password, denies effective financial writes and
unreviewed privileged functions including PUBLIC inheritance, and installs only
that role's first credential. It never rotates an enabled unknown role.

After a committed-but-unacknowledged result, read the role marker/attributes and
follow the same operation. A later invocation with the same canonical password
verifies the owned identity without changing it. A mismatched canonical password
or marker refuses; do not generate another password or revoke the listener. The
provider prints only status/role/operation identifiers. Bootstrap's read-only
dedicated-session verification must pass before any host installation.
