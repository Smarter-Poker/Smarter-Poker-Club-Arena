/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NEW CASH GAME (Operation Table Stakes, Slice 1 - OPORD 1.3 section 7 as
 *  amended by OPORD 1.4 section 2.6)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A host creates a GAME, not a table. The choice order is locked:
 *
 *   1. Template   classic | action | madness  (defaults load from the server)
 *   2. Variant    only what the engine deals; anything else is offered
 *                 disabled with "This Variant Is Not Available Yet"
 *   3. Stakes     from the existing preset ladder
 *   4. Handedness classic NLH 9 or 6; action / madness NLH 6 (host may
 *                 change); PLO family 6, locked; short deck / pineapple 6,
 *                 host 2-8
 *   5. Overrides  every field of section 8; stay clock and rejoin window
 *                 can only be raised
 *   6. Confirm    one RPC, fn_cash_game_create, which persists the game and
 *                 its resolved ruleset snapshot and opens Main 1
 *
 * Nothing here writes `tables`. The database resolves the snapshot and
 * refuses anything the rules refuse; this component renders the server's
 * defaults and reports the server's answer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { getTableState } from '../../services/GameServerAPI';
import { presetsFor, DEFAULT_BLINDS_INDEX } from '../../config/blindsPresets';
import { isFixedLimitVariant, stakesLabel } from '../../lib/bettingStructure';
import { getRakeConfig, RAKE_INHERIT } from '../../config/RakeConfig';
import { formatCurrency } from '../../lib/utils';
import {
  CASH_TEMPLATES,
  CASH_VARIANTS,
  cashGameCreateRefusalText,
  isDealtVariant,
  overridesFromSnapshot,
  type CashGameOverrides,
  type CashRulesetSnapshot,
  type CashTemplate,
} from '../../config/cashGames';
import { Slider, Toggle } from '../table-config/controls';
import './CashGameCreateFlow.css';

interface Props {
  clubId: string;
  /** The variant the previous screen was opened for; still changeable here. */
  initialVariant?: string | null;
  /** fn_game_creation_access said this person may build here. */
  canBuildHere: boolean;
  deniedMessage?: string | null;
  /**
   * Embedded hosts (Table Management, for a club or a union) own the URL.
   * When set, a saved game hands control back here instead of navigating to
   * /clubs/<id> - which, from a union console, is a page the operator did not
   * come from. Start still goes to the felt: that is the point of Start.
   */
  onSaved?: () => void;
}

export default function CashGameCreateFlow({
  clubId,
  initialVariant,
  canBuildHere,
  deniedMessage,
  onSaved,
}: Props) {
  const navigate = useNavigate();
  const toast = useToast();

  const [template, setTemplate] = useState<CashTemplate | null>(null);
  const [variant, setVariant] = useState<string | null>(
    isDealtVariant(initialVariant) ? (initialVariant as string) : null
  );
  const [blindsIndex, setBlindsIndex] = useState<number | null>(null);
  const [handedness, setHandedness] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<CashRulesetSnapshot | null>(null);
  const [overrides, setOverrides] = useState<CashGameOverrides | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'save' | 'start' | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);

  const limitGame = isFixedLimitVariant(variant);
  const presets = useMemo(() => presetsFor(limitGame), [limitGame]);

  /* Step 1 + 2 -> the server's defaults for this template x variant. Every
     change re-loads them (OPORD 1.3 ROE 6: templates auto-load defaults). */
  useEffect(() => {
    if (!template || !variant) {
      setSnapshot(null);
      setOverrides(null);
      return;
    }
    let live = true;
    setLoadingDefaults(true);
    void (async () => {
      const { data, error } = await supabase.rpc('fn_cash_template_defaults', {
        p_template: template,
        p_variant: variant,
      });
      if (!live) return;
      setLoadingDefaults(false);
      if (error || !data) {
        reportError(error ?? new Error('no defaults'), 'CashGameCreateFlow.defaults');
        toast.error('Could Not Load The Template Defaults. Please Try Again.');
        setSnapshot(null);
        setOverrides(null);
        return;
      }
      const snap = data as CashRulesetSnapshot;
      setSnapshot(snap);
      setOverrides(overridesFromSnapshot(snap));
      setHandedness(snap.seats);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, variant]);

  /* A limit variant offers a shorter ladder; keep the chosen row on it. */
  useEffect(() => {
    if (blindsIndex === null) return;
    if (blindsIndex >= presets.length) setBlindsIndex(presets.length - 1);
  }, [presets, blindsIndex]);

  const stakes = blindsIndex !== null ? presets[blindsIndex] : null;
  const stepTemplateDone = template !== null;
  const stepVariantDone = stepTemplateDone && variant !== null;
  const stepStakesDone = stepVariantDone && stakes !== null;
  const stepHandednessDone = stepStakesDone && handedness !== null && snapshot !== null;
  const canConfirm =
    canBuildHere && stepHandednessDone && overrides !== null && busy === null && !loadingDefaults;

  const setOverride = useCallback(
    <K extends keyof CashGameOverrides>(key: K, value: CashGameOverrides[K]) => {
      setOverrides((prev) => (prev ? { ...prev, [key]: value } : prev));
    },
    []
  );

  const create = useCallback(
    async (mode: 'save' | 'start') => {
      if (!canConfirm || !template || !variant || !stakes || !overrides) return;
      if (!canBuildHere) {
        toast.error(deniedMessage || 'You Cannot Create Games In This Club');
        return;
      }
      setBusy(mode);
      try {
        const resolvedClubId = await resolveClubUUID(clubId);
        const { data, error } = await supabase.rpc('fn_cash_game_create', {
          p_club_id: resolvedClubId,
          p_template: template,
          p_variant: variant,
          p_sb: stakes.sb,
          p_bb: stakes.bb,
          p_handedness: handedness,
          p_overrides: overrides,
          p_name: name.trim() || null,
        });
        if (error) throw error;
        const res = (data ?? {}) as {
          ok?: boolean;
          game_id?: string;
          table_id?: string;
          name?: string;
        };
        if (!res.ok || !res.table_id) throw new Error('fn_cash_game_create returned no table');

        masterBus.emit('TABLE_CREATED', { tableId: res.table_id, clubId: resolvedClubId });

        if (mode === 'start') {
          // Same wake the old Start button used: an authenticated engine read
          // that provisions the table's engine before the felt loads.
          try {
            await getTableState(res.table_id);
          } catch (err) {
            reportError(err, 'CashGameCreateFlow.engine_wake');
          }
          toast.success('Game Created And Started');
          navigate(`/table/${res.table_id}`);
        } else {
          toast.success('Game Created');
          if (onSaved) onSaved();
          else navigate(`/clubs/${clubId}`);
        }
      } catch (err) {
        // A refusal the function raised on purpose gets its house wording;
        // anything else surfaces the server message rather than a fixed
        // string (tests/a-control-that-says-none-must-mean-none.law.test.ts).
        const refusal = cashGameCreateRefusalText(err);
        if (!refusal) reportError(err, 'CashGameCreateFlow.create_failed');
        const serverMessage = err instanceof Error && err.message ? err.message : null;
        toast.error(refusal ?? serverMessage ?? 'Could Not Create The Game');
      } finally {
        setBusy(null);
      }
    },
    [
      canConfirm,
      template,
      variant,
      stakes,
      overrides,
      canBuildHere,
      deniedMessage,
      clubId,
      handedness,
      name,
      navigate,
      toast,
    ]
  );

  const seatChoices = snapshot?.seat_choices ?? [];
  const seatsLocked = snapshot?.seats_locked === true;

  return (
    <div className="cash-create">
      {/* ── 1. Template ─────────────────────────────────────────────────── */}
      <section className="cash-create__step" data-step="template" data-done={stepTemplateDone}>
        <h2 className="cash-create__title">1. Template</h2>
        <div className="cash-create__cards">
          {CASH_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`cash-create__card${template === t.id ? ' is-selected' : ''}`}
              onClick={() => setTemplate(t.id)}
              aria-pressed={template === t.id}
            >
              <span className="cash-create__card-title">{t.label}</span>
              <span className="cash-create__card-blurb">{t.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── 2. Variant ──────────────────────────────────────────────────── */}
      <section
        className="cash-create__step"
        data-step="variant"
        data-done={stepVariantDone}
        aria-disabled={!stepTemplateDone}
      >
        <h2 className="cash-create__title">2. Variant</h2>
        <div className="cash-create__chips">
          {CASH_VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`config-preset-chip cash-create__chip${variant === v.id ? ' is-selected' : ''}`}
              disabled={!stepTemplateDone}
              onClick={() => setVariant(v.id)}
              aria-pressed={variant === v.id}
            >
              {v.label}
            </button>
          ))}
          {/* Anything the engine cannot deal yet is offered disabled, never
              silently saved as NLHE (ROE 16). The list is empty today; the
              slot exists so a new variant appears here before it is dealt. */}
          {initialVariant && !isDealtVariant(initialVariant) && (
            <button
              type="button"
              className="config-preset-chip cash-create__chip is-unavailable"
              disabled
              title="This Variant Is Not Available Yet"
            >
              {initialVariant.toUpperCase()} - Not Available Yet
            </button>
          )}
        </div>
      </section>

      {/* ── 3. Stakes ───────────────────────────────────────────────────── */}
      <section
        className="cash-create__step"
        data-step="stakes"
        data-done={stepStakesDone}
        aria-disabled={!stepVariantDone}
      >
        <h2 className="cash-create__title">3. Stakes</h2>
        <div className="cash-create__chips">
          {presets.map((p, i) => (
            <button
              key={p.label}
              type="button"
              className={`config-preset-chip cash-create__chip${blindsIndex === i ? ' is-selected' : ''}`}
              disabled={!stepVariantDone}
              onClick={() => setBlindsIndex(i)}
              aria-pressed={blindsIndex === i}
            >
              {stakesLabel(p.sb, p.bb, variant)}
            </button>
          ))}
        </div>
        {stepVariantDone && blindsIndex === null && (
          <button
            type="button"
            className="cash-create__link"
            onClick={() => setBlindsIndex(Math.min(DEFAULT_BLINDS_INDEX, presets.length - 1))}
          >
            Use The Usual Stakes
          </button>
        )}
      </section>

      {/* ── 4. Handedness ───────────────────────────────────────────────── */}
      <section
        className="cash-create__step"
        data-step="handedness"
        data-done={stepHandednessDone}
        aria-disabled={!stepStakesDone}
      >
        <h2 className="cash-create__title">4. Table Size</h2>
        {loadingDefaults && <p className="cash-create__note">Loading Defaults</p>}
        {snapshot && (
          <div className="cash-create__chips">
            {seatChoices.map((n) => (
              <button
                key={n}
                type="button"
                className={`config-preset-chip cash-create__chip${handedness === n ? ' is-selected' : ''}`}
                disabled={!stepStakesDone || seatsLocked}
                onClick={() => setHandedness(n)}
                aria-pressed={handedness === n}
              >
                {n === 2 ? 'Heads Up' : `${n}-Max`}
              </button>
            ))}
            {seatsLocked && (
              <span className="cash-create__note">6-Max Is Locked For Omaha Games</span>
            )}
          </div>
        )}
      </section>

      {/* ── 5. Overrides (every field of section 8) ─────────────────────── */}
      <section
        className="cash-create__step"
        data-step="overrides"
        data-done={stepHandednessDone}
        aria-disabled={!stepHandednessDone}
      >
        <h2 className="cash-create__title">5. Rules</h2>
        {snapshot && overrides && stakes && (
          <div className="config-options cash-create__options">
            <div className="config-name">
              <input
                type="text"
                placeholder="Game Name (Optional)"
                value={name}
                maxLength={60}
                aria-label="Game Name"
                onChange={(e) => setName(e.target.value.slice(0, 60))}
              />
            </div>

            <Slider
              label="Minimum Buy In"
              value={overrides.min_buyin_bb}
              onChange={(v) => setOverride('min_buyin_bb', Math.min(v, overrides.max_buyin_bb))}
              min={10}
              max={400}
              step={10}
              format={(v) => `${v} BB (${stakesLabelChips(stakes.bb * v)})`}
            />
            <Slider
              label="Maximum Buy In"
              value={overrides.max_buyin_bb}
              onChange={(v) => setOverride('max_buyin_bb', Math.max(v, overrides.min_buyin_bb))}
              min={40}
              max={1000}
              step={10}
              format={(v) => `${v} BB (${stakesLabelChips(stakes.bb * v)})`}
            />

            <div className="config-radio-group">
              <span className="radio-group-label">Ante Each Dealt In Player</span>
              <div className="radio-options">
                {(['none', 'sb', 'bb'] as const).map((a) => (
                  <label key={a} className="radio-option">
                    <input
                      type="radio"
                      name="regular_ante"
                      checked={overrides.regular_ante === a}
                      onChange={() => setOverride('regular_ante', a)}
                    />
                    <span>
                      {a === 'none' ? 'None' : a === 'sb' ? 'One Small Blind' : 'One Big Blind'}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <Slider
              label="VPIP Floor"
              value={overrides.vpip_floor}
              onChange={(v) => setOverride('vpip_floor', v)}
              min={0}
              max={100}
              step={5}
              format={(v) => (v === 0 ? 'Off' : `${v}%`)}
              tooltip="Players Under This Voluntarily Put In Pot Rate Over The Window Are Cashed Out After The Hand."
            />
            {overrides.vpip_floor > 0 && (
              <Slider
                label="VPIP Window"
                value={overrides.vpip_window}
                onChange={(v) => setOverride('vpip_window', v)}
                min={10}
                max={200}
                step={10}
                suffix=" Hands"
              />
            )}

            <Toggle
              label="Bomb Pots"
              value={overrides.bombs.enabled}
              onChange={(v) => setOverride('bombs', { ...overrides.bombs, enabled: v })}
              tooltip="Two Boards. No Preflop. Every Dealt In Player Posts The Bomb Ante Instead Of The Blinds."
            />
            {overrides.bombs.enabled && (
              <>
                <div className="config-radio-group">
                  <span className="radio-group-label">Bomb Trigger</span>
                  <div className="radio-options">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bomb_trigger"
                        checked={overrides.bombs.trigger === 'timed_15m'}
                        onChange={() =>
                          setOverride('bombs', { ...overrides.bombs, trigger: 'timed_15m' })
                        }
                      />
                      <span>Every 15 Minutes</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bomb_trigger"
                        checked={overrides.bombs.trigger === 'every_orbit'}
                        onChange={() =>
                          setOverride('bombs', { ...overrides.bombs, trigger: 'every_orbit' })
                        }
                      />
                      <span>Every Orbit</span>
                    </label>
                  </div>
                </div>
                <Slider
                  label="Bomb Ante"
                  value={overrides.bombs.ante_bb}
                  onChange={(v) => setOverride('bombs', { ...overrides.bombs, ante_bb: v })}
                  min={1}
                  max={20}
                  step={1}
                  suffix=" BB"
                />
                <div className="config-radio-group">
                  <span className="radio-group-label">Boards</span>
                  <div className="radio-options">
                    {[2, 3].map((b) => (
                      <label key={b} className="radio-option">
                        <input
                          type="radio"
                          name="bomb_boards"
                          checked={overrides.bombs.boards === b}
                          onChange={() => setOverride('bombs', { ...overrides.bombs, boards: b })}
                        />
                        <span>{b === 2 ? 'Double Board' : 'Triple Board'}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ROE 7: the two clocks may only be raised. The floor IS the slider minimum. */}
            <Slider
              label="Stay Clock"
              value={overrides.stay_clock_min}
              onChange={(v) => setOverride('stay_clock_min', Math.max(snapshot.stay_clock_min, v))}
              min={snapshot.stay_clock_min}
              max={60}
              step={5}
              suffix=" Minutes"
              tooltip="A Player Ahead Of The Money They Put In Stays Seated This Long Before They Can Leave. Ten Minutes Is The Minimum."
            />
            <Slider
              label="Rejoin Window"
              value={overrides.rejoin_window_min}
              onChange={(v) =>
                setOverride('rejoin_window_min', Math.max(snapshot.rejoin_window_min, v))
              }
              min={snapshot.rejoin_window_min}
              max={720}
              step={30}
              suffix=" Minutes"
              tooltip="A Player Who Returns To This Game Inside The Window Buys In For At Least The Stack They Left With. Two Hours Is The Minimum."
            />

            <Toggle
              label="Private Game"
              value={overrides.options.is_private}
              onChange={(v) => setOverride('options', { ...overrides.options, is_private: v })}
            />
            <Toggle
              label="VIP Only"
              value={overrides.options.is_vip_only}
              onChange={(v) => setOverride('options', { ...overrides.options, is_vip_only: v })}
            />
            <Toggle
              label="Anonymous Seats"
              value={overrides.options.is_anonymous}
              onChange={(v) => setOverride('options', { ...overrides.options, is_anonymous: v })}
            />
            <Toggle
              label="Ban Chat"
              value={overrides.options.ban_chat}
              onChange={(v) => setOverride('options', { ...overrides.options, ban_chat: v })}
            />
            <Toggle
              label="Insurance"
              value={overrides.options.insurance_enabled}
              onChange={(v) =>
                setOverride('options', { ...overrides.options, insurance_enabled: v })
              }
            />
            {variant === 'nlh' && (
              <Toggle
                label="Seven Deuce Bonus"
                value={overrides.options.seven_deuce_enabled}
                onChange={(v) =>
                  setOverride('options', { ...overrides.options, seven_deuce_enabled: v })
                }
              />
            )}
            <Slider
              label="Action Time"
              value={overrides.options.action_time_seconds}
              onChange={(v) =>
                setOverride('options', { ...overrides.options, action_time_seconds: v })
              }
              min={10}
              max={60}
              step={5}
              suffix=" Seconds"
            />
            {/*
              WHAT THIS TABLE WILL ACTUALLY CHARGE (carried over from the old
              form, 2026-08-31). The rake is the club schedule (section 8:
              "rake: existing"), and the schedule is a table in a config
              file, so without this line a host would set up a game without
              ever seeing its price. Resolved through getRakeConfig, the same
              function and precedence the engine applies, so it cannot drift
              into advertising a rate we do not charge.
            */}
            {stakes &&
              (() => {
                const priced = getRakeConfig(stakes.bb, variant || 'nlh', stakes.sb, {
                  rakePercent: RAKE_INHERIT,
                  rakeCapBB: RAKE_INHERIT,
                });
                const capInBB = stakes.bb > 0 ? priced.rakeCap / stakes.bb : 0;
                return (
                  <div className="config-slider" data-testid="cash-create-price">
                    <div className="slider-header">
                      <span className="slider-label">
                        This Game Charges {priced.rakePercent}% Of Each Raked Pot, Up To{' '}
                        {formatCurrency(priced.rakeCap)} ({Number(capInBB.toFixed(1))} Big Blinds)
                      </span>
                    </div>
                    <div className="slider-header">
                      <span className="slider-label">
                        {priced.bbjEnabled ? (
                          <>
                            Bad Beat Jackpot Drop {formatCurrency(stakes.bb * priced.bbjFeeBB)} Per
                            Flopped Hand ({priced.bbjFeeBB} Big Blinds)
                          </>
                        ) : (
                          <>No Bad Beat Jackpot On This Game</>
                        )}
                      </span>
                    </div>
                    <div className="slider-header">
                      <span className="slider-label">
                        Published Schedule For {priced.tier} Stakes
                      </span>
                    </div>
                  </div>
                );
              })()}
            <p className="cash-create__note">
              Run It Multiple Times Is Opt In Per Hand. Rake Follows The Club Schedule. Straddles
              Are Off.
            </p>
          </div>
        )}
      </section>

      {/* ── 6. Confirm ──────────────────────────────────────────────────── */}
      <footer className="config-footer cash-create__footer">
        <button
          type="button"
          className="btn-save"
          onClick={() => void create('save')}
          disabled={!canConfirm}
        >
          {busy === 'save' ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="btn-start"
          onClick={() => void create('start')}
          disabled={!canConfirm}
        >
          {busy === 'start' ? 'Starting...' : 'Start'}
        </button>
      </footer>
      {!canBuildHere && deniedMessage && <p className="cash-create__note">{deniedMessage}</p>}
    </div>
  );
}

function stakesLabelChips(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
