# Every Player Sees The Add-On Closing Minute

Owner October 31: every add-on tournament finishes all hands, pauses every table for a full 60 seconds and tells every player the cost, chip grant and deadline using the tournament break screen.

The purchase popup previously excluded already-purchased and otherwise ineligible players. A separate public notice now reads the committed add-on window through the shared tournament event subscription, including reconnect and visibility recovery. Free Buy early purchase windows are never represented as a pause; only the drained closing minute is. An overlapping regular break keeps its own pause and shows this notice for the final minute. Existing purchase authorization and payment remain unchanged.

Creator forms and payloads enforce one minute. The client uses the existing serving-engine durable window contract; runtime enforcement against older stored durations is a separate engine delivery. No new polling, financial mutation or release loop.

Validation: rendered mobile screen; event-driven notice, expiry, minimized reopening, early Free Buy, overlap and failure recovery regressions; creator mapping and real form tests. Publication and live proof are recorded in the owning task checkpoint.
