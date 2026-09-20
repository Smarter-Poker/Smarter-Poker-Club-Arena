# Tournament structure displays follow the engine clock

MTT displays disagreed with the engine and each other. The overview called all
short clocks Turbo and long clocks Deep Stack. Satellite cards called three
minutes Hyper. The main tournament lobby treated stored seconds as minutes,
estimated missing durations from a name, and omitted the structured clock from
its cards. The main MTT board used a name or starting-stack bucket as speed.

One pure engine module now describes speed, opening duration, complete known
playing-level duration range and starting depth in big blinds. Existing engine
creation thresholds are unchanged: at most two minutes Hyper Turbo, at most
five Turbo, at least twelve Slow, otherwise Regular. These are Club Arena's
policy, not a claim of universal industry thresholds. Actual minutes and depth
are disclosed independently. Stored seconds are converted once, camel/snake
minute fields retain engine precedence, true breaks are skipped, and malformed
or missing opening evidence remains unknown rather than borrowing a later row.

Overview, tournament lobby cards, satellite cards and the main MTT board use
these facts. Board sorting follows the displayed MTT clock category. Names and
stacks cannot relabel its speed. Cards show starting BB depth and fixed or
variable clocks; tapered descriptions can wrap. The main board retains its
compact opening-minute display. Existing Spin/SNG board stack categories remain
outside this MTT change. No funded ladder, stack, prize, bounty, registration or
payment contract is modified. Manual defaults remain 1,000 chips at 10/20 and a
three-minute independent clock override, including when the Slow ramp is chosen.

Validation: 562 client cases in 30 files, including rendered overview/cards and
actual satellite/main-board adapters; 126 engine cases in two files, using the
server's installed Vitest 2.1.9; app and server TypeScript pass. Earlier expanded
engine checks also passed under the root Vitest 4 runner; these are not added to
the distinct case count. The pure helper bundles for a browser as one input,
zero runtime imports and 1,752 minified bytes. The full production client bundle
is not qualified locally because terser is unavailable; no dependency install
was performed. No live rendered UI or release completion is claimed.

Preexisting client countdown timers and the lobby's broader event/query model
are unchanged and remain separately tracked real-time architecture gaps. Required
CI, merge, serving provenance and post-deploy checks remain open; GitHub workflow
admission currently reports a payment-authorization failure through the release
owner. This source change does not bypass that release path.
