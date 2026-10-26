# The paired-board fold adds PLO4 and the flop, and goes live now

Dan, 2026-10-25 19:10 Chicago: "ADD PLO4 AND PLO5 AND THE FLOP TO THE PAIRED
BOARD FOLD RULE. MAKE IT GO LIVE WHEN ITS READY, NOT AT 4AM".

The rule from #8088 (`HorsePloPairedBoardFold.ts`) now covers PLO4 as well as
PLO5 and PLO6, and a paired flop as well as the turn and river. A horse without
a full house or better facing a committing bet (bettor all in, a quarter or
more of its stack, or a call that leaves it all in) folds. Still left to the
brain: hold'em, PLO8 and other hi-lo games, multi-board pots, and token calls
needing under 15% equity.

The law test now replays PLO4 turn and flop spots and a PLO5 paired flop
through the whole brain across seeds (all fold), checks a PLO6 paired flop, and
keeps flop full houses calling.

Activation: Dan ordered it live off-cycle. One owner-ordered window in
`server/release/owner-maintenance-windows.json`, merged with this change,
names the #8088 merge (acb5e84e9, not yet serving) so the release of this
merge contains both. It uses the existing last-hand notice, drain, freeze,
certificate, rollback reserve and thaw, expires within six hours and is spent
once the containing engine serves.

## Two earlier pins reconciled with the later ruling

- The maniac law (Dan 2026-10-22, "call off lighter") pins that a horse never
  folds heads-up well over the price against a potter. With PLO4 and the flop
  in scope, Dan's later "FOLD 100% OF THE TIME" folds some of those spots on
  purpose. The harness now marks each fold the paired-board rule made, and the
  call-down pins exclude exactly those; every other fold is still held to the
  price. The two read-speed pins time the read on their original hand stream,
  so they ablate the new rule.
- The V56 Omaha pressure test's "with V56 off it called" control ablates the
  paired-board rule too, as the V40 control already does, so it keeps
  measuring V56 alone.

## The window was re-anchored

The first window named the #8088 merge, but the owner-ordered bust-door
release (#8096) had already put #8088 into the serving engine (fdd0a7efd)
before this change merged, so the window was spent and the widening queued for
04:00. The entry now names the widening's own protected merge (#8104,
afea03a16) and nothing else changes: same order, same certified route, same
expiry rules, still spent once the containing engine serves.
