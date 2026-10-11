# Player Command Phase 1 Verification

The Phase 1 production workspace test failed its return-position assertion
(expected 448, observed 372), and its serial suite did not execute the last
three cases. Its row activation now focuses the real button with preventScroll
and presses Enter, asserting both the pre-activation position and the saved
position before Back. The original exact 448 return assertion remains. The
isolated click fixture did not reproduce the production discrepancy; the
original failure is not classified as an application or harness defect without
that evidence. The maintained post-publication suite must execute all five
cases against the corrected release.

Connected source review reproduced two actual continuity defects:

- A short viewport near the end of a roster restored 9200 to 9144 because the
  clamp subtracted a fixed 696 height. Restoration and required-page calculation
  now use the actual viewport height and rendered scroll extent. The actual
  component regression fails before the correction and passes after it.
- Explicit same-club navigation while the component remained mounted left the
  old controls active and rewrote the new URL. External history queries now
  update the view and sort before the controls replace their URL. Ordinary
  control replacements and account isolation retain their existing ownership.
  A real router/component regression covers linked navigation and history Back;
  it fails before and passes after the correction.

No engine API, database schema, financial action or approved artwork changed.
Real-time law: continuity is triggered by explicit navigation and scroll events;
no snapshot diff or polling was added. Compilation, focused connected tests,
required exact-candidate checks, protected merge, publication and live proof
are recorded separately in the existing task checkpoint.
