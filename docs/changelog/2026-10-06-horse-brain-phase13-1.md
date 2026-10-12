# Horse Brain Phase 13.1: the joint owner records its inputs and prices what it executes

October 6, 2026. Horse Brain only, shadow only. Record: [P13.1](../horse-brain-phase13-1-input-binding-2026-10-06.md).

- **Legal form.** Joint candidates were priced and ranked at cent sizes the legalizer rewrites to whole chips, so the receipt priced one action and the table would execute another (for example 77 of 217 fired PLO4 cash decisions over natural controller spots on main). Every candidate is now rebuilt from the owner's legalizer before it is priced, and the proposal is the exact legal decision. The joint node refuses an applied candidate the legalizer would rewrite (`illegal_candidate`) and never applies a Phase 13 candidate on top of an applied Phase 10/11/12 one (`earlier_phase_applied`).
- **Positions.** The preflop first actor came from a dealer offset; with a tournament dead small blind the big blind's option was treated as closed. It now comes from the blinds the engine posted (`JointResponseOrder.ts`).
- **Input binding.** `joint-input-binding-v1` on the receipt, `phase13Inputs` on the execution witness, reviewer `input_mismatch`, worker-boundary validation, shadow-drop counted as `phase13_shadow_receipt_binding_dropped`, ledger family `phase13_range_*`. Domain version `joint-multiway-round1-v4`.
- **Receipt.** `rangePackVersion`, `actionPackVersion`, `uniformEscapes`, `selectionRefusal`.
- **Join.** The accepted execution joins the journaled receipt through `phase13Inputs`; no engine change was needed.
