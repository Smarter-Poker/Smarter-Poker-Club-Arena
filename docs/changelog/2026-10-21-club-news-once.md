# Club news appears once per new message

Club entry no longer resets its popup each day or offers a Do Not Show Again preference. The entry request atomically records which club message and announcement copy the authenticated player has received, across browsers and devices. Closing with X or Enter Lobby has the same result. New or edited copy can appear on the next club entry; unchanged saves and pin/order changes do not reopen it. Hidden and expired announcements are excluded. Existing explicit lobby-message dismissals remain respected.

The database owns receipts and duplicate-request arbitration. A per-player/club transaction lock orders snapshot reads with receipt writes across staff edits. Staff saves render exactly the claimed snapshot and reject responses after switching accounts or clubs. Account deletion cascades its receipt cleanup. The client shares only an in-flight claim during React StrictMode effect replay, rejects responses for abandoned club/account entries, and has no local date gate. Prior clients' dismissal endpoint remains compatible. A failed/unknown claim does not open an unrecorded popup; no background retry is introduced.

Verification: focused component and setup tests, native PostgreSQL tests for cross-session receipts, duplicate claims, unchanged/changed copy, announcements, legacy dismissal, authorization and RLS. Native qualification runs in the existing required CI server shard.

At-most-once delivery records the receipt with the request that returns the news. A connection lost after commit can consume that delivery without rendering; the client does not replay unknown outcomes.
