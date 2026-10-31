# Tournament HUD reads release their original owner

The served browser verification retained two tournament HUDs that received the committed level-up event but kept displaying the previous level. Both ensuing tournament-row requests remained unsettled. The HUD's single in-flight read then prevented subsequent named events from obtaining the committed row and clock anchor.

The HUD now passes an AbortSignal through TournamentService to the original PostgREST request and independently bounds that promise, including transports that ignore cancellation. Retirement aborts that same request. A late response cannot paint or retain the read slot. Rows older than the highest named committed level are rejected; duplicate event carriers remain coalesced. The last confirmed row is preserved on unknown outcomes, and the level number and clock anchor are never inferred from event arrival time.

The read budget is derived from the interval between the existing first and second deadline catch-ups (15 seconds minus 5 seconds). This prevents one request from consuming that entire recovery interval. No new retry loop, polling owner, production action, or engine change is introduced.

Validation: three focused regressions fail against the prior source and pass with the fix; all 49 Tournament HUD tests pass. Client TypeScript compilation passes. Publication and actual served behavior remain separate delivery requirements.
