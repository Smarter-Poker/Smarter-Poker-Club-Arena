# Shared Channels Keep Every Consumer

RealtimeChannelService deduplicated club, tournament and lobby subscriptions by
returning early for the second consumer. Its callbacks were never registered,
and either consumer's cleanup sent LEAVE and removed everybody's listeners.
A delayed cleanup could also remove a newer subscription with the same name.

Each consumer now owns its listeners and an idempotent cleanup. The first
consumer sends JOIN and the last cleanup sends LEAVE. Explicit unsubscribe
still clears the entire subscription. Cleanup checks record identity before
touching a replacement. No additional socket or duplicate server JOIN is needed.

Four regression cases failed against the previous implementation: each shared
channel kind losing callbacks/ownership, and stale cleanup removing a replacement.
They exercise the actual service with a mocked transport, rather than a copy
of subscription logic. Full browser lifecycle verification remains outstanding.
