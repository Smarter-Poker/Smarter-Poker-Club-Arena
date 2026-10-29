# Remove opponent HUD presentation

Owner direction: opponent HUDs must never be displayed. Removed the seat statistics panel, seat play-style badge and final-table play-style classification, including their data/render wiring and keyboard toggle. The retired MiniHUD entry point returns no content even for stale callers. Legacy saved settings and every settings update force showHUD off.

Public hand-stat recording and the player's own session/VPIP information remain intact. No engine contract or database change is required. Regression coverage checks populated stale inputs, settings restoration/update paths and the absence of opponent rendering wiring.
