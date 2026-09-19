import { useEffect, useRef, useState } from 'react';
import { GameConsole } from '../components/games/GameConsole';
import ChoiceScene from '../components/games/ChoiceScene';
import PlinkoBoard from '../components/plinko/PlinkoBoard';
import CrashCurve from '../components/crash/CrashCurve';
import DoubleDownOffer from '../components/games/DoubleDownOffer';
import { WheelWinReveal } from '../components/wheel/WheelWinReveal';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import { useLiveBonusGuard } from '../hooks/useLiveBonusGuard';
import { minePrize, ROAD_LADDERS, roadSurvives } from '../utils/diamondChoiceMath';
import {
  crashMultiplierCents,
  crashPointCentsFromRoll,
  plinkoBitsFromPathBits,
} from '../utils/diamondGamesFairness';
import { plinkoAllocations } from '../utils/bonusGameBudget';
import styles from './diamondGames.module.css';
import setup from '../components/games/BonusSetup.module.css';

const games = {
  plinko: 'Plinko',
  crash: 'Crash',
  crossing: 'Donkey Cross',
  mines: 'Diamond Mines',
};
type Game = keyof typeof games;
const tables = {
  steady: [2000, 1000, 500, 250, 160, 130, 100, 65, 0, 65, 100, 130, 160, 250, 500, 1000, 2000],
  bold: [13000, 4000, 995, 410, 200, 105, 100, 50, 0, 50, 100, 105, 200, 410, 995, 4000, 13000],
  extreme: [
    100000, 10050, 2025, 525, 250, 130, 100, 0, 0, 0, 100, 130, 250, 525, 2025, 10050, 100000,
  ],
};
function roll48() {
  const a = crypto.getRandomValues(new Uint32Array(2));
  return BigInt(a[0]) * 65536n + BigInt(a[1] & 65535);
}
const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fictional rounds only. No user, club, wallet, RPC, award or share is created. */
export default function DiamondTestPage() {
  const params = new URLSearchParams(window.location.search);
  const candidate = params.get('game') ?? 'plinko';
  const game: Game = candidate in games ? (candidate as Game) : 'plinko';
  const upgraded = params.get('super') === '1';
  const [entry, setEntry] = useState(100),
    [doubled, setDoubled] = useState(false),
    [offer, setOffer] = useState(false);
  const [denomination, setDenomination] = useState(5),
    [risk, setRisk] = useState<keyof typeof tables>('steady');
  const [phase, setPhase] = useState<'idle' | 'open' | 'cashed' | 'lost'>('idle');
  const [sceneBusy, setSceneBusy] = useState(false);
  const [picked, setPicked] = useState<number[]>([]),
    [paths, setPaths] = useState<number[] | null>(null);
  const [landed, setLanded] = useState(0),
    [epoch, setEpoch] = useState(0),
    [settled, setSettled] = useState(false),
    [reveal, setReveal] = useState(false);
  const [prize, setPrize] = useState(0),
    [liveCents, setLiveCents] = useState(100),
    [notice, setNotice] = useState('');
  const [measure, width] = useMeasuredWidth<HTMLDivElement>(600);
  const started = useRef(0),
    crash = useRef(100),
    sealedRoad = useRef(0n),
    mines = useRef<number[]>([]),
    busy = useRef(false),
    payout = useRef(0);
  const total = entry * (upgraded ? 2 : 1) + (doubled ? entry : 0),
    chips = total / 100,
    minimum = chips / 10;
  const open = phase === 'open';
  const active = open || (phase !== 'idle' && !settled);
  useLiveBonusGuard(active, () => setNotice('Finish This Test Round Before Leaving.'));
  const finish = (value: number, status: 'cashed' | 'lost') => {
    if (!busy.current) return;
    busy.current = false;
    setPrize(value);
    setPhase(status);
  };
  const animationComplete = () => {
    setSceneBusy(false);
    if (!busy.current && phase !== 'idle' && phase !== 'open') {
      setSettled(true);
      setReveal(true);
    }
  };
  useEffect(() => {
    if (!open || game !== 'crash') return;
    let frame: number;
    const tick = () => {
      const cents = crashMultiplierCents(performance.now() - started.current, 0.04, 10000);
      setLiveCents(cents);
      if (cents >= 10000 && crash.current >= 10000) finish(chips * 100, 'cashed');
      else if (cents >= crash.current) finish(minimum, 'lost');
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, game, minimum, chips]);
  const nextPrize = (count: number) => {
    if (game === 'crossing') return (chips * (ROAD_LADDERS[risk][count - 1] ?? 0)) / 100;
    const p = minePrize(chips, 5, count, minimum);
    return Number(p.numerator) / Number(p.denominator) / 100;
  };
  const start = () => {
    if (busy.current) return;
    busy.current = true;
    setNotice('');
    setPicked([]);
    setLanded(0);
    setPrize(0);
    setSettled(false);
    setReveal(false);
    setEpoch((n) => n + 1);
    setPhase('open');
    setLiveCents(100);
    started.current = performance.now();
    if (game === 'plinko') {
      const next = Array.from(crypto.getRandomValues(new Uint16Array(total / denomination)));
      setPaths(next);
      payout.current = next.reduce(
        (sum, path) =>
          sum +
          (denomination * tables[risk][plinkoBitsFromPathBits(path).reduce((a, b) => a + b, 0)]) /
            10000,
        0
      );
    } else if (game === 'crash')
      crash.current = Math.min(10000, crashPointCentsFromRoll(roll48(), chips, minimum));
    else if (game === 'crossing') sealedRoad.current = roll48();
    else {
      const cells = Array.from({ length: 25 }, (_, i) => i);
      for (let i = 24; i > 0; i--) {
        const j = Number(roll48() % BigInt(i + 1));
        [cells[i], cells[j]] = [cells[j], cells[i]];
      }
      mines.current = cells.slice(0, 5);
    }
  };
  const pick = (cell: number) => {
    if (!open || !busy.current || sceneBusy || picked.includes(cell)) return;
    if (game === 'crossing') setSceneBusy(true);
    const next = [...picked, cell];
    setPicked(next);
    const safe =
      game === 'mines'
        ? !mines.current.includes(cell)
        : roadSurvives(sealedRoad.current, ROAD_LADDERS[risk][picked.length], chips, minimum);
    if (!safe) finish(minimum, 'lost');
    else if (next.length === (game === 'mines' ? 20 : ROAD_LADDERS[risk].length))
      finish(nextPrize(next.length), 'cashed');
  };
  const cash = () => {
    if (!open) return;
    if (game === 'crash') {
      const cents = crashMultiplierCents(performance.now() - started.current, 0.04, 10000);
      setLiveCents(cents);
      finish(
        cents >= crash.current && crash.current < 10000 ? minimum : (chips * cents) / 100,
        cents >= crash.current && crash.current < 10000 ? 'lost' : 'cashed'
      );
    } else if (picked.length) finish(nextPrize(picked.length), 'cashed');
  };
  const reset = () => {
    if (active) return;
    setReveal(false);
    setPhase('idle');
    setPaths(null);
    setPicked([]);
    setSettled(false);
    setPrize(0);
  };
  const current = open
    ? game === 'crash'
      ? (chips * liveCents) / 100
      : picked.length
        ? nextPrize(picked.length)
        : 0
    : prize;
  return (
    <main className={`${styles.page} ${styles.fullscreenPage}`}>
      <p role="status">
        Test Mode. Simulated Diamonds And Chips Only. No Account Or Wallet Connection.
      </p>
      <nav className={styles.spinsTabs} style={{ display: 'grid' }} aria-label="Test Games">
        {Object.entries(games).flatMap(([id, title]) =>
          [false, true].map((superGame) => (
            <a
              key={`${id}-${superGame}`}
              className={styles.back}
              href={`?game=${id}${superGame ? '&super=1' : ''}`}
            >
              {superGame ? 'Super ' : ''}
              {title}
            </a>
          ))
        )}
      </nav>
      {notice && <p role="alert">{notice}</p>}
      <GameConsole
        title={`${upgraded ? 'Super ' : ''}${games[game]}`}
        pill={open ? 'Test In Play' : 'Test Mode'}
        setup={
          <section className={setup.setup} aria-label="Test Setup">
            <label className={setup.entry}>
              Simulated Spin Diamonds
              <select
                value={entry}
                disabled={active}
                onChange={(e) => {
                  setEntry(Number(e.target.value));
                  setDenomination(5);
                }}
              >
                {[25, 100, 500, 1000, 2500].map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <button className={setup.offer} disabled={active} onClick={() => setOffer(true)}>
              {doubled ? 'Double Down Selected' : 'Double Down'}
            </button>
            {game === 'plinko' && (
              <label className={setup.entry}>
                Diamonds Per Drop
                <select
                  value={denomination}
                  disabled={active}
                  onChange={(e) => setDenomination(Number(e.target.value))}
                >
                  {plinkoAllocations(total).map((c) => (
                    <option key={c.diamondsPerDrop} value={c.diamondsPerDrop}>
                      {c.diamondsPerDrop} Diamonds, {c.drops} Drops
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(game === 'plinko' || game === 'crossing') && (
              <label className={setup.entry}>
                Payout Range
                <select
                  value={risk}
                  disabled={active}
                  onChange={(e) => setRisk(e.target.value as keyof typeof tables)}
                >
                  <option value="steady">Lower Risk, Smaller Top Prizes</option>
                  <option value="bold">Medium Risk, Larger Top Prizes</option>
                  <option value="extreme">Higher Risk, Largest Top Prizes</option>
                </select>
              </label>
            )}
            <p>
              {total.toLocaleString()} Simulated Diamonds
              {upgraded ? ' Including The Super Bonus' : ''}
            </p>
          </section>
        }
        bays={[
          { label: 'Bonus Entry', value: total.toLocaleString() },
          {
            label: game === 'plinko' ? 'Drops' : 'Choices',
            value: game === 'plinko' ? `${landed}/${total / denomination}` : String(picked.length),
          },
          {
            label: game === 'crash' ? 'Multiplier' : 'Current Prize',
            value: game === 'crash' ? `${(liveCents / 100).toFixed(2)}x` : money(current),
            ink: 'gold',
          },
          {
            label: game === 'mines' || game === 'crossing' ? 'Next Prize' : 'Chip Prize',
            value:
              game === 'mines' || game === 'crossing'
                ? money(
                    nextPrize(
                      Math.min(picked.length + 1, game === 'mines' ? 20 : ROAD_LADDERS[risk].length)
                    )
                  )
                : money(prize),
            ink: 'blue',
          },
        ]}
        primary={{
          label: open
            ? game === 'crash'
              ? 'Cash Out'
              : game === 'crossing'
                ? 'Cross Next Road'
                : game === 'mines'
                  ? 'Choose A Diamond'
                  : 'Dropping Diamonds'
            : phase === 'idle'
              ? 'Start Test'
              : 'Play Again',
          disabled: sceneBusy || (open ? game === 'mines' || game === 'plinko' : active),
          onClick: () =>
            open
              ? game === 'crash'
                ? cash()
                : pick(picked.length)
              : phase === 'idle'
                ? start()
                : reset(),
        }}
        secondary={{
          label: 'Book The Win',
          disabled: sceneBusy || !open || game === 'plinko' || (!picked.length && game !== 'crash'),
          onClick: cash,
        }}
      >
        <div ref={measure} style={{ width: '100%' }}>
          {game === 'plinko' ? (
            <PlinkoBoard
              key={epoch}
              width={Math.min(720, width)}
              multipliersCents={tables[risk]}
              path={null}
              dropKey={epoch}
              batchPathBits={paths}
              restingSlot={null}
              onProgress={setLanded}
              onLanded={() => {
                if (!busy.current) return;
                finish(Math.round(payout.current * 100) / 100, 'cashed');
                setSettled(true);
                setReveal(true);
              }}
            />
          ) : game === 'crash' ? (
            <CrashCurve
              key={epoch}
              width={width}
              height={Math.max(280, Math.min(560, width * 0.7))}
              phase={phase === 'lost' ? 'crashed' : phase}
              growthK={0.04}
              capCents={10000}
              startedAtLocalMs={open ? started.current : null}
              finalCents={phase === 'lost' ? crash.current : liveCents}
              cashoutCents={phase === 'cashed' ? liveCents : null}
              autoCashoutCents={null}
              onSettled={animationComplete}
            />
          ) : (
            <ChoiceScene
              key={epoch}
              game={game}
              phase={phase}
              picked={picked}
              mines={phase === 'lost' ? mines.current : null}
              roadEnd={null}
              busy={sceneBusy || !open}
              onPick={pick}
              onSettled={animationComplete}
            />
          )}
        </div>
      </GameConsole>
      {offer && (
        <DoubleDownOffer
          budget={{
            base: entry * (upgraded ? 2 : 1),
            doubled,
            denomination,
            award: {
              id: '00000000-0000-4000-8000-000000000001',
              entryDiamonds: entry,
              boostMultiplier: upgraded ? 2 : 1,
            },
          }}
          diamonds={2500}
          onChoose={(value) => {
            setDoubled(value);
            setOffer(false);
          }}
          onBuyMore={() => setOffer(false)}
        />
      )}
      {reveal && (
        <WheelWinReveal
          prize={{ kind: 'chips' }}
          title={`${money(prize)} Test Chips`}
          detail="Simulated Prize Only. No Wallet Was Changed."
          autoContinue
          autoContinueAfterMs={5000}
          onOpen={() => setReveal(false)}
        />
      )}
    </main>
  );
}
