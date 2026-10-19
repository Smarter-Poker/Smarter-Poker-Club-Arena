# The Lightning admission witness meets the entry door a fresh device sees

Both private Action admission runs (39160085181 on October 18 and 39295960542
on October 19) ended in phase `join` with the join outcome `unknown`, having
spent nearly the whole four-minute budget. Production readback showed the join
door was never reached: no seat hold, no waitlist row, no seat, no pool session
and an unchanged wallet (146.78 on October 19). On October 18 the member also
still held a cluster seat without a pool session, so the entry correctly
offered View Game instead of Join Lightning.

The cause is in the witness. The Lightning entry route lives inside the app
shell, and a fresh browser meets the shell's first-run layers over it: the
device welcome (a full-screen acknowledgement stored only in that browser),
then the soft asks (daily bonus, analytics, notifications). The table route
has no shell, so the existing-pool witnesses never met them. The witness
tapped Join Lightning blindly with the whole remaining budget as its timeout,
so an obstructed or absent door looked identical to a lost reply.

The admission witness now waits, bounded, for the settled entry and reads what
it actually offers in fixed classes only: the door (Join Lightning, Join Game,
Joining, View Game, Try Again or joins closed), the profile gate state and the
layer sitting over the door. It answers the device welcome through its own
checkbox and Enter control, and puts a soft ask off with Not Now (which never
claims, grants or pays), each at most once. Anything else (profile gate, age
gate, an unknown layer, or a door that is not Join Lightning) is reported with
its class and nothing is tapped. The single Join Lightning tap is bounded to
15 seconds, and a refused join keeps only its native leading code.

No join, buy-in, funding, consent, roster, matcher, horse or Lightning mode
behaviour changed. Regression: the device-welcome case fails before (the tap
never lands and the run is unknown) and passes after; the not-offered,
covered, soft-ask and refusal-code cases pass; the 132 witness operator tests
pass.
