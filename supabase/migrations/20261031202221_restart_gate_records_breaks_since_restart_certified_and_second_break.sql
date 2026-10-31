SET LOCAL lock_timeout = '3s';

ALTER TABLE public.engine_maintenance_break_log
  ADD COLUMN IF NOT EXISTS breaks_since_restart_certified INTEGER;

COMMENT ON COLUMN public.engine_maintenance_break_log.breaks_since_restart_certified IS
  'Consecutive breaks, this one included, that ended with no restart certificate (0 = this break certified). Written by the engine at MaintenanceBreak.end(); >= 2 raises ClubArenaRestartGateShut. NULL on rows written before 2026-10-31.';

ALTER TABLE public.engine_maintenance_break_faults
  DROP CONSTRAINT IF EXISTS engine_maintenance_break_faults_stage_check;
ALTER TABLE public.engine_maintenance_break_faults
  ADD CONSTRAINT engine_maintenance_break_faults_stage_check
  CHECK (stage IN ('announcement', 'countdown', 'adoption', 'boot', 'restart_gate'));

ALTER TABLE public.engine_maintenance_break_faults
  DROP CONSTRAINT IF EXISTS engine_maintenance_break_faults_outcome_check;
ALTER TABLE public.engine_maintenance_break_faults
  ADD CONSTRAINT engine_maintenance_break_faults_outcome_check
  CHECK (outcome IN ('cancelled', 'held_without_restart', 'straggler_reported', 'refusing_accounting_pending'));