# The Spins Masthead Survives A Reload

Live verification of the Poker Spins presentation exposed a cold-load identity gap: entering a union game from the club lobby displayed the full club and union, but reloading the same active table could leave only the union. The masthead read the current-club store once, while the existing lobby destination resolver also knows the persisted last entered club and filters union hubs out.

The masthead now uses that same resolver before reading the viewer club name. Ordinary club tables keep their own names, unavailable identity remains withheld, and the union is never printed twice. The read reports errors and ignores results after the table unmounts. This changes presentation only, with no wallet, seat, tournament, or engine write.

A regression source check failed against the prior lookup and passes after the change. An isolated resolver case covers a null current club, cold union cache, persisted entered club and authoritative union flags. Existing club routing and masthead tests remain in the normal client verification path. Publication and live reload proof are recorded in the existing Poker Spins checkpoint.
