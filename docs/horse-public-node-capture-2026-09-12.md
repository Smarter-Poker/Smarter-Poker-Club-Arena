# Public action capture prerequisite

The action-history writer previously had only post-action amounts and could not reconstruct the price, boards, player contributions and legal choices that existed before the action. The controller now freezes those public facts after validating the action and before changing the hand. The internal event carries them into the existing accepted-hand history transaction. A delayed consumer never reconstructs them from a later table state.

The bounded record contains exact variant, chip asset/unit, cash/tournament mode, street, actor/button seats, blinds/ante, bomb-pot and all-in-or-fold flags, actual board count, public boards, pot/current price, legal action bounds, and compact seat contributions/status. Nested arrays are frozen and copied. No player cards, private discarded card/index, deck, names, account identity or worker decision data are read by the capture helper. Private chosen/forced discards and missed-discard folds have explicit unavailable reasons. Invalid metadata excludes learning evidence without preventing an otherwise valid poker action.

Controller action history and realtime player-action broadcasts omit this internal metadata. Durable history uses the existing atomic hand transaction; the existing worker observation is only enqueued after the accepted receipt. No new database table, writer, activation switch, policy adjustment or safety change is introduced.

This is a Phase14 prerequisite, not completion of Phase14. Before learning, the accepted-hand producer still must bind immutable hand UUID and original action ordinal, precise hand-bound seating session, accepted action origin, tournament stage and deduction context. Restart-safe durable observations, exact scoped modeling, uncertainty/session floors, isolated holdouts, proposal lineage, shadow gates and activation/rollback remain required. Existing worker ACK is not database durability.

Verification before integration:

- Build passed after correcting a required field in the test fixture.
  -80 tests in5 files passed for actual-controller captures, all8 ordinary betting variants through the river, actual deck-driven bomb-board downgrades, funding units, delayed consumers, durable history, malformed-state exclusions and Pineapple private/forced discards. Initial failures were incorrect fixture deck-capacity expectations, preserved in local evidence.
- A frozen native comparison played162 identical offline hands across all9 variants, HU/three/max seats, ordinary/three-board-requested hands and passive/raise/fold lines. Complete poker states, settlement events and accepted histories matched the previous controller after removing only the new metadata. There were2,205 captured actions and70 explicit discard exclusions. No live traffic or randomness source was changed.
- The largest observed node was659 bytes. A separate20,000-sample9-seat/3-board capture-only diagnostic measured p50=0.002084ms, p99=0.007584ms and maximum=0.908792ms. This excludes rule execution, serialization, persistence and fleet load and is not whole-action latency certification.
- The offline driver initially omitted the explicit synchronous Pineapple-settle flush and the terminal fold-out event; those harness failures are retained. The corrected driver uses the controller's supported flush and HAND_COMPLETE boundary on both sources.

Protected review, publication, the final integrated suite and natural pipeline proof remain open at this checkpoint.

Integrated verification on a2670f055ad6a38a19639dfaa8b77e49fa1036a7 (protected base ab9b1cbd958ff6a48828d9c0455331e4665d73dc): build passed; the full server suite passed11,028 tests with145 existing skips,757 files passed and1 skipped, in149.12seconds. The162-hand native comparison was rerun against this integrated source. Required review, engine publication and full Phase14 pipeline acceptance remain open.
