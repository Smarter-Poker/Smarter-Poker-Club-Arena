/** Durable cross-device propagation for user-owned table customization. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Binding = {
  config: { event: string; table: string; filter?: string };
  handler: (payload: any) => void;
};

const bindings: Binding[] = [];
const emit = vi.fn();
const channel = {
  on: vi.fn((_kind: string, config: Binding['config'], handler: Binding['handler']) => {
    bindings.push({ config, handler });
    return channel;
  }),
  subscribe: vi.fn(() => channel),
  unsubscribe: vi.fn(),
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: (...args: unknown[]) => emit(...args) },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { postgresSyncHooks } from '../../src/services/PostgresSyncHooks';

beforeEach(() => {
  bindings.length = 0;
  emit.mockClear();
  channel.on.mockClear();
  channel.subscribe.mockClear();
  postgresSyncHooks.destroy();
  postgresSyncHooks.init('user-1');
});

afterEach(() => postgresSyncHooks.destroy());

const binding = (table: string, event: string) => {
  const found = bindings.find((item) => item.config.table === table && item.config.event === event);
  if (!found) throw new Error(`missing ${table}:${event} binding`);
  return found;
};

describe('customization postgres sync', () => {
  it('invalidates management access from a recipient-filtered database event', () => {
    const access = binding('game_management_events', 'INSERT');
    expect(access.config.filter).toBe('recipient_id=eq.user-1');
    access.handler({
      new: {
        event_type: 'management_access_changed',
        scope_kind: 'club',
        scope_id: 'club-1',
        club_id: 'club-1',
      },
    });

    expect(emit).toHaveBeenCalledWith('GAME_MANAGEMENT_ACCESS_CHANGED', {
      scope: 'club',
      scopeId: 'club-1',
      clubId: 'club-1',
      userId: 'user-1',
    });
  });

  it('repaints table art and card-back controls from another device', () => {
    binding('user_theme_settings', 'UPDATE').handler({
      eventType: 'UPDATE',
      old: { table_id: 'old', cards_id: 'classic_blue' },
      new: { game_type: 'ALL', table_id: 'neon_city', cards_id: 'dragon' },
    });

    expect(emit).toHaveBeenCalledWith('UI_THEME_CHANGED', {
      key: 'ALL',
      value: { table_id: 'neon_city', cards_id: 'dragon' },
      userId: 'user-1',
    });
    expect(emit).toHaveBeenCalledWith('SETTINGS_CHANGED', {
      setting: 'cardBack',
      value: 'dragon',
      userId: 'user-1',
      origin: 'postgres-sync:user-theme-settings',
    });
  });

  it('applies newly inserted visual table settings to every mounted table', () => {
    binding('user_table_settings', '*').handler({
      eventType: 'INSERT',
      old: {},
      new: { user_id: 'user-1', blue_buttons_enabled: true, show_avatars: false },
    });

    expect(emit).toHaveBeenCalledWith('SETTINGS_CHANGED', {
      setting: 'blue_buttons_enabled',
      value: true,
      userId: 'user-1',
      origin: 'postgres-sync:user-table-settings',
    });
    expect(emit).toHaveBeenCalledWith('SETTINGS_CHANGED', {
      setting: 'show_avatars',
      value: false,
      userId: 'user-1',
      origin: 'postgres-sync:user-table-settings',
    });
  });

  it('applies light/dark mode stored by SettingsPage on another device', () => {
    binding('profiles', 'UPDATE').handler({
      eventType: 'UPDATE',
      old: {},
      new: { id: 'user-1', settings: { theme: 'light' } },
    });

    expect(emit).toHaveBeenCalledWith('UI_THEME_CHANGED', {
      key: 'theme',
      value: 'light',
      userId: 'user-1',
    });
  });

  it('does not put an unfiltered profiles subscription on every table socket', () => {
    const source = readFileSync(resolve(__dirname, '../../src/services/TableWebSocket.ts'), 'utf8');
    expect(source).not.toMatch(/table:\s*'profiles'/);
  });
});
