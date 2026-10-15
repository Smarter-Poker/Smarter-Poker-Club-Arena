# Lightning Phase 2 Private Pilot Preparation

The pilot had only a six-seat target, no explicitly invoked qualification report, and entry copy that promised a Lightning stream while the game used ordinary Must-Move tables.

The maintained authenticated setup now prepares separately named six- and nine-seat private targets. Six-seat creation and control operation IDs remain unchanged. Nine-seat uses separate stable control IDs and blinds of 0.02/0.04; the existing game uniqueness key excludes handedness, so reusing the six-seat 0.01/0.02 stakes would collide. No schema change or adoption of seeded games is needed. Both targets stay in Must Move with Lightning disabled and worker mode off. Setup validates receipts and final game, configuration, club identity and owner-only roster. Unknown acknowledgments stop the explicit operation; a later invocation recovers its durable identity.

The new dispatch-only qualification report authenticates the existing service identity and reads actual target configuration, readiness, recorded settled hands with history, pool sessions, audit events and database access decisions. It checks serving identities before and after collection. Missing, partial, refused or malformed evidence remains UNKNOWN; zero requires a successful count. Its target identity comes from the setup definitions. The report is an observation, certifies none of the 54 release gates, and never enables a game or moves chips. Database access decisions are explicitly distinct from authenticated browser and socket proof.

Entry copy now explains the normal buy-in and inactive Lightning mode for Must-Move games. Preparing games receive normal buy-in guidance. Live Lightning copy, session gates and manual navigation remain intact. No new population reader, polling, artwork or guessed threshold is introduced.

Explicit session-read refusals remain failures. A new join needs readable metadata matching the requested game; missing or mismatched metadata no longer presents a false join entry. Existing owned-room recovery and manual seat return remain available when metadata is unavailable.

A join also belongs to the entry route that started it. Changing games clears the old local pending state and prevents a delayed old-game result from navigating, showing a toast, writing entry preferences or clearing the new game's join. The backend outcome remains authoritative and is not cancelled or financially modified by navigation.

Setup also checks the result of local service-session cleanup. Returned or thrown cleanup errors prevent a success receipt from being written or printed; an earlier preparation failure retains its diagnosis. No global signout is used.

Verification retained in the existing task checkpoint: setup 46 Node cases; report 17 Node cases; 91 relevant entry/session/client tests before the route repair and 70 affected tests after it; TypeScript; copy guards; phone and desktop renders without horizontal overflow. Meaningful regressions failed before the corresponding repairs, including actual stale navigation and toast effects. Protected delivery and actual provisioning/report execution remain separate evidence. Designated participant admission, legitimate funding, authenticated private access and actual gameplay are not certified by source or isolated fixtures.

Real-time law: existing named session and operator events remain intact; no snapshot diff or new polling.
