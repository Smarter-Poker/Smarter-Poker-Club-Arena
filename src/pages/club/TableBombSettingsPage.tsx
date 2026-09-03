/**
 * TABLE BOMB SETTINGS — editing a table that is already running (2026-08-29)
 * ============================================================================
 * Every bomb-pot setting on this platform used to be WRITE-ONCE.
 * TableConfigPage takes a `gameType`, never a table id, has no hydration path
 * and ends in an INSERT — so a host who shipped a table with the wrong
 * frequency, or wanted to raise the ante, or wanted to turn bomb pots off on a
 * table that was annoying their players, had exactly one option: kill the
 * table and build a new one, losing every seated player to fix a number.
 *
 * This page is the other half of fn_update_table_bomb_settings. It edits ONLY
 * the columns the engine re-reads on its own throttled refresh
 * (ServerTableEngineBase.refreshRakeConfig), which is what makes them safe to
 * change under a live table: the next hand plays by the new rules, with no
 * restart and nothing to reconcile.
 *
 * Everything else about a table — its variant, its blinds, its seat count, its
 * buy-in range — is baked into seated players' stacks or read once at engine
 * start, and is deliberately absent here rather than disabled: a control a
 * host cannot use is worse than one that was never offered.
 *
 * The RPC is the authority. It re-checks owner / co_owner / admin, validates
 * and clamps every field, clears the bomb LIVE state so an old schedule cannot
 * detonate under the new rules, and writes an audit row. Everything below is
 * presentation.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/common/Toast';
import { reportError } from '../../utils/errorReporter';
import styles from './TableBombSettingsPage.module.css';

type TriggerMode = 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only';

interface Draft {
  enabled: boolean;
  mode: TriggerMode;
  frequency: number;
  intervalMinutes: number;
  boards: number;
  minPlayers: number;
  anteBB: number;
  anteFixed: number;
  variant: string;
  separateButton: boolean;
  announceMinutes: number;
}

const MODES: Array<{ value: TriggerMode; label: string; hint: string }> = [
  {
    value: 'every_n_hands',
    label: 'Every Set Number Of Hands',
    hint: 'Choose Which Dealt Hand Becomes A Bomb Pot',
  },
  {
    value: 'once_per_orbit',
    label: 'Every Orbit',
    hint: 'One Bomb Each Time The Button Goes Round',
  },
  { value: 'timed', label: 'On The Clock', hint: 'A Bomb Every Few Minutes' },
  { value: 'bomb_pot_only', label: 'Bomb Pots Only', hint: 'Every Hand Is A Bomb Pot' },
];

const VARIANTS = [
  { value: '', label: 'Same As Table' },
  { value: 'nlh', label: 'NLH' },
  { value: 'plo4', label: 'PLO4' },
  { value: 'plo5', label: 'PLO5' },
  { value: 'plo6', label: 'PLO6' },
];

export default function TableBombSettingsPage() {
  const { clubId, tableId } = useParams<{ clubId: string; tableId: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [tableName, setTableName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tableId) return;
    let cancelled = false;
    void (async () => {
      const { data, error: readErr } = await supabase
        .from('tables')
        .select(
          'name, bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_frequency, ' +
            'bomb_pot_interval_seconds, bomb_pot_board_count, bomb_pot_min_players, ' +
            'bomb_pot_ante_multiplier, bomb_pot_ante_fixed, bomb_pot_variant, ' +
            'bomb_pot_button_policy, bomb_pot_announce_seconds'
        )
        .eq('id', tableId)
        .maybeSingle();
      if (cancelled) return;
      if (readErr || !data) {
        if (readErr) reportError(readErr, 'TableBombSettingsPage.Load_failed');
        setError('Could Not Load This Table');
        setLoading(false);
        return;
      }
      const r = data as unknown as Record<string, unknown>;
      setTableName(String(r.name ?? ''));
      setDraft({
        enabled: r.bomb_pot_enabled === true,
        mode: (['every_n_hands', 'once_per_orbit', 'timed', 'bomb_pot_only'] as const).includes(
          r.bomb_pot_trigger_mode as TriggerMode
        )
          ? (r.bomb_pot_trigger_mode as TriggerMode)
          : 'every_n_hands',
        frequency: Number(r.bomb_pot_frequency ?? 0) || 10,
        intervalMinutes:
          Math.max(1, Math.round(Number(r.bomb_pot_interval_seconds ?? 0) / 60)) || 15,
        boards: Number(r.bomb_pot_board_count ?? 1) || 1,
        minPlayers: Number(r.bomb_pot_min_players ?? 3) || 3,
        anteBB: Number(r.bomb_pot_ante_multiplier ?? 0) || 2,
        anteFixed: Number(r.bomb_pot_ante_fixed ?? 0) || 0,
        variant: typeof r.bomb_pot_variant === 'string' ? r.bomb_pot_variant : '',
        separateButton: r.bomb_pot_button_policy === 'separate',
        announceMinutes: Math.round(Number(r.bomb_pot_announce_seconds ?? 0) / 60) || 0,
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tableId]);

  const set = useCallback(<K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  }, []);

  const save = useCallback(async () => {
    if (!draft || !tableId) return;
    setSaving(true);
    const { data, error: rpcErr } = await supabase.rpc('fn_update_table_bomb_settings', {
      p_table_id: tableId,
      p_settings: {
        bomb_pot_enabled: draft.enabled,
        bomb_pot_trigger_mode: draft.mode,
        bomb_pot_frequency: draft.frequency,
        bomb_pot_interval_seconds: Math.round(draft.intervalMinutes * 60),
        bomb_pot_board_count: draft.boards,
        bomb_pot_min_players: draft.minPlayers,
        bomb_pot_ante_multiplier: draft.anteBB,
        bomb_pot_ante_fixed: draft.anteFixed,
        bomb_pot_variant: draft.variant || null,
        bomb_pot_button_policy: draft.separateButton ? 'separate' : 'regular',
        bomb_pot_announce_seconds: Math.round(draft.announceMinutes * 60),
      },
    });
    setSaving(false);
    if (rpcErr) {
      reportError(rpcErr, 'TableBombSettingsPage.Save_failed');
      toast.error('Could Not Save These Settings');
      return;
    }
    const res = data as {
      ok?: boolean;
      reason?: string;
      changed?: boolean;
      /** The column is an integer, so a fractional ante was rounded to store. */
      ante_multiplier_rounded?: boolean;
    } | null;
    if (!res?.ok) {
      // The RPC names WHY. Surfacing its reason beats a generic failure — a
      // host who set a 30-second timer should be told that, not told "error".
      toast.error(
        res?.reason === 'not_authorized'
          ? 'Only Club Staff Can Change This'
          : res?.reason === 'frequency_must_be_at_least_1'
            ? 'The Number Of Hands Between Bomb Pots Must Be At Least 1'
            : res?.reason === 'interval_must_be_at_least_60s'
              ? 'The Timer Must Be At Least One Minute'
              : 'Could Not Save These Settings'
      );
      return;
    }
    // The engine re-reads on its own throttle, so this is a promise the code
    // actually keeps — no restart, and no need to tell the host to do anything.
    //
    // If the ante was rounded, SAY SO. The column is an integer, and a host
    // who asked for two and a half big blinds and silently got three would
    // find out from the felt, after every player at the table had already
    // been charged the larger amount.
    toast.success(
      !res.changed
        ? 'Nothing Changed'
        : res.ante_multiplier_rounded
          ? `Saved. The Ante Was Rounded To ${draft.anteBB} Big Blinds. The Table Picks This Up Within A Minute.`
          : 'Saved. The Table Picks This Up Within A Minute.'
    );
    navigate(`/clubs/${clubId}`);
  }, [draft, tableId, clubId, toast, navigate]);

  if (loading) return <p className={styles.empty}>Loading Table Settings...</p>;
  if (error || !draft) return <p className={styles.empty}>{error ?? 'No Table'}</p>;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(`/clubs/${clubId}`)}>
          Back
        </button>
        <h1>Bomb Pots{tableName ? ` · ${tableName}` : ''}</h1>
      </header>

      <p className={styles.lede}>
        These Take Effect On A Running Table. The Engine Picks Them Up Within A Minute, So You Do
        Not Need To Close The Game.
      </p>

      <label className={styles.toggleRow}>
        <span>Bomb Pots</span>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
      </label>

      {draft.enabled && (
        <>
          <div className={styles.field}>
            <span className={styles.label}>Trigger</span>
            <div className={styles.modes}>
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={draft.mode === m.value ? styles.modeActive : styles.mode}
                  onClick={() => set('mode', m.value)}
                >
                  <span className={styles.modeLabel}>{m.label}</span>
                  <span className={styles.modeHint}>{m.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {draft.mode === 'every_n_hands' && (
            <label className={styles.field}>
              <span className={styles.label}>Bomb Pot Hand Interval</span>
              <input
                type="number"
                min={1}
                max={200}
                value={draft.frequency}
                onChange={(e) => set('frequency', Math.max(1, Number(e.target.value) || 1))}
              />
              <span className={styles.suffix}>Hands</span>
            </label>
          )}

          {draft.mode === 'timed' && (
            <>
              <label className={styles.field}>
                <span className={styles.label}>A Bomb Every</span>
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={draft.intervalMinutes}
                  onChange={(e) => set('intervalMinutes', Math.max(1, Number(e.target.value) || 1))}
                />
                <span className={styles.suffix}>Minutes</span>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Show The Clock Within</span>
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={draft.announceMinutes}
                  onChange={(e) => set('announceMinutes', Math.max(0, Number(e.target.value) || 0))}
                />
                <span className={styles.suffix}>Minutes (0 = Always)</span>
              </label>
            </>
          )}

          <label className={styles.field}>
            <span className={styles.label}>Boards</span>
            <select value={draft.boards} onChange={(e) => set('boards', Number(e.target.value))}>
              <option value={1}>1 Board</option>
              <option value={2}>2 Boards</option>
              <option value={3}>3 Boards</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Ante</span>
            {/* WHOLE BIG BLINDS ONLY. tables.bomb_pot_ante_multiplier is an
                INTEGER column, so a half-step here would be a control offering
                a value the database cannot hold — a host dragging to 2.5 would
                have 3 stored and every player charged the larger ante. The
                fractional case has a proper home in the Fixed Ante below,
                which is `numeric` and states the price in chips. */}
            <input
              type="number"
              min={0}
              step={1}
              value={draft.anteBB}
              onChange={(e) => set('anteBB', Math.max(0, Math.round(Number(e.target.value) || 0)))}
            />
            <span className={styles.suffix}>X BB (Whole Blinds)</span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Or A Fixed Ante</span>
            <input
              type="number"
              min={0}
              value={draft.anteFixed}
              onChange={(e) => set('anteFixed', Math.max(0, Number(e.target.value) || 0))}
            />
            <span className={styles.suffix}>Chips (0 = Use The Multiple)</span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Needs</span>
            <input
              type="number"
              min={2}
              max={10}
              value={draft.minPlayers}
              onChange={(e) => set('minPlayers', Math.max(2, Number(e.target.value) || 2))}
            />
            <span className={styles.suffix}>Players Before It Fires</span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Played As</span>
            <select value={draft.variant} onChange={(e) => set('variant', e.target.value)}>
              {VARIANTS.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.toggleRow}>
            <span>Separate Bomb Button</span>
            <input
              type="checkbox"
              checked={draft.separateButton}
              onChange={(e) => set('separateButton', e.target.checked)}
            />
          </label>
        </>
      )}

      <button className={styles.saveBtn} onClick={save} disabled={saving}>
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}
