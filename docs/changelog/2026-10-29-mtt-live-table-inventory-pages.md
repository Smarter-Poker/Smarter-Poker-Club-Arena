# Balance against the complete occupied tournament field

The balancer's live-table inventory read only one PostgREST page of tables and seats. At 1,009 seats it could omit the final occupied table, and at 9,001 seats both inventories were truncated. The live-table reader now pages both inventories, filters seats through the named tournament/table relationship, and returns unknown if a page fails or its manager lifecycle changes.

The actual manager reader fails the 1,009/9,001-seat regressions before this fix. Boundary cases at 1,000 and 1,001 seats, page failures and lifecycle withdrawal pass after it. Connected balancing and durable-break suite: 87 tests passed; three relationship/field source-contract files: 16 tests passed; root and server TypeScript passed. No production stalled field in the initial census exceeded 218 entrants, so this is a reproduced large-field defect, not an attribution for the three current stalls.
