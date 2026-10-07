# The Diamond Arena runs the Midway schedule (rows) - 2026-10-06

Dan, 2026-10-06 13:09 CT: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE
MIDWAY UNION FOR NOW."

Migration `20261007010105` copies every active Midway Union schedule onto the
Diamond Arena with `club_id` = the arena and `union_id` NULL; the config is
copied unchanged and read 1 chip = 1 Diamond. It refuses if the arena already
has schedules, and leaves Deep Stack Society's (inactive) schedules alone.

Order of installation: after `20261007000010` (the Diamond spawn door,
guarantee set-aside, fee) is installed and after the engine that routes arena
schedules to that door (#6330) is live. Before that, the old engine would
insert arena schedules directly.
