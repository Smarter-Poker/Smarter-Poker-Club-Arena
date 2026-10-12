# Club Arena Navigation Live Contracts

The first complete production browser pass after the hamburger information-architecture release
found three focused failures. One was a real dead action and two were certification contracts that
rejected valid production destinations.

## Root Causes And Repairs

- Club Arena home intentionally canonicalizes to the slashless
  `/hub/club-arena` URL. The hamburger destination matcher now accepts both that canonical URL and
  the equivalent slash-terminated form.
- Invite Players sent controlling members to the prospect join page. That page correctly refuses an
  existing member and returned the administrator to the club, leaving the action with no useful
  result. The action now opens Club Settings, where Share Club and Copy Invite Link are already
  implemented. The join-page membership protection remains unchanged.
- Club-scoped Messages intentionally hands off to the World Hub Messenger. The responsive audit now
  recognizes that exact route shape, still requires the Messenger destination, and continues to
  measure the resulting document at mobile, tablet, and desktop widths.

No route guard, permission, API, Supabase contract, realtime flow, form, checkout path, or stored
data was weakened. The follow-up changes one action destination and makes the two browser contracts
match the application contracts they certify.

## Candidate Verification

- Hamburger source contract: 41 of 41 tests passed.
- TypeScript application check passed.
- Targeted lint passed for every changed source and test file.
- The hamburger, exhaustive Club Operations, and responsive-fit browser files discovered all 171
  cases successfully.

These are local candidate results. Protected merge, publication, public build identity, authenticated
production behavior, and fixture cleanup remain separate release evidence.
