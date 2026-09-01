# The club level lives below the logo in a blue box

2026-09-01, rebuilt against main after #2509. Dan, binding: "ANYTIME A NEW
CLUB IS CREATED, IT NEEDS TO START AT LEVEL 1, THAT NEEDS TO BE BELOW THE
LOGO INSIDE A BLUE BOX, NOT OVERLAPPING THE LOGO."

Level 1 at creation was already true twice over: clubs.level defaults to 1
AND fn_create_club_atomic_membership_impl inserts level 1 explicitly; the
displayed level is then a pure member-count fact.

Two different cures collided on the display half. The badge originally
floated at its own absolute coordinates across the logo's bottom edge.
PR #2509 cured the overlap by REMOVING the level from the card entirely
(no-level artwork, prop deleted). Dan's order was the other cure: keep the
level, put it below the logo, in a blue box. This restores the level prop
and element and gives it that box, in the logo's exact column, starting
beneath the current logo square (centered at 52%, so it ends ~70.8%; the
box sits at 72.8%). ClubHomePage passes clubLevel again.

Also carried on this branch: the lobby empty-state now names the Favorites
filter when Favorites is the reason a tab looks empty (Dan hit "None Of
This Type Right Now" on the PLO tab while 980 cash games sat one persisted
toggle away).
