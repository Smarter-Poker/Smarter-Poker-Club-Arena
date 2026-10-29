# Original variant and format evidence in the horse census

The previous census could prove original turns and input consumption without identifying which game variant each turn qualified. The control now produces version3 packets and version2 ledgers with a closed original variant and coarse cash/tournament context per hand. Classic context must match both committed hand history and the exact retained submission; Lightning provenance is explicitly the committed hand history. No current mutable table metadata supplies the context.

The installed read-only observer compares the original context with the reconciled decision snapshot before granting canonical-input credit. Wrong variant/format remains contradictory with input unknown, while the expected turn is retained. Missing captures remain unknown. PLO8 means four-card Omaha hi-lo eight-or-better; no eight-card variant is invented.

Exact legacy version2 packets/version1 ledgers remain supported and unchanged. Their context summary is unknown. Mixed-schema unions refuse rather than retroactively upgrading historical evidence. Context observations do not certify strategy quality, durable memory or universal fleet readiness.

No runtime policy, database schema, extra query, source window, action/partition/privacy bound, release route or workflow changed. The existing control supplies maintained JavaScript into the serving image read-only. Production invocation is separate from source qualification.

Version3 also reads the optional original `ownPublicHistoryProvenance` envelope. A reason is exported only after original input/hand/variant binding and independent observer-context, exact decision cutoff, state, five-key shape, reason whitelist and packet-presence validation. Older images or unavailable context helpers yield `unknown`; no new runtime module is required. Only the closed reason leaves the observer, never its private context or provider message.

Validation: 29 packet regressions, 27 native PostgreSQL assertions (zero production queries), 11 transport tests and 16 actual journal/runtime tests passed. Both compilers passed on the variant candidate; the server compiler is repeated for the added history-provenance regression. The new variant-binding regression fails against the prior module. Existing version2 actual-runtime cases stay unchanged. A new256-turn worst-case transport envelope, including the extra closed fields, remains below the unchanged1,572,864-byte remote stdout limit; packet1MiB and partition256-turn ceilings remain unchanged.
