import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';

export type TickerSource =
  | 'overlays'
  | 'starting_soon'
  | 'custom_messages'
  | 'registration_closing'
  | 'guarantees'
  | 'table_openings'
  | 'maintenance'
  | 'winner_results';

export interface ManagedTickerSettings {
  enabled: boolean;
  speedSeconds: number;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: 'Rajdhani' | 'Inter' | 'Roboto Condensed' | 'System';
  sources: Record<TickerSource, boolean>;
  customMessages: string[];
  serviceMessages: string[];
}

export const DEFAULT_TICKER_SETTINGS: ManagedTickerSettings = {
  enabled: true,
  speedSeconds: 24,
  backgroundColor: '#0b1a33',
  textColor: '#f5fbff',
  accentColor: '#00d4ff',
  fontFamily: 'Rajdhani',
  sources: {
    overlays: true,
    starting_soon: true,
    custom_messages: true,
    registration_closing: true,
    guarantees: false,
    table_openings: false,
    maintenance: true,
    winner_results: false,
  },
  customMessages: [],
  serviceMessages: [],
};

function parse(raw: unknown): ManagedTickerSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_TICKER_SETTINGS;
  const row = raw as Record<string, any>;
  const settings = (
    row.settings && typeof row.settings === 'object' ? row.settings : row
  ) as Record<string, any>;
  return {
    ...DEFAULT_TICKER_SETTINGS,
    enabled: settings.enabled !== false,
    speedSeconds: Math.min(
      60,
      Math.max(8, Number(settings.speed_seconds ?? settings.speedSeconds ?? 24))
    ),
    backgroundColor: String(
      settings.background_color ??
        settings.backgroundColor ??
        DEFAULT_TICKER_SETTINGS.backgroundColor
    ),
    textColor: String(
      settings.text_color ?? settings.textColor ?? DEFAULT_TICKER_SETTINGS.textColor
    ),
    accentColor: String(
      settings.accent_color ?? settings.accentColor ?? DEFAULT_TICKER_SETTINGS.accentColor
    ),
    fontFamily: settings.font_family ?? settings.fontFamily ?? DEFAULT_TICKER_SETTINGS.fontFamily,
    sources: { ...DEFAULT_TICKER_SETTINGS.sources, ...(settings.sources || {}) },
    customMessages: Array.isArray(settings.custom_messages ?? settings.customMessages)
      ? (settings.custom_messages ?? settings.customMessages)
          .filter((message: unknown) => typeof message === 'string')
          .slice(0, 10)
      : [],
    serviceMessages: Array.isArray(settings.service_messages ?? settings.serviceMessages)
      ? (settings.service_messages ?? settings.serviceMessages)
          .filter((message: unknown) => typeof message === 'string')
          .slice(0, 5)
      : [],
  };
}

export const tickerManagementService = {
  async get(clubId?: string | null, unionId?: string | null): Promise<ManagedTickerSettings> {
    const { data, error } = await supabase.rpc('fn_get_game_ticker_settings', {
      p_club_id: clubId || null,
      p_union_id: unionId || null,
    });
    if (error) return DEFAULT_TICKER_SETTINGS;
    return parse(data);
  },

  async save(
    scope: 'club' | 'union',
    scopeId: string,
    settings: ManagedTickerSettings
  ): Promise<void> {
    const { data, error } = await supabase.rpc('fn_save_game_ticker_settings', {
      p_scope: scope,
      p_scope_id: scopeId,
      p_settings: {
        enabled: settings.enabled,
        speed_seconds: settings.speedSeconds,
        background_color: settings.backgroundColor,
        text_color: settings.textColor,
        accent_color: settings.accentColor,
        font_family: settings.fontFamily,
        sources: settings.sources,
        custom_messages: settings.customMessages,
        service_messages: settings.serviceMessages,
      },
    });
    if (error) throw new Error(error.message || 'Could not save ticker settings.');
    if (!(data as { ok?: boolean } | null)?.ok) throw new Error('Could not save ticker settings.');
    masterBus.emit('TICKER_SETTINGS_CHANGED', { scope, scopeId });
  },
};
