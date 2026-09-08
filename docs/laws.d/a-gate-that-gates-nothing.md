# tests/a-gate-that-gates-nothing.law.test.ts

`TOSGuard` wrapped the entire router in App.tsx and its whole body was
`return <>{children}</>`, under a doc comment describing everything it would do
"when enabled". The app read as gated and gated nothing: 0 of 1,308 profiles
had ever accepted the Club Arena Terms of Service, `getTOSStatus` and
`acceptTOS` had no callers, the complete `TOSAcceptanceModal` was imported by
nothing, and `/api/club-arena/accept-tos` - a working endpoint - was called by
nothing in either repo. A second identical passthrough stub (`TermsGate`) sat
beside it. An inert guard is worse than no guard because it answers "is this
enforced?" with a file that looks like enforcement. The guard now reads the
canonical column through `getTOSStatus`, blocks with the modal on a definite
no, records acceptance only through the endpoint and only after the response
is checked (an optimistic flip would let the app through on a 500 and record
nothing), treats a failed read as a re-ask rather than as consent or as a
lockout of every account on one PostgREST blip, and keeps `/legal`, `/auth`
and `/help` reachable while it is up. The law pins each of those and that the
dead twin stays deleted. The server seat gate in the World Hub is the durable
boundary; it sits on a path Club Arena's felt does not currently use, and
enforcing it before anyone can accept would simply stop every human sitting
down - so the UI half lands first.
