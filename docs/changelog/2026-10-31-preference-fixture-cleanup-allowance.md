# Preference fixture preserves guarded cleanup allowance

The live Chromium preference journey completed its fresh-device proof, but its account fixture exceeded the fixed 120-second teardown budget before producing a cleanup receipt. Browser traces do not observe the Node-side cleanup request, so the precise hosted wait is unknown. A nearby case reported an actual maintenance freeze, which is context rather than proof of this account's timeout cause.

The fixture could not accommodate the existing guarded cleanup helper's supported thaw wait. Bind its budget to the maintained CLEANUP_FREEZE_ALLOWANCE_MS plus the original 120 seconds, as other certification owners already do. The journey and every assertion retain their existing deadlines; cleanup still requires authoritative deletion and readback. No bypass, skip, new retry, game, financial or engine change.

The maintained budget regression fails against the original fixture and passes with the binding. Full post-deploy certification remains required; spectator table preparation availability is a separate observed blocker.
