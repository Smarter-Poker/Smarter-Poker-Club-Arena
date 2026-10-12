# Horse Brain Phase 13 P13-A: one bounded raise in the joint response model

The joint multiway owner's response model could only fold, call or move a short stack all in, then go straight to showdown. On turn and river decisions it now models one bounded legal opponent raise, hero's answer to that raise and, from the turn, one river round dealt from the same physical sample. The new pack is `joint-action-response-round2-v1`; the old model stays callable as `joint-action-response-round1-v2` for comparison. Preflop and flop keep the old model.

- Raise size comes from the horses' own action builder over the responder's authoritative menu (pot-sized under the structure cap, the fixed increment in fixed limit, or the stack).
- Raise rights follow the controller: a full raise reopens, a short all-in does not, fixed limit caps at four wagers. A new parity test drives a real HandController and requires the same menus and bounds at every post-flop decision.
- Every terminal branch settles through the existing pot, score and deduction owners and must conserve chips. Hand-built settlements for NLH, PLO4, a three-way side pot and PLO8 equal the model exactly.
- Work limits are explicit: one raise slot per sample, at most 32 terminal branches per candidate. Over the limit the ranking is refused as `joint_response_branch_unavailable`; a deadline anywhere in the tree returns no ranking at all.
- Found during the build: a capped fixed-limit all-in (which the controller executes as a call) was being modeled as a raise. Fixed, and pinned by the cap test and the parity test.
- Still shadow only. Nothing selects; no live decision can change. Engine-host timing qualification is P13-C.

Record: [horse-brain-phase13-a-response-tree-2026-10-06.md](../horse-brain-phase13-a-response-tree-2026-10-06.md).
