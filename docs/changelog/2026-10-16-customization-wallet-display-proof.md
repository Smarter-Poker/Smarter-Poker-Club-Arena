# Customization Wallet Display Proof

The October 16 wallet display contract preserves two decimal places and grouped thousands below one million. Production customization certification still expected the default locale rendering of its independently read playable balance, so the correct zero wallet printed `0.00` while the certificate required `0`.

The browser assertion now uses a test-only display expectation derived from that same independently calculated `max(0, total - locked)` amount. It does not import the runtime formatter. Literal boundary regressions retain exact cents below one million and truncated million/billion figures above it; non-finite source amounts refuse verification. The original authoritative membership/agent reads, persistent wallet comparisons, account isolation, cross-device cosmetics, reconnect proof and reserved-account cleanup remain unchanged. No runtime, database or financial command changes.

The new expectation regressions failed against the former default-locale behavior (14 failures, including the observed zero-wallet case), then passed after the correction. Production verification remains owed by the existing publisher-owned browser workflow.
