# Lobby certification dismisses both entry overlays

Production verification35297026229 failed four club-lobby interactions because the optional Diamond Spins invitation covered the controls. Each test receives a fresh browser context; global setup cannot dismiss a session-scoped invitation for later contexts.

The lobby spec now uses the existing prepareCashLobbyActions helper, shared with live-table verification. It probes the optional club greeting before registering the invitation handler, then uses the real Close and Not Now controls. No product behavior, financial write, forced click or assertion is changed.

Regression protection lives in the existing production preflight source-contract test and the existing Chromium/WebKit delayed-offer fixtures. Hosted production lobby execution remains separate from isolated fixture proof.
