import { useMemo, useState } from 'react';
import {
  ArenaGameCard,
  listArenaGameCardSkins,
  resolveArenaGameCardTemplate,
  type ArenaGameCardActions,
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
  spins: {
    id: 'spin-1',
    family: 'spins',
    title: '50 Chip Spin PLO5',
    subtitle: 'Three-Player Prize Machine',
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
    subtitle: 'One Opponent. One Winner.',
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
  spins: 'Spins',
  'heads-up': 'Heads Up',
};

interface CardPreview {
  data: ArenaGameCardData;
  skin?: string;
}

function previewActions(data: ArenaGameCardData): ArenaGameCardActions {
  if (data.family === 'mtt') {
    if (data.registeredByViewer && (data.status === 'running' || data.status === 'late-reg')) {
      return {
        primaryLabel: 'Return To Tournament',
        primaryTone: 'gold',
        secondaryLabel: 'Details',
      };
    }
    if (data.registeredByViewer) {
      return { primaryLabel: 'Unregister', primaryTone: 'red', secondaryLabel: 'Details' };
    }
    if (data.status === 'late-reg') {
      return { primaryLabel: 'Late Register', primaryTone: 'gold', secondaryLabel: 'Details' };
    }
    if (data.status === 'running' || data.status === 'closed' || data.status === 'full') {
      return {
        primaryLabel: data.status === 'full' ? 'Tournament Full' : 'Registration Closed',
        primaryTone: 'neutral',
        primaryDisabled: true,
        secondaryLabel: 'Details',
      };
    }
    return { primaryLabel: 'Register', primaryTone: 'blue', secondaryLabel: 'Details' };
  }
  if (data.family === 'spins' || data.family === 'heads-up') return { primaryLabel: 'Sit Down' };
  return {
    secondaryLabel: 'View Table',
    primaryLabel: data.status === 'waitlist' ? 'Join Waitlist' : 'Join Table',
  };
}

export default function ArenaGameCardsShowcasePage() {
  const [status, setStatus] = useState<ArenaGameStatus | 'sample'>('sample');
  const [longValues, setLongValues] = useState(false);
  const [presentation, setPresentation] = useState<'mobile' | 'desktop'>('mobile');
  const [familyFilter, setFamilyFilter] = useState<ArenaGameFamily | 'all'>('all');
  const [skinMode, setSkinMode] = useState('default');
  const [viewerState, setViewerState] = useState<'sample' | 'unregistered' | 'registered'>(
    'sample'
  );

  const cards = useMemo<CardPreview[]>(() => {
    const normalized = (Object.keys(samples) as ArenaGameFamily[])
      .filter((family) => familyFilter === 'all' || family === familyFilter)
      .map((family) => {
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
          registeredByViewer:
            family !== 'mtt' || viewerState === 'sample'
              ? sample.registeredByViewer
              : viewerState === 'registered',
        };
      });
    const previews: CardPreview[] = [];
    for (const data of normalized) {
      if (familyFilter === 'all' || skinMode === 'default') previews.push({ data });
      else if (skinMode === 'compare') {
        for (const cardSkin of listArenaGameCardSkins(data.family))
          previews.push({ data, skin: cardSkin.id });
      } else previews.push({ data, skin: skinMode });
    }
    return previews;
  }, [familyFilter, longValues, skinMode, status, viewerState]);

  const availableSkins = familyFilter === 'all' ? [] : listArenaGameCardSkins(familyFilter);

  return (
    <main className="agc-showcase">
      <header className="agc-showcase__header">
        <div>
          <p>#ClubButtons / Dynamic Game Factory</p>
          <h1>Same Factory. Five Different Machines.</h1>
          <span>Approved Artwork As Hardware. Every Displayed Value Is Live DOM Content.</span>
        </div>
        <div className="agc-showcase__controls">
          <label>
            Family
            <select
              value={familyFilter}
              onChange={(event) => {
                setFamilyFilter(event.target.value as ArenaGameFamily | 'all');
                setSkinMode('default');
              }}
            >
              <option value="all">All Families</option>
              {(Object.keys(samples) as ArenaGameFamily[]).map((family) => (
                <option key={family} value={family}>
                  {labels[family]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Skin
            <select
              value={skinMode}
              disabled={familyFilter === 'all'}
              onChange={(event) => setSkinMode(event.target.value)}
            >
              <option value="default">Family Default</option>
              <option value="compare">Compare All Skins</option>
              {availableSkins.map((cardSkin) => (
                <option key={cardSkin.id} value={cardSkin.id}>
                  {cardSkin.name}
                </option>
              ))}
            </select>
          </label>
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
          <label>
            Player State
            <select
              value={viewerState}
              onChange={(event) => setViewerState(event.target.value as typeof viewerState)}
            >
              <option value="sample">Sample Player State</option>
              <option value="unregistered">Not Registered</option>
              <option value="registered">Already Registered</option>
            </select>
          </label>
          <label className="agc-showcase__check">
            <input
              type="checkbox"
              checked={longValues}
              onChange={(event) => setLongValues(event.target.checked)}
            />
            Stress-Test Long Values
          </label>
        </div>
      </header>

      <section className={`agc-showcase__grid agc-showcase__grid--${presentation}`}>
        {cards.map(({ data, skin }) => {
          const resolved = resolveArenaGameCardTemplate({
            family: data.family,
            skin,
            presentation,
          });
          return (
            <article className="agc-showcase__sample" key={`${data.family}-${resolved.skinId}`}>
              <div className="agc-showcase__label">
                <span>{labels[data.family]}</span>
                <small>
                  {resolved.skin.name} · {resolved.skin.lifecycle} ·{' '}
                  {Object.keys(resolved.template.zones).join(' · ')}
                </small>
              </div>
              <ArenaGameCard
                data={data}
                skin={resolved.skinId}
                presentation={presentation}
                actions={previewActions(data)}
              />
            </article>
          );
        })}
      </section>
    </main>
  );
}
