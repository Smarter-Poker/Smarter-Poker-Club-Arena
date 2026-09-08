import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const migration = read(
  'supabase/migrations/20260908133319_recovery_drills_cannot_count_as_production_watchdog_kills.sql'
);
const verifier = read('server/src/services/DealRateVerifier.ts');
const engine = read('server/src/engine/ServerTableEngineBase.ts');
const schemaFragment = JSON.parse(
  read('scripts/ci/schema-manifest.d/recovery-drill-provenance.json')
) as {
  functions?: string[];
  columns?: Record<string, string[]>;
};
const requiredColumns = JSON.parse(read('scripts/ci/supabase-required-columns-manifest.json')) as {
  required?: Record<string, string[]>;
};

describe('synthetic recovery drills are evidence, not production kills', () => {
  it('stores constrained provenance and keeps old writers safe during rollout', () => {
    expect(migration).toContain(
      "ADD COLUMN event_class text NOT NULL DEFAULT 'automatic_recovery'"
    );
    expect(migration).toContain("CHECK (event_class IN ('automatic_recovery', 'fault_injection'))");
    expect(migration).toContain('CREATE TRIGGER classify_engine_recovery_event');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_classify_engine_recovery_event\(\)\s+FROM PUBLIC, anon, authenticated, service_role/
    );
    expect(schemaFragment.functions).toContain('fn_classify_engine_recovery_event');
    expect(schemaFragment.columns?.engine_recovery_events).toContain('event_class');
    // A defaulted provenance column is deliberately optional for rolling old
    // engines. Declaring it caller-required would defeat that compatibility.
    expect(requiredColumns.required?.engine_recovery_events).not.toContain('event_class');
  });

  it('makes every production kill counter an exact positive selection', () => {
    expect(verifier).toContain(".eq('event', 'watchdog_kill_rebuild')");
    expect(verifier).toContain(".eq('event_class', 'automatic_recovery')");
    expect(verifier).not.toContain(".neq('event_class'");

    expect(migration).toMatch(
      /SELECT count\(\*\) INTO v_kill FROM public\.engine_recovery_events\s+WHERE event = 'watchdog_kill_rebuild'\s+AND event_class = 'automatic_recovery'/
    );
    expect(migration).toContain('maintenance break scorecard still counts fault-injection kills');
  });

  it('fences test processes before the service-role telemetry write', () => {
    const fence = engine.indexOf('if (process.env.VITEST) return;');
    const write = engine.indexOf("supabase.from('engine_recovery_events').insert");
    expect(fence).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(fence);
  });
});
