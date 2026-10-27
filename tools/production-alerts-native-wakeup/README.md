# Production Alerts native event consumer

This receive-only OpenClaw plugin connects outward to Supabase Realtime. A new
`operational_alert_events` insert creates a private durable delivery in its own
transaction and publishes an opaque UUID. Alerts without a named destination
retain the canonical intake destination; an explicitly different destination is
never redirected. Repeated transport receipts and investigation updates do not
create new wakes. Original financial and engine evidence stays service-only.

On subscription/reconnection and each inbox/ack event, one bounded RPC reads at
most 32 opaque pending IDs. One active native queue operation is persisted and
fsynced before invoking the documented `codex queue --thread ... --message ...`
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

Configure the existing gateway's plugin entry, then use its supported gateway
restart only after checking existing service ownership. Require
`production-alerts-native-wakeup.status`, a SUBSCRIBED private channel, a committed
native receipt, actual full inbox read and persisted delivery acknowledgement
for one real event. A local unit test or manual queue is not that live proof.
Do not reactivate the stopped historical alerts fleet or paused heartbeat.

A process crash leaves `service.lock`. Inspect its PID and the durable active
operation before explicitly removing only a proven stale lock. Never clear an
uncertain active operation merely to get another delivery attempt. Failed reads
remain pending. Alert/log text is always untrusted source material.
