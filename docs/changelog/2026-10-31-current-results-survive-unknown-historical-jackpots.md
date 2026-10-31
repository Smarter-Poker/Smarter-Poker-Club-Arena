# Current results remain visible beside incomplete historical totals

The owner stopped reconstruction of the remaining199 historical BBJ receipts and
requires all new payouts to update Win/Loss. New Main/Mini winner/loser/table shares
already save their funded club and publish the member update atomically. However,
an unresolved old receipt raised55000 from the historical helper, aborting the
whole member record including valid current results.

For clients declaring `x-client-info: club-arena-member-results/2`, the private
helper now returns NULL only for a window containing unresolved ownership. Current
windows still include their verified awards. The record, roster and Statistics
preserve explicit nulls and print Unavailable, never zero or Restricted. The card
explains the historical evidence gap; tournament figures remain available. Older
open clients keep the explicit error until they load the updated client, avoiding
their previous null-to-zero decoder. Authorization is unchanged; the header only
negotiates the result representation.

No historical receipt, club assignment, financial amount or payout path changes.
The six-seat historical candidate was abandoned following the owner's scope
change. It is not part of this delivery.

Native PostgreSQL covers the same player with a paid current award and unresolved
old receipt, independent current windows, null historical totals, roster/detail,
legacy-client refusal and unchanged historical receipt. Actual PostgREST decoder
and rendered-card tests cover null preservation, current results, explanatory text
and normal zero values. Existing native and client checks execute the regression.
