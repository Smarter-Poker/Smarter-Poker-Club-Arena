# A captured add-on field keeps its closing minute

Prime Time Free Buy, October 26 Chicago, held its field for the exact persisted
minute 02:30:42.886 through 02:31:42.886 UTC October 27. Of 237 eligible horses,
113 had already added on and 124 still had the chips and a seat. Only 73 of
those 124 received a new receipt; 51 received no add-on and no receipt. The
field's 35 tables subsequently resumed, but participation failed.

Purchases stopped for 25.994 seconds between 02:31:05.143 and 02:31:31.137.
The bounded purchase pass returned its captured cohort after twenty seconds,
then lost most of the remaining minute waiting for shared scheduler admission.
Canonical SQL serializes the event's money purchases; eight concurrent HTTP
requests cannot make that event's settlement lock parallel.

Eligibility reads retain their twenty-second bound. Once the eligible cohort
is captured, the same purchase pool keeps its original owner through the
earlier persisted window deadline or the existing sixty-second sweep lifetime
measured from operation start. No global scheduler bound, pool size, purchase
RPC, price, funding rule, receipt identity, or break duration changes. Stop,
abort and maintenance freeze still stop further requests.

The serialized 124-horse regression purchases only 75 before this repair and
all 124 afterward, using one eligibility snapshot. Larger-field coverage pins
the existing sixty-second ceiling, and lifecycle/deadline/ambiguous-reply cases
retain their own assertions. Live participation still requires new evidence
after this repair is protected-merged and published.
