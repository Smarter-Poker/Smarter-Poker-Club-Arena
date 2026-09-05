# Rabbit Hunt: what the industry actually does

2026-09-05. Companion to `2026-09-05-card-reveal-industry-standards.md`, and
under the same rule Dan set for it: "DO A DEEP DIVE ONLINE HOW THE OTHER
ONLINE POKER ROOMS RUN AND PROGRAM THIS ... SO WE HAVE THE INDUSTRY STANDARD
AND AREN'T JUST GUESSING." Every row below carries a confidence level. Where
a room's page could not be read (several are JavaScript-rendered and invisible
to a plain fetch) or a claim rests on a single passing mention, the row says
so. **Two search-engine result summaries fabricated specific, checkable, false
sentences during this work** - a confabulated 888poker line attributed to two
pages that do not contain it - so a "quote" that could not be found on the
page itself is not in this table.

The findings were gathered in the 2026-09-05 session that shipped the 1750ms
inter-hand rest (#3152) and were carried in that session's handoff only; this
file is the durable record.

## The table

| Room               | Has it                         | Cost                                         | Who sees the cards                        | Notes                                                                                                                              | Confidence |
| ------------------ | ------------------------------ | -------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| GGPoker / Natural8 | YES                            | none published                               | **everyone at the table** (official page) | has a dedicated, mappable **hotkey** for it                                                                                        | SOLID      |
| WPT Global         | YES                            | flat **$0.01** (official)                    | not published                             | you click a rabbit-backed board card; there is no button                                                                           | SOLID      |
| ClubWPT Gold       | YES                            | chips, price shown on the button             | not published                             | also usable LATER from the hand replayer                                                                                           | MEDIUM     |
| Winamax ("Reveal") | YES                            | free                                         | not published                             | cards land face down on the board and you click to flip; window ends at the next deal; MTT + cash; Hold'em/Omaha only              | MEDIUM     |
| PokerStars         | YES (beta 2024, cash Oct 2024) | not published                                | not published                             | 2025: window lengthened, and restricted to hands that reach the flop                                                               | MEDIUM     |
| partypoker         | YES                            | Diamonds (earned)                            | not published                             | click your own hole cards                                                                                                          | MEDIUM     |
| 888poker           | **UNCONFIRMED**                | -                                            | -                                         | one passing media mention, contradicted by 888's own pages; two search "quotes" were confabulations. Open the client before citing | WEAK       |
| Americas Cardroom  | NO EVIDENCE                    | -                                            | -                                         | its own glossary says "most online platforms don't allow it"                                                                       | MEDIUM     |
| PokerBros          | YES ("Rabbit Cams")            | per-player consumable, sent by club managers | not published                             |                                                                                                                                    | MEDIUM     |
| ClubGG             | YES                            | subscription tier benefit                    | not published                             |                                                                                                                                    | MEDIUM     |
| PPPoker / X-Poker  | YES                            | Diamonds / **VIP card** tiers                | not published                             | X-Poker gates it behind a VIP card - the same model Club Arena uses for the VIP all-in squeeze                                     | MEDIUM     |
| EvenBet (B2B)      | YES                            | -                                            | -                                         | the ONLY vendor documenting a dedicated **inter-hand break** for rabbit hunting, and a per-table enable                            | MEDIUM     |

## What it means for Club Arena

**No room publishes a countdown duration.** The 1750ms
`HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS` is a design decision (Dan's number,
"THIS SAME 1.75MS PAUSE SHOULD BE DONE ON ALL HANDS UPON COMPLETION") and
cannot be defended as parity - but nothing found contradicts it, and no
complaint that any room's window is too short was found anywhere, despite
targeted searching. Dan's report is ahead of the public record.

**We are ahead on two axes.** An explicit user hide/disable toggle
(`rabbit_hunt_button`) was found at no major room except one unverified iPoker
claim. An UNCONDITIONAL inter-hand rest was found only at EvenBet, and theirs
is conditional - which leaks, because a pause that happens only when cards
remain tells the table that cards remain (CLAUDE.md 10.5: timing is part of
the treatment).

**We differ from GGPoker on who sees the cards, on purpose.** GG shows them to
the whole table. Ours go only to the buyer - Dan 2026-08-25: "These should
ONLY APPEAR TO THE PLAYER WHO CLICKED." Ours is also the safer rule: live
poker bans rabbit hunting specifically because it leaks information. Do not
"fix" this toward GG.

**Parity gap, now closed (2026-09-05, P4):** GGPoker's answer to the short
window for multi-tablers is a hotkey. Ours is **B**
(`docs/changelog/2026-09-05-a-hotkey-for-the-rabbit-hunt.md`). Theirs is
mappable; ours is fixed, because no key on the table is mappable yet.

**Differentiator still open (P5):** ClubWPT Gold lets you rabbit hunt later
from the hand replayer, so missing the window is not final. We have a
`HandReplay` component and a 90-second server offer TTL
(`RABBIT_HUNT_OFFER_TTL_MS`), so this is closer than it looks.

## Method notes, for whoever extends this

- Render the page; do not trust a search summary. Two summaries invented
  sentences about 888poker that the cited pages do not contain.
- Several room help centres are client-rendered and return a shell to a plain
  fetch. WPT Global, GGPoker and ACR were readable; ClubWPT Gold, Winamax and
  PokerStars were reconstructed from media coverage and are MEDIUM for that
  reason.
- "Has it" is the easy column. Cost and audience are where rooms are silent,
  and silence is recorded as "not published", never inferred.
