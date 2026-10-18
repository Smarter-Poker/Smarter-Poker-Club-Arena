# A completed envelope stays complete when local custody expires

The October 17 digest highlighted rising post-commit alerts. Readback on October
18 found all 631 distinct recent alerted hands had post_commit_completed_at;
the inspected hand's F06 permit was already accepted before its give-up alert.
The database's f06_accept_hand trigger accepts the permit in the completed
post-commit transaction. The redundant engine finish callback could then reject
f06_owner_changed after the local lease expired, causing five retries of already
completed obligations and a false critical financial alert.

The settlement success path now recognizes that precise race only when its
receipt names the exact hand ID and hand number and the engine has lost local
mutation authority. It keeps the durable completion and reflects no local
player state. An active owner, missing/mismatched receipt or any other failure
still follows the existing refusal and retry path. No money, database authority,
permit-writing RPC or maintenance boundary changes.

Regression coverage exercises the exact settlement success block and the real
predecessor engine flow. It pins exact receipt matching, refuses a healthy
owner's failure, verifies one obligation attempt and zero false financial
alerts, and preserves the fence on local reflection.
