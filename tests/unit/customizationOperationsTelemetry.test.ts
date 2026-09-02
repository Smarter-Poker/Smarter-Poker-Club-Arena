import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  recordCustomizationOperation,
  shouldSampleCustomizationSuccess,
} from '../../src/services/CustomizationOperationsTelemetry';

describe('customization operational sampling', () => {
  it('keeps every failure, recovery, and conflict signal', () => {
    for (const event of [
      'appearance_failed',
      'purchase_failed',
      'realtime_failed',
      'realtime_recovered',
      'conflict_suppressed',
    ] as const) {
      expect(shouldSampleCustomizationSuccess(event, 0.999)).toBe(true);
    }
  });

  it('samples routine successes so measurement cannot double write volume', () => {
    expect(shouldSampleCustomizationSuccess('appearance_saved', 0.1)).toBe(true);
    expect(shouldSampleCustomizationSuccess('appearance_saved', 0.9)).toBe(false);
    expect(shouldSampleCustomizationSuccess('purchase_succeeded', 0.1)).toBe(true);
    expect(shouldSampleCustomizationSuccess('purchase_succeeded', 0.9)).toBe(false);
  });

  it('can never throw into the customization path', () => {
    expect(() =>
      recordCustomizationOperation({
        userId: null,
        event: 'appearance_failed',
        surface: 'table-studio',
      })
    ).not.toThrow();
  });
});

describe('customization operational wiring', () => {
  const apply = readFileSync(
    path.resolve(__dirname, '../../src/lib/applyTableAppearance.ts'),
    'utf8'
  );
  const modal = readFileSync(
    path.resolve(__dirname, '../../src/components/table/ThemeSettingsModal.tsx'),
    'utf8'
  );
  const realtime = readFileSync(
    path.resolve(__dirname, '../../src/hooks/useUserThemeSettings.ts'),
    'utf8'
  );

  it('measures apply latency and failures at the one authoritative writer', () => {
    expect(apply).toContain('recordCustomizationOperation');
    expect(apply).toContain(
      "event: outcome === 'saved' ? 'appearance_saved' : 'appearance_failed'"
    );
    expect(apply).toMatch(/durationMs[:,]/);
  });

  it('measures purchase success and failure around the server checkout', () => {
    expect(modal).toContain("event: 'purchase_succeeded'");
    expect(modal).toContain("event: 'purchase_failed'");
  });

  it('measures realtime disconnect and recovery at the shared account channel', () => {
    expect(realtime).toContain("event: 'realtime_failed'");
    expect(realtime).toContain("event: 'realtime_recovered'");
  });
});

describe('the operational dashboard ships with its sink', () => {
  it('has write-own RLS, a bounded retention index, and hourly/daily KPI views', () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        '../../supabase/migrations/20260830170000_customization_operations_telemetry.sql'
      ),
      'utf8'
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.customization_operations/);
    expect(sql).toMatch(/WITH CHECK \(user_id = auth\.uid\(\)\)/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_customization_health_hourly/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_customization_health_daily/);
    expect(sql).toMatch(/percentile_disc\(0\.95\)/);
  });
});
