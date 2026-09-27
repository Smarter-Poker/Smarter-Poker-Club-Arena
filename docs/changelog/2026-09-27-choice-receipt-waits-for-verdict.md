# Choice receipt assertions wait for the cryptographic verdict

Publisher 36324132318 failed the hit-receipt assertion with all four game-result fields correct but its proof sentence empty. The helper read after five fake-clock turns while the page was still performing real SHA-256/HMAC work outside that clock. The later verification helper in the same test already waited for an actual on-screen verdict.

Both receipt readers now share that bounded state wait, accepting either displayed verdict before retaining all original exact outcome and verification assertions. If no verdict arrives within the existing 50-turn budget, the assertion fails with the receipt text. The test does not advance game time to make cryptography finish. No application, financial rule, timeout or production behavior changes.

A controlled regression holds the real WebCrypto digest until after the scene has finished and the former fixed-turn reader has returned. It failed before the correction because the receipt read completed without proof. After release, the real digest and HMAC still compute the displayed failed-verification verdict; no verification outcome is mocked. Source compilation, the complete component suite and exact full suite remain required for delivery.
