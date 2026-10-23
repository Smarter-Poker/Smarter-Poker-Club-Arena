# Cashout status follows the other session

Settlement admission was removed from cashout requests and decisions in #7824.
Follow-up end-to-end inspection found the open player request dialog did not
subscribe to decisions made by the agent in another session. It now subscribes
to that player's cashout rows and reloads only pending status. Amount/note drafts,
club/account generations and the receipt-recovery read gate remain intact. A
verified decision also invokes the callers' existing balance-only/quiet read
so a rejected hold immediately becomes available again in the displayed balance.
That read waits behind an owned command and does not reset the working draft.

The mounted regression fails without the subscription and passes with it,
including draft preservation and retired-owner events. The existing required
native fixture workflow now executes a two-browser request/approval/rejection
lifecycle with both settlement locks active, genuine Auth/REST/Realtime and the
captured financial SQL/triggers. It asserts custody, replay and unauthorized
refusal. See tests/fixtures/cashier-realtime-lifecycle/README.md for its precise
isolation/fidelity boundary. Hosted and live outcomes belong in the delivery
checkpoint; this source description does not certify a run that has not finished.
