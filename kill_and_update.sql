SET statement_timeout = '10s';
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE '%get_club_home%';
\i get_club_home_fixed.sql
