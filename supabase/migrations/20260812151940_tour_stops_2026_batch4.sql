-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812151940 "tour_stops_2026_batch4"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 18a8580e1ba07d6c1469b1aa337e52bf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Harrah''s Atlantic City', 'WSOPC', 'WSOPC', 'Harrah''s Resort Atlantic City', 'Atlantic City', 'NJ', DATE '2026-08-13', DATE '2026-08-24',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Harrah''s Atlantic City')
                    AND ps.start_date = DATE '2026-08-13');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Hard Rock Tulsa', 'WSOPC', 'WSOPC', 'Hard Rock Hotel and Casino Tulsa', 'Catoosa', 'OK', DATE '2026-08-26', DATE '2026-09-07',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/tournaments/wsop-circuit-hard-rock-tulsa/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Hard Rock Tulsa')
                    AND ps.start_date = DATE '2026-08-26');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Texas Card House Austin', 'WSOPC', 'WSOPC', 'Texas Card House', 'Austin', 'TX', DATE '2026-09-10', DATE '2026-09-21',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Texas Card House Austin')
                    AND ps.start_date = DATE '2026-09-10');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Thunder Valley', 'WSOPC', 'WSOPC', 'Thunder Valley Casino Resort', 'Lincoln', 'CA', DATE '2026-09-24', DATE '2026-10-05',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Thunder Valley')
                    AND ps.start_date = DATE '2026-09-24');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Turning Stone', 'WSOPC', 'WSOPC', 'Turning Stone Resort Casino', 'Verona', 'NY', DATE '2026-10-15', DATE '2026-10-26',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Turning Stone')
                    AND ps.start_date = DATE '2026-10-15');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Caesars Southern Indiana', 'WSOPC', 'WSOPC', 'Caesars Southern Indiana', 'Elizabeth', 'IN', DATE '2026-10-22', DATE '2026-11-02',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/tournaments/wsop-circuit-caesars-southern-indiana/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Caesars Southern Indiana')
                    AND ps.start_date = DATE '2026-10-22');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit The Reserve Poker Club', 'WSOPC', 'WSOPC', 'The Reserve Poker Club', 'Toledo', 'OH', DATE '2026-10-29', DATE '2026-11-09',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit The Reserve Poker Club')
                    AND ps.start_date = DATE '2026-10-29');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Grand Victoria', 'WSOPC', 'WSOPC', 'Grand Victoria Casino', 'Elgin', 'IL', DATE '2026-11-05', DATE '2026-11-16',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Grand Victoria')
                    AND ps.start_date = DATE '2026-11-05');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WSOP Circuit Harrah''s Cherokee (November)', 'WSOPC', 'WSOPC', 'Harrah''s Cherokee Casino Resort', 'Cherokee', 'NC', DATE '2026-11-26', DATE '2026-12-07',
       1700, 'phase7b-tour-research', 'https://www.wsop.com/circuit/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WSOP Circuit Harrah''s Cherokee (November)')
                    AND ps.start_date = DATE '2026-11-26');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WPT Bay 101 Shooting Star Championship', 'WPT', 'WPT', 'Bay 101 Casino', 'San Jose', 'CA', DATE '2026-10-23', DATE '2026-10-27',
       5300, 'phase7b-tour-research', 'https://www.worldpokertour.com/event/main-tour-wpt-bay-101-shooting-star-championship-season-2026/details', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WPT Bay 101 Shooting Star Championship')
                    AND ps.start_date = DATE '2026-10-23');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Illinois Poker State Championship (Main Event #320)', 'MSPT', 'MSPT', 'Rivers Casino (Des Plaines/Chicago)', 'Des Plaines', 'IL', DATE '2026-08-04', DATE '2026-08-09',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Illinois Poker State Championship (Main Event #320)')
                    AND ps.start_date = DATE '2026-08-04');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Indiana Poker State Championship (Main Event #322)', 'MSPT', 'MSPT', 'Ameristar East Chicago', 'East Chicago', 'IN', DATE '2026-08-25', DATE '2026-08-30',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Indiana Poker State Championship (Main Event #322)')
                    AND ps.start_date = DATE '2026-08-25');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Nevada Poker State Championship (Main Event #324)', 'MSPT', 'MSPT', 'The Venetian Resort', 'Las Vegas', 'NV', DATE '2026-09-10', DATE '2026-09-13',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Nevada Poker State Championship (Main Event #324)')
                    AND ps.start_date = DATE '2026-09-10');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT 100 Grand Stack (Main Event #326)', 'MSPT', 'MSPT', 'Sycuan Casino Resort', 'El Cajon', 'CA', DATE '2026-09-29', DATE '2026-10-04',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT 100 Grand Stack (Main Event #326)')
                    AND ps.start_date = DATE '2026-09-29');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Festival Grand Falls (Main Event #329)', 'MSPT', 'MSPT', 'Grand Falls Casino & Golf Resort', 'Larchwood', 'IA', DATE '2026-10-28', DATE '2026-11-01',
       1110, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Festival Grand Falls (Main Event #329)')
                    AND ps.start_date = DATE '2026-10-28');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Rock ''N'' Roll Poker Open (Main Event #331)', 'MSPT', 'MSPT', 'Seminole Hard Rock Hotel & Casino', 'Hollywood', 'FL', DATE '2026-11-18', DATE '2026-12-02',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Rock ''N'' Roll Poker Open (Main Event #331)')
                    AND ps.start_date = DATE '2026-11-18');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Diamond Poker Championship 2027', 'MSPT', 'MSPT', 'Talking Stick Resort', 'Scottsdale', 'AZ', DATE '2027-02-02', DATE '2027-02-07',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Diamond Poker Championship 2027')
                    AND ps.start_date = DATE '2027-02-02');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Festival Riverside (March 2027)', 'MSPT', 'MSPT', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2027-03-16', DATE '2027-03-21',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Festival Riverside (March 2027)')
                    AND ps.start_date = DATE '2027-03-16');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Michigan Poker State Championship 2027', 'MSPT', 'MSPT', 'FireKeepers Casino Hotel', 'Battle Creek', 'MI', DATE '2027-05-11', DATE '2027-05-16',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Michigan Poker State Championship 2027')
                    AND ps.start_date = DATE '2027-05-11');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Wisconsin Poker State Championship 2027', 'MSPT', 'MSPT', 'Potawatomi Casino Hotel', 'Milwaukee', 'WI', DATE '2027-09-21', DATE '2027-09-26',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Wisconsin Poker State Championship 2027')
                    AND ps.start_date = DATE '2027-09-21');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'MSPT Festival Riverside (November 2027)', 'MSPT', 'MSPT', 'Riverside Casino & Golf Resort', 'Riverside', 'IA', DATE '2027-11-02', DATE '2027-11-07',
       NULL, 'phase7b-tour-research', 'https://msptpoker.com/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('MSPT Festival Riverside (November 2027)')
                    AND ps.start_date = DATE '2027-11-02');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Gateway Poker Classic', 'RGPS', 'RGPS', 'Hollywood Casino St. Louis', 'Maryland Heights', 'MO', DATE '2026-08-04', DATE '2026-08-09',
       800, 'phase7b-tour-research', 'https://www.pokernews.com/news/2026/07/rgps-gateway-poker-classic-st-louis-51951.htm', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Gateway Poker Classic')
                    AND ps.start_date = DATE '2026-08-04');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Southern Indiana', 'RGPS', 'RGPS', 'Caesars Southern Indiana', 'Elizabeth', 'IN', DATE '2026-08-18', DATE '2026-08-23',
       800, 'phase7b-tour-research', 'https://www.pokernews.com/news/2026/08/rgps-golden-expedition-southern-indiana-52065.htm', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Southern Indiana')
                    AND ps.start_date = DATE '2026-08-18');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition New Orleans', 'RGPS', 'RGPS', 'Caesars New Orleans', 'New Orleans', 'LA', DATE '2026-09-03', DATE '2026-09-13',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition New Orleans')
                    AND ps.start_date = DATE '2026-09-03');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition MGM National Harbor', 'RGPS', 'RGPS', 'MGM National Harbor', 'Oxon Hill', 'MD', DATE '2026-09-21', DATE '2026-09-27',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition MGM National Harbor')
                    AND ps.start_date = DATE '2026-09-21');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition St. Louis', 'RGPS', 'RGPS', 'Hollywood Casino St. Louis', 'Maryland Heights', 'MO', DATE '2026-10-06', DATE '2026-10-11',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition St. Louis')
                    AND ps.start_date = DATE '2026-10-06');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Tulsa', 'RGPS', 'RGPS', 'Hard Rock Hotel & Casino Tulsa', 'Catoosa', 'OK', DATE '2026-10-20', DATE '2026-10-25',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Tulsa')
                    AND ps.start_date = DATE '2026-10-20');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Atlantic City', 'RGPS', 'RGPS', 'Borgata Hotel Casino & Spa', 'Atlantic City', 'NJ', DATE '2026-11-04', DATE '2026-11-09',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/pages/events', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Atlantic City')
                    AND ps.start_date = DATE '2026-11-04');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Tunica', 'RGPS', 'RGPS', 'Horseshoe Tunica', 'Tunica', 'MS', DATE '2026-11-10', DATE '2026-11-15',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Tunica')
                    AND ps.start_date = DATE '2026-11-10');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Council Bluffs', 'RGPS', 'RGPS', 'Horseshoe Council Bluffs', 'Council Bluffs', 'IA', DATE '2026-11-17', DATE '2026-11-22',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Council Bluffs')
                    AND ps.start_date = DATE '2026-11-17');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'RGPS Golden Expedition Kentucky II', 'RGPS', 'RGPS', 'The OG Clubhouse', 'Oak Grove', 'KY', DATE '2026-11-17', DATE '2026-11-22',
       NULL, 'phase7b-tour-research', 'https://www.rungood.com/blogs/tour-news-1/rungood-poker-series-announces-2026-fall-season-golden-expedition', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('RGPS Golden Expedition Kentucky II')
                    AND ps.start_date = DATE '2026-11-17');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'DeepStack Showdown (August 2026)', 'VENETIAN', 'VENETIAN', 'The Venetian Resort Las Vegas', 'Las Vegas', 'NV', DATE '2026-08-03', DATE '2026-08-31',
       600, 'phase7b-tour-research', 'https://www.venetianlasvegas.com/resort/casino/poker/deepstack-extravaganza-poker-tournament/dss-aug-2026.html', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('DeepStack Showdown (August 2026)')
                    AND ps.start_date = DATE '2026-08-03');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Wynn Signature Series (August 2026)', 'WYNN', 'WYNN', 'Wynn Las Vegas', 'Las Vegas', 'NV', DATE '2026-08-17', DATE '2026-09-07',
       NULL, 'phase7b-tour-research', 'https://www.wynnlasvegas.com/casino/poker', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Wynn Signature Series (August 2026)')
                    AND ps.start_date = DATE '2026-08-17');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 Rock ''N'' Roll Poker Open', 'SHRPO', 'SHRPO', 'Seminole Hard Rock Hotel & Casino Hollywood', 'Hollywood', 'FL', DATE '2026-11-18', DATE '2026-12-02',
       3500, 'phase7b-tour-research', 'https://casino.hardrock.com/hollywood/newsroom/2026/01/seminole-hard-rock-hotel-and-casino-hollywood-partners-with-mspt-for-2026-rock-n-roll-poker-open', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 Rock ''N'' Roll Poker Open')
                    AND ps.start_date = DATE '2026-11-18');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'WPT Bay 101 Shooting Star Festival 2026', 'BAY101', 'BAY101', 'Bay 101 Casino', 'San Jose', 'CA', DATE '2026-10-16', DATE '2026-11-01',
       5300, 'phase7b-tour-research', 'https://www.pokernews.com/news/2026/07/wpt-bay-101-shooting-star-returns-51989.htm', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('WPT Bay 101 Shooting Star Festival 2026')
                    AND ps.start_date = DATE '2026-10-16');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT '2026 Mega Monster ($1.5M GTD)', 'LODGE', 'LODGE', 'The Lodge Card Club', 'Round Rock', 'TX', DATE '2026-07-23', DATE '2026-08-17',
       400, 'phase7b-tour-research', 'https://thelodgepokerclub.com/mega-monster-2026/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('2026 Mega Monster ($1.5M GTD)')
                    AND ps.start_date = DATE '2026-07-23');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Super High Roller Bowl PLO IV', 'PGT', 'PGT', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-03', DATE '2026-10-05',
       103000, 'phase7b-tour-research', 'https://www.pgt.com/schedule', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Super High Roller Bowl PLO IV')
                    AND ps.start_date = DATE '2026-10-03');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Super High Roller Bowl XI', 'PGT', 'PGT', 'PokerGO Studio at ARIA Resort & Casino', 'Las Vegas', 'NV', DATE '2026-10-07', DATE '2026-10-08',
       103000, 'phase7b-tour-research', 'https://www.pgt.com/schedule', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Super High Roller Bowl XI')
                    AND ps.start_date = DATE '2026-10-07');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Caesars Sizzler', 'GCPT', 'GCPT', 'Caesars New Orleans', 'New Orleans', 'LA', DATE '2026-08-06', DATE '2026-08-16',
       NULL, 'phase7b-tour-research', 'https://gulfcoastpoker.net/blog/gcp2026/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Caesars Sizzler')
                    AND ps.start_date = DATE '2026-08-06');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Fall 7 Clans Poker Cup Series', 'GCPT', 'GCPT', 'Coushatta Casino Resort', 'Kinder', 'LA', DATE '2026-09-01', DATE '2026-09-13',
       NULL, 'phase7b-tour-research', 'https://gulfcoastpoker.net/blog/gcp2026/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Fall 7 Clans Poker Cup Series')
                    AND ps.start_date = DATE '2026-09-01');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Ante Up Poker Tour - Rivers Casino Schenectady', 'ANTEUP', 'ANTEUP', 'Rivers Casino & Resort Schenectady', 'Schenectady', 'NY', DATE '2026-09-15', DATE '2026-09-25',
       NULL, 'phase7b-tour-research', 'https://anteupmagazine.com/where-to-play/tour/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Ante Up Poker Tour - Rivers Casino Schenectady')
                    AND ps.start_date = DATE '2026-09-15');
INSERT INTO poker_series
  (series_name, tour, tour_code, venue_name, city, state, start_date, end_date,
   main_event_buyin, source, source_url, data_quality, scrape_html_hash,
   scrape_timestamp, is_suppressed)
SELECT 'Trailblazer Poker Tour III - LIPS Ladies Event', 'LIPS', 'LIPS', 'Texas Card House Las Colinas', 'Irving', 'TX', DATE '2026-08-29', DATE '2026-08-29',
       300, 'phase7b-tour-research', 'https://lipstour.com/schedule/', 'manual_research', 'phase7b-manual-research-20260808',
       now(), false
WHERE NOT EXISTS (SELECT 1 FROM poker_series ps
                  WHERE lower(ps.series_name) = lower('Trailblazer Poker Tour III - LIPS Ladies Event')
                    AND ps.start_date = DATE '2026-08-29');
