# Club Arena: Compact Browsing And Clearer Table Controls

October 22 owner feedback replaces the mobile card feed with compact desktop-style game rows. Selecting any game opens its approved game card before an explicit participation action. Cash, tournament, Spin and Heads-Up retain their authoritative admission, registration, waitlist, funding and permission gates. The full tournament lobby remains available through Details.

Mobile rows share the existing numeric sorting and persisted club/category sort. Only the selected game renders its large artwork. Players see the game, stakes or entry, player count and status together; long names retain full accessible labels and details. The removed duplicate mobile sort toolbar is replaced by touch-sized column-heading controls.

Filters now remain in natural page flow. Reversing scroll direction cannot summon them over the games. This supersedes the October 11 direction-following behavior and earlier sticky filter requirements, preserving the independent footer behavior. The old visibility hook is removed.

The arena home adds an explicit Play Poker shortcut to an eligible remembered club, using the approved action artwork and fresh membership directory. It never auto-navigates or buys in. The avatar hub opens on Stats by default, keeps optional Throwables secondary, and no longer duplicates Table Settings; the table menu remains the settings entry. Old remembered settings tabs recover into Stats. Top-up and rebuy sheets name Wallet Balance explicitly, separately from At Table, New Stack and the amount being added.

Existing consent-aware product analytics receive list readiness, detail selection, browse duration/abandonment and authoritative game-admission outcomes/durations. Existing table-seat funnel events provide the downstream seat witness. Telemetry never retries admission, contains no raw private errors, and analytics failure cannot change a successful outcome. Event collection depends on configured analytics and consent; source wiring alone is not a claim of live collected data.

Table clarity is delivered by existing PR #7716 (owner requested this chat take ownership): bet/dealer seat ownership, crowded-phone player layout, shown-hand readability and occupied-ring browser coverage. Keep its source/CI/release identity separate until protected merge and live verification establish the containing release. No engine replacement or new engine API is required for this cleanup.

Validation and release identities are recorded in the task checkpoint under external evidence. Before release, run final-candidate compilation, applicable contracts, client browser checks, protected CI, both client build-info endpoints, affected live UI and the live-table interoperability job against the serving engine. Local fixture renders do not replace production proof. No unfamiliar-player study has been conducted or claimed.

The selected NLH card referenced an immutable View plate that existed on the
origin but was absent from maintained source. Restored the exact approved
bytes from that existing public asset, SHA-256
10e21c24e5d628c00b6b7f2d2cbc487a087fce7c8f218352245922d59c1d7b72,
and retained a regression asserting every declared NLH layer exists locally.
No approved artwork was repainted.

The obsolete CasinoPlaque component and stylesheet are retired after removing
their final caller. Aggregate player-count and hidden Spin-multiplier checks
now exercise the live card adapter. Production lobby checks require the new
card-first review followed by explicit tournament Details navigation.

Full-suite qualification also found a crash-drill fixture with only two
seconds of setup time before its unchanged ten-second leadership reserve.
On the loaded Mac, subprocess startup exhausted it before the intended
delayed-adoption assertion. Its isolated test budget is now 30 seconds;
production limits and every refusal/failure/success assertion are unchanged.
