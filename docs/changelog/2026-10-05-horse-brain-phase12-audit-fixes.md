# Horse Brain Phase 12 audit fixes (2026-10-05)

A read-only audit of everything Phase 12 merged (#6156, with #6151's P12-B
economics) found four issues; all are fixed here.

1. **Completion readers counted a DEEP second look as a second decision.** The
   worker journals FAST and DEEP results as `decision` records for the same
   turn. Both `phase11-completion-extract.py` and `phase12-completion-extract.py`
   now count first looks only (`snapshot.type == 'DECIDE_FAST'`) and name the
   rest `excluded_deep_second_look`. Checked against the live journal (every
   recent decision snapshot carries `type`), tested in both stage-1 suites. The
   predeclared completion window was amended before it opened (#6157's
   declaration, amendment 4).
2. **The Phase 12 reader's discard exclusion never fired on real records.** A
   discard snapshot is a `DECIDE_DISCARD` request (variant at top level, time in
   `journalContext.requestedAtMs`), not a betting snapshot, so the time filter
   dropped it before the named counter. It is now windowed and named by its own
   shape, and the test fixture uses that shape.
3. **Two data-ledger descriptions were swapped by the #6151 merge** (the PLO4
   row named the Phase 12 bindings). Restored.
4. **The P12.1 record** now says the binding's feature list is the proposal's,
   without the post-decision `net_action_economics` tag.

Noted, not changed: the Phase 10 policy digest omits `BettingStructure.ts` (the
reason Phase 11's digest v3 added it); live and league states carry an explicit
betting structure, and Phase 10 has no qualification to protect.
