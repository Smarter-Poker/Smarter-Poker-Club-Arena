# A closed Lightning room is no absence while the anchor still sees the player

Samantha (a horse in the private Action pilot) was admitted through the normal
Join Lightning and buy-in UI at 19:41Z (pool session c5a84f27). At 20:04Z the
player witness opened her room in a browser, and closed it at 20:05:12. Two
seconds later the room reported her disconnected (`disconnected_at`
20:05:14.481), and at 20:08:17 the reaper exited her pool session with
`disconnect_expired`. Her anchor seat stayed open with 4.51, so she was left
seated at a held anchor table without a pool session.

Her input device never went away. A horse's presence is its anchor engine's
heartbeat; the matcher and the boot presence pass both treat a player an
anchor engine reports CONNECTED as present ("connected anywhere wins"). The
runtime room path did not: when a room's last socket closed it reported a
disconnect without asking the anchor engines, so any browser that opened a
horse's room and closed again expelled that horse three minutes later.

`LightningRegistry` now takes the anchor engines' presence reports (never the
rooms' own) and does not report a room's last-socket close while an anchor
engine reports the player CONNECTED in that Cluster. A definite or unknown
anchor absence, another Cluster's report, a missing or failing presence read
all still report the disconnect exactly as before. No horse branch: the rule
is the same one matching uses for every player.

The damage is participation only: no chips moved (the 4.51 stays on her
anchor seat, wallet 142.78), and the exited session is not revived; she
rejoins through the ordinary door like anyone else. Regression: the
anchor-connected case failed before (a disconnect was reported) and passes
after; the anchor-absent, unknown, other-Cluster, empty and failing-source
cases keep reporting; the boot wiring is pinned to the anchor engines only.
