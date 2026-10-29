# Original variant and format evidence in the horse census

The previous census could prove original turns and input consumption without identifying which game variant each turn qualified. The control now produces version3 packets and version2 ledgers with a closed original variant and coarse cash/tournament context per hand. Classic context must match both committed hand history and the exact retained submission; Lightning provenance is explicitly the committed hand history. No current mutable table metadata supplies the context.

The installed read-only observer compares the original context with the reconciled decision snapshot before granting canonical-input credit. Wrong variant/format remains contradictory with input unknown, while the expected turn is retained. Missing captures remain unknown. PLO8 means four-card Omaha hi-lo eight-or-better; no eight-card variant is invented.

Exact legacy version2 packets/version1 ledgers remain supported and unchanged. Their context summary is unknown. Mixed-schema unions refuse rather than retroactively upgrading historical evidence. Context observations do not certify strategy quality, durable memory or universal fleet readiness.

No runtime policy, database schema, extra query, source window, action/partition/privacy bound, release route or workflow changed. The existing control supplies maintained JavaScript into the serving image read-only. Production invocation is separate from source qualification.
