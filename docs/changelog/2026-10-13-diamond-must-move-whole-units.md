# Diamond Must-Move lobby whole units

The Diamond Must-Move lobby reused the chip decimal formatter for stakes and stacks. It now accepts the table asset and uses the existing whole-unit formatter for Diamond stakes, the viewer’s seat, and occupied chairs. Omitted asset retains the chip formatter. Seat requests, focus, polling and navigation are unchanged.

The rendered regression failed before the repair with `10.00/20.00` instead of `10/20`. Afterward all 43 existing lobby audit cases passed, including whole Diamond stacks of 1,376, zero and 123,456,789, and unchanged default chip displays of 0.10/0.20 and 12.50. Publication and live verification remain separate delivery steps.
