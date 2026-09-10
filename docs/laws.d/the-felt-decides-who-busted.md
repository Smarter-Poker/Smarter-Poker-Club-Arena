# tests/the-felt-decides-who-busted.law.test.ts

tournament_players.chips mirrors the seat, and the seat is the bank. Pins that
neither the seat-assignment path nor the absent-player eliminator may read that
mirror to decide a stack or a bust: the move reads the seat the player is
leaving and falls back to the mirror only when no live seat exists, and the
eliminator asks what the seat they LAST LEFT held rather than whether any seat
ever held chips (a vacated seat keeps its stack, which had made anyone who ever
held chips un-eliminable). Also pins the conservation gate that makes the class
impossible however an input goes wrong - a seat assignment may move chips
between chairs but may never raise a tournament's live total above what was
bought in, computed from registrants, rebuys and add-ons; a normal move
subtracts the player's own live seat before adding the new stack, so it cannot
trip, and an existing overage is tolerated while growth is refused.
