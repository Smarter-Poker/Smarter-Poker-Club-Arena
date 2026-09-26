import { useEffect, useRef, useState } from 'react';
import { GameConsole } from '../components/games/GameConsole';
import ChoiceScene from '../components/games/ChoiceScene';
import PlinkoBoard from '../components/plinko/PlinkoBoard';
import CrashCurve from '../components/crash/CrashCurve';
import DoubleDownOffer from '../components/games/DoubleDownOffer';
import { WheelWinReveal } from '../components/wheel/WheelWinReveal';
import { BonusReceiptArt } from '../components/games/BonusReceiptArt';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import { useSceneBudget } from '../hooks/useSceneBudget';
import { useLiveBonusGuard } from '../hooks/useLiveBonusGuard';
import {
  CHOICE_MODE,
  CHOICE_PAYOUT_VERSION,
  minePrizeV4,
  RANDOM_SPACE,
  roadLadder,
  roadSurvives,
} from '../utils/diamondChoiceMath';
import {
  CRASH_PAYOUT_VERSION,
  crashMultiplierCents,
  crashPointCentsFromRoll,
  crashPointFloorCents,
  plinkoBitsFromPathBits,
} from '../utils/diamondGamesFairness';
import { plinkoAllocations } from '../utils/bonusGameBudget';
import { PLINKO_TABLES, diamondBonusFloor, plinkoTableForFloor } from '../utils/diamondBonusPayout';
import { diamondGameTitle, type DiamondBonusGame } from '../utils/diamondGameTitles';
import styles from './diamondGames.module.css';
import setup from '../components/games/BonusSetup.module.css';

const games: Record<DiamondBonusGame, string> = {
  plinko: 'Plinko',
  crash: 'Crash',
  crossing: 'Donkey Cross',
  mines: 'Diamond Mines',
};
type Game = DiamondBonusGame;
/** The one setting per game, exactly as the server installs it: the ladder of
 * the contract every live round is sealed with. */
const ROAD = roadLadder(CHOICE_MODE.crossing, CHOICE_PAYOUT_VERSION) as readonly number[];
const MINES = Number(CHOICE_MODE.mines);
const MINE_PICKS = 25 - MINES;
/** Every crash round is capped at 25.00x, as the server seals it. */
const CRASH_CAP = 2500;
/** The live curve: e^(0.10 t), the 25x ceiling in about 32 seconds (migration 20260925215112). */
const CRASH_K = 0.1;
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
  const rollParam = Number(params.get('roll'));
  const fixedRoll =
    params.has('roll') && Number.isFinite(rollParam) && rollParam >= 0 && rollParam < 1
      ? BigInt(Math.floor(rollParam * Number(RANDOM_SPACE)))
      : null;
  const boost = upgraded ? 2 : 1;
  const [entry, setEntry] = useState(100),
    // Double Diamonds can be opened already taken, so the board a Super award
    // WITH the add-on is dealt - Super Double, the one its two-thirds floor
    // needs - can be reached offline as well as through the offer step.
    [doubled, setDoubled] = useState(params.get('double') === '1'),
    [offer, setOffer] = useState(false);
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
  // Held sideways, the scene gets the height the console leaves it.
  const sceneBudget = useSceneBudget();
  const started = useRef(0),
    crash = useRef(100),
    sealedRoad = useRef(0n),
    mines = useRef<number[]>([]),
    busy = useRef(false),
    payout = useRef(0),
    // The best bucket the batch lands in, for the receipt's own art.
    bestCents = useRef(0);
  const total = entry * boost + (doubled ? entry : 0),
    chips = total / 100,
    // What the player paid: the spin entry, plus the add-on when it was taken.
    paid = entry + (total - entry * boost),
    // The guaranteed minimum, by the server's rule (contract 4): half the
    // stake, or for a Super award the greater of that and what was paid.
    minimum = diamondBonusFloor(chips, boost, paid, 100);
  // The board follows that floor, exactly as fn_plinko_table_for_floor picks it.
  // The live game lets the player choose the drop value (R6); this offline copy
  // plays the ten-drop split when the stake offers it, else the fewest drops
  // the stake allows.
  const tableVersion = plinkoTableForFloor(chips, minimum) as number;
  const table = PLINKO_TABLES[tableVersion];
  const allocations = plinkoAllocations(total);
  const allocation = allocations.find((a) => a.drops === 10) ?? allocations[allocations.length - 1];
  const drop = allocation?.diamondsPerDrop ?? total;
  const dropCount = allocation?.drops ?? 1;
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
      const cents = crashMultiplierCents(CRASH_K, performance.now() - started.current, CRASH_CAP);
      setLiveCents(cents);
      if (cents >= CRASH_CAP && crash.current >= CRASH_CAP) finish(chips * 25, 'cashed');
      else if (cents >= crash.current) finish(minimum, 'lost');
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, game, minimum, chips]);
  const nextPrize = (count: number) => {
    if (game === 'crossing') return (chips * (ROAD[count - 1] ?? 0)) / 100;
    const p = minePrizeV4(chips, MINES, count, minimum);
    return Number(p.numerator) / Number(p.denominator) / 100;
  };
  const ladderPrizes =
    game === 'crossing'
      ? ROAD.map((mult) => (chips * mult) / 100)
      : game === 'mines'
        ? Array.from({ length: MINE_PICKS }, (_, i) => nextPrize(i + 1))
        : [];
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
      const next = Array.from(crypto.getRandomValues(new Uint16Array(dropCount)));
      setPaths(next);
      bestCents.current = Math.max(
        ...next.map(
          (path) => table.multipliersCents[plinkoBitsFromPathBits(path).reduce((a, b) => a + b, 0)]
        )
      );
      const dropped = next.reduce(
        (sum, path) =>
          sum +
          (drop * table.multipliersCents[plinkoBitsFromPathBits(path).reduce((a, b) => a + b, 0)]) /
            10000,
        0
      );
      // Every batch returns at least its floor whatever the drops did: half the
      // stake, or for a Super award with the add-on what the player paid.
      payout.current = Math.max(dropped, minimum);
    } else if (game === 'crash')
      crash.current = Math.min(
        CRASH_CAP,
        crashPointCentsFromRoll(
          fixedRoll ?? roll48(),
          chips,
          minimum,
          crashPointFloorCents(CRASH_PAYOUT_VERSION)
        )
      );
    // A fixed road for screenshots and demos: ?roll=0.07 seals the road at that
    // fraction of the draw space (0 crosses every street, 1 is hit on street 2).
    // The same ?roll= seals a crash point (0.02 flies to 15.5x, 0.3 crashes at 1.50x).
    else if (game === 'crossing') sealedRoad.current = fixedRoll ?? roll48();
    // CONTRACT 4: the board is not dealt until the first tile is picked, so
    // that tile is always a gem and the ladder's first rung is certain.
    else mines.current = [];
  };
  /** The twenty-four tiles other than the first pick, shuffled around it. */
  const dealMines = (first: number) => {
    const cells = Array.from({ length: 25 }, (_, i) => i).filter((c) => c !== first);
    for (let i = 23; i > 0; i--) {
      const j = Number(roll48() % BigInt(i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    mines.current = cells.slice(0, MINES);
  };
  const pick = (cell: number) => {
    if (!open || !busy.current || sceneBusy || picked.includes(cell)) return;
    if (game === 'crossing') setSceneBusy(true);
    if (game === 'mines' && picked.length === 0) dealMines(cell);
    const next = [...picked, cell];
    setPicked(next);
    const safe =
      game === 'mines'
        ? !mines.current.includes(cell)
        : roadSurvives(sealedRoad.current, ROAD[picked.length], chips, minimum);
    if (!safe) finish(minimum, 'lost');
    else if (next.length === (game === 'mines' ? MINE_PICKS : ROAD.length))
      finish(nextPrize(next.length), 'cashed');
  };
  const cash = () => {
    if (!open) return;
    if (game === 'crash') {
      const cents = crashMultiplierCents(CRASH_K, performance.now() - started.current, CRASH_CAP);
      setLiveCents(cents);
      finish(
        cents >= crash.current && crash.current < CRASH_CAP ? minimum : (chips * cents) / 100,
        cents >= crash.current && crash.current < CRASH_CAP ? 'lost' : 'cashed'
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
  // How far the sealed road really ran, told once the win is booked, exactly
  // as the live page reads it from the round's proof.
  const roadEnd =
    game === 'crossing' && phase === 'cashed'
      ? ROAD.filter((target) => roadSurvives(sealedRoad.current, target, chips, minimum)).length
      : null;
  const current = open
    ? game === 'crash'
      ? (chips * liveCents) / 100
      : picked.length
        ? nextPrize(picked.length)
        : 0
    : prize;
  const guaranteeSentence = upgraded
    ? `${diamondGameTitle(game, 2)} Pays At Least ${money(minimum)} Chips, What You Paid For It, Whatever Happens.`
    : `Pays At Least ${money(minimum)} Chips On Any Loss.`;
  return (
    <main className={`${styles.page} ${styles.fullscreenPage}`}>
      <p role="status">
        Test Mode. Simulated Diamonds And Chips Only. No Account Or Wallet Connection.
      </p>
      <nav className={styles.spinsTabs} style={{ display: 'grid' }} aria-label="Test Games">
        {(Object.keys(games) as Game[]).flatMap((id) =>
          [false, true].map((superGame) => (
            <a
              key={`${id}-${superGame}`}
              className={styles.back}
              href={`?game=${id}${superGame ? '&super=1' : ''}`}
            >
              {diamondGameTitle(id, superGame ? 2 : 1)}
            </a>
          ))
        )}
      </nav>
      {notice && <p role="alert">{notice}</p>}
      <GameConsole
        title={diamondGameTitle(game, boost)}
        pill={open ? 'Test In Play' : 'Test Mode'}
        setup={
          <section className={setup.setup} aria-label="Test Setup">
            <label className={setup.entry}>
              Simulated Spin Diamonds
              <select
                value={entry}
                disabled={active}
                onChange={(e) => setEntry(Number(e.target.value))}
              >
                {[100, 500, 1000, 2500].map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <button className={setup.offer} disabled={active} onClick={() => setOffer(true)}>
              {doubled ? 'Double Down Selected' : 'Double Down'}
            </button>
            <p>
              {total.toLocaleString()} Simulated Diamonds
              {upgraded ? ' Including The Super Bonus' : ''}
              {game === 'plinko'
                ? `, ${dropCount} Drops Of ${drop.toLocaleString()} On The ${table.name} Table`
                : game === 'crossing'
                  ? `, ${ROAD.length} Streets`
                  : game === 'mines'
                    ? `, ${MINES} Mines In 25 Tiles`
                    : ''}
            </p>
            <p className={setup.promise} role="status">
              {guaranteeSentence}
            </p>
          </section>
        }
        bays={[
          { label: 'Bonus Entry', value: total.toLocaleString() },
          {
            label: game === 'plinko' ? 'Drops' : 'Choices',
            value: game === 'plinko' ? `${landed}/${dropCount}` : String(picked.length),
          },
          {
            label: 'Guaranteed',
            value: `${money(minimum)} Chips`,
            ink: upgraded ? 'gold' : undefined,
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
                      Math.min(picked.length + 1, game === 'mines' ? MINE_PICKS : ROAD.length)
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
          // The scene is still playing the move out: the plate keeps its focus.
          disabled: open ? game === 'mines' || game === 'plinko' : active,
          'aria-disabled': sceneBusy || undefined,
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
          disabled: !open || game === 'plinko' || (!picked.length && game !== 'crash'),
          'aria-disabled': sceneBusy || undefined,
          onClick: cash,
        }}
      >
        <div ref={measure} className={styles.sceneFit} data-scene={game}>
          {game === 'plinko' ? (
            <PlinkoBoard
              key={epoch}
              width={Math.min(720, width)}
              multipliersCents={table.multipliersCents}
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
              height={Math.min(
                Math.max(280, Math.min(560, width * 0.7)),
                sceneBudget === null ? Infinity : Math.max(200, sceneBudget)
              )}
              phase={phase === 'lost' ? 'crashed' : phase}
              growthK={CRASH_K}
              capCents={CRASH_CAP}
              startedAtLocalMs={open ? started.current : null}
              finalCents={phase === 'lost' ? crash.current : liveCents}
              cashoutCents={phase === 'cashed' ? liveCents : null}
              crashCents={phase === 'cashed' ? crash.current : null}
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
              roadEnd={roadEnd}
              busy={sceneBusy || !open}
              onPick={pick}
              onSettled={animationComplete}
              ladder={game === 'crossing' ? ROAD : undefined}
              prizes={ladderPrizes}
              betChips={chips}
              payoutChips={phase === 'cashed' || phase === 'lost' ? prize : undefined}
            />
          )}
        </div>
      </GameConsole>
      {offer && (
        <DoubleDownOffer
          budget={{
            base: entry * boost,
            doubled,
            denomination: drop,
            award: {
              id: '00000000-0000-4000-8000-000000000001',
              entryDiamonds: entry,
              boostMultiplier: boost,
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
          // The live receipt's own art and figure, and its loss dress.
          eyebrow={phase === 'lost' ? 'Guarantee Paid' : undefined}
          // As on the live pages: only Plinko's receipt sings a win; the other
          // three scenes sound their own ending.
          silent={phase === 'lost' || game !== 'plinko'}
          art={
            <BonusReceiptArt
              game={game}
              cap={CRASH_CAP / 100}
              dim={phase === 'lost'}
              figure={
                game === 'crash'
                  ? (phase === 'lost' ? crash.current : liveCents) / 100
                  : game === 'plinko'
                    ? bestCents.current / 100
                    : game === 'mines' && phase === 'lost'
                      ? Math.max(0, picked.length - 1)
                      : picked.length
              }
            />
          }
        />
      )}
    </main>
  );
}
