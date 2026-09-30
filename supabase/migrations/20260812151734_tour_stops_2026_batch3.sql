-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812151734 "tour_stops_2026_batch3"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 271a448276d343950027440b5dd53fa3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Harrah''s Atlantic City', 'Harrah''s Resort Atlantic City', 'Atlantic City', 'NJ', DATE '2026-08-13', DATE '2026-08-24',
       'WSOP Circuit Harrah''s Atlantic City - Main Event', 1700, true, DATE '2026-08-13', 'Stop-level placeholder row (Phase-7b). Listed Aug 13-24, 2026 on official wsop.com/circuit schedule; corroborated by poker.org second-half 2026 announcement coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Harrah''s Atlantic City');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Hard Rock Tulsa', 'Hard Rock Hotel and Casino Tulsa', 'Catoosa', 'OK', DATE '2026-08-26', DATE '2026-09-07',
       'WSOP Circuit Hard Rock Tulsa - Main Event', 1700, true, DATE '2026-08-26', 'Stop-level placeholder row (Phase-7b). Official stop page shows Aug 26 - Sep 7, 2026 with $1,700 NLH Main Event (flights Sep 4-5)', 'https://www.wsop.com/tournaments/wsop-circuit-hard-rock-tulsa/', 'https://www.wsop.com/tournaments/wsop-circuit-hard-rock-tulsa/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Hard Rock Tulsa');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Texas Card House Austin', 'Texas Card House', 'Austin', 'TX', DATE '2026-09-10', DATE '2026-09-21',
       'WSOP Circuit Texas Card House Austin - Main Event', 1700, true, DATE '2026-09-10', 'Stop-level placeholder row (Phase-7b). Listed Sep 10-21, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Texas Card House Austin');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Thunder Valley', 'Thunder Valley Casino Resort', 'Lincoln', 'CA', DATE '2026-09-24', DATE '2026-10-05',
       'WSOP Circuit Thunder Valley - Main Event', 1700, true, DATE '2026-09-24', 'Stop-level placeholder row (Phase-7b). Listed Sep 24 - Oct 5, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Thunder Valley');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Turning Stone', 'Turning Stone Resort Casino', 'Verona', 'NY', DATE '2026-10-15', DATE '2026-10-26',
       'WSOP Circuit Turning Stone - Main Event', 1700, true, DATE '2026-10-15', 'Stop-level placeholder row (Phase-7b). Listed Oct 15-26, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Turning Stone');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Caesars Southern Indiana', 'Caesars Southern Indiana', 'Elizabeth', 'IN', DATE '2026-10-22', DATE '2026-11-02',
       'WSOP Circuit Caesars Southern Indiana - Main Event', 1700, true, DATE '2026-10-22', 'Stop-level placeholder row (Phase-7b). Official stop page shows Oct 22 - Nov 2, 2026 (moved from Sep 3-14 dates in earlier press coverage); tournament schedule TBA', 'https://www.wsop.com/tournaments/wsop-circuit-caesars-southern-indiana/', 'https://www.wsop.com/tournaments/wsop-circuit-caesars-southern-indiana/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Caesars Southern Indiana');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit The Reserve Poker Club', 'The Reserve Poker Club', 'Toledo', 'OH', DATE '2026-10-29', DATE '2026-11-09',
       'WSOP Circuit The Reserve Poker Club - Main Event', 1700, true, DATE '2026-10-29', 'Stop-level placeholder row (Phase-7b). Listed Oct 29 - Nov 9, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit The Reserve Poker Club');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Grand Victoria', 'Grand Victoria Casino', 'Elgin', 'IL', DATE '2026-11-05', DATE '2026-11-16',
       'WSOP Circuit Grand Victoria - Main Event', 1700, true, DATE '2026-11-05', 'Stop-level placeholder row (Phase-7b). Listed Nov 5-16, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Grand Victoria');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WSOPC', 'WSOP Circuit Harrah''s Cherokee (November)', 'Harrah''s Cherokee Casino Resort', 'Cherokee', 'NC', DATE '2026-11-26', DATE '2026-12-07',
       'WSOP Circuit Harrah''s Cherokee (November) - Main Event', 1700, true, DATE '2026-11-26', 'Stop-level placeholder row (Phase-7b). Listed Nov 26 - Dec 7, 2026 on official wsop.com/circuit schedule; corroborated by poker.org coverage', 'https://www.wsop.com/circuit/', 'https://www.wsop.com/circuit/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WSOPC' AND tse.stop_name = 'WSOP Circuit Harrah''s Cherokee (November)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WPT', 'WPT Bay 101 Shooting Star Championship', 'Bay 101 Casino', 'San Jose', 'CA', DATE '2026-10-23', DATE '2026-10-27',
       'WPT Bay 101 Shooting Star Championship - Main Event', 5300, true, DATE '2026-10-23', 'Stop-level placeholder row (Phase-7b). Official WPT event page lists championship Oct 23-27, 2026 at Bay 101 Casino, $5,300 buy-in; Bay 101 is in San Jose, CA.', 'https://www.worldpokertour.com/event/main-tour-wpt-bay-101-shooting-star-championship-season-2026/details', 'https://www.worldpokertour.com/event/main-tour-wpt-bay-101-shooting-star-championship-season-2026/details',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WPT' AND tse.stop_name = 'WPT Bay 101 Shooting Star Championship');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Illinois Poker State Championship (Main Event #320)', 'Rivers Casino (Des Plaines/Chicago)', 'Des Plaines', 'IL', DATE '2026-08-04', DATE '2026-08-09',
       'MSPT Illinois Poker State Championship (Main Event #320) - Main Event', 1110, true, DATE '2026-08-04', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists Aug 4-9 ''Rivers Casino, Chicago, IL'' with $750K GTD; MSPT X announcement confirms Aug 4-9, 2026; venue is physically in Des Plaines, IL (branded as Chicago).', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Illinois Poker State Championship (Main Event #320)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Indiana Poker State Championship (Main Event #322)', 'Ameristar East Chicago', 'East Chicago', 'IN', DATE '2026-08-25', DATE '2026-08-30',
       'MSPT Indiana Poker State Championship (Main Event #322) - Main Event', 1110, true, DATE '2026-08-25', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Aug 25-30, Ameristar East Chicago, $300K GTD; PokerNews tour page confirms Aug 25-30, 2026.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Indiana Poker State Championship (Main Event #322)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Nevada Poker State Championship (Main Event #324)', 'The Venetian Resort', 'Las Vegas', 'NV', DATE '2026-09-10', DATE '2026-09-13',
       'MSPT Nevada Poker State Championship (Main Event #324) - Main Event', 1110, true, DATE '2026-09-10', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Sep 10-13, The Venetian, Las Vegas, guarantee TBD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Nevada Poker State Championship (Main Event #324)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT 100 Grand Stack (Main Event #326)', 'Sycuan Casino Resort', 'El Cajon', 'CA', DATE '2026-09-29', DATE '2026-10-04',
       'MSPT 100 Grand Stack (Main Event #326) - Main Event', 1110, true, DATE '2026-09-29', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Sep 29-Oct 4, Sycuan Casino Resort, $100K GTD; venue is physically in El Cajon, CA (branded San Diego).', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT 100 Grand Stack (Main Event #326)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Festival Grand Falls (Main Event #329)', 'Grand Falls Casino & Golf Resort', 'Larchwood', 'IA', DATE '2026-10-28', DATE '2026-11-01',
       'MSPT Festival Grand Falls (Main Event #329) - Main Event', 1110, true, DATE '2026-10-28', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Oct 28-Nov 1, Grand Falls Casino, Larchwood, IA, $200K GTD (PokerNews tour page shows Oct 27 start; official site date used).', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Festival Grand Falls (Main Event #329)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Rock ''N'' Roll Poker Open (Main Event #331)', 'Seminole Hard Rock Hotel & Casino', 'Hollywood', 'FL', DATE '2026-11-18', DATE '2026-12-02',
       'MSPT Rock ''N'' Roll Poker Open (Main Event #331) - Main Event', NULL, true, DATE '2026-11-18', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule: Nov 18-Dec 2, Seminole Hard Rock, Hollywood FL, $2,000,000 GTD; MSPT X posts reference a $3,500 RRPO MSPT Championship, so standard $1,110 buy-in not assumed here.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Rock ''N'' Roll Poker Open (Main Event #331)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Diamond Poker Championship 2027', 'Talking Stick Resort', 'Scottsdale', 'AZ', DATE '2027-02-02', DATE '2027-02-07',
       'MSPT Diamond Poker Championship 2027 - Main Event', NULL, true, DATE '2027-02-02', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 Diamond Poker Championship, Feb 2-7, Talking Stick Resort, Scottsdale AZ, $1,000,000 GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Diamond Poker Championship 2027');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Festival Riverside (March 2027)', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2027-03-16', DATE '2027-03-21',
       'MSPT Festival Riverside (March 2027) - Main Event', NULL, true, DATE '2027-03-16', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 MSPT Festival, Mar 16-21, Riverside Casino, Riverside IA, $300K GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Festival Riverside (March 2027)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Michigan Poker State Championship 2027', 'FireKeepers Casino Hotel', 'Battle Creek', 'MI', DATE '2027-05-11', DATE '2027-05-16',
       'MSPT Michigan Poker State Championship 2027 - Main Event', NULL, true, DATE '2027-05-11', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 Michigan Poker State Championship, May 11-16, FireKeepers Casino, Battle Creek MI, $1,000,000 GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Michigan Poker State Championship 2027');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Wisconsin Poker State Championship 2027', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2027-09-21', DATE '2027-09-26',
       'MSPT Wisconsin Poker State Championship 2027 - Main Event', NULL, true, DATE '2027-09-21', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 Wisconsin Poker State Championship, Sep 21-26, Potawatomi Casino, Milwaukee WI, $1,000,000 GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Wisconsin Poker State Championship 2027');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'MSPT', 'MSPT Festival Riverside (November 2027)', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2027-11-02', DATE '2027-11-07',
       'MSPT Festival Riverside (November 2027) - Main Event', NULL, true, DATE '2027-11-02', 'Stop-level placeholder row (Phase-7b). msptpoker.com schedule lists 2027 MSPT Festival, Nov 2-7, Riverside Casino, Riverside IA, $300K GTD.', 'https://msptpoker.com/', 'https://msptpoker.com/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'MSPT' AND tse.stop_name = 'MSPT Festival Riverside (November 2027)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Gateway Poker Classic', 'Hollywood Casino St. Louis', 'Maryland Heights', 'MO', DATE '2026-08-04', DATE '2026-08-09',
       'RGPS Gateway Poker Classic - Main Event', 800, true, DATE '2026-08-04', 'Stop-level placeholder row (Phase-7b). PokerNews (Jul 2026): RGPS Gateway Poker Classic Aug 4-9 at Hollywood St. Louis, $800 Main Event with $200K GTD; venue is physically in Maryland Heights, MO.', 'https://www.pokernews.com/news/2026/07/rgps-gateway-poker-classic-st-louis-51951.htm', 'https://www.pokernews.com/news/2026/07/rgps-gateway-poker-classic-st-louis-51951.htm',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Gateway Poker Classic');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Southern Indiana', 'Caesars Southern Indiana', 'Elizabeth', 'IN', DATE '2026-08-18', DATE '2026-08-23',
       'RGPS Golden Expedition Southern Indiana - Main Event', 800, true, DATE '2026-08-18', 'Stop-level placeholder row (Phase-7b). PokerNews (Aug 2026): RGPS at Caesars, Elizabeth IN, Aug 18-23, 10 ring events, $800 Main Event with $200K GTD; matches rungood.com schedule.', 'https://www.pokernews.com/news/2026/08/rgps-golden-expedition-southern-indiana-52065.htm', 'https://www.pokernews.com/news/2026/08/rgps-golden-expedition-southern-indiana-52065.htm',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Southern Indiana');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition New Orleans', 'Caesars New Orleans', 'New Orleans', 'LA', DATE '2026-09-03', DATE '2026-09-13',
       'RGPS Golden Expedition New Orleans - Main Event', NULL, true, DATE '2026-09-03', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 Golden Expedition announcement: Sep 3-13, Caesars New Orleans; matches rungood.com events calendar.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition New Orleans');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition MGM National Harbor', 'MGM National Harbor', 'Oxon Hill', 'MD', DATE '2026-09-21', DATE '2026-09-27',
       'RGPS Golden Expedition MGM National Harbor - Main Event', NULL, true, DATE '2026-09-21', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Sep 21-27, MGM National Harbor, Oxon Hill, Maryland; matches rungood.com events calendar.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition MGM National Harbor');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition St. Louis', 'Hollywood Casino St. Louis', 'Maryland Heights', 'MO', DATE '2026-10-06', DATE '2026-10-11',
       'RGPS Golden Expedition St. Louis - Main Event', NULL, true, DATE '2026-10-06', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Oct 6-11, Hollywood Casino St. Louis (physically in Maryland Heights, MO); matches rungood.com events calendar.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition St. Louis');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Tulsa', 'Hard Rock Hotel & Casino Tulsa', 'Catoosa', 'OK', DATE '2026-10-20', DATE '2026-10-25',
       'RGPS Golden Expedition Tulsa - Main Event', NULL, true, DATE '2026-10-20', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Oct 20-25, Hard Rock Tulsa (branded Tulsa; property is physically in Catoosa, OK).', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Tulsa');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Atlantic City', 'Borgata Hotel Casino & Spa', 'Atlantic City', 'NJ', DATE '2026-11-04', DATE '2026-11-09',
       'RGPS Golden Expedition Atlantic City - Main Event', NULL, true, DATE '2026-11-04', 'Stop-level placeholder row (Phase-7b). rungood.com events calendar and PokerNews RGPS tour page both list Nov 4-9, 2026 at Borgata (original announcement said Nov 3-8; two current sources supersede).', 'https://www.rungood.com/pages/events', 'https://www.rungood.com/pages/events',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Atlantic City');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Tunica', 'Horseshoe Tunica', 'Tunica', 'MS', DATE '2026-11-10', DATE '2026-11-15',
       'RGPS Golden Expedition Tunica - Main Event', NULL, true, DATE '2026-11-10', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Nov 10-15, Horseshoe Tunica; PokerNews RGPS tour page confirms Nov 10-15.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Tunica');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Council Bluffs', 'Horseshoe Council Bluffs', 'Council Bluffs', 'IA', DATE '2026-11-17', DATE '2026-11-22',
       'RGPS Golden Expedition Council Bluffs - Main Event', NULL, true, DATE '2026-11-17', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Nov 17-22, Horseshoe Council Bluffs, Iowa; PokerNews RGPS tour page confirms.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Council Bluffs');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'RGPS', 'RGPS Golden Expedition Kentucky II', 'The OG Clubhouse', 'Oak Grove', 'KY', DATE '2026-11-17', DATE '2026-11-22',
       'RGPS Golden Expedition Kentucky II - Main Event', NULL, true, DATE '2026-11-17', 'Stop-level placeholder row (Phase-7b). Official RunGood fall 2026 schedule: Nov 17-22, The OG Clubhouse, Oak Grove, Kentucky; PokerNews RGPS tour page confirms.', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'RGPS' AND tse.stop_name = 'RGPS Golden Expedition Kentucky II');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'VENETIAN', 'DeepStack Showdown (August 2026)', 'The Venetian Resort Las Vegas', 'Las Vegas', 'NV', DATE '2026-08-03', DATE '2026-08-31',
       'DeepStack Showdown (August 2026) - Main Event', 600, true, DATE '2026-08-03', 'Stop-level placeholder row (Phase-7b). Official Venetian series page: ''August 3 - 31, 2026'', $1.1M+ in guarantees; largest event $600 NLH $150K GTD (Aug 5-9).', 'https://www.venetianlasvegas.com/resort/casino/poker/deepstack-extravaganza-poker-tournament/dss-aug-2026.html', 'https://www.venetianlasvegas.com/resort/casino/poker/deepstack-extravaganza-poker-tournament/dss-aug-2026.html',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'VENETIAN' AND tse.stop_name = 'DeepStack Showdown (August 2026)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'WYNN', 'Wynn Signature Series (August 2026)', 'Wynn Las Vegas', 'Las Vegas', 'NV', DATE '2026-08-17', DATE '2026-09-07',
       'Wynn Signature Series (August 2026) - Main Event', NULL, true, DATE '2026-08-17', 'Stop-level placeholder row (Phase-7b). Official Wynn Las Vegas poker page lists Wynn Signature Series August 17 - September 7, 2026 with schedule/structure PDFs; 41 events per PokerAtlas.', 'https://www.wynnlasvegas.com/casino/poker', 'https://www.wynnlasvegas.com/casino/poker',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'WYNN' AND tse.stop_name = 'Wynn Signature Series (August 2026)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'SHRPO', '2026 Rock ''N'' Roll Poker Open', 'Seminole Hard Rock Hotel & Casino Hollywood', 'Hollywood', 'FL', DATE '2026-11-18', DATE '2026-12-02',
       '2026 Rock ''N'' Roll Poker Open - Main Event', 3500, true, DATE '2026-11-18', 'Stop-level placeholder row (Phase-7b). Official Hard Rock newsroom (Jan 2026): 2026 RRPO scheduled Nov 18 - Dec 2, 2026 with $3,500 buy-in $2M GTD championship (MSPT season-ending championship).', 'https://casino.hardrock.com/hollywood/newsroom/2026/01/seminole-hard-rock-hotel-and-casino-hollywood-partners-with-mspt-for-2026-rock-n-roll-poker-open', 'https://casino.hardrock.com/hollywood/newsroom/2026/01/seminole-hard-rock-hotel-and-casino-hollywood-partners-with-mspt-for-2026-rock-n-roll-poker-open',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'SHRPO' AND tse.stop_name = '2026 Rock ''N'' Roll Poker Open');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'BAY101', 'WPT Bay 101 Shooting Star Festival 2026', 'Bay 101 Casino', 'San Jose', 'CA', DATE '2026-10-16', DATE '2026-11-01',
       'WPT Bay 101 Shooting Star Festival 2026 - Main Event', 5300, true, DATE '2026-10-16', 'Stop-level placeholder row (Phase-7b). PokerNews (July 2026): festival runs Oct 16 - Nov 1, 2026 at Bay 101, San Jose; $5,300 WPT Shooting Star Championship Oct 23-27. Note: also a WPT main tour stop.', 'https://www.pokernews.com/news/2026/07/wpt-bay-101-shooting-star-returns-51989.htm', 'https://www.pokernews.com/news/2026/07/wpt-bay-101-shooting-star-returns-51989.htm',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'BAY101' AND tse.stop_name = 'WPT Bay 101 Shooting Star Festival 2026');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'LODGE', '2026 Mega Monster ($1.5M GTD)', 'The Lodge Card Club', 'Round Rock', 'TX', DATE '2026-07-23', DATE '2026-08-17',
       '2026 Mega Monster ($1.5M GTD) - Main Event', 400, true, DATE '2026-07-23', 'Stop-level placeholder row (Phase-7b). Official Lodge page: Mega Monster July 23 - Aug 17, 2026, $400 buy-in $1.5M GTD; Day 1 flights at Round Rock and San Antonio, Days 2-3 (Aug 16-17) at Round Rock. Currently running.', 'https://thelodgepokerclub.com/mega-monster-2026/', 'https://thelodgepokerclub.com/mega-monster-2026/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'LODGE' AND tse.stop_name = '2026 Mega Monster ($1.5M GTD)');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'PGT', 'Super High Roller Bowl PLO IV', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-03', DATE '2026-10-05',
       'Super High Roller Bowl PLO IV - Main Event', 103000, true, DATE '2026-10-03', 'Stop-level placeholder row (Phase-7b). Official PGT.com schedule: $10,300 satellite Oct 3, $103,000 PLO main Oct 5 at PokerGO Studio.', 'https://www.pgt.com/schedule', 'https://www.pgt.com/schedule',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'PGT' AND tse.stop_name = 'Super High Roller Bowl PLO IV');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'PGT', 'Super High Roller Bowl XI', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-07', DATE '2026-10-08',
       'Super High Roller Bowl XI - Main Event', 103000, true, DATE '2026-10-07', 'Stop-level placeholder row (Phase-7b). Official PGT.com schedule: $10,300 satellite Oct 7, $103,000 NLH main event Oct 8 at PokerGO Studio.', 'https://www.pgt.com/schedule', 'https://www.pgt.com/schedule',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'PGT' AND tse.stop_name = 'Super High Roller Bowl XI');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'GCPT', 'Caesars Sizzler', 'Caesars New Orleans', 'New Orleans', 'LA', DATE '2026-08-06', DATE '2026-08-16',
       'Caesars Sizzler - Main Event', NULL, true, DATE '2026-08-06', 'Stop-level placeholder row (Phase-7b). Official Gulf Coast Poker 2026 schedule page lists Caesars Sizzler Aug 6-16 at Caesars New Orleans (series currently running).', 'https://gulfcoastpoker.net/blog/gcp2026/', 'https://gulfcoastpoker.net/blog/gcp2026/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'GCPT' AND tse.stop_name = 'Caesars Sizzler');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'GCPT', 'Fall 7 Clans Poker Cup Series', 'Coushatta Casino Resort', 'Kinder', 'LA', DATE '2026-09-01', DATE '2026-09-13',
       'Fall 7 Clans Poker Cup Series - Main Event', NULL, true, DATE '2026-09-01', 'Stop-level placeholder row (Phase-7b). Official Gulf Coast Poker 2026 schedule lists Fall 7 Clans Poker Cup Series Sept 1-13 at Coushatta Casino Resort, Kinder LA.', 'https://gulfcoastpoker.net/blog/gcp2026/', 'https://gulfcoastpoker.net/blog/gcp2026/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'GCPT' AND tse.stop_name = 'Fall 7 Clans Poker Cup Series');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'ANTEUP', 'Ante Up Poker Tour - Rivers Casino Schenectady', 'Rivers Casino & Resort Schenectady', 'Schenectady', 'NY', DATE '2026-09-15', DATE '2026-09-25',
       'Ante Up Poker Tour - Rivers Casino Schenectady - Main Event', NULL, true, DATE '2026-09-15', 'Stop-level placeholder row (Phase-7b). Official Ante Up Poker Tour page lists Rivers Casino & Resort Schenectady stop Sept 15-25, 2026.', 'https://anteupmagazine.com/where-to-play/tour/', 'https://anteupmagazine.com/where-to-play/tour/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'ANTEUP' AND tse.stop_name = 'Ante Up Poker Tour - Rivers Casino Schenectady');
INSERT INTO tour_stop_events
  (tour_code, stop_name, stop_venue, stop_city, stop_state, stop_start_date, stop_end_date,
   event_name, buy_in, is_main_event, start_date, notes, source_url, scrape_url,
   scrape_html_hash, scrape_timestamp, data_quality)
SELECT 'LIPS', 'Trailblazer Poker Tour III - LIPS Ladies Event', 'Texas Card House Las Colinas', 'Irving', 'TX', DATE '2026-08-29', DATE '2026-08-29',
       'Trailblazer Poker Tour III - LIPS Ladies Event - Main Event', 300, true, DATE '2026-08-29', 'Stop-level placeholder row (Phase-7b). Official LIPS Tour schedule: one-day $300-entry $10K GTD NLH ladies event Aug 29, 2026 at Texas Card House Las Colinas (Las Colinas district of Irving, TX).', 'https://lipstour.com/schedule/', 'https://lipstour.com/schedule/',
       'phase7b-manual-research-20260808', now(), 'manual_research'
WHERE NOT EXISTS (SELECT 1 FROM tour_stop_events tse
                  WHERE tse.tour_code = 'LIPS' AND tse.stop_name = 'Trailblazer Poker Tour III - LIPS Ladies Event');
