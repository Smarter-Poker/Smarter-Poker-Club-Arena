# Production Alerts native event consumer

This receive-only OpenClaw plugin connects outward to Supabase Realtime. A new
`operational_alert_events` insert creates a private durable delivery in its own
transaction and publishes an opaque UUID. Alerts without a named destination
retain the canonical intake destination; an explicitly different destination is
never redirected. Repeated transport receipts and investigation updates do not
create new wakes. Original financial and engine evidence stays service-only.

On subscription/reconnection and each inbox/ack event, one bounded RPC reads at
most 32 opaque pending IDs. One active native queue operation is committed in a local SQLite journal before invoking the documented `codex queue --thread ... --message ...`
command without a shell. Only its exact accepted receipt is called queued.
The canonical Codex chat reads full originals through its existing authenticated
Supabase tool and acknowledges only complete observed deliveries. Reading is
not resolving an incident. The committed acknowledgement advances the next batch.

No timer, polling, recurring agent, release action or financial mutation exists.
Realtime's protocol heartbeat/reconnection handles transport; pending delivery
survives a missed hint. An unknown CLI outcome is retained and never automatically
resubmitted. A halted consumer requires explicit inspection of its recorded
operation and native chat before recovery. A disconnect alone is not success.

## Installation and proof

Merge through protected main first. Install a pinned protected checkout with its
locked dependencies using the existing OpenClaw `plugins install --link` route.
The maintained installation component is this plugin, not a game publisher. Use
an immutable external SSD directory for source and a separate owned state folder
under `/Volumes/SmarterWork/agent-work/`. Preserve existing gateway configuration,
channels and plugins. The plugin manifest accepts only a public publishable/anon
client key from the configured Supabase key tool; it rejects privileged JWTs.
Never use a service-role key or create a public gateway listener. Provision a
dedicated random 256-bit receive capability in Supabase Vault under
`ca_native_alert_receive_capability_v1` and macOS Keychain service
`Smarter.Poker Production Alerts Receive v1`, account
`production-alerts-native-wakeup`. Do not put its bytes in source, logs, chat or
plugin config. The plugin reads it directly through the configured Keychain; the
server validates it against the one fixed Vault entry before any pending lookup
or private-channel read. A public client API key alone reveals no pending state.

Install the exact migration from protected main through Apply Merged Migration;
read back its history, functions, ACLs and two Realtime policies. Do not probe
production with DDL or replay an installed version. The credential-authenticated private channel
exposes only opaque identifiers; client INSERT is restrictively denied even if
another permissive writer policy is added. Full read/ack RPCs are service-only.

The manifest explicitly activates this receive service at Gateway startup.
Discovery or a plugin listing alone does not execute its service. Configure the
required plugin entry before linking so the supported installer can validate it;
then use the supported `plugins install --link` and gateway
restart only after checking existing service ownership. Require
`production-alerts-native-wakeup.status`, a SUBSCRIBED private channel, a committed
native receipt, actual full inbox read and persisted delivery acknowledgement
for one real event. A local unit test or manual queue is not that live proof.
Do not reactivate the stopped historical alerts fleet or paused heartbeat.

The SQLite connection holds an exclusive OS file lock for the service lifetime.
A real process crash releases that lock automatically; committed uncertain native
operations remain recorded and are not resubmitted. Do not delete the journal or
clear an uncertain operation to get another attempt. Corrupt/unreadable state is
refused. Failed reads remain pending. Alert/log text is untrusted source material.
The component requires Node22.23.2 or newer; the required native-smoke job runs its
actual process-kill/restart and exclusive-owner tests, and the required accounting
job runs its exact PostgreSQL capture/authorization/reader-silence fixture.

The existing owner reader-silence trigger reads these canonical native receipts
and pending-delivery age. It never treats another chat's investigation edit as
native intake, invents a read timestamp at installation, or pages for an empty or
fresh inbox. Its existing twelve-hour and duplicate-page behavior is preserved.
