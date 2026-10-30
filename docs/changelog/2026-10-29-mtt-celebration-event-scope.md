# Mystery bounty announcements stay with their event

TournamentDetails renders the celebration without an event key. Changing events retained the old banner and reactivated callbacks left on shared channels. Scope the banner state to tournament identity, retire each listener and ladder request independently, and release only its acquired channel. The existing discrete mystery_bounty_revealed event, artwork and six-second animation remain unchanged.

Two rendered regressions failed before the repair: old banner carryover and old-channel delivery into the new event. All 71 connected celebration, money-unit and snapshot-recovery tests pass, as does TypeScript. No production freeze attribution or live verification is claimed.
