# A stranger is never named by a legal name (2026-10-06)

Diamond Arena Phase 10 line 2, the follow-ups ruling 25 left open.

The 2026-10-01 column revoke stopped every browser read of a person's money,
legal name, birth date and whereabouts. It could not reach code that runs as
the service role or as a function's owner, and that code still printed legal
names and, in one place, a balance:

- World Hub server routes (Smarter-Poker-World-Hub#2148): friends search and
  suggestions (legal name, city, state, last active), the social feed's author
  names, leaderboards, reviews, comments, notification titles, live-stream
  titles, reel cards, home-game seat requests, an anonymous health endpoint's
  real balance, and other people's email to union leads and venue co-managers.
- Definer functions: fifteen home-game and messenger functions (World Hub
  migration 20261006001817) and four Club Arena ones (this repo's
  20261006005823, installed as 20261006010336) fell back to `full_name` when a
  member had no display name.

Also closed: `/api/live/gift` exempted any account whose `full_name` contained
the owner's name from every gift limit; `full_name` is writable by its owner,
so any account could rename itself into the exemption. It matches the owner's
account id now.

Proof (rolled back, as the platform service identity): another account's
`diamond_balance`, `full_name`, `birth_year`, `city`, `diamonds` and
`last_seen` are refused (42501); the caller's own row reads through
`get_my_full_profile()`; the messenger inbox prints no legal name.

Kept, by decision: club staff and a member's upline see that member's last
login date (credit risk), recorded under ruling 25.
