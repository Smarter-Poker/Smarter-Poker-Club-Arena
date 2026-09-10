# server/src/engine/AHorseSpeaksAtTheTable.law.test.ts

Measured 2026-09-08: `table_chat` held 6 messages in its entire history, all
from one human, and across 1,000 horses and 1,271 occupied seats a horse had
NEVER sent one - not rarely, never. Not a live tell while nobody chats, but
the loudest one on the platform the day real players arrive: a human types
"nh" and eight seats never answer, every table, every night. Chat is a feature
every human seat has and no horse seat had, which is the exclusion Dan ruled
on for the rebuy pause ("IF YOU DIDN'T GIVE THEM THE SAME EXACT FEATURES AND
FUNCTIONALITY, PEOPLE WOULD NOTICE"). `HorseTableTalk` gives a horse the same
door: the same `table_chat` row a human's composer writes
(`message_type: 'player'`, nothing in it saying which kind of player), refused
by the same `fn_table_chat_is_silenced` - which the engine must ask for itself,
because it holds the service role and RLS does not stop it, and a silenced
horse that kept talking would be the tell instead. The law pins that row, that
refusal, that an unreadable silence check is not permission (10.86), that the
message never lands on the pot's own tick or at a fixed delay (V35's lesson),
that chattiness is derived per horse so the rate is not itself a signature,
that it never repeats itself or anyone else (reusing `horse_phrase_ledger`,
6,121 rows and already proven on the social feed), and that settlement calls
it with `void` so chat can never hold up a pot.
