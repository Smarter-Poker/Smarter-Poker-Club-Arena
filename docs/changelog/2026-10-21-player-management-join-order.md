# Player Management defaults and club join ordering

Player Management now opens with Win / Loss This Week and Newest Players First.
The sort control also offers Oldest Players First. Both order the entire matching
roster by the date the player joined the club, with stable player-ID ties and
unknown join dates last. Existing workspaces adopt the new default once while retaining search, filters
and columns. Subsequent saved sort choices and explicit deep links remain available, along with role, activity, name, downline, wallet and fee sorts.

The server page and authorized CSV export share this ordering. Query-bound
cursors retain viewer, club, search and filter ownership. The existing hierarchy
cache is used only for hierarchy requests, so cached rows cannot briefly display
an incorrect join order.

Verification: isolated PostgreSQL regression fails before the migration and
passes after it for newest/oldest, tied and null dates, three pages, search,
club scope, malformed and mismatched cursors, export and replay refusal.
The native regression runs in the existing Data Console PostgreSQL workflow.
Client workspace tests cover defaults, oldest selection and saved-view continuity.
