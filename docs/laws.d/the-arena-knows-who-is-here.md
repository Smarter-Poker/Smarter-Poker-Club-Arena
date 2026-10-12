# tests/the-arena-knows-who-is-here.law.test.ts

The Diamond Arena's Online Now figure counts the players who are here right
now by three live sources that already exist and that nothing new writes:
Supabase Realtime's register of live table feeds (realtime.subscription, a
row for every feed a signed-in page holds open), the messenger's presence and
a live arena seat (migration 20260930044500_the_arena_knows_who_is_here). The
law pins that fn_diamond_arena_counts was redefined only over its pinned live
text and that members, tables and seated are word for word what
20260929214500 wrote; that online reads signed-in claims only, with a guarded
id, counts through fn_diamond_arena_is_player (fixtures and deleted accounts
out, horses never named) and answers a number only, never a name or an id;
that it is a number only while one of the sources shows the person asking,
and otherwise NULL with its reason; that the migration writes nothing, keeps
its grants and opens no switch; that the client keeps holding the feeds the
count reads (GlobalWaitlistListener in App.tsx, the header's notifications
feed); and that the Players page asks an unknown Online once more before it
prints Unavailable.
