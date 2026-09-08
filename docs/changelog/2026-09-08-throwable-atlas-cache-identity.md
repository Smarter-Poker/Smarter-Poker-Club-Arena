# Updated artwork reaches returning players

Live atlas responses cache for 30 days, but revised atlases reused the same URLs. Runtime rendering and pre-charge readiness now share a content fingerprint derived from the delivered WebP bytes. Unchanged sheets keep their cache identity; changed artwork gets a new URL. Tests check all 50 fingerprints, renderer identity and unknown-name rejection.

The prior final-original release was verified on both Hetzner routes at 303d1d8ee66b9a7add2c384d97477a6e88995c13: all 382 requests for 191 artwork files per origin matched source bytes. Expanded artwork remains pending: the image tool rejected both donkey atlas attempts. Overall 80-item acceptance remains incomplete.
