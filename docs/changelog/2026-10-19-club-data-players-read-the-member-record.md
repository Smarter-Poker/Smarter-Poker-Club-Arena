# 2026-10-19 - Club Data's player list reads the Member record

Seen first on one Club JAQK member (005428fe): the Club Data player list said
+474.45 cash on 2026-10-13 and -219.69 on 2026-10-14; her Member record said
-169.86 and +238.05. Hands and fees disagreed too.

## What was measured (production, UTC days 2026-10-13..2026-10-19)

| Club                     | Players with activity | Hands differ | Cash net differs | Fees differ |
| ------------------------ | --------------------- | ------------ | ---------------- | ----------- |
| Club JAQK                | 519                   | 477          | 270              | 515         |
| SHARK CLUB               | 525                   | 474          | 271              | 515         |
| Deep Stack Society       | 417                   | 209          | 214              | 381         |
| Midway Union (root)      | 262                   | 262          | 195              | 105         |
| Lightning Internal Pilot | 72                    | 72           | 72               | 70          |

## Why

- **Hands** were read across the whole union. Since 2026-10-17 the list is
  every member of the club, and 518 people are members of both JAQK and SHARK,
  so both clubs listed the same union hands. JAQK listed 11.0M hands; 5.7M
  were played through JAQK.
- **Rake** was each player's rake across the whole union, and left out today.
  JAQK listed 1,061,331.73; the fees filed to JAQK are 613,351.83.
- **Cash net** was cash-outs minus buy-ins on the day the wallet moved. The
  Member record shows what the hands played that day won or lost. A session
  that runs past midnight lands on different days.

## Fix

Migration `20261019145606_club_data_players_read_the_member_record.sql`
changes only the reading part of the player list, its summary and its CSV
export: hands and cash net now come from `member_record_daily_facts` (the
funded club, the club's launch cutoff), fees from `ca_club_member_fee_totals`,
both exactly as the Member record reads them. Tournament net was already the
same on both and is unchanged. Both use UTC days. Columns, sorting, paging,
search and who may read the list are unchanged; no money table or settlement
projection is touched. Today's fees are now included, so the "rake complete
through" caveat no longer shows.
