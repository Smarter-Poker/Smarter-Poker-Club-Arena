-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812150642 "tour_stops_2026_batch1"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f65eeafd148ce55ad5e9f52af11da13b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Harrah''s Cherokee (August)', 'Harrah''s Cherokee Casino Resort', 'Cherokee', 'NC', DATE '2026-08-06', DATE '2026-08-17',
       'WSOP Circuit Harrah''s Cherokee (August) - Main Event', 1700, true, DATE '2026-08-06', 'Stop-level placeholder row (Phase-7b). Listed Aug 6-17, 2026 on official wsop.com/circuit 2026-27 schedule; $1,700 ME standardized per official WSOP season announcement', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Harrah''s Cherokee (August)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Horseshoe Tunica', 'Horseshoe Casino Tunica', 'Robinsonville', 'MS', DATE '2026-08-20', DATE '2026-08-31',
       'WSOP Circuit Horseshoe Tunica - Main Event', 1700, true, DATE '2026-08-20', 'Stop-level placeholder row (Phase-7b). Listed Aug 20-31, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Horseshoe Tunica');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Caesars Virginia', 'Caesars Virginia', 'Danville', 'VA', DATE '2026-09-03', DATE '2026-09-14',
       'WSOP Circuit Caesars Virginia - Main Event', 1700, true, DATE '2026-09-03', 'Stop-level placeholder row (Phase-7b). Official stop page shows Sep 3-14, 2026 with $1,700 NLH Main Event $500K GTD (flights Sep 10-12)', 'https://www.wsop.com/tournaments/wsop-circuit-caesars-virginia/', 'https://www.wsop.com/tournaments/wsop-circuit-caesars-virginia/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Caesars Virginia');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Horseshoe Council Bluffs', 'Horseshoe Council Bluffs', 'Council Bluffs', 'IA', DATE '2026-09-17', DATE '2026-09-28',
       'WSOP Circuit Horseshoe Council Bluffs - Main Event', 1700, true, DATE '2026-09-17', 'Stop-level placeholder row (Phase-7b). Listed Sep 17-28, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Horseshoe Council Bluffs');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Harrah''s Pompano Beach', 'Harrah''s Pompano Beach', 'Pompano Beach', 'FL', DATE '2026-10-01', DATE '2026-10-12',
       'WSOP Circuit Harrah''s Pompano Beach - Main Event', 1700, true, DATE '2026-10-01', 'Stop-level placeholder row (Phase-7b). Listed Oct 1-12, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Harrah''s Pompano Beach');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Caesars Republic Lake Tahoe', 'Caesars Republic Lake Tahoe', 'Stateline', 'NV', DATE '2026-10-22', DATE '2026-11-02',
       'WSOP Circuit Caesars Republic Lake Tahoe - Main Event', 1700, true, DATE '2026-10-22', 'Stop-level placeholder row (Phase-7b). Listed Oct 22 - Nov 2, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Caesars Republic Lake Tahoe');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Choctaw Durant', 'Choctaw Casino Resort', 'Durant', 'OK', DATE '2026-10-28', DATE '2026-11-09',
       'WSOP Circuit Choctaw Durant - Main Event', 1700, true, DATE '2026-10-28', 'Stop-level placeholder row (Phase-7b). Official stop page shows Oct 28 - Nov 9, 2026; tournament schedule TBA', 'https://www.wsop.com/tournaments/wsop-circuit-choctaw-durant-october-2026/', 'https://www.wsop.com/tournaments/wsop-circuit-choctaw-durant-october-2026/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Choctaw Durant');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Talking Stick', 'Talking Stick Resort', 'Scottsdale', 'AZ', DATE '2026-11-05', DATE '2026-11-16',
       'WSOP Circuit Talking Stick - Main Event', 1700, true, DATE '2026-11-05', 'Stop-level placeholder row (Phase-7b). Listed Nov 5-16, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Talking Stick');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Caesars New Orleans', 'Caesars New Orleans', 'New Orleans', 'LA', DATE '2026-11-12', DATE '2026-11-23',
       'WSOP Circuit Caesars New Orleans - Main Event', 1700, true, DATE '2026-11-12', 'Stop-level placeholder row (Phase-7b). Listed Nov 12-23, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Caesars New Orleans');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WPT', 'WPT bestbet Scramble Championship', 'bestbet Jacksonville', 'Jacksonville', 'FL', DATE '2026-09-04', DATE '2026-09-09',
       'WPT bestbet Scramble Championship - Main Event', 5000, true, DATE '2026-09-04', 'Stop-level placeholder row (Phase-7b). Official WPT event page lists championship Sep 4-9, 2026 at bestbet Jacksonville, $5,000 buy-in with $1,000,000 guarantee.', 'https://www.worldpokertour.com/event/main-tour-wpt-bestbet-scramble-championship-season-2026/details', 'https://www.worldpokertour.com/event/main-tour-wpt-bestbet-scramble-championship-season-2026/details',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WPT' AND tse.stop_name = 'WPT bestbet Scramble Championship');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WPTPRIME', 'WPT Prime Lodge Championship', 'The Lodge Card Club', 'Round Rock', 'TX', DATE '2026-09-24', DATE '2026-10-12',
       'WPT Prime Lodge Championship - Main Event', 1100, true, DATE '2026-09-24', 'Stop-level placeholder row (Phase-7b). Official WPT press release (Jul 7, 2026): festival Sep 24 - Oct 12, 2026, with $1,100 WPT Prime Lodge Championship ($1M GTD) running Oct 8-12; venue is The Lodge Card Club (Round Rock, TX per official schedule page).', 'https://www.worldpokertour.com/press-release/world-poker-tour-returns-to-texas-for-prime-lodge-championship', 'https://www.worldpokertour.com/press-release/world-poker-tour-returns-to-texas-for-prime-lodge-championship',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WPTPRIME' AND tse.stop_name = 'WPT Prime Lodge Championship');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Festival Cleveland (Main Event #321)', 'JACK Cleveland Casino', 'Cleveland', 'OH', DATE '2026-08-18', DATE '2026-08-23',
       'MSPT Festival Cleveland (Main Event #321) - Main Event', 1110, true, DATE '2026-08-18', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Aug 18-23, JACK Cleveland Casino, $500K GTD main event (PokerNews tour page shows Aug 18-24; official site date used).', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Festival Cleveland (Main Event #321)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Ameristar Poker Open (Main Event #323)', 'Ameristar Casino St. Charles', 'St. Charles', 'MO', DATE '2026-09-01', DATE '2026-09-07',
       'MSPT Ameristar Poker Open (Main Event #323) - Main Event', 1110, true, DATE '2026-09-01', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Sep 1-7, Ameristar Poker Open, $300K GTD; PokerNews tour page confirms Sep 1-7, 2026 in St. Charles, MO (venue city; MSPT site labels it St. Louis).', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Ameristar Poker Open (Main Event #323)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Wisconsin Poker State Championship (Main Event #325)', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2026-09-22', DATE '2026-09-27',
       'MSPT Wisconsin Poker State Championship (Main Event #325) - Main Event', 1110, true, DATE '2026-09-22', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Sep 22-27, Potawatomi Casino, Milwaukee, $1,000,000 GTD; Pokerfuse 2026 guide agrees on dates.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Wisconsin Poker State Championship (Main Event #325)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Spade Poker Championship (Main Event #328)', 'FireKeepers Casino Hotel', 'Battle Creek', 'MI', DATE '2026-10-13', DATE '2026-10-18',
       'MSPT Spade Poker Championship (Main Event #328) - Main Event', 1110, true, DATE '2026-10-13', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Oct 13-18, FireKeepers Casino, Battle Creek, $1,000,000 GTD; Pokerfuse 2026 guide agrees on dates.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Spade Poker Championship (Main Event #328)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Festival Riverside (Main Event #330)', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2026-11-03', DATE '2026-11-08',
       'MSPT Festival Riverside (Main Event #330) - Main Event', 1110, true, DATE '2026-11-03', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Nov 3-8, Riverside Casino, $300K GTD; PokerNews tour page and Pokerfuse guide both confirm Nov 3-8, 2026.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Festival Riverside (Main Event #330)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Winter Poker Classic (Main Event #332)', 'Running Aces Casino', 'Columbus', 'MN', DATE '2026-12-01', DATE '2026-12-13',
       'MSPT Winter Poker Classic (Main Event #332) - Main Event', 1110, true, DATE '2026-12-01', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Dec 1-13, Running Aces Casino, Columbus MN, $500K GTD; PokerNews tour page confirms Dec 1-13, 2026.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Winter Poker Classic (Main Event #332)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Club Poker Championship 2027', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2027-02-16', DATE '2027-02-21',
       'MSPT Club Poker Championship 2027 - Main Event', NULL, true, DATE '2027-02-16', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 Club Poker Championship, Feb 16-21, Potawatomi Casino, Milwaukee WI, $1,000,000 GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Club Poker Championship 2027');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Festival Potawatomi (Spring 2027)', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2027-04-27', DATE '2027-05-02',
       'MSPT Festival Potawatomi (Spring 2027) - Main Event', NULL, true, DATE '2027-04-27', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 MSPT Festival, Apr 27-May 2, Potawatomi Casino, Milwaukee WI, $1,000,000 GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Festival Potawatomi (Spring 2027)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Iowa Poker State Championship 2027', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2027-07-20', DATE '2027-07-25',
       'MSPT Iowa Poker State Championship 2027 - Main Event', NULL, true, DATE '2027-07-20', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 Iowa Poker State Championship, Jul 20-25, Riverside Casino, Riverside IA, $300K GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Iowa Poker State Championship 2027');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Spade Poker Championship 2027', 'FireKeepers Casino Hotel', 'Battle Creek', 'MI', DATE '2027-10-12', DATE '2027-10-17',
       'MSPT Spade Poker Championship 2027 - Main Event', NULL, true, DATE '2027-10-12', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 Spade Poker Championship, Oct 12-17, FireKeepers Casino, Battle Creek MI, $1,000,000 GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Spade Poker Championship 2027');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Rock ''N'' Roll Poker Open 2027', 'Seminole Hard Rock Hotel & Casino', 'Hollywood', 'FL', DATE '2027-11-17', DATE '2027-12-01',
       'MSPT Rock ''N'' Roll Poker Open 2027 - Main Event', NULL, true, DATE '2027-11-17', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 Rock ''N'' Roll Poker Open, Nov 17-Dec 1, Seminole Hard Rock, Hollywood FL, $2,000,000 GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Rock ''N'' Roll Poker Open 2027');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Dallas', 'Palace Poker', 'Grand Prairie', 'TX', DATE '2026-08-13', DATE '2026-08-23',
       'RGPS Golden Expedition Dallas - Main Event', 600, true, DATE '2026-08-13', 'Stop-level placeholder row (Phase-7b). PokerNews and rungood.com Golden Expedition schedule: Aug 13-23 at Palace Poker (Grand Prairie, TX; branded Dallas), $600 Main Event, $200K GTD.', 'https://www.pokernews.com/news/2026/07/rgps-palace-poker-dallas-52037.htm', 'https://www.pokernews.com/news/2026/07/rgps-palace-poker-dallas-52037.htm',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Dallas');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Kentucky (The Barrel)', 'The Barrel Social Club', 'Franklin', 'KY', DATE '2026-09-01', DATE '2026-09-07',
       'RGPS Golden Expedition Kentucky (The Barrel) - Main Event', NULL, true, DATE '2026-09-01', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 Golden Expedition announcement: Sep 1-7, The Barrel Social Club, Franklin, Kentucky (rungood.com events calendar mislabels state as TN; venue confirmed in Franklin, KY).', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Kentucky (The Barrel)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Joplin', 'Downstream Casino Resort', 'Quapaw', 'OK', DATE '2026-09-15', DATE '2026-09-20',
       'RGPS Golden Expedition Joplin - Main Event', NULL, true, DATE '2026-09-15', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Sep 15-20, Downstream Casino (branded ''Joplin, MO'' stop; resort is physically in Quapaw, OK at the MO/KS/OK border).', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Joplin');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Ohio', 'Lake Erie Poker Room', 'Elyria', 'OH', DATE '2026-09-29', DATE '2026-10-04',
       'RGPS Golden Expedition Ohio - Main Event', NULL, true, DATE '2026-09-29', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Sep 29-Oct 4, Lake Erie Poker Room, Elyria, Ohio.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Ohio');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Houston', 'Champions Club Texas', 'Houston', 'TX', DATE '2026-10-12', DATE '2026-10-18',
       'RGPS Golden Expedition Houston - Main Event', NULL, true, DATE '2026-10-12', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Oct 12-18, Champions Club Texas, Houston.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Houston');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Jacksonville', 'bestbet Jacksonville', 'Jacksonville', 'FL', DATE '2026-10-22', DATE '2026-11-01',
       'RGPS Golden Expedition Jacksonville - Main Event', NULL, true, DATE '2026-10-22', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Oct 22-Nov 1, bestbet Jacksonville, Florida.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Jacksonville');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition San Antonio', 'Lodge Card Club San Antonio', 'San Antonio', 'TX', DATE '2026-11-06', DATE '2026-11-15',
       'RGPS Golden Expedition San Antonio - Main Event', NULL, true, DATE '2026-11-06', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Nov 6-15, Lodge Card Club San Antonio; PokerNews RGPS tour page confirms Nov 6-15.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition San Antonio');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Bay Area', 'Graton Resort & Casino', 'Rohnert Park', 'CA', DATE '2026-11-12', DATE '2026-11-23',
       'RGPS Golden Expedition Bay Area - Main Event', NULL, true, DATE '2026-11-12', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Nov 12-23, Graton Resort and Casino, Rohnert Park, CA; PokerNews RGPS tour page confirms Nov 12-23.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Bay Area');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition San Diego', 'Jamul Casino', 'Jamul', 'CA', DATE '2026-11-17', DATE '2026-11-22',
       'RGPS Golden Expedition San Diego - Main Event', NULL, true, DATE '2026-11-17', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Nov 17-22, Jamul Casino (branded San Diego; casino is in Jamul, CA); PokerNews RGPS tour page confirms.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition San Diego');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Dream Factory Festival', 'Thunder Valley Casino Resort', 'Lincoln', 'CA', DATE '2026-11-27', DATE '2026-12-03',
       'RGPS Dream Factory Festival - Main Event', NULL, true, DATE '2026-11-27', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Nov 27-Dec 3, Dream Factory Festival at Thunder Valley Casino Resort, Lincoln, CA; PokerNews RGPS tour page confirms.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Dream Factory Festival');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'VENETIAN', 'DeepStack Extravaganza III (September 2026)', 'The Venetian Resort Las Vegas', 'Las Vegas', 'NV', DATE '2026-09-01', DATE '2026-09-27',
       'DeepStack Extravaganza III (September 2026) - Main Event', 1100, true, DATE '2026-09-01', 'Stop-level placeholder row (Phase-7b). Official Venetian series page: ''September 1 - 27, 2026''; headline event $1,100 NLH MSPT $300K GTD Nevada Poker State Championship, Sept 10-13.', 'https://www.venetianlasvegas.com/resort/casino/poker/deepstack-extravaganza-poker-tournament/dse-sep-2026.html', 'https://www.venetianlasvegas.com/resort/casino/poker/deepstack-extravaganza-poker-tournament/dse-sep-2026.html',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'VENETIAN' AND tse.stop_name = 'DeepStack Extravaganza III (September 2026)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'SHRPO', '2026 Seminole Hard Rock Poker Open (SHRPO)', 'Seminole Hard Rock Hotel & Casino Hollywood', 'Hollywood', 'FL', DATE '2026-07-28', DATE '2026-08-11',
       '2026 Seminole Hard Rock Poker Open (SHRPO) - Main Event', 5300, true, DATE '2026-07-28', 'Stop-level placeholder row (Phase-7b). Official SHRPO schedule page: series July 28 - Aug 11, 2026; $5,300 SHRPO Championship $3M GTD, flights Aug 7-10, Day 4 Aug 11. Currently running.', 'https://www.seminolehardrockpokeropen.com/2026-seminole-hard-rock-poker-open-schedule/', 'https://www.seminolehardrockpokeropen.com/2026-seminole-hard-rock-poker-open-schedule/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'SHRPO' AND tse.stop_name = '2026 Seminole Hard Rock Poker Open (SHRPO)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'BORGATA', '2026 Borgata Fall Poker Open', 'Borgata Hotel Casino & Spa', 'Atlantic City', 'NJ', DATE '2026-11-03', DATE '2026-11-17',
       '2026 Borgata Fall Poker Open - Main Event', NULL, true, DATE '2026-11-03', 'Stop-level placeholder row (Phase-7b). PokerAtlas series page lists 2026 Fall Poker Open Nov 3-17, 2026; Pokerfuse 2026 Borgata player guide independently lists the same Nov 3-17, 2026 dates. Full schedule/ME buy-in TBA.', 'https://www.pokeratlas.com/poker-tournament-series/2026-fall-poker-open-borgata-atlantic-city-2026', 'https://www.pokeratlas.com/poker-tournament-series/2026-fall-poker-open-borgata-atlantic-city-2026',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'BORGATA' AND tse.stop_name = '2026 Borgata Fall Poker Open');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'BESTBET', '2026 WPT bestbet Scramble', 'bestbet Jacksonville', 'Jacksonville', 'FL', DATE '2026-08-20', DATE '2026-09-09',
       '2026 WPT bestbet Scramble - Main Event', 5000, true, DATE '2026-08-20', 'Stop-level placeholder row (Phase-7b). Official bestbet page: series Aug 20 - Sep 9, 2026 at 201 Monument Rd, Jacksonville; $5,000 NLH WPT Championship $1M GTD, Day 1s Sept 4-6, final table Sept 9. Note: also a WPT main tour stop.', 'https://bestbetjax.com/poker/tournaments/wpt-main-event-bestbet-scramble-2026', 'https://bestbetjax.com/poker/tournaments/wpt-main-event-bestbet-scramble-2026',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'BESTBET' AND tse.stop_name = '2026 WPT bestbet Scramble');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'PGT', '2026 PGT PLO Series', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-09-23', DATE '2026-10-02',
       '2026 PGT PLO Series - Main Event', 26000, true, DATE '2026-09-23', 'Stop-level placeholder row (Phase-7b). Official PGT.com schedule lists PLO Series events Sept 23 (satellite) / Sept 24 (Event #1) through Oct 2 $26,000 PLO Championship at PokerGO Studio.', 'https://www.pgt.com/schedule', 'https://www.pgt.com/schedule',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'PGT' AND tse.stop_name = '2026 PGT PLO Series');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'PGT', '2026 Super High Roller Series', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-06', DATE '2026-10-10',
       '2026 Super High Roller Series - Main Event', 26000, true, DATE '2026-10-06', 'Stop-level placeholder row (Phase-7b). Official PGT.com schedule lists $26,000 NLH/PLO events on Oct 6, 9 and 10 around SHRB XI.', 'https://www.pgt.com/schedule', 'https://www.pgt.com/schedule',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'PGT' AND tse.stop_name = '2026 Super High Roller Series');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'PGT', '2026 Poker Masters', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-12', DATE '2026-10-23',
       '2026 Poker Masters - Main Event', 51000, true, DATE '2026-10-12', 'Stop-level placeholder row (Phase-7b). PokerNews 2026 Poker Masters schedule page: Oct 12-23 at PokerGO Studio, concluding with $51,000 NLH Event #10; first events also on official PGT.com schedule.', 'https://www.pokernews.com/tours/pokergo-tour/2026-poker-masters/schedule.htm', 'https://www.pokernews.com/tours/pokergo-tour/2026-poker-masters/schedule.htm',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'PGT' AND tse.stop_name = '2026 Poker Masters');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'GCPT', 'Louisiana State Poker Championship', 'Horseshoe Bossier City', 'Bossier City', 'LA', DATE '2026-08-19', DATE '2026-08-30',
       'Louisiana State Poker Championship - Main Event', NULL, true, DATE '2026-08-19', 'Stop-level placeholder row (Phase-7b). Official Gulf Coast Poker 2026 schedule: Aug 19-30 at Horseshoe Bossier City; Visit Shreveport-Bossier listing corroborates 15 events in 12 days with $300K+ guaranteed.', 'https://gulfcoastpoker.net/blog/gcp2026/', 'https://gulfcoastpoker.net/blog/gcp2026/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'GCPT' AND tse.stop_name = 'Louisiana State Poker Championship');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'GCPT', 'Arkansas Championship', 'Saracen Casino Resort', 'Pine Bluff', 'AR', DATE '2026-10-06', DATE '2026-10-11',
       'Arkansas Championship - Main Event', NULL, true, DATE '2026-10-06', 'Stop-level placeholder row (Phase-7b). Official Gulf Coast Poker 2026 schedule lists Arkansas Championship Oct 6-11 at Saracen Casino, Pine Bluff AR.', 'https://gulfcoastpoker.net/blog/gcp2026/', 'https://gulfcoastpoker.net/blog/gcp2026/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'GCPT' AND tse.stop_name = 'Arkansas Championship');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'ANTEUP', 'Ante Up Poker Tour - SoCal Classic at Sycuan', 'Sycuan Casino Resort', 'El Cajon', 'CA', DATE '2026-10-14', DATE '2026-10-24',
       'Ante Up Poker Tour - SoCal Classic at Sycuan - Main Event', NULL, true, DATE '2026-10-14', 'Stop-level placeholder row (Phase-7b). Official Ante Up Poker Tour page lists Sycuan Casino Resort (San Diego area; resort is in El Cajon) SoCal Classic partnership stop Oct 14-24, 2026.', 'https://anteupmagazine.com/where-to-play/tour/', 'https://anteupmagazine.com/where-to-play/tour/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'ANTEUP' AND tse.stop_name = 'Ante Up Poker Tour - SoCal Classic at Sycuan');
