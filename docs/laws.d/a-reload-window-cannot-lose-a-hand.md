# tests/a-reload-window-cannot-lose-a-hand.law.test.ts

A PostgREST schema-cache reload, measured at about 28 seconds on this database,
must not drop a hand's stack result. The exact immutable hand payload remains
owned by the awaited post-hand promise until the database returns a complete
authoritative receipt or a definitive refusal. The retry schedule outlasts the
measured reload while remaining inside the five-minute settlement barrier.

The law also pins what is forbidden: no timer queue, watcher, reconciler,
replacement engine, per-seat fallback, or table-count reconciler may inherit
the payload. Tournament success additionally requires exact written stack and
standings proof from the database authority.
