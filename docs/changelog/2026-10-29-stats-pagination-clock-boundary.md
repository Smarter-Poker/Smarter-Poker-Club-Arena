# Stats pagination proof clock boundary

The first exact production proof froze browser time before the Rake and Downline
lazy imports finished. The trace contains no downline RPC request and remains on
the loading ledger; this was not evidence of a production pagination defect.

Warm the actual published Rake panel with the same three synthetic reads while
time runs normally, retain those warmup reads separately, return to Overview and
prove the ledger unmounted, then settle initial reads before the fresh timed
mount. Row predicates flush only tasks due now with runFor(0), so asynchronous
transport completion cannot spend the initial 300ms debounce budget. The original
500-member expansion, initial-debounce retention, changed-search reset, exact
read sequence, write guard and exact release/cleanup checks remain required.

Focused source contracts preserve this boundary; the existing real-component
regression still exercises the original debounce defect with fake timers.
