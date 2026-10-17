# A satellite winner is not capped by the satellite it won (2026-10-17) - superseded, never applied

Migration `20261017025359_a_satellite_winner_is_not_capped_by_the_satellite_it_won`
(#7205) was written for Sunday Deep Stack Satellite 10 (a4445447), whose
Diamond winner was refused with `diamond_satellite_winner_at_the_table_cap`
because both satellite settlement authorities counted the winner's own seat at
the RUNNING satellite toward the four-game cap.

Before it could be installed, another agent installed
`20261017033733_a_capped_diamond_satellite_winner_is_paid_not_held` (#7211).
That migration fixes the same cause the same way (it subtracts the winner's
live seats at the satellite being settled) and also pays a capped Diamond
winner the ticket's value in whole Diamonds. Satellite 10 then completed at
03:41:13 UTC with a 200 cash award to its winner.

On 04:16 UTC, the installer refused this migration because the live body was
no longer its pinned preimage (`8fb5cdbc...`). Nothing was sent. The
migration, its law test and its registry entry are removed, so main carries
no migration that can never apply. The cause, the fix and its law live with
#7211.
