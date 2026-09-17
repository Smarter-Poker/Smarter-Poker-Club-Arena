import { pendingBonus } from '../services/diamondBonusRecovery';
import { useBonusBudget } from '../hooks/useBonusBudget';
import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { GameConsole, GamePanel } from '../components/games/GameConsole';
import BonusSetup from '../components/games/BonusSetup';
import TodayLine from '../components/games/TodayLine';
import { useGameCooldown } from '../hooks/useGameCooldown';
import PlinkoBoard from '../components/plinko/PlinkoBoard';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondGamesService, { type GameState } from '../services/DiamondGamesService';
import {
  DiamondBonusService,
  BonusRefusal,
  parsePlinkoBonus,
  type PlinkoBonus,
} from '../services/DiamondBonusService';
import { bonusTotal, gameChips, validSpinAmount } from '../utils/bonusGameBudget';
import { randomClientSeed, hmacSha256Hex, sha256Hex } from '../utils/wheelFairness';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { multiplierLabel } from '../utils/diamondGamesFairness';
import { roundedMinePrize } from '../utils/diamondChoiceMath';
import styles from './diamondGames.module.css';

export default function DiamondPlinkoPage() {
  const { user } = useAuthUser();
  const { clubId } = useParams();
  return <DiamondPlinkoGame key={`${user?.id ?? ''}:${clubId ?? ''}`} />;
}
function DiamondPlinkoGame() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [uuid, setUuid] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [quotedAmount, setQuotedAmount] = useState<number | null>(null);
  const [budget, setBudget] = useBonusBudget(clubId, 'plinko');
  const [tableVersion, setTableVersion] = useState(2);
  const [ticket, setTicket] = useState<{ id: string; hash: string } | null>(null);
  const [seed, setSeed] = useState(randomClientSeed);
  const [result, setResult] = useState<PlinkoBonus | null>(null);
  const [landed, setLanded] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [waitSeconds, setWaitSeconds] = useGameCooldown();
  const live = useRef(true),
    busyRef = useRef(false),
    generation = useRef(0);
  const held = useRef<Parameters<typeof DiamondBonusService.start>[0] | null>(null);
  const [stageRef, width] = useMeasuredWidth<HTMLDivElement>(300);
  const total = bonusTotal(budget);
  const player = state?.player;
  const table = state?.tables.find((t) => t.version === tableVersion) ?? state?.tables[0];
  const paths = useMemo(() => result?.drops.map((ball) => ball.path_bits) ?? null, [result]);
  const painted =
    result && animating
      ? result.multipliers_cents
      : (table?.multipliers_cents ?? result?.multipliers_cents ?? []);
  const blocked =
    !validSpinAmount(budget.base) ||
    quotedAmount !== total ||
    !state?.available ||
    state.frozen ||
    !state.player?.is_member ||
    state.player.spendable < total ||
    !table ||
    !state.bets.some(
      (b) => b.bet_diamonds === total && b.cap_cents >= table.max_multiplier_cents
    ) ||
    state.player.rounds_today >= (state.config?.max_rounds_per_player_per_day ?? 0) ||
    waitSeconds > 0;

  const newTicket = useCallback(async () => {
    const next = await DiamondGamesService.commit('plinko');
    if (
      !next.ok ||
      !/^[a-f0-9]{64}$/.test(next.server_seed_hash) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(next.commit_id)
    )
      throw new Error(next.error ?? 'The Ticket Could Not Be Loaded');
    if (live.current) setTicket({ id: next.commit_id, hash: next.server_seed_hash });
  }, []);
  const load = useCallback(
    async (id: string, amount: number) => {
      const g = ++generation.current;
      setQuotedAmount(null);
      const next = await DiamondGamesService.getState(id, 'plinko', amount);
      if (live.current && g === generation.current) {
        setState(next);
        setQuotedAmount(amount);
        setWaitSeconds(next.player?.seconds_until_next ?? 0);
      }
    },
    [setWaitSeconds]
  );
  useEffect(() => {
    live.current = true;
    let cancelled = false;
    (async () => {
      if (!clubId) return;
      try {
        const id = await resolveClubUUID(clubId);
        if (cancelled) return;
        setUuid(id);
        const pending = pendingBonus(user?.id ?? '', id, 'plinko');
        if (pending) {
          held.current = pending;
          setBudget(pending.budget);
          setUncertain(true);
          setTicket(null);
          setError('Check Your Saved Bonus Before Starting Another.');
          return;
        }
        const saved = await DiamondBonusService.latest(id, 'plinko');
        if (cancelled) return;
        if (saved) {
          const previous = parsePlinkoBonus(saved);
          setResult(previous);
          setLanded(previous.drops.length);
        }
        await newTicket();
      } catch (e) {
        reportError(e, 'DiamondPlinkoPage.load');
        if (!cancelled) setError('Plinko Could Not Be Loaded. Try Refresh.');
      }
    })();
    return () => {
      cancelled = true;
      live.current = false;
      generation.current++;
    };
  }, [clubId, user?.id, newTicket, setBudget]);
  useEffect(() => {
    if (!uuid || !validSpinAmount(budget.base)) return;
    void load(uuid, total).catch((e) => {
      reportError(e, 'DiamondPlinkoPage.quote');
      if (live.current) setError('The Entry Could Not Be Checked. Try Refresh.');
    });
  }, [uuid, total, budget.base, load]);

  const accept = (next: PlinkoBonus, animate: boolean) => {
    setResult(next);
    setLanded(animate ? 0 : next.drops.length);
    setAnimating(animate);
    held.current = null;
    setUncertain(false);
    setTicket(null);
    setError(null);
    if (uuid) void load(uuid, total).catch((e) => reportError(e, 'DiamondPlinkoPage.after'));
  };
  const play = async () => {
    if (!uuid || !ticket || busyRef.current || blocked || animating || uncertain) return;
    busyRef.current = true;
    generation.current++;
    setQuotedAmount(null);
    setBusy(true);
    setError(null);
    setVerified(null);
    const request = {
      clubId: uuid,
      game: 'plinko' as const,
      budget: { ...budget },
      commitId: ticket.id,
      serverSeedHash: ticket.hash,
      seed,
      tableVersion: table!.version,
    };
    held.current = request;
    try {
      const next = parsePlinkoBonus(await DiamondBonusService.start(request, user?.id ?? ''));
      if (live.current) accept(next, true);
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.start');
      if (live.current) {
        setUncertain(!(e instanceof BonusRefusal));
        setError(
          e instanceof BonusRefusal ? e.message : 'Check Your Bonus Before Starting Another.'
        );
      }
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  const check = async () => {
    if (!uuid || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (held.current && uncertain) {
        const next = parsePlinkoBonus(
          await DiamondBonusService.start(held.current, user?.id ?? '')
        );
        if (!live.current) return;
        accept(next, false);
      }
      if (!live.current) return;
      await load(uuid, validSpinAmount(budget.base) ? total : 100);
      if (!live.current) return;
      if (!ticket || uncertain) await newTicket();
      if (live.current) setError(null);
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.check');
      if (live.current) {
        setError(
          e instanceof BonusRefusal ? e.message : 'Your Bonus Could Not Be Checked. Try Again.'
        );
        if (e instanceof BonusRefusal) {
          held.current = null;
          setUncertain(false);
        }
      }
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  const finish = () => {
    setAnimating(false);
    if (result) setLanded(result.drops.length);
    void newTicket().catch((e) => {
      reportError(e, 'DiamondPlinkoPage.ticket');
      if (live.current) setError('Refresh To Prepare Your Next Ticket.');
    });
  };
  const verify = async () => {
    if (!result || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      let matches = (await sha256Hex(result.server_seed)) === result.server_seed_hash;
      for (const ball of result.drops) {
        if (!live.current) return;
        const hash = await hmacSha256Hex(
          result.server_seed,
          `${result.client_seed}:${result.nonce}:drop:${ball.index}`
        );
        const bits =
          Number.parseInt(hash.slice(0, 2), 16) | (Number.parseInt(hash.slice(2, 4), 16) << 8);
        let slot = 0;
        for (let i = 0; i < 16; i++) slot += (bits >> i) & 1;
        const rounding = await hmacSha256Hex(
          result.server_seed,
          `${result.client_seed}:${result.nonce}:rounding:${ball.index}`
        );
        const cents = roundedMinePrize(
          BigInt(result.diamonds_per_drop * ball.multiplier_cents),
          BigInt(result.diamonds_per_chip),
          BigInt(`0x${rounding.slice(0, 12)}`)
        );
        if (
          bits !== ball.path_bits ||
          slot !== ball.slot ||
          Number(cents) !== Math.round(ball.payout_chips * 100)
        ) {
          matches = false;
          break;
        }
      }
      if (live.current) setVerified(matches);
    } catch (e) {
      reportError(e, 'DiamondPlinkoPage.verify');
      if (live.current) setVerified(false);
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  const shownWin = result
    ? result.drops
        .slice(0, landed)
        .reduce((sum, ball) => sum + Math.round(ball.payout_chips * 100), 0) / 100
    : 0;
  return (
    <div className={`${styles.page} ${styles.fullscreenPage}`}>
      <button className={styles.back} onClick={() => navigate(`/clubs/${clubId}/diamond-games`)}>
        ‹ Diamond Spins
      </button>
      <DiamondSpinsTabs clubId={clubId ?? ''} />
      <GameConsole
        setup={
          !animating && (
            <BonusSetup
              budget={budget}
              onChange={setBudget}
              diamonds={state?.player?.spendable ?? null}
              disabled={busy || uncertain}
              plinko
              clubId={clubId ?? ''}
            />
          )
        }
        title="Diamond Plinko"
        eyebrow="Diamond Spins"
        pill={uncertain ? 'Check Bonus' : animating ? 'Dropping' : result ? 'Completed' : 'Ready'}
        bays={[
          {
            label: 'Table',
            value: table?.name ?? 'Loading',
            disabled: busy || animating || uncertain,
            onPress: () => {
              const tables = state?.tables ?? [];
              if (tables.length)
                setTableVersion(
                  tables[
                    (tables.findIndex((t) => t.version === table?.version) + 1) % tables.length
                  ].version
                );
            },
          },
          {
            label: 'Per Drop',
            value: String(animating ? result?.diamonds_per_drop : budget.denomination),
          },
          {
            label: 'Drops',
            value:
              animating && result
                ? `${landed}/${result.drops.length}`
                : validSpinAmount(budget.base)
                  ? String(total / budget.denomination)
                  : '0',
          },
          { label: 'Chip Prize', value: gameChips(shownWin), ink: 'gold' },
        ]}
        secondary={{
          label: uncertain ? 'Check Bonus' : animating ? 'Show Results' : 'Refresh',
          onClick: () => (animating ? finish() : void check()),
          disabled: busy,
        }}
        primary={{
          label: waitSeconds > 0 ? `Ready In ${waitSeconds}s` : 'Drop Diamonds',
          onClick: () => void play(),
          disabled: busy || uncertain || animating || blocked || !ticket,
        }}
      >
        <TodayLine
          used={player?.rounds_today ?? 0}
          cap={state?.config?.max_rounds_per_player_per_day ?? 0}
          spentDiamonds={player?.diamonds_today ?? 0}
          noun="Rounds"
        />
        <div ref={stageRef}>
          <PlinkoBoard
            width={Math.max(240, Math.min(680, width))}
            multipliersCents={painted}
            path={null}
            dropKey={result ? Number.parseInt(result.id.slice(0, 8), 16) : 0}
            batchPathBits={animating ? paths : null}
            onProgress={setLanded}
            onLanded={finish}
            restingSlot={
              result?.table_version === table?.version
                ? (result?.drops[Math.max(0, landed - 1)]?.slot ?? null)
                : null
            }
          />
        </div>
        <p className="sc-copy" role="status">
          {error ??
            (animating
              ? 'Every Drop Follows Your Saved Result.'
              : result
                ? `${gameChips(result.payout_chips)} Chips Booked From ${result.drops.length} Drops.`
                : 'Choose Your Drop Value, Then Start Your Bonus.')}
        </p>
        {!animating && blocked && state && (
          <p className="sc-copy">
            {!state.available
              ? 'Plinko Is Not Open Here Yet.'
              : !state.player?.is_member
                ? 'Join The Club To Play.'
                : state.player.spendable < total
                  ? 'Buy More Diamonds Or Change Your Entry.'
                  : 'Refresh To Check This Entry And The Available Prize Cover.'}
          </p>
        )}
      </GameConsole>
      <GamePanel title="How To Play" pill="Rules" foot="foot">
        <p className="sc-copy">
          Your Entry Is Divided Into Drops At The Value You Choose. Each Ball Lands In A Prize Slot.
          All Diamonds In This Bonus Are Played Together, And Your Chips Are Booked Automatically.
        </p>
      </GamePanel>
      <GamePanel
        title="Bonus Proof"
        pill={verified === true ? 'Verified' : 'Sealed'}
        eyebrow="Sealed Before Play"
        foot="foot"
      >
        <p className={`sc-copy ${styles.proofHash}`}>
          {ticket?.hash ?? result?.server_seed_hash ?? 'Preparing Your Ticket'}
        </p>
        <label className={styles.seedField}>
          Your Seed
          <input
            className={styles.seedInput}
            value={seed}
            maxLength={64}
            disabled={busy || animating || uncertain}
            onChange={(e) => setSeed(e.target.value)}
          />
        </label>
        {result && !animating && (
          <p className={`sc-copy ${styles.proofHash}`}>
            Completed Bonus: {result.server_seed_hash}
          </p>
        )}
        {result && !animating && (
          <button className={styles.back} disabled={busy} onClick={() => void verify()}>
            Verify Every Drop
          </button>
        )}
        {verified !== null && (
          <p className="sc-copy">
            {verified
              ? 'Every Drop And Chip Prize Matches The Sealed Bonus.'
              : 'The Bonus Could Not Be Verified.'}
          </p>
        )}
      </GamePanel>
      {result && !animating && (
        <GamePanel title="Your Results" pill={`${result.drops.length} Drops`} foot="foot">
          {result.multipliers_cents.map((mult, slot) => {
            const balls = result.drops.filter((b) => b.slot === slot);
            return balls.length ? (
              <div className={styles.row} key={slot}>
                <span className="sc-label">
                  {balls.length} At {multiplierLabel(mult)}
                </span>
                <span>{gameChips(balls.reduce((sum, b) => sum + b.payout_chips, 0))} Chips</span>
              </div>
            ) : null;
          })}
        </GamePanel>
      )}
    </div>
  );
}
