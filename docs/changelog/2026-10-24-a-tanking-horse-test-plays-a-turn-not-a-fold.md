# A tanking horse test plays a turn, not a fold (2026-10-24)

`LightningHandHost.test.ts` "a horse that tanks runs into its bank" failed on
main in both engine release runs after #7958 (99f89c63, 49d93f96) and about
three times in four locally. The fixture plays the real `HorseLogic.decide`,
so the first heads-up decision is a preflop fold roughly half the time, and a
fold commits at once (#7896): no clock runs, no time bank activates, and the
assertion `TIME_BANK_ACTIVATED > 0` has nothing to see. Since #7958 an early
look can also be the first decision, which is not a turn at all.

The tempo pin now counts turns only, and a tanking turn the brain wanted to
fold is played as the check or call, the only actions a tank can run a clock
on. Six consecutive full-file runs pass. No engine code changed.

The Lightning fence law (`aLightningHorseTurnHasTheEngineFence.law.test.ts`)
is scoped to turn decisions: an early look keeps its `:early` fence, which
`AHorseThatIsAlreadyFoldingFoldsRightAway.law.test.ts` reads. Giving early
looks the five-part fence too is left to the Lightning early-fold owner.
