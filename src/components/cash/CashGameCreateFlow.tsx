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
 *   3. Table Mode R9 (Dan 2026-09-04): Automated Must Move (the cluster of
 *                 OPORD 1.4) or Manual Individual Table (one table the host
 *                 runs by hand)
 *   4. Stakes     from the existing preset ladder
 *   5. Handedness classic NLH 9 or 6; action / madness NLH 6 (host may
 *                 change); PLO family 6, locked; short deck / pineapple 6,
 *                 host 2-8
 *   6. Rules      what the HOST edits: buy-in band, stay clock and rejoin
 *                 window (raise only), the table options. What the TEMPLATE
 *                 promised - ante, VPIP floor and window, bomb pots - is
 *                 printed read-only as "Set By The <Template> Template" and
 *                 is never sent: since 2026-09-09 fn_cash_game_create resolves
 *                 those four from fn_cash_template_defaults and reads nothing
 *                 the caller offers for them (docs/changelog/2026-09-09-a-
 *                 classic-game-has-no-antes-and-no-bombs.md). A control the
 *                 server ignores is a lie to the host, so there is none.
 *   7. Confirm    one RPC, fn_cash_game_create, which persists the game and
 *                 its resolved ruleset snapshot and opens Main 1
 *
 * Nothing here writes `tables`. The database resolves the snapshot and
 * refuses anything the rules refuse; this component renders the server's
 * defaults and reports the server's answer. The one thing it does read is the
 * club's existing games, so a stakes rung the club already holds (Action and
 * Madness are one game per blind band; a must-move game is one per exact
 * stakes) is greyed with the reason before the database has to refuse it.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
import CashGameCard, { rulesLineFor } from './CashGameCard';
import {
  CASH_TEMPLATES,
  CASH_VARIANTS,
  CASH_VARIANT_LONG,
  cashGameCreateRefusalText,
  isDealtVariant,
  overridesFromSnapshot,
  stakesRungTaken,
  templateLabel,
  templatePromiseLines,
  type CashGameOverrides,
  type CashRulesetSnapshot,
  type CashTemplate,
  type ExistingCashGame,
} from '../../config/cashGames';
import { Slider, Toggle } from '../table-config/controls';
import './CashGameCreateFlow.css';

/* ═══ THE WAKE HAS AN ANSWER, AND START READS IT (2026-09-20) ═══════════════
   getTableState never throws: it answers null for every non-OK response (403,
   404, 503) and for a network failure. Start used to await it inside a
   try/catch that could therefore never fire, toast "Game Created And Started"
   and send the host to a felt whose engine had not woken - which is where
   "This Table Is No Longer Running" and the endless "Reconnecting To The
   Table" on a table thirty seconds old came from.

   null now means "not awake yet". The wake is retried a bounded number of
   times, awaited one after another INSIDE the one request the host started by
   tapping Start (the double-tap guard and the busy label cover all of it). It
   is not a background loop: it ends after WAKE_RETRY_DELAYS_MS.length + 1
   reads, about four seconds, whatever the engine says. */
export const WAKE_RETRY_DELAYS_MS = [700, 1300, 2000] as const;
export const GAME_CREATED_STILL_STARTING = 'Game Created. The Table Is Still Starting';

async function wakeTableEngine(tableId: string): Promise<boolean> {
  for (let attempt = 0; attempt <= WAKE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = WAKE_RETRY_DELAYS_MS[attempt - 1];
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
    try {
      if (await getTableState(tableId)) return true;
    } catch (err) {
      reportError(err, 'CashGameCreateFlow.engine_wake');
    }
  }
  return false;
}

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
  const [tableMode, setTableMode] = useState<'must_move' | 'manual' | null>(null);
  const [snapshot, setSnapshot] = useState<CashRulesetSnapshot | null>(null);
  const [overrides, setOverrides] = useState<CashGameOverrides | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'save' | 'start' | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  /* The club's live games, so a rung it already holds is greyed rather than
     refused. Advisory only: the database is the authority, and a read the
     host's role cannot see simply leaves the chip enabled. */
  const [existingGames, setExistingGames] = useState<ExistingCashGame[]>([]);
  const [existingGamesEpoch, setExistingGamesEpoch] = useState(0);
  /* Two taps inside one render tick both see busy === null; the ref is the
     guard that makes a network failure mid-create a single create, not two. */
  const inFlight = useRef(false);
  /* The id the struck stakes chips point at, so the reason they are struck is
     associated with them rather than hidden in a tooltip. */
  const takenReasonsId = useId();

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

  useEffect(() => {
    if (!clubId) return;
    let live = true;
    void (async () => {
      try {
        const resolvedClubId = await resolveClubUUID(clubId);
        const { data, error } = await supabase
          .from('cash_games')
          .select('name, template_name, variant, sb, bb, must_move')
          .eq('club_id', resolvedClubId)
          .eq('enabled', true);
        if (!live) return;
        if (error) {
          reportError(error, 'CashGameCreateFlow.existingGames');
          return;
        }
        setExistingGames(
          ((data ?? []) as Array<Record<string, unknown>>).map((g) => ({
            name: String(g.name ?? ''),
            template_name: String(g.template_name ?? ''),
            variant: String(g.variant ?? ''),
            sb: Number(g.sb),
            bb: Number(g.bb),
            must_move: g.must_move === true,
          }))
        );
      } catch (err) {
        if (live) reportError(err, 'CashGameCreateFlow.existingGames');
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId, existingGamesEpoch]);

  /* Why each rung of the ladder is closed to this template, variant and mode,
     or null when it is open. */
  const rungTaken = useCallback(
    (sb: number, bb: number): string | null =>
      template && variant && tableMode
        ? stakesRungTaken(existingGames, template, variant, sb, bb, tableMode === 'must_move')
        : null,
    [existingGames, template, variant, tableMode]
  );

  /* A rung that closes under the chosen row (the template, variant or mode
     changed, or the club opened that game meanwhile) un-picks it rather than
     leaving a choice the server will refuse. */
  useEffect(() => {
    if (blindsIndex === null) return;
    const p = presets[blindsIndex];
    if (p && rungTaken(p.sb, p.bb)) setBlindsIndex(null);
  }, [blindsIndex, presets, rungTaken]);

  /* Every reason a rung on THIS ladder is closed, each said once. Several
     rungs of one band share a reason, so the list is short: at most one per
     band for Action and Madness, one per exact stakes for a must-move game. */
  const takenReasons = useMemo(() => {
    // No stepModeDone guard: rungTaken already answers null until the
    // template, variant and mode are all chosen, so this is [] until then -
    // and reading stepModeDone here would be reading it before it is declared.
    const seen = new Set<string>();
    for (const p of presets) {
      const why = rungTaken(p.sb, p.bb);
      if (why) seen.add(why);
    }
    return [...seen];
  }, [presets, rungTaken]);

  const usualStakesIndex = useMemo(() => {
    const start = Math.min(DEFAULT_BLINDS_INDEX, presets.length - 1);
    for (let d = 0; d < presets.length; d++) {
      for (const i of [start + d, start - d]) {
        const p = presets[i];
        if (p && !rungTaken(p.sb, p.bb)) return i;
      }
    }
    return null;
  }, [presets, rungTaken]);

  const stakes = blindsIndex !== null ? presets[blindsIndex] : null;
  const stepTemplateDone = template !== null;
  const stepVariantDone = stepTemplateDone && variant !== null;
  const stepModeDone = stepVariantDone && tableMode !== null;
  const stepStakesDone = stepModeDone && stakes !== null;
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
      if (inFlight.current) return;
      inFlight.current = true;
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
          p_must_move: tableMode === 'must_move',
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
          // that provisions the table's engine before the felt loads. The
          // answer is READ now (see wakeTableEngine): only an engine that
          // answered is called started.
          const awake = await wakeTableEngine(res.table_id);
          if (awake) {
            toast.success('Game Created And Started');
            navigate(`/table/${res.table_id}`);
          } else {
            // The game row exists; the engine has not answered for it yet.
            // Say exactly that and leave by the Save door: the club page,
            // where the first viewer of the table wakes it on demand.
            toast.info(GAME_CREATED_STILL_STARTING);
            if (onSaved) onSaved();
            else navigate(`/clubs/${clubId}`);
          }
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
        // The club holds a rung this screen did not know about: re-read the
        // ladder so the chip greys out instead of refusing a second time.
        if (/GAME_EXISTS|ONE_GAME_PER_BLIND_CATEGORY/.test(String(serverMessage ?? ''))) {
          setExistingGamesEpoch((n) => n + 1);
        }
      } finally {
        inFlight.current = false;
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
      tableMode,
      navigate,
      toast,
      onSaved,
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

      {/* ── 3. Table Mode (R9) ─────────────────────────────────────────── */}
      <section
        className="cash-create__step"
        data-step="mode"
        data-done={stepModeDone}
        aria-disabled={!stepVariantDone}
      >
        <h2 className="cash-create__title">3. Table Mode</h2>
        <div className="cash-create__cards cash-create__cards--two">
          <button
            type="button"
            className={`cash-create__card${tableMode === 'must_move' ? ' is-selected' : ''}`}
            disabled={!stepVariantDone}
            onClick={() => setTableMode('must_move')}
            aria-pressed={tableMode === 'must_move'}
          >
            <span className="cash-create__card-title">Automated Must Move</span>
            <span className="cash-create__card-blurb">
              One Game, Many Tables. Main 1 Is Always On; Feeders Open And Close Themselves. One Per
              Stakes Per Club; Action And Madness Run One Per Blind Band.
            </span>
          </button>
          <button
            type="button"
            className={`cash-create__card${tableMode === 'manual' ? ' is-selected' : ''}`}
            disabled={!stepVariantDone}
            onClick={() => setTableMode('manual')}
            aria-pressed={tableMode === 'manual'}
          >
            <span className="cash-create__card-title">Manual Individual Table</span>
            <span className="cash-create__card-blurb">
              One Table You Run By Hand. It Closes When It Empties. Create As Many As You Like.
            </span>
          </button>
        </div>
      </section>

      {/* ── 4. Stakes ───────────────────────────────────────────────────── */}
      <section
        className="cash-create__step"
        data-step="stakes"
        data-done={stepStakesDone}
        aria-disabled={!stepModeDone}
      >
        <h2 className="cash-create__title">4. Stakes</h2>
        <div className="cash-create__chips">
          {presets.map((p, i) => {
            const taken = stepModeDone ? rungTaken(p.sb, p.bb) : null;
            return (
              <button
                key={p.label}
                type="button"
                className={`config-preset-chip cash-create__chip${blindsIndex === i ? ' is-selected' : ''}${taken ? ' is-taken' : ''}`}
                disabled={!stepModeDone || taken !== null}
                onClick={() => setBlindsIndex(i)}
                aria-pressed={blindsIndex === i}
                aria-describedby={taken ? takenReasonsId : undefined}
                data-taken={taken ? 'true' : undefined}
              >
                {stakesLabel(p.sb, p.bb, variant)}
              </button>
            );
          })}
        </div>
        {stepModeDone && template !== 'classic' && (
          <p className="cash-create__note">
            {templateLabel(template)} Runs One Game Per Blind Band Per Variant. A Greyed Rung Is One
            This Club Already Holds.
          </p>
        )}
        {/* WHY A RUNG IS GREY, WHERE A HOST CAN ACTUALLY READ IT (2026-09-09).
            This was a `title` on the disabled chip. A title is the passive
            help this page threw out in 2026-08-31
            (tests/unit/createTableHelpAndSwitches.test.tsx): it does not exist
            on touch, and a `disabled` button is not focusable, so the reason
            reached nobody but a desktop mouse. The page already has the right
            pattern for a control a rule has locked - the Free Buy lock states
            its rule as visible `role="status"` copy beside the locked control
            - so the reasons are printed, deduplicated, and the struck chips
            point at them with aria-describedby. */}
        {takenReasons.length > 0 && (
          <div className="cash-create__taken" id={takenReasonsId} role="status">
            {takenReasons.map((why) => (
              <p key={why} className="cash-create__note">
                {why}.
              </p>
            ))}
          </div>
        )}
        {stepModeDone && blindsIndex === null && usualStakesIndex !== null && (
          <button
            type="button"
            className="cash-create__link"
            onClick={() => setBlindsIndex(usualStakesIndex)}
          >
            Use The Usual Stakes
          </button>
        )}
      </section>

      {/* The card the lobby will paint, from the choices made so far. The
          same component the board uses at Gate 4 - a host sees the real thing
          before they commit, not a description of it. */}
      {template && variant && stakes && snapshot && overrides && (
        <section className="cash-create__step cash-create__preview" data-step="preview">
          <h2 className="cash-create__title">Preview</h2>
          <div className="cash-create__preview-card">
            <CashGameCard
              template={template}
              stakesLabel={stakesLabel(stakes.sb, stakes.bb, variant)}
              variantLabel={CASH_VARIANT_LONG[variant] ?? variant.toUpperCase()}
              status="waiting"
              mustMove={tableMode === 'must_move'}
              players={0}
              tables={1}
              rulesLine={rulesLineFor({
                /* Ante, VPIP floor and bombs are the snapshot's: the template
                   promised them and the host cannot change them. */
                ...snapshot,
                seats: handedness ?? snapshot.seats,
                min_buyin_bb: overrides.min_buyin_bb,
                max_buyin_bb: overrides.max_buyin_bb,
              })}
              joinDisabled
            />
          </div>
        </section>
      )}

      {/* ── 5. Handedness ───────────────────────────────────────────────── */}
      <section
        className="cash-create__step"
        data-step="handedness"
        data-done={stepHandednessDone}
        aria-disabled={!stepStakesDone}
      >
        <h2 className="cash-create__title">5. Table Size</h2>
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

      {/* ── 6. Overrides (every field of section 8) ─────────────────────── */}
      <section
        className="cash-create__step"
        data-step="overrides"
        data-done={stepHandednessDone}
        aria-disabled={!stepHandednessDone}
      >
        <h2 className="cash-create__title">6. Rules</h2>
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
              tooltip="The Smallest Stack A Player May Sit Down With, In Big Blinds. It Cannot Be Set Above The Maximum Buy In."
            />
            <Slider
              label="Maximum Buy In"
              value={overrides.max_buyin_bb}
              onChange={(v) => setOverride('max_buyin_bb', Math.max(v, overrides.min_buyin_bb))}
              min={40}
              max={1000}
              step={10}
              format={(v) => `${v} BB (${stakesLabelChips(stakes.bb * v)})`}
              tooltip="The Largest Stack A Player May Buy In For, In Big Blinds. It Cannot Be Set Below The Minimum Buy In."
            />

            {/* ═══ THE TEMPLATE'S PROMISE IS PRINTED, NOT OFFERED ═════════════
                2026-09-09 (docs/changelog/2026-09-09-a-classic-game-has-no-
                antes-and-no-bombs.md): the ante, the VPIP floor and window and
                the whole bombs object come from fn_cash_template_defaults and
                fn_cash_game_create reads NOTHING the caller sends for them. An
                ante radio and a bomb-pot switch stood here until this date -
                a host would set "One Big Blind" on a Classic game, the server
                would create a game with no ante, and nobody would tell them.
                That is worse than no control. So the four fields are read-only
                copy in Title Case, each saying which template set it, and
                p_overrides never carries them (pinned by
                tests/cash-games-are-created-from-a-template.law.test.tsx). */}
            <div
              className="cash-create__promise"
              role="group"
              aria-label={`Set By The ${templateLabel(template)} Template`}
              data-testid="cash-create-promise"
            >
              <span className="cash-create__promise-title">
                Set By The {templateLabel(template)} Template
              </span>
              {templatePromiseLines(snapshot).map((line) => (
                <div
                  key={line.key}
                  className="cash-create__rule-readout"
                  data-rule={line.key}
                  aria-readonly="true"
                >
                  <span className="cash-create__rule-readout__label">{line.label}</span>
                  <span className="cash-create__rule-readout__value">{line.value}</span>
                  <span className="cash-create__rule-readout__note">{line.note}</span>
                </div>
              ))}
            </div>

            {/* ROE 7: the two clocks may only be raised. The floor IS the slider minimum. */}
            <Slider
              label="Stay Clock"
              value={overrides.stay_clock_min}
              onChange={(v) => setOverride('stay_clock_min', Math.max(snapshot.stay_clock_min, v))}
              min={snapshot.stay_clock_min}
              max={60}
              step={5}
              suffix=" Minutes"
              tooltip={`A Player Ahead Of The Money They Put In Stays Seated This Long Before They Can Leave. ${snapshot.stay_clock_min} Minutes Is The Minimum.`}
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
              tooltip={`A Player Who Returns To This Game Inside The Window Buys In For At Least The Stack They Left With. ${snapshot.rejoin_window_min} Minutes Is The Minimum.`}
            />

            <Toggle
              label="Private Game"
              value={overrides.options.is_private}
              onChange={(v) => setOverride('options', { ...overrides.options, is_private: v })}
              tooltip="Visible Only Inside Your Club, Never In The Union Lobby"
            />
            <Toggle
              label="VIP Only"
              value={overrides.options.is_vip_only}
              onChange={(v) => setOverride('options', { ...overrides.options, is_vip_only: v })}
              tooltip="Only VIP Members And Club Staff May Take A Seat"
            />
            <Toggle
              label="Anonymous Seats"
              value={overrides.options.is_anonymous}
              onChange={(v) => setOverride('options', { ...overrides.options, is_anonymous: v })}
              tooltip="Every Seat Shows As Player And Its Seat Number. Names, Avatars, Frames And Auras Are Hidden From Everyone, Including You."
            />
            <Toggle
              label="Ban Chat"
              value={overrides.options.ban_chat}
              onChange={(v) => setOverride('options', { ...overrides.options, ban_chat: v })}
              tooltip="Players Cannot Send Chat Messages At This Table"
            />
            <Toggle
              label="Insurance"
              value={overrides.options.insurance_enabled}
              onChange={(v) =>
                setOverride('options', { ...overrides.options, insurance_enabled: v })
              }
              tooltip="When Players Are All In, The Player Who Is Ahead May Buy Insurance Against Losing The Pot"
            />
            {variant === 'nlh' && (
              <Toggle
                label="Seven Deuce Bonus"
                value={overrides.options.seven_deuce_enabled}
                onChange={(v) =>
                  setOverride('options', { ...overrides.options, seven_deuce_enabled: v })
                }
                tooltip="Win A Pot That Saw A Flop While Holding A Seven And A Deuce, And Every Other Player Dealt In Pays You Two Big Blinds"
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
              tooltip="How Many Seconds A Player Has To Act On Each Decision"
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

      {/* ── 7. Confirm ──────────────────────────────────────────────────── */}
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
