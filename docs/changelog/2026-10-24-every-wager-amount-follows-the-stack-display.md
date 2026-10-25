# Every Wager Amount Follows The Stack Display (2026-10-24)

Follow-up to `2026-10-24-one-bb-shape-and-no-guessed-big-blind.md` (#7925). That change put the Call button, the raise readout's BB figure and the slider floor through one `asBB` gate. With stacks in BB, these still printed chips beside a BB Call:

- the Bet / Raise / All In confirm button;
- the All In button's amount;
- the fixed-limit Bet / Raise amount;
- the slider tick labels;
- the preset and All In titles and spoken labels.

All of them now print through `wagerAmount(n) = asBB(n) ?? formatChips(n)`, so the setting gives one unit everywhere. The typed bet field stays in chips, because that is what the numeric keyboard edits; its BB readout already sits beside it.

Pinned in `tests/the-pot-follows-the-stack-display.law.test.tsx`. Two of the three new checks fail on the previous code.
