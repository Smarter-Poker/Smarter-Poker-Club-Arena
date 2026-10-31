# Lightning awards and live hand sharing

The October 30 daily report retained 4,395 client errors from the pot-award
fallback and five Share Hand null-card exceptions. Lightning passed the hand
controller's flat per-pot awards to `potWinFrame`, while the client expected
groups with a `winners` array. Every flat award became an empty group, and the
fallback displayed an equal split of the gross pot instead of the recorded
post-rake shares.

The shared engine frame now groups flat awards by board, pot and high/low half.
It publishes only presentation fields, not evaluated private card objects.
The client accepts the legacy flat shape as well, so its repair can publish
against the currently serving engine. Exact amounts, including zero shares,
stay exact. Existing grouped physical-table frames remain unchanged.

Live Share Hand now reads only visible cards. Hidden or malformed slots do not
crash the completion handler. A missing board slot ends the known board prefix;
it cannot shift a river into the turn, or a later run into an unavailable run.

Lightning pool rooms have no `tables` row. Their cluster metadata now supplies
the club owner that the physical-table bootstrap normally sets, preventing the
completed-hand counter call from losing its club scope. Unknown metadata does
not substitute a viewer's club.

Regression evidence covers the actual engine frame through client award groups
and chip-fan generation, legacy frame compatibility, exact zero shares, private
card omission, hidden-card sharing and preserved street/run positions. The
retained baseline produces zero award groups for the flat fixture; the repair
produces three exact groups. Existing engine frame equivalence and actual
Lightning showdown pacing checks also pass. No production game or money writes
were used for verification.

Client publication and engine activation are separate delivery states. The
client does not require the new engine frame. Engine activation continues
through the existing certified release transaction; these source changes alone
do not establish production adoption or recovery of the stalled tournaments.
