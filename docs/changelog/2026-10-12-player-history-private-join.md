# Player History Private Join

Cold production proof on protected 1579ce6 loaded history but returned Unauthorized on the private staff channel. The receive policy required private IS TRUE; the installed realtime.authorize inserts join probes with id, topic and extension only, so private defaults false. Existing native coverage used private producer rows and missed the join boundary.

A separate immutable migration changes only that policy predicate. Authenticated SELECT, exact topic equality, canonical UUID, broadcast extension and the unchanged staff helper remain required. Both client private:true and producer realtime.send(...,true) remain unchanged; no INSERT access or raw journal access is added. The installed original migration is untouched.

The existing required native history driver now reproduces the original denial with the actual default-false join probe, applies the correction, proves authorized staff/union/platform/admin joins and denied revocation, agent, anonymous, wrong topic, malformed topic, presence and client publishing, and refuses replay. Existing journal privacy, pagination and transport isolation assertions remain enforced. Two additive routing cases and only current source hashes retain required execution.

Real-time law: triggered by history_changed discrete private broadcast event, no snapshot diff.

Validation and live installation/publication evidence are recorded in the task checkpoint. No engine runtime change.
