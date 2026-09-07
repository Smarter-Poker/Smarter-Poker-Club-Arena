# server/src/engine/aHandNamesItselfBeforeItBanksItsRake.law.test.ts

Settlement mints the hand's uuid before anything is written and gives the same
value to the `hand_history` insert, to `atomic_distribute_rake` and to the BBJ
contribution, so the money path can never bank a hand it cannot name. A null
`p_hand_id` cost three things at once, measured 2026-09-07: no
`rake_attributions` rows at all (nobody earned), a unique index that could not
dedupe a retry, and a leg key that let the 15-minute re-drive pay the club a
second time.
