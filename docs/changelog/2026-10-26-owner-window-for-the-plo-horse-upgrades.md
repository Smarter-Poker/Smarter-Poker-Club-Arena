# Owner window for the PLO horse upgrades (#8110)

#8110 (PLO horses read every person as an aggressive raiser until proven
otherwise, cross-table-size corroboration of a maniac's read, and PLO6 river
nut discipline on paired and unpaired boards) merged at 12:06 UTC as e01ac0115.
Routine engine changes wait for the 04:00 Chicago window, which would have held
it until 2026-10-27. Dan ordered at 08:08 Chicago: "SHIP THE PLO HORSE UPGRADES
(#8110) AT THE NEXT AVAILABLE BREAK, DON'T WAIT FOR 4 AM." One owner window
names e01ac0115. It is placed first because both the staging admission and the
host transaction take the first currently valid window, and the earlier
paired-board window (valid until 15:08 UTC) is already served. It uses the
existing last-hand notice, drain, freeze, certificate, rollback reserve and
thaw, expires within six hours and is spent once the containing engine serves.
