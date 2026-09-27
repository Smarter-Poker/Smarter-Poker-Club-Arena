-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812151438 "tour_stops_2026_batch2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 24deee353d0ffdec755e6fa8ee0dd3f4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Harrah''s Cherokee (August)', 'WSOPC', 'WSOPC', 'Harrah''s Cherokee Casino Resort', 'Cherokee', 'NC', DATE '2026-08-06', DATE '2026-08-17',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Harrah''s Cherokee (August)')
                    AND ps.start_date = DATE '2026-08-06');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Horseshoe Tunica', 'WSOPC', 'WSOPC', 'Horseshoe Casino Tunica', 'Robinsonville', 'MS', DATE '2026-08-20', DATE '2026-08-31',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Horseshoe Tunica')
                    AND ps.start_date = DATE '2026-08-20');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Caesars Virginia', 'WSOPC', 'WSOPC', 'Caesars Virginia', 'Danville', 'VA', DATE '2026-09-03', DATE '2026-09-14',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/tournaments/wsop-circuit-caesars-virginia/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Caesars Virginia')
                    AND ps.start_date = DATE '2026-09-03');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Horseshoe Council Bluffs', 'WSOPC', 'WSOPC', 'Horseshoe Council Bluffs', 'Council Bluffs', 'IA', DATE '2026-09-17', DATE '2026-09-28',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Horseshoe Council Bluffs')
                    AND ps.start_date = DATE '2026-09-17');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Harrah''s Pompano Beach', 'WSOPC', 'WSOPC', 'Harrah''s Pompano Beach', 'Pompano Beach', 'FL', DATE '2026-10-01', DATE '2026-10-12',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Harrah''s Pompano Beach')
                    AND ps.start_date = DATE '2026-10-01');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Caesars Republic Lake Tahoe', 'WSOPC', 'WSOPC', 'Caesars Republic Lake Tahoe', 'Stateline', 'NV', DATE '2026-10-22', DATE '2026-11-02',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Caesars Republic Lake Tahoe')
                    AND ps.start_date = DATE '2026-10-22');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Choctaw Durant', 'WSOPC', 'WSOPC', 'Choctaw Casino Resort', 'Durant', 'OK', DATE '2026-10-28', DATE '2026-11-09',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/tournaments/wsop-circuit-choctaw-durant-october-2026/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Choctaw Durant')
                    AND ps.start_date = DATE '2026-10-28');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Talking Stick', 'WSOPC', 'WSOPC', 'Talking Stick Resort', 'Scottsdale', 'AZ', DATE '2026-11-05', DATE '2026-11-16',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Talking Stick')
                    AND ps.start_date = DATE '2026-11-05');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Caesars New Orleans', 'WSOPC', 'WSOPC', 'Caesars New Orleans', 'New Orleans', 'LA', DATE '2026-11-12', DATE '2026-11-23',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Caesars New Orleans')
                    AND ps.start_date = DATE '2026-11-12');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WPT bestbet Scramble Championship', 'WPT', 'WPT', 'bestbet Jacksonville', 'Jacksonville', 'FL', DATE '2026-09-04', DATE '2026-09-09',
       5000, 'phase7b-tour-research', 'https://www.worldpokertour.com/event/main-tour-wpt-bestbet-scramble-championship-season-2026/details', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WPT bestbet Scramble Championship')
                    AND ps.start_date = DATE '2026-09-04');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WPT Prime Lodge Championship', 'WPTPRIME', 'WPTPRIME', 'The Lodge Card Club', 'Round Rock', 'TX', DATE '2026-09-24', DATE '2026-10-12',
       1100, 'phase7b-tour-research', 'https://www.worldpokertour.com/press-release/world-poker-tour-returns-to-texas-for-prime-lodge-championship', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WPT Prime Lodge Championship')
                    AND ps.start_date = DATE '2026-09-24');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Festival Cleveland (Main Event #321)', 'MSPT', 'MSPT', 'JACK Cleveland Casino', 'Cleveland', 'OH', DATE '2026-08-18', DATE '2026-08-23',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Festival Cleveland (Main Event #321)')
                    AND ps.start_date = DATE '2026-08-18');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Ameristar Poker Open (Main Event #323)', 'MSPT', 'MSPT', 'Ameristar Casino St. Charles', 'St. Charles', 'MO', DATE '2026-09-01', DATE '2026-09-07',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Ameristar Poker Open (Main Event #323)')
                    AND ps.start_date = DATE '2026-09-01');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Wisconsin Poker State Championship (Main Event #325)', 'MSPT', 'MSPT', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2026-09-22', DATE '2026-09-27',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Wisconsin Poker State Championship (Main Event #325)')
                    AND ps.start_date = DATE '2026-09-22');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Spade Poker Championship (Main Event #328)', 'MSPT', 'MSPT', 'FireKeepers Casino Hotel', 'Battle Creek', 'MI', DATE '2026-10-13', DATE '2026-10-18',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Spade Poker Championship (Main Event #328)')
                    AND ps.start_date = DATE '2026-10-13');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Festival Riverside (Main Event #330)', 'MSPT', 'MSPT', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2026-11-03', DATE '2026-11-08',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Festival Riverside (Main Event #330)')
                    AND ps.start_date = DATE '2026-11-03');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Winter Poker Classic (Main Event #332)', 'MSPT', 'MSPT', 'Running Aces Casino', 'Columbus', 'MN', DATE '2026-12-01', DATE '2026-12-13',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Winter Poker Classic (Main Event #332)')
                    AND ps.start_date = DATE '2026-12-01');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Club Poker Championship 2027', 'MSPT', 'MSPT', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2027-02-16', DATE '2027-02-21',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Club Poker Championship 2027')
                    AND ps.start_date = DATE '2027-02-16');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Festival Potawatomi (Spring 2027)', 'MSPT', 'MSPT', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2027-04-27', DATE '2027-05-02',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Festival Potawatomi (Spring 2027)')
                    AND ps.start_date = DATE '2027-04-27');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Iowa Poker State Championship 2027', 'MSPT', 'MSPT', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2027-07-20', DATE '2027-07-25',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Iowa Poker State Championship 2027')
                    AND ps.start_date = DATE '2027-07-20');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Spade Poker Championship 2027', 'MSPT', 'MSPT', 'FireKeepers Casino Hotel', 'Battle Creek', 'MI', DATE '2027-10-12', DATE '2027-10-17',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Spade Poker Championship 2027')
                    AND ps.start_date = DATE '2027-10-12');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Rock ''N'' Roll Poker Open 2027', 'MSPT', 'MSPT', 'Seminole Hard Rock Hotel & Casino', 'Hollywood', 'FL', DATE '2027-11-17', DATE '2027-12-01',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Rock ''N'' Roll Poker Open 2027')
                    AND ps.start_date = DATE '2027-11-17');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Dallas', 'RGPS', 'RGPS', 'Palace Poker', 'Grand Prairie', 'TX', DATE '2026-08-13', DATE '2026-08-23',
       600, 'phase7b-tour-research', 'https://www.pokernews.com/news/2026/07/rgps-palace-poker-dallas-52037.htm', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Dallas')
                    AND ps.start_date = DATE '2026-08-13');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Kentucky (The Barrel)', 'RGPS', 'RGPS', 'The Barrel Social Club', 'Franklin', 'KY', DATE '2026-09-01', DATE '2026-09-07',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Kentucky (The Barrel)')
                    AND ps.start_date = DATE '2026-09-01');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Joplin', 'RGPS', 'RGPS', 'Downstream Casino Resort', 'Quapaw', 'OK', DATE '2026-09-15', DATE '2026-09-20',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Joplin')
                    AND ps.start_date = DATE '2026-09-15');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Ohio', 'RGPS', 'RGPS', 'Lake Erie Poker Room', 'Elyria', 'OH', DATE '2026-09-29', DATE '2026-10-04',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Ohio')
                    AND ps.start_date = DATE '2026-09-29');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Houston', 'RGPS', 'RGPS', 'Champions Club Texas', 'Houston', 'TX', DATE '2026-10-12', DATE '2026-10-18',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Houston')
                    AND ps.start_date = DATE '2026-10-12');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Jacksonville', 'RGPS', 'RGPS', 'bestbet Jacksonville', 'Jacksonville', 'FL', DATE '2026-10-22', DATE '2026-11-01',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Jacksonville')
                    AND ps.start_date = DATE '2026-10-22');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition San Antonio', 'RGPS', 'RGPS', 'Lodge Card Club San Antonio', 'San Antonio', 'TX', DATE '2026-11-06', DATE '2026-11-15',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition San Antonio')
                    AND ps.start_date = DATE '2026-11-06');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Bay Area', 'RGPS', 'RGPS', 'Graton Resort & Casino', 'Rohnert Park', 'CA', DATE '2026-11-12', DATE '2026-11-23',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Bay Area')
                    AND ps.start_date = DATE '2026-11-12');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition San Diego', 'RGPS', 'RGPS', 'Jamul Casino', 'Jamul', 'CA', DATE '2026-11-17', DATE '2026-11-22',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition San Diego')
                    AND ps.start_date = DATE '2026-11-17');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Dream Factory Festival', 'RGPS', 'RGPS', 'Thunder Valley Casino Resort', 'Lincoln', 'CA', DATE '2026-11-27', DATE '2026-12-03',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Dream Factory Festival')
                    AND ps.start_date = DATE '2026-11-27');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'DeepStack Extravaganza III (September 2026)', 'VENETIAN', 'VENETIAN', 'The Venetian Resort Las Vegas', 'Las Vegas', 'NV', DATE '2026-09-01', DATE '2026-09-27',
       1100, 'phase7b-tour-research', 'https://www.venetianlasvegas.com/resort/casino/poker/deepstack-extravaganza-poker-tournament/dse-sep-2026.html', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('DeepStack Extravaganza III (September 2026)')
                    AND ps.start_date = DATE '2026-09-01');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 Seminole Hard Rock Poker Open (SHRPO)', 'SHRPO', 'SHRPO', 'Seminole Hard Rock Hotel & Casino Hollywood', 'Hollywood', 'FL', DATE '2026-07-28', DATE '2026-08-11',
       5300, 'phase7b-tour-research', 'https://www.seminolehardrockpokeropen.com/2026-seminole-hard-rock-poker-open-schedule/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 Seminole Hard Rock Poker Open (SHRPO)')
                    AND ps.start_date = DATE '2026-07-28');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 Borgata Fall Poker Open', 'BORGATA', 'BORGATA', 'Borgata Hotel Casino & Spa', 'Atlantic City', 'NJ', DATE '2026-11-03', DATE '2026-11-17',
       NULL, 'phase7b-tour-research', 'https://www.pokeratlas.com/poker-tournament-series/2026-fall-poker-open-borgata-atlantic-city-2026', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 Borgata Fall Poker Open')
                    AND ps.start_date = DATE '2026-11-03');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 WPT bestbet Scramble', 'BESTBET', 'BESTBET', 'bestbet Jacksonville', 'Jacksonville', 'FL', DATE '2026-08-20', DATE '2026-09-09',
       5000, 'phase7b-tour-research', 'https://bestbetjax.com/poker/tournaments/wpt-main-event-bestbet-scramble-2026', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 WPT bestbet Scramble')
                    AND ps.start_date = DATE '2026-08-20');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 PGT PLO Series', 'PGT', 'PGT', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-09-23', DATE '2026-10-02',
       26000, 'phase7b-tour-research', 'https://www.pgt.com/schedule', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 PGT PLO Series')
                    AND ps.start_date = DATE '2026-09-23');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 Super High Roller Series', 'PGT', 'PGT', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-06', DATE '2026-10-10',
       26000, 'phase7b-tour-research', 'https://www.pgt.com/schedule', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 Super High Roller Series')
                    AND ps.start_date = DATE '2026-10-06');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 Poker Masters', 'PGT', 'PGT', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-12', DATE '2026-10-23',
       51000, 'phase7b-tour-research', 'https://www.pokernews.com/tours/pokergo-tour/2026-poker-masters/schedule.htm', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 Poker Masters')
                    AND ps.start_date = DATE '2026-10-12');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Louisiana State Poker Championship', 'GCPT', 'GCPT', 'Horseshoe Bossier City', 'Bossier City', 'LA', DATE '2026-08-19', DATE '2026-08-30',
       NULL, 'phase7b-tour-research', 'https://gulfcoastpoker.net/blog/gcp2026/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Louisiana State Poker Championship')
                    AND ps.start_date = DATE '2026-08-19');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Arkansas Championship', 'GCPT', 'GCPT', 'Saracen Casino Resort', 'Pine Bluff', 'AR', DATE '2026-10-06', DATE '2026-10-11',
       NULL, 'phase7b-tour-research', 'https://gulfcoastpoker.net/blog/gcp2026/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Arkansas Championship')
                    AND ps.start_date = DATE '2026-10-06');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Ante Up Poker Tour - SoCal Classic at Sycuan', 'ANTEUP', 'ANTEUP', 'Sycuan Casino Resort', 'El Cajon', 'CA', DATE '2026-10-14', DATE '2026-10-24',
       NULL, 'phase7b-tour-research', 'https://anteupmagazine.com/where-to-play/tour/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Ante Up Poker Tour - SoCal Classic at Sycuan')
                    AND ps.start_date = DATE '2026-10-14');
