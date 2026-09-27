# Wallet proof selects the totals region

The connected member-balance journey reached its final rendered amount on September 27 at 05:17 UTC, but the global "Playable Now" locator matched both the wallet header and the actual totals section. The strict selector failed before comparing the balance. Both displayed zero in that run; this was not an observed financial mismatch.

The maintained assertion now scopes the unchanged exact amount comparison to the accessible "All Wallets Combined" region rendered by PlayerWalletPage. Its helper is shared with a real Chromium counterexample that reproduces the former two-match strict-mode failure, proves the correct value is selected when the header differs, detects a changed amount and refuses to substitute the header if the totals region disappears. The existing routes directory sweep runs this regression after publication. No runtime wallet code, financial write, realtime event assertion or authoritative read is changed.

The full production journey still requires its own containing release and actual browser result. Passing this isolated DOM regression does not supply that evidence.
