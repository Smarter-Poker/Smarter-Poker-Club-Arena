import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));

import {
  DEFAULT_TICKER_SETTINGS,
  normalizeTickerSettings,
  tickerManagementService,
  validateTickerContrast,
} from '../../src/services/TickerManagementService';
import { ManagementContentError } from '../../src/services/ManagementContentError';

describe('TickerManagementService hostile-state boundary', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.emit.mockReset();
  });

  it('normalizes malformed settings into a bounded canonical model', () => {
    const normalized = normalizeTickerSettings({
      enabled: 'yes',
      speed_seconds: 'not-a-number',
      background_color: 'javascript:alert(1)',
      text_color: '#ABCDEF',
      accent_color: null,
      font_family: 'Comic Sans',
      sources: { overlays: 'true', maintenance: false, unknown: true },
      custom_messages: ['  First   Message  ', 44, '', 'x'.repeat(200)],
      service_messages: { surprise: true },
    });

    expect(normalized).toEqual({
      ...DEFAULT_TICKER_SETTINGS,
      textColor: '#abcdef',
      sources: { ...DEFAULT_TICKER_SETTINGS.sources, maintenance: false },
      customMessages: ['First Message', 'x'.repeat(160)],
      serviceMessages: [],
    });
    expect(Number.isFinite(normalized.speedSeconds)).toBe(true);
    expect(normalizeTickerSettings({ speed_seconds: 24.6 }).speedSeconds).toBe(25);
  });

  it('does not turn a failed authoritative management read into editable defaults', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Network unavailable' } });

    await expect(tickerManagementService.getManagement('club', 'club-1')).rejects.toMatchObject({
      name: 'ManagementContentError',
      reason: 'unavailable',
    });
  });

  it('loads an explicit zero revision only when no ticker row exists', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, settings: {}, revision: 0, updated_at: null },
      error: null,
    });

    await expect(tickerManagementService.getManagement('union', 'union-1')).resolves.toEqual({
      settings: normalizeTickerSettings({}),
      revision: 0,
      updatedAt: null,
    });
  });

  it('sends the reviewed revision and surfaces a typed stale-editor conflict', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: 'version_conflict', current_revision: 8 },
      error: null,
    });

    const error = await tickerManagementService
      .save('club', 'club-1', DEFAULT_TICKER_SETTINGS, 7)
      .catch((caught) => caught);

    expect(mocks.rpc).toHaveBeenCalledWith(
      'fn_save_game_ticker_settings_versioned',
      expect.objectContaining({ p_expected_revision: 7 })
    );
    expect(error).toBeInstanceOf(ManagementContentError);
    expect(error).toMatchObject({ reason: 'version_conflict', currentRevision: 8 });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('refuses inaccessible colors before sending a mutation', async () => {
    const inaccessible = {
      ...DEFAULT_TICKER_SETTINGS,
      backgroundColor: '#111111',
      textColor: '#222222',
    };
    expect(validateTickerContrast(inaccessible)).toMatch(/4\.5:1/);

    await expect(
      tickerManagementService.save('club', 'club-1', inaccessible, 2)
    ).rejects.toMatchObject({ reason: 'inaccessible_colors' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('returns the server-normalized snapshot and emits only after a successful save', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        settings: { ...DEFAULT_TICKER_SETTINGS, speed_seconds: 30 },
        revision: 4,
        updated_at: '2026-09-01T18:00:00Z',
      },
      error: null,
    });

    await expect(
      tickerManagementService.save('union', 'union-1', DEFAULT_TICKER_SETTINGS, 3)
    ).resolves.toMatchObject({ revision: 4, updatedAt: '2026-09-01T18:00:00Z' });
    expect(mocks.emit).toHaveBeenCalledWith('TICKER_SETTINGS_CHANGED', {
      scope: 'union',
      scopeId: 'union-1',
    });
  });
});
