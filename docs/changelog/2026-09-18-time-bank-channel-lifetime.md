# Time-bank announcements release their channel objects

Automatic and manual time-bank activation created a new Supabase channel for each message and retained it for the engine process lifetime. Both paths now use one shared sender that preserves the existing topic, event and payload, sends once through the explicit HTTP interface, and releases its captured channel in the original request's completion path. Failed sends remain nonblocking and are reported; no retry loop or player-feature reduction is added.

The live TableWebSocket consumer still needs these messages for opponent timers, so the messages remain. This fixes an accumulating engine resource leak; it is not a claimed reduction in billable messages.

The actual Supabase SDK regression demonstrates repeated sends returning to zero retained channels, failure cleanup, and independently finishing overlapping sends. Real engine tests exercise automatic and manual activation with the unchanged 20-second grant and consumed-use count. Both actual caller regressions fail on the original engine. Related time-bank, reconnect and recovered-clock tests retain their assertions.
