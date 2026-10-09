# server/src/aFilledSpinStartsAtOnce.law.test.ts

The fill that buys a seat-first board's last seat asks for that board's start at once, through ensureTournamentManagerAdmission under every gate the fast lane keeps (current generation, no freeze, no parked launch, no held manager), instead of leaving it for the next poll; and a step budget blown while a table idles is logged rather than reported as a dealing error, while one blown mid-hand is still reported.
