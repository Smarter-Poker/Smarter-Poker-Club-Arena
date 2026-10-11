# Cashier Phase 4: Roster Workspace

The Trade cashier now puts its recipient directory before the read-only reconciliation report. Unresolved transfer recovery and pending-operation controls stay ahead of the directory. Phone balance strips and action tabs use compact, readable columns without an enclosing frame.

Search has explicit Clear Search and Clear Filters controls that return focus to the search field. Role filtering uses the authorized roster, combines with the existing assigned-player filter and search, resets on club changes and recovery, and prunes hidden selections. Names, member numbers, handles and readable roles remain searchable.

Recipient rows name the Player Wallet figure. Selecting one player shows their identity, known Player Wallet balance and the actual destination for chips, tickets or diamonds. Agent destinations explicitly distinguish the Player Wallet figure from the separate Agent Wallet. Advanced Send and Distribute have clearable search and selected-wallet context; filtering out a selected recipient clears the destination. Advanced Send no longer projects an agent transfer onto an unrelated Player Wallet balance. Switching from self funding in Distribute to Send also clears the hidden self recipient and disables submission.

Six independently mounted regressions fail on the original source and pass on the revised real components. Existing financial authority, durable intent, interrupted-operation receipts, deleted-account visibility and read-only accounting tests remain enforced by the maintained client checks. The production cashier browser test additionally verifies clearing/focus, role filtering and the native selected-wallet context without submitting a financial action.

Fresh Phase 3 verification passed 140 isolated PostgreSQL cases and 80 connected component/source cases. Both public endpoints still contained the qualified Phase 3 source, installed migration/function hashes and permissions matched, and the actual published read showed truthful incomplete baseline coverage with zero covered drift. No migration was replayed and no financial probe changed production balances.

Phase 4 source and local checks are distinct from protected merge, publication and live acceptance; final provider identities and screenshots are recorded in the existing task checkpoint.

Hosted qualification exposed an existing Lightning operator test race: recording the request did not mean its answer had rendered. The test now awaits the acknowledged Close button before continuing, with the same request assertions and default wait bound. No Lightning runtime behavior changed.
