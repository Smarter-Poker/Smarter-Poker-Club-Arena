# Isolate Each CSP Route Document

Production browser run 40813374123 passed 678 of 679 sweep cases. The CSP journey aborted its first navigation to `/hub/home-games` while the prior Diamond Store document remained visible. No trace was retained, so the cause of the aborted navigation is not proven.

The CSP journey now creates a fresh page in the existing authenticated context for each of its eight routes, installs the violation collector before its first navigation, collects that document using the existing readiness and observation checks, and closes the page in `finally`. This removes cross-route document lifetime coupling. Navigation or collector failures still reject; there is no reload, retry, suppressed error, removed route, shorter observation window or changed zero-violation assertion.

The existing CSP unit and source-contract suites cover fresh pages, collector-before-navigation ordering, retained evidence from both routes, and cleanup on collector or navigation failure. Application code, engine behavior and production financial records are unchanged. Protected integration and a successful production browser result remain required before completion.
