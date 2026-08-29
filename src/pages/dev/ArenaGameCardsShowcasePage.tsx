import { useMemo, useState } from 'react';
import {
  ArenaGameCard,
  ARENA_GAME_CARD_TEMPLATES,
  type ArenaGameCardData,
  type ArenaGameFamily,
  type ArenaGameStatus,
} from '../../components/lobby/game-cards';
import type { RuleMedallion } from '../../components/lobby/lobbyEntries';
import './ArenaGameCardsShowcasePage.css';

const rule = (key: string, label: string, detail?: string): RuleMedallion => ({
  key,
  label,
  detail,
  tip: `${label}${detail ? `: ${detail}` : ''}`,
});

const samples: Record<ArenaGameFamily, ArenaGameCardData> = {
  mtt: {
    id: 'mtt-1',
    family: 'mtt',
    title: 'Sunday $200 Deep Stack (NLH)',
    subtitle: 'No Limit Hold’em',
    gameType: 'NLH',
    buyIn: '200',
    guarantee: '20,000 GTD',
    registered: '25/500',
    startTime: 'Aug 30, 12:00 PM',
    startsIn: 'Starts In 38:04:38',
    startingStack: '30,000',
    currentLevel: '1',
    currentBlinds: '25/50',
    status: 'registering',
    statusLabel: 'Registering',
    featured: true,
    registeredByViewer: true,
    rules: [
      rule('pko', 'PKO'),
      rule('rebuy', 'Rebuy'),
      rule('addon', 'Add-On'),
      rule('deepstack', 'Deep Stack'),
      rule('latereg', 'Late Reg', '8 Levels'),
    ],
  },
  nlh: {
    id: 'nlh-1',
    family: 'nlh',
    title: 'NLH 25/50 Insurance Test',
    subtitle: 'No Limit Hold’em',
    gameType: 'NLH',
    stakes: '25/50',
    players: '3/6',
    buyIn: '2,000 - 10,000',
    status: 'running',
    statusLabel: 'Running',
    rules: [
      rule('insurance', 'Insurance'),
      rule('nit_game', 'VPIP', '25% Min'),
      rule('straddle', 'Straddle'),
      rule('time_bank', 'Time Bank'),
    ],
  },
  plo: {
    id: 'plo-1',
    family: 'plo',
    title: 'PLO8 Bomb Pot Double Board',
    subtitle: 'Omaha Hi-Lo',
    gameType: 'PLO8',
    stakes: '1/2',
    players: '8/8',
    buyIn: '80 - 400',
    waitlist: 'Waitlist 2',
    status: 'waitlist',
    statusLabel: 'Waitlist 2',
    rules: [
      rule('bomb', 'Bomb Pots', 'Every Orbit'),
      rule('double_board', 'Double Board'),
      rule('rit', 'Run It Twice'),
      rule('ante', 'Ante', '2x BB'),
    ],
  },
  spin: {
    id: 'spin-1',
    family: 'spin',
    title: '50 Chip Spin PLO5',
    subtitle: 'Three-player prize machine',
    gameType: 'PLO5',
    buyIn: '50',
    registered: '2/3',
    startingStack: '300',
    maxPayout: 'Win Up To 100x',
    topPrize: 'Top Prize 5,000',
    blindLevels: '3 Min',
    format: 'Turbo',
    status: 'filling',
    statusLabel: 'Filling',
    featured: true,
    rules: [rule('turbo', 'Turbo'), rule('gtd', '100x Live')],
  },
  'heads-up': {
    id: 'heads-1',
    family: 'heads-up',
    title: 'NLH Heads-Up 1',
    subtitle: 'One opponent. One winner.',
    gameType: 'NLH',
    buyIn: '1',
    registered: '1/2',
    startingStack: '1,000',
    blindLevels: '3 Min',
    format: 'Deepstack',
    status: 'filling',
    statusLabel: 'Filling',
    rules: [rule('deepstack', 'Deep Stack'), rule('time_bank', 'Time Bank')],
  },
};

const statusOptions: ArenaGameStatus[] = [
  'open',
  'running',
  'filling',
  'registering',
  'late-reg',
  'full',
  'waitlist',
  'closed',
  'starting',
  'paused',
];

const labels: Record<ArenaGameFamily, string> = {
  mtt: 'MTT / Tournament',
  nlh: 'NLH Cash',
  plo: 'PLO Family',
  spin: 'Spins',
  'heads-up': 'Heads Up',
};

export default function ArenaGameCardsShowcasePage() {
  const [status, setStatus] = useState<ArenaGameStatus | 'sample'>('sample');
  const [longValues, setLongValues] = useState(false);
  const [presentation, setPresentation] = useState<'mobile' | 'desktop'>('mobile');

  const cards = useMemo(
    () =>
      (Object.keys(samples) as ArenaGameFamily[]).map((family) => {
        const sample = samples[family];
        return {
          ...sample,
          title: longValues
            ? `${sample.title} - Super High Roller Championship Satellite Final Table`
            : sample.title,
          buyIn: longValues ? '100,000 - 1,000,000' : sample.buyIn,
          guarantee: longValues && family === 'mtt' ? '$1,000,000 GTD' : sample.guarantee,
          status: status === 'sample' ? sample.status : status,
          statusLabel: status === 'sample' ? sample.statusLabel : status.replace('-', ' '),
        };
      }),
    [longValues, status]
  );

  return (
    <main className="agc-showcase">
      <header className="agc-showcase__header">
        <div>
          <p>#ClubButtons / Dynamic Game Factory</p>
          <h1>Same Factory. Five Different Machines.</h1>
          <span>Approved artwork as hardware. Every displayed value is live DOM content.</span>
        </div>
        <div className="agc-showcase__controls">
          <label>
            View
            <select
              value={presentation}
              onChange={(event) => setPresentation(event.target.value as 'mobile' | 'desktop')}
            >
              <option value="mobile">Mobile Template</option>
              <option value="desktop">Desktop Template</option>
            </select>
          </label>
          <label>
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ArenaGameStatus | 'sample')}
            >
              <option value="sample">Family Sample State</option>
              {statusOptions.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="agc-showcase__check">
            <input
              type="checkbox"
              checked={longValues}
              onChange={(event) => setLongValues(event.target.checked)}
            />
            Stress-test long values
          </label>
        </div>
      </header>

      <section className={`agc-showcase__grid agc-showcase__grid--${presentation}`}>
        {cards.map((data) => (
          <article className="agc-showcase__sample" key={data.family}>
            <div className="agc-showcase__label">
              <span>{labels[data.family]}</span>
              <small>{ARENA_GAME_CARD_TEMPLATES[data.family].zones.join(' · ')}</small>
            </div>
            <ArenaGameCard
              data={data}
              presentation={presentation}
              actions={{
                secondaryLabel:
                  data.family === 'mtt'
                    ? 'Details'
                    : data.family === 'spin' || data.family === 'heads-up'
                      ? undefined
                      : 'View Table',
                primaryLabel:
                  data.family === 'mtt'
                    ? 'Register'
                    : data.family === 'spin' || data.family === 'heads-up'
                      ? 'Sit Down'
                      : data.status === 'waitlist'
                        ? 'Join Waitlist'
                        : 'Join Table',
              }}
            />
          </article>
        ))}
      </section>
    </main>
  );
}
