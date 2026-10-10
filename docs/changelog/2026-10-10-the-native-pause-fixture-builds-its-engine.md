# The native pause fixture builds its engine

The generic pre-push Node test entry point called the PostgreSQL fixture without compiled server modules and failed to import the Supabase client. The maintained fixture runner now builds the current server before creating its disposable database. CI uses the same runner and no longer duplicates that build. All native assertions and the original timeout remain unchanged.

The failed pre-push run demonstrated the missing module. Exact clean-output native verification and ordinary required hooks remain mandatory before delivery.
