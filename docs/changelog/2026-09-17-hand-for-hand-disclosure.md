# Hand-For-Hand State Reaches The Lobby And Table

The detail banner read a tournament-row field that the engine never populated. Table announcements only covered clients present at the transition, leaving a newly opened or reconnected view without the current hand-for-hand state.

The existing authenticated tournament channel now returns the current manager's display state after joining, and carries changes at the existing hand-for-hand transitions. The detail banner and mounted table HUD consume that state. Reconnect, account changes, terminal rows and unavailable manager authority clear the observation until a fresh snapshot arrives. A retiring manager reads the currently owned slot before publishing; display transport failure cannot block its stop fence.

The channel listener is installed before requesting the snapshot. Shared consumers retain independent release ownership. Existing pause, barrier, blind, ranking and payment decisions are unchanged. No database field, polling or background repair is introduced.

Connected regression coverage exercises the actual manager presentation, channel join/rejoin, shared client subscription, detail banner and table HUD. Original-source controls fail the missing-disclosure assertions. Local and protected release evidence is recorded by the owning task; this source record alone does not claim deployment.
