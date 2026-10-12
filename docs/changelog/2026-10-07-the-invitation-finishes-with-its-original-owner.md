# The invitation finishes with its original owner

The mobile lobby certificate could stop before measuring My Wallets because retiring the Diamond Spins locator handler did not wait for a callback already running. The explicit readiness flow then declined the same invitation, leaving the original callback waiting for a control that had already disappeared.

The existing helper now records its handler owner, unregisters future callbacks and drains the original callback before deciding whether the invitation still needs its real Not Now control. An original failure stays a failure, including when global setup collected it. The existing click, hidden, lobby and navigation deadlines are unchanged.

A real Chromium regression fails on the previous helper with the same missing-control timeout as the retained production report and passes after the ownership repair. The late-invitation browser case and focused collector/budget checks cover the directly affected alternatives. This changes certificate setup only; no wallet, invitation product, financial or engine behavior changes.
