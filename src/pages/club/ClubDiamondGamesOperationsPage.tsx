/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND PLINKO + DIAMOND CRASH - the operator's console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * One console, two games, a switch at the top. What a host owner needs to run
 * them and nothing else: open and close each game, the bet sizes, the exposure
 * allowance (the most the host accepts being ahead of what the game has minted
 * it), the cap fraction, the multiplier ceiling, the crash curve, the
 * per-player limits, and the readings that say whether the game is doing what
 * its odds promise: realised return against the 80 percent spec as a z-score
 * per window, the constrained rate, exposure headroom, open rounds still
 * holding a reservation, and the invariant (paid + reserved <= minted +
 * allowance) that the arithmetic makes impossible to break and
 * fn_diamond_game_metrics re-derives anyway.
 *
 * Every control posts a patch to fn_diamond_game_set_config, which decides who
 * may (fn_wheel_can_operate). The page shows a refusal, it never pre-empts one.
 *
 * Route: /clubs/:clubId/diamond-games-operations, finance access in the
 * operations registry. The players' pages are /clubs/:clubId/plinko and
 * /clubs/:clubId/crash. The wheel has its own console at /wheel-operations.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { ErrorState, LoadingState } from '../../components/common/EmptyState';
import DiamondGamesService, {
  type DiamondGame,
  type GameConfigPatch,
  type GameMetrics,
} from '../../services/DiamondGamesService';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { useIsMounted } from '../../hooks/useIsMounted';
import {
  CasinoBay,
  CasinoBays,
  CasinoButton,
  CasinoChips,
  CasinoFrame,
  CasinoNote,
} from '../../components/diamond-games/CasinoChassis';
import styles from './ClubWheelOperationsPage.module.css';

const chips = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? 'N/A' : `${(n * 100).toFixed(digits)}%`;

interface Draft {
  bet_options: string;
  min_bet_diamonds: string;
  max_bet_diamonds: string;
  exposure_allowance_chips: string;
  cap_fraction: string;
  max_multiplier: string;
  growth_k: string;
  max_rounds_per_player_per_day: string;
  min_seconds_between_rounds: string;
  purchased_only: boolean;
  allow_fixture_accounts: boolean;
}

function draftFrom(m: GameMetrics | null): Draft {
  const c = m?.config;
  return {
    bet_options: (c?.bet_options ?? [100, 200, 500, 1000]).join(', '),
    min_bet_diamonds: String(c?.min_bet_diamonds ?? 100),
    max_bet_diamonds: String(c?.max_bet_diamonds ?? 1000),
    exposure_allowance_chips: String(c?.exposure_allowance_chips ?? 1250),
    cap_fraction: String(c?.cap_fraction ?? 0.95),
    max_multiplier: String((c?.max_multiplier_cents ?? 100000) / 100),
    growth_k: String(c?.growth_k ?? 0.12),
    max_rounds_per_player_per_day: String(c?.max_rounds_per_player_per_day ?? 500),
    min_seconds_between_rounds: String(c?.min_seconds_between_rounds ?? 2),
    purchased_only: c?.purchased_only ?? true,
    allow_fixture_accounts: c?.allow_fixture_accounts ?? false,
  };
}

const GAME_WORD: Record<DiamondGame, string> = { plinko: 'Plinko', crash: 'Crash' };

export default function ClubDiamondGamesOperationsPage() {
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [game, setGame] = useState<DiamondGame>('plinko');
  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GameMetrics | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (which: DiamondGame) => {
      if (!routeClubId) return;
      setLoading(true);
      setError(null);
      try {
        const uuid = clubUuid ?? (await resolveClubUUID(routeClubId));
        if (!isMountedRef.current) return;
        setClubUuid(uuid);
        const m = await DiamondGamesService.metrics(uuid, which);
        if (!isMountedRef.current) return;
        if (!m.ok) {
          setError(m.error || 'The Readings Could Not Be Loaded');
          return;
        }
        setMetrics(m);
        setDraft(draftFrom(m));
      } catch (err) {
        reportError(err, 'ClubDiamondGamesOperationsPage.load');
        if (isMountedRef.current) setError('The Readings Could Not Be Loaded');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    },
    [routeClubId, clubUuid, isMountedRef]
  );

  useEffect(() => {
    void load(game);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, routeClubId]);

  const apply = useCallback(
    async (patch: GameConfigPatch, done: string) => {
      if (!clubUuid) return;
      setSaving(true);
      try {
        const res = await DiamondGamesService.setConfig(clubUuid, game, patch);
        if (!isMountedRef.current) return;
        if (!res.ok) {
          toast.error(res.error || 'That Change Was Refused');
          return;
        }
        toast.success(done);
        await load(game);
      } catch (err) {
        reportError(err, 'ClubDiamondGamesOperationsPage.apply');
        if (isMountedRef.current) toast.error('That Change Did Not Go Through');
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    },
    [clubUuid, game, isMountedRef, toast, load]
  );

  const saveNumbers = () => {
    const bets = draft.bet_options
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (!bets.length || bets.some((b) => !Number.isInteger(b) || b <= 0))
      return toast.error('Bet Sizes Must Be Whole Numbers Of Diamonds');
    const minBet = Number(draft.min_bet_diamonds);
    const maxBet = Number(draft.max_bet_diamonds);
    const allowance = Number(draft.exposure_allowance_chips);
    const capFraction = Number(draft.cap_fraction);
    const maxMult = Number(draft.max_multiplier);
    const growthK = Number(draft.growth_k);
    const rounds = Number(draft.max_rounds_per_player_per_day);
    const gap = Number(draft.min_seconds_between_rounds);
    if (!Number.isInteger(minBet) || minBet <= 0 || !Number.isInteger(maxBet) || maxBet < minBet)
      return toast.error('The Bet Limits Must Be Whole Numbers Of Diamonds, Max At Least Min');
    if (!Number.isFinite(allowance) || allowance < 0)
      return toast.error('The Exposure Allowance Must Be Zero Or More');
    if (!Number.isFinite(capFraction) || capFraction <= 0 || capFraction >= 1)
      return toast.error('The Cap Fraction Must Be Between 0 And 1');
    if (!Number.isFinite(maxMult) || maxMult < 1.01)
      return toast.error('The Multiplier Ceiling Must Be At Least 1.01');
    if (!Number.isFinite(growthK) || growthK <= 0) return toast.error('The Curve Must Climb');
    if (!Number.isInteger(rounds) || rounds <= 0)
      return toast.error('The Daily Limit Must Be A Whole Number Of Rounds');
    if (!Number.isInteger(gap) || gap < 0)
      return toast.error('The Pause Between Rounds Must Be Zero Or More Seconds');
    void apply(
      {
        bet_options: bets,
        min_bet_diamonds: minBet,
        max_bet_diamonds: maxBet,
        exposure_allowance_chips: Math.round(allowance * 100) / 100,
        cap_fraction: Math.round(capFraction * 1000) / 1000,
        max_multiplier_cents: Math.round(maxMult * 100),
        growth_k: Math.round(growthK * 10000) / 10000,
        max_rounds_per_player_per_day: rounds,
        min_seconds_between_rounds: gap,
        purchased_only: draft.purchased_only,
        allow_fixture_accounts: draft.allow_fixture_accounts,
      },
      `${GAME_WORD[game]} Settings Saved`
    );
  };

  if (loading && !metrics) return <LoadingState message="Reading The Games" />;
  if (error) {
    return (
      <div className={styles.page}>
        <ErrorState message={error} onRetry={() => void load(game)} />
      </div>
    );
  }

  const cfg = metrics?.config;
  const pool = metrics?.pool;
  const enabled = Boolean(cfg?.enabled);
  const word = GAME_WORD[game];
  const hostWord = metrics?.host_kind === 'union' ? 'Union Bank' : 'Club Treasury';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate(`/clubs/${routeClubId}/operations`)}
        >
          ‹ Operations
        </button>
        <h1>Diamond Games</h1>
        <span className={`${styles.pill} ${enabled ? styles.pillOn : styles.pillOff}`}>
          {enabled ? 'Open' : 'Closed'}
        </span>
      </header>

      <CasinoChips
        label="Game"
        value={game}
        onChange={(v) => setGame(v as DiamondGame)}
        items={[
          { value: 'plinko', label: 'Plinko', sub: 'Three Boards' },
          { value: 'crash', label: 'Crash', sub: 'The Curve' },
        ]}
      />

      <CasinoFrame eyebrow={`Diamond ${word}`} title="The Readings" tight>
        <CasinoBays columns={3}>
          <CasinoBay label={hostWord} value={chips(metrics?.bank_chips)} sub="Chips To Pay" small />
          <CasinoBay
            label="Exposure"
            value={chips(metrics?.exposure_chips)}
            sub={`Room ${chips(metrics?.exposure_headroom_chips)}`}
            tone={(metrics?.exposure_chips ?? 0) > 0 ? 'gold' : 'chrome'}
            small
          />
          <CasinoBay
            label="Return"
            value={pct(metrics?.realized_rtp_lifetime)}
            sub={`${(pool?.rounds ?? 0).toLocaleString()} Rounds`}
            small
          />
          <CasinoBay
            label="House Take"
            value={chips(metrics?.house_take_lifetime_chips)}
            sub="In Chips"
            tone="gold"
            small
          />
          <CasinoBay
            label="Capped"
            value={pct(metrics?.constrained_rate)}
            sub={game === 'crash' ? `${metrics?.open_rounds ?? 0} Open` : 'Of Rounds'}
            small
          />
          <CasinoBay
            label="Invariant"
            value={metrics?.invariant_ok === false ? 'Broken' : 'Holds'}
            sub="Paid + Held"
            tone={metrics?.invariant_ok === false ? 'red' : 'green'}
            small
          />
        </CasinoBays>
        <CasinoNote>
          Paid Plus Reserved Never Exceeds Minted Plus The Allowance; The Per-Round Cap Makes That
          Arithmetic, And The Metrics Re-Derive It. Capped Rounds Are Ones The Pool Could Not
          Promise The Full Ceiling On.
        </CasinoNote>
      </CasinoFrame>

      <CasinoFrame eyebrow="Against The 80% Spec" title="Realised Return" tight>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Window</th>
                <th className={styles.num}>Rounds</th>
                <th className={styles.num}>Intake</th>
                <th className={styles.num}>Paid</th>
                <th className={styles.num}>Return</th>
                <th className={styles.num}>Z</th>
                <th className={styles.num}>Capped</th>
                {game === 'crash' ? <th className={styles.num}>Instant</th> : null}
              </tr>
            </thead>
            <tbody>
              {(metrics?.windows ?? []).map((w) => (
                <tr key={w.window} className={w.drift ? styles.rowBad : undefined}>
                  <td>{w.window}</td>
                  <td className={styles.num}>{w.rounds.toLocaleString()}</td>
                  <td className={styles.num}>{chips(w.intake_chips)}</td>
                  <td className={styles.num}>{chips(w.paid_chips)}</td>
                  <td className={styles.num}>{pct(w.realized_rtp)}</td>
                  <td className={styles.num}>{w.z === null ? 'N/A' : w.z.toFixed(2)}</td>
                  <td className={styles.num}>{w.constrained.toLocaleString()}</td>
                  {game === 'crash' ? (
                    <td className={styles.num}>{(w.instant_crashes ?? 0).toLocaleString()}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CasinoNote>
          Z Is The Realised Return Against 80% In Standard Errors. Under 2,000 Rounds It Is Noise;
          Past 2,000, |Z| Of 4 Or More Flags Drift And Colours The Row.
          {game === 'crash'
            ? ' A Crashed Round Is Scored At Its Own Crash Point, The Most It Could Have Asked For, So Z Runs Conservative.'
            : ''}
        </CasinoNote>
        {game === 'plinko' && metrics?.tables?.length ? (
          <CasinoBays columns={3} className={styles.bayRow}>
            {metrics.tables.map((t) => (
              <CasinoBay
                key={t.version}
                label={t.name}
                value={multiplierLabel(t.max_multiplier_cents)}
                sub={`${pct(t.spec_rtp, 1)} / Pays ${pct(t.hit_rate, 0)}`}
                tone={t.activated_at ? 'gold' : 'chrome'}
                locked={!t.activated_at}
                small
              />
            ))}
          </CasinoBays>
        ) : null}
      </CasinoFrame>

      <CasinoFrame eyebrow={`${word} Is ${enabled ? 'Open' : 'Closed'}`} title="Controls" tight>
        <CasinoButton
          tone={enabled ? 'danger' : 'gold'}
          wide
          disabled={saving}
          onClick={() =>
            void apply({ enabled: !enabled }, enabled ? `${word} Is Closed` : `${word} Is Open`)
          }
          sub={
            enabled
              ? 'Closing It Refuses The Next Round At Once'
              : 'Nobody Can Play Until You Open It'
          }
        >
          {enabled ? `Close ${word}` : `Open ${word}`}
        </CasinoButton>

        <div className={styles.fields}>
          <label className={styles.field}>
            <span>Bet Sizes (Diamonds, Comma Separated)</span>
            <input
              value={draft.bet_options}
              onChange={(e) => setDraft({ ...draft, bet_options: e.target.value })}
            />
            <small>Whole Chips Only: Multiples Of 100 Diamonds.</small>
          </label>
          <label className={styles.field}>
            <span>Exposure Allowance (Chips)</span>
            <input
              inputMode="decimal"
              value={draft.exposure_allowance_chips}
              onChange={(e) => setDraft({ ...draft, exposure_allowance_chips: e.target.value })}
            />
            <small>The Most {word} May Pay Beyond What It Has Minted You.</small>
          </label>
          <label className={styles.field}>
            <span>Minimum Bet (Diamonds)</span>
            <input
              inputMode="numeric"
              value={draft.min_bet_diamonds}
              onChange={(e) => setDraft({ ...draft, min_bet_diamonds: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>Maximum Bet (Diamonds)</span>
            <input
              inputMode="numeric"
              value={draft.max_bet_diamonds}
              onChange={(e) => setDraft({ ...draft, max_bet_diamonds: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>Cap Fraction</span>
            <input
              inputMode="decimal"
              value={draft.cap_fraction}
              onChange={(e) => setDraft({ ...draft, cap_fraction: e.target.value })}
            />
            <small>
              The Share Of The Pool Headroom One Round May Be Promised. 0.95 Keeps The Pool Alive
              After A Full Hit.
            </small>
          </label>
          <label className={styles.field}>
            <span>Multiplier Ceiling</span>
            <input
              inputMode="decimal"
              value={draft.max_multiplier}
              onChange={(e) => setDraft({ ...draft, max_multiplier: e.target.value })}
            />
            <small>
              {game === 'crash'
                ? 'Where A Round Auto Cashes If It Never Crashed.'
                : 'Never Above The Board Itself.'}
            </small>
          </label>
          {game === 'crash' ? (
            <label className={styles.field}>
              <span>Curve (K Per Second)</span>
              <input
                inputMode="decimal"
                value={draft.growth_k}
                onChange={(e) => setDraft({ ...draft, growth_k: e.target.value })}
              />
              <small>
                Multiplier = Exp(K Times Seconds). 0.12 Reaches 2x In 5.8s And 1000x In 57.6s.
              </small>
            </label>
          ) : null}
          <label className={styles.field}>
            <span>Rounds Per Player Per Day</span>
            <input
              inputMode="numeric"
              value={draft.max_rounds_per_player_per_day}
              onChange={(e) =>
                setDraft({ ...draft, max_rounds_per_player_per_day: e.target.value })
              }
            />
          </label>
          <label className={styles.field}>
            <span>Seconds Between Rounds</span>
            <input
              inputMode="numeric"
              value={draft.min_seconds_between_rounds}
              onChange={(e) => setDraft({ ...draft, min_seconds_between_rounds: e.target.value })}
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.purchased_only}
              onChange={(e) => setDraft({ ...draft, purchased_only: e.target.checked })}
            />
            <span>
              Purchased Diamonds Only
              <small>Promotional And Earned Diamonds Cannot Be Played Into Chips.</small>
            </span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.allow_fixture_accounts}
              onChange={(e) => setDraft({ ...draft, allow_fixture_accounts: e.target.checked })}
            />
            <span>
              Allow Certification Accounts
              <small>For Burn-In Only. Their Rounds Are Kept Out Of The Fairness Statistics.</small>
            </span>
          </label>
        </div>
        <CasinoButton onClick={saveNumbers} disabled={saving}>
          {saving ? 'Saving' : 'Save Settings'}
        </CasinoButton>
      </CasinoFrame>

      <CasinoFrame eyebrow="Lifetime" title="The Pool" tight>
        <dl className={styles.dl}>
          <dt>Rounds</dt>
          <dd>{(pool?.rounds ?? 0).toLocaleString()}</dd>
          <dt>Diamonds Taken In</dt>
          <dd>{(pool?.intake_diamonds ?? 0).toLocaleString()}</dd>
          <dt>Chips Minted To The {hostWord}</dt>
          <dd>{chips(pool?.chips_minted)}</dd>
          <dt>Chips Paid To Players</dt>
          <dd>{chips(pool?.chips_paid)}</dd>
          <dt>Chips Held For Open Rounds</dt>
          <dd>{chips(pool?.reserved_chips)}</dd>
          <dt>Capped Rounds</dt>
          <dd>{(pool?.constrained_rounds ?? 0).toLocaleString()}</dd>
        </dl>
        <CasinoButton
          tone="secondary"
          className={styles.linkButton}
          onClick={() => navigate(`/clubs/${routeClubId}/${game}`)}
        >
          Open The Players {word}
        </CasinoButton>
      </CasinoFrame>
    </div>
  );
}
