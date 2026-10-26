# Player Record Agent Assignment Save

The Player Record's Assign To An Agent / Transfer To Another Agent control now saves the selected destination in one click. The previous Review and Confirm Move steps prevented the initial button from performing the requested assignment.

Save obtains a fresh server preview and immediately applies its fingerprint through the installed atomic assignment RPC. Permission, active-agent, hierarchy, cycle, audit and receipt checks remain authoritative. The dropdown offers only the destination roles accepted by that RPC. A synchronous in-flight guard prevents duplicate clicks; stale navigation cannot apply an old preview. An unconfirmed write retains its exact operation ID and token for an explicit retry. Success refreshes the upline and emits the existing agent update event to refresh the record.

The component regression covers one-click assignment and transfer, validation refusal, concurrent hierarchy refusal, double clicks, stale navigation, permission denial and unknown-outcome replay. The one-click test fails against the previous component. The existing post-deploy assignment qualification now clicks Save on the actual production Player Record with its reserved zero-chip accounts, records the UI-owned request before forwarding it unchanged, and verifies persistence, source/destination visibility, audit history, replay and cleanup.

Client-only delivery uses the existing installed database contract; no engine replacement or migration. Publication and final live evidence are tracked in this task's external evidence checkpoint.
