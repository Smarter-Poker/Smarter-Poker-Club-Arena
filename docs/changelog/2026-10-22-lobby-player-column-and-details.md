# Centered player counts and readable lobby details

Keep the player total and table count on the same centerline beneath Players, including the desktop game counter. The phone column has room for the count and seat meter at 320px. Cash rows now include the same Action/Madness rules note as desktop, with up to three wrapped detail lines instead of a single truncated line. The full game card remains available on selection; selection never commits admission.

A real LobbyTable browser regression measures player and table counts against the Players header at 320, 393 and 1024px, checks horizontal containment, wrapped details and selection. Original styles fail the centerline assertion; corrected styles pass.

Owner review requested the previous board depth: compact rows now reuse the wider board’s dark material shading, raised header and row edges, restrained blue accents and cast shadows. The compact column widths, wrapped details and player centerline are unchanged.
