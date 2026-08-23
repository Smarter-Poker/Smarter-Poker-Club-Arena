SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE '%get_club_home%' AND pid <> pg_backend_pid();
