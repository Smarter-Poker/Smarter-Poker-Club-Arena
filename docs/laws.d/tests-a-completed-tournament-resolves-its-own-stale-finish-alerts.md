# tests/a-completed-tournament-resolves-its-own-stale-finish-alerts.law.test.ts

An AFTER UPDATE OF status trigger on public.tournaments closes a tournament's own stale Tournament.atomic_finish_*/atomic_satellite_finish_* financial_alerts rows with re-read evidence (never silence) the instant it reaches COMPLETED, and the one-time backfill re-reads live status rather than trusting a count.
