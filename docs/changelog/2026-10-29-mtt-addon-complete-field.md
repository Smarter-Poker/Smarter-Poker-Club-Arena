# Add-on eligibility includes every live entrant and seat

The add-on input device read one page of tournament players and tables. Its bounded table-ID filter also returned only one page of seats: 200 tables can contain more than 1,000 players. A simulated 1,801-player held field bought only 1,000 add-ons, and the existing 2,400-player throughput test exposed the same omission once its database fixture enforced the real row cap.

All three inventories now use stable ID cursors and require complete results before offering purchases. Table-ID URL chunks remain bounded; each chunk's seat results are independently paginated. The existing work allowance stops page admission after freeze, owner stop, abort or preparation deadline. Canonical purchase RPCs, participation decisions, concurrency limits and persisted offer deadlines are unchanged.

Seven cases fail against the previous implementation. The corrected source passes 108 connected tests including 1,000/1,001/1,801/9,001 entrants, a 1,001-table field, later-page errors, existing deadline/freeze/abort cases, serialized purchasing and ambiguous receipt identity. Root and server TypeScript checks pass. These large-field omissions are separate from the active maintenance-lock/original-hand outage; no live recovery is claimed.
