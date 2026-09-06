# Private Realtime Authorization

- Prime Supabase Realtime Authorization from the current authenticated session before joining a private MasterBus Broadcast channel.
- Preserve private per-player Daily Mission topics while preventing authenticated pages from receiving an unauthorized channel error during startup.
- Keep failed authorization observable through the existing subscription error callback and error reporter.
