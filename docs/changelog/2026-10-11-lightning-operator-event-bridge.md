# Lightning operator changes reach the authenticated engine channel

Phase 13 operator reads were interval-based even though cash cluster state changes have a named transaction ledger. `LightningOperatorEvents` subscribes once on the leader, resolves the owning club and forwards identifiers and event kinds through ChannelHub. It never forwards raw ledger payloads or cards. A named resync reconciles missed events when the database subscription reconnects. Stop invalidates outstanding lookups and unregisters the channel. The cache is bounded. An always-on subscription gauge makes runtime admission observable.

GameServer starts and stops the bridge with its Lightning supervisor. The producer tests cover private-payload omission, club routing, reconnect, lookup failure and delayed completion after stop. The operator follow-up adds the database publication and consuming client. Lightning remains disabled until staged rollout evidence is present; this transport is not launch approval.
