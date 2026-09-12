# MTT move publication and orphan diagnostics

A tournament rebalance response now belongs to the committed player, source table, route and subscription lifetime that requested it. Embedded tables update their parent table slot; standalone tables replace their owned source route. Later requests, authentication changes, cleanup and abandoned React renders cannot publish an obsolete move. A committed callback update remains usable by an already pending read.

Orphan recovery now reports every positive closed-source row when a player has multiple possible source rows and no open seat. It preserves the rows for diagnosis, leaves that player's source unresolved and continues existing eligible repairs. It does not combine stacks or select a source by guesswork.

Independent reviews 0056 and 0058 addendum 02 accepted the bounded changes. The actual hook has 28 passing focused cases, including Suspense and StrictMode lifecycle regressions; the preserved independent failing Suspense reproducer now passes. An exact original rebalance-branch adapter produced 17 expected assertion failures and one ordinary-behavior pass. The actual manager/helper harness has 27 passing cases, versus 20 passes and seven expected failures with the original source. Full server compilation passed. Full client compilation requires the protected CI environment; local native dependencies were incomplete.

These checks do not certify complete table-breaking recovery, live player seating, the next accepted hand or all MTT behavior. Durable table-break custody and retry recovery remain a separate implementation.
