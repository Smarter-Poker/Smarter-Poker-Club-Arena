# Tournament Spectating Holder And Rebuy Seat Recovery

Tournament spectators now see the approved two-compartment holder with a live registration-close countdown on the left and Tap Here To Enter on the right. The existing tournament entry page remains the purchase owner. Expired clicks are refused; tournament switches and failed reads cannot paint a stale offer.

The bottom tournament dock now uses a dedicated painted metal chassis, larger live figures and its existing collapse/close controls. The final rebuy level carries a persistent flashing top notice, including when the bottom dock is closed.

The rebuy display now bounds level-based eligibility by the configured clock as well. A confirmed rebuy retains its atomic receipt's table and seat instead of discarding them; the table marks that seat, updates table-tab ownership and requests a fresh engine snapshot immediately. A purchase assigned to another table follows its confirmed seat without another purchase. Pending receipt recovery and duplicate-request serialization remain intact.

Validation: focused service, receipt, countdown, cutoff, stale-owner, dock and rebuy-prompt tests; compiler and copy gates. Publication and database/engine phase corrections are tracked separately in the task evidence checkpoint.
