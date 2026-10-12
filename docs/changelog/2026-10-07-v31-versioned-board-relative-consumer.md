# Immutable V31 Hand Features

Phase 6 retained-source diagnosis found that the legacy rank/suit-count key merged top pair with ace-high on different boards. This change adds the separately named `holdem-board-relative-v2` contract without rewriting the legacy key or any existing sealed dataset.

The sealed dataset chooses the lookup implementation. Its optional version is carried through loader boundaries, dataset identities, source seals, agreement receipts and evaluation configuration. Unknown explicit versions and explicit nulls fail closed; nullable historical SQL metadata is removed only at the loader boundary. Existing omitted-version identity bytes remain unchanged.

The V2 descriptor records made-hand category, relative hole/board roles, drawing and suit relationships, tiebreak roles and coarse connectivity. It is not an exact-board hash. The SQL producer must emit the identical positional wire representation. This consumer cannot turn unqualified sources into an active corpus.

Root verification on the integrated candidate: 103 focused tests across seven suites passed. The SQL fixture comparison also checked 88 valid positional keys, seven invalid decks and 15 malformed keys, including all 24 suit permutations; the consumer now matches its cross-field rules. Genuine expanded solver coverage, full compaction/sealing, unchanged quality gates, eight evaluation families and actual playing-worker proof remain separate Phase 6 requirements. This source change does not claim they have passed.
