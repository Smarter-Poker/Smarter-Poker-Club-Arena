# Club MTT Creation Uses The Shared Setup Profiles

The club tournament modal previously changed only the blind ladder when an operator selected Regular, Deep Stack or Turbo. Its initial 1,500 chips at a 20-chip opening big blind remained 75 BB, including after selecting Deep Stack. The table-config creator already offered the engine-owned setup profiles.

Explicit MTT selections in the club modal now use that same existing policy: Regular 150 BB with 10-minute playing levels, Deep Stack 300 BB with 15-minute levels, Turbo 100 BB with 5-minute levels, and Hyper Turbo 50 BB with 2-minute levels. Chips are derived from the selected ramp's actual opening big blind. These are Club Arena product choices, not universal industry requirements. The preview reports the draft's actual playing clock and opening depth.

Opening the modal preserves its existing custom draft. Overriding a profile's stack displays Custom Setup and retains the selected ladder and clock. Edited custom ladders survive switching away and back; their inactive controls are disabled so invalid hidden input cannot block a different preset's submission. Existing break rows, fixed SNG/Spin choices, payout settings, satellite targets and scheduling paths remain intact. Existing events and restored table-config drafts are not modified.

Free Buy retains its existing serializer rule: an omitted rebuy-chip amount follows the selected starting stack (`freeBuyConfig`), while explicit add-on chips and both purchase costs remain unchanged. Thus selecting Deep Stack produces 6,000 starting and default rebuy chips with the existing 1-chip purchase costs and 10,000-chip add-on. This change introduces no serializer, fee, payout or capacity rule.

## Verification

- The actual modal regression failed on the old implementation for all four profile choices and the initial custom-depth disclosure.
- All 23 cases in `tests/components/tournamentCreatePaidField.test.tsx` pass, including the actual modal submission, real RPC serializer, saved-schedule service path, custom round trip, Free Buy, bounty variants, re-entry, satellite and fixed-format preservation. Database effects and target reads are mocked at the boundary.
- Existing profile/TableConfig contract suites contributed 18 passing cases; the existing fixed-format/config suite contributed 16. Their unchanged coverage was retained rather than repeated after the final isolated custom-fieldset correction.
- Final client project-reference typecheck (`tsc -b --pretty false`) passes. A local Chromium check independently confirms hidden disabled fieldsets do not participate in constraint validation and preserve their values when re-enabled; this is browser DOM semantics evidence, not a deployed modal test.

This is a source-and-local-test preparation. Protected CI, production build, publication and live verification remain delivery steps. No engine runtime, database, economic policy or R46 activation change is included.
