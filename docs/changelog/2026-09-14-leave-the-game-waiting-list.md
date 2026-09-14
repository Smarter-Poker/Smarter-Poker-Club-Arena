# A queued player can leave the game waiting list

The Must-Move lobby now shows the caller's waiting-list place and an existing-style Leave Waiting List button. It calls the installed game cancellation door, validates its receipt, and refreshes the authoritative lobby. Failed or malformed replies keep the queue visible and show plain retry copy. A late response after closing the lobby cannot show a toast or update a new opening; repeated taps send one request.

Six interaction regressions fail on the old component. All nine added cases pass with the fix, alongside the existing Must-Move lobby checks. Before/after previews at 375×812 and 1280×900 have no horizontal overflow or page errors; the isolated preview cancellation removes the control at both sizes. Preview data is synthetic and no real player or balance was changed. Dan approved the displayed before/after addition on 2026-09-14 before publication.
