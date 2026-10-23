# Hand Review Across Game Variants

Hand review preserves every retained private card through Summary, Detail and the selected Replay for Hold'em, Short Deck, Pineapple and four, five and six card Omaha, including hi/lo labels. Focused rendered regressions also cover tournament forced money, bomb boards and multiple runouts.

For older service records without an attached replay model, preserve bomb-pot identity, the stored main/side pot split and the arena denomination. This prevents invented blinds in legacy bomb pots, collapsed side pots and Diamond precision drift. The normal raw-row replay path remains the authority for richer records.

Validation: the fallback regressions failed before the change and passed after; the focused review, adapter, multiple-board, money, replay, showdown and Diamond selection passed 171 tests. These checks do not claim every historical record exists or that unavailable private cards can be reconstructed.
