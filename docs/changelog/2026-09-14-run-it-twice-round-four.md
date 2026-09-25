# Run it twice, round four: the wait listens, the record names the winning hand, the panel is heard

2026-09-14. Engine and client. No migration. Follows
`2026-09-13-run-it-twice-round-three-engine.md` / `-client.md` (PRs #4496,
#4500) and the parity spec `docs/rit-pokerbros-parity.md` §2g.

## Engine

### The host's wait listens for the offer to end, instead of polling for it

`ServerTableEngineRunout.waitForRITResponse` ran two clocks per offer: a
250 ms `setInterval` reading `getState().status` until it was no longer
`offered`, and a safety `setTimeout` at window + 5 s. The poll was the
delivery mechanism; up to a hundred empty reads per hand, and a settlement
that began anywhere inside a quarter-second window after the last consent
landed, which the multiway and exclusivity tests then had to wait through.

The `RunItTwiceEngine` already emitted an event for almost every way an offer
ends - `RIT_ACCEPTED` on unanimous consent, `RIT_DECLINED` from a player or
from the `DeadlineScheduler`'s expiry - except one: the chooser picking one
board set the state to `declined` and emitted nothing. That was harmless
under the poll and would have been a hang under a listener, so
`chooserDecides(runs = 1)` now emits `RIT_DECLINED { declinedBy, reason:
'chooser' }` (`RITDeclineReason` gains `'chooser'`). The felt notice for it is
unchanged: `respondToRIT` still announces `chooser_chose_one`, and the
`wireRunItTwiceEvents` forwarder still forwards only `reason === 'timeout'`.

The wait now registers one listener keyed to this hand's offer id, finishes
on the terminal event, and keeps the safety timeout as the single net for an
offer that vanished without an event (a voided hand clearing it), which
`finish` drops by controller identity as before. The finish is deferred one
macrotask (`setImmediate`): the event fires inside the `accept()` /
`decline()` call that `respondToRIT` makes, and `respondToRIT` still has
`rit_all_accepted` / `rit_single_run` / `rit_response_update` to broadcast
after that call returns. Settling synchronously would have put `rit_result`
on the wire before the acceptance that caused it. The order on the wire is
what it was under the poll; the gap is gone. A wait armed after the offer has
already ended (a horse chooser answering inside `offer()`) finishes at once
from the state read, since no event will come.

### `winners[].hand` names the hand that won the money

On the multi-board path `currentHandWinners[].hand` came from
`currentHandShowdownResults`, which is evaluated on the FIRST board only. A
player who lost board one with a pair and took board two with a flush was
recorded - in `pot_win.winners[].hand_name` and `hand_history.winners` - as
having won with "Pair". It now reads the player's largest per-pot award
slice, whichever run it came from (name and ranking only; `pot_win` lights
`card_indices` against board one, and a best five from run two would light
the wrong felt - the per-run highlight is `rit_result.per_board_awards`). The
showdown row remains the fallback for a paid player with no award row.
Pinned in `RunItTwice.parity.test.ts`.

### `pot_distributed` is exact per pot

The event names every pot, what it held, and who received it, and the
per-winner share was an estimate: each eligible winner's whole-hand total,
scaled proportionally into the pot. Exact for one pot on one board; wrong for
a three-way all-in run twice where A and B split the main pot on board one
and C took the side pot on both - the estimate handed C a slice of the main
pot because his total was the largest. `buildPotDistribution()` reads the
per-pot award slices (one per board, pot, half, winner), sums a pot's slices
by winner, and applies them as proportions of the pot in cents with the
remainder folded into the largest share, so the shares sum to the pot. The
estimate stays as the fallback for a pot with no slices, now cent-exact too.
`PotDistributedIsExact.test.ts`.

### The timeout is driven through the host, end to end

`RitOfferExpiryEndsTheWait.test.ts`: a real `ServerTableEngine` with a
`RunItTwiceEngine` on a `DeadlineScheduler` whose clock the test owns.
Nobody answers, the clock passes the window, `tickNow()` expires the offer,
the forwarder announces `no_agreement` (or `no_answer` naming the one silent
seat when the chooser had answered), the wait ends, the board runs once to
`HAND_COMPLETE`, and `rit_result` never fires. Two more cases pin that the
chooser's "1" and unanimous consent end the wait through the event alone,
and that `rit_all_accepted` precedes `rit_result` on the wire.

## Client

### The consent panel is heard

The Run It Twice panel opened silently, 1.5 s after `rit_offer`. A player
looking at another table found the question with the clock half gone. The
panel-open timer now plays the same attention cue "your turn" and the
insurance offer use (`useTableSound.playTurnAlert`, which respects the sound
setting), for the all-in seats only - the handler already returns before that
point for everyone else. Nothing new to mute.

### The replay names each run's made hand once the runs diverge

`buildReplay` evaluated a seat's per-street made hand against board one on
every street. On the streets after the all-in, where the runs have dealt
different cards, that is half the picture: the seat is drawing to two rivers
and the frame draws both. On a street where an extra board differs from board
one, `madeHands[].name` is now "Run 1 Four Of A Kind · Run 2 Three Of A Kind",
the shape the showdown frame already uses; shared streets keep the single
name. Pinned on production hand 3048511 in `handReplay.test.ts`.

## Tests

Engine: `RitOfferExpiryEndsTheWait.test.ts` (new), `PotDistributedIsExact.test.ts`
(new), `RunItTwice.parity.test.ts` (winners[].hand pin), and the existing RIT
suite (`consent`, `offerpath`, `multiway`, `threeruns`, `money`, `diamonds`,
`DecisionBoundary`, `TerminalBoundary`, `HorsesCanDeclineRunItTwice`,
`InsuranceRitExclusivity`, `HandController.tripleboard`) green. Client:
`handReplay.test.ts` (per-run made hands), `ritSingleRunIsAnnounced`,
`ritConsentIntegrity`, `ritShipsPerBoard.law`, `animations-always-play.law`,
`replayFrames`, `shareLinkCarriesTheWholeHand`, `handHistoryMoneyAgreement`
green.
