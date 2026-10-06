# A refused table decision says so (2026-10-06)

## What was wrong

Three in-hand decisions failed silently (launch audit 2026-10-05):

- **Run It Twice, accept.** The check beside the hero's name was drawn and the
  hero added to the accepted list BEFORE the request. On a refusal only an
  error report was written: the panel said the player had agreed to run it
  twice while the engine had recorded nothing.
- **Run It Twice, chooser.** The same shape: the panel moved to "waiting on
  the others" before the engine answered and stayed there on a refusal.
- **Show Hand.** A refused tap appeared to do nothing at all.

## The fix

On a refusal the optimistic state is taken back (the check, the accepted id,
the chooser's "decided" state) and the player is told in a toast what was not
received, so they can answer again while the window is still open. A decline
and a one-run choice are not reopened on a refusal: the engine's own timeout
answers the same way, and its broadcast closes the panel for everyone.

## Proof

`tests/unit/aRefusedTableDecisionSaysSo.test.ts`.
