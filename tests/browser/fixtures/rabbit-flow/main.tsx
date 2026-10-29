// Isolated test document: real components and transport, no production account.
import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { CommunityCards } from '../../../../src/components/table/CommunityCards';
import { HandDetailModal } from '../../../../src/components/table/HandDetailModal';
import { ToastProvider } from '../../../../src/components/common/Toast';
import RabbitHunt from '../../../../src/components/table/RabbitHunt';
import { requestRabbitHunt, readRabbitHuntReceipt } from '../../../../src/services/GameServerAPI';
import { adaptServiceHandToPanel } from '../../../../src/lib/handHistoryAdapter';
import { canonicalCards } from '../../../../src/utils/tableGeometry';
import '../../../../src/styles/club-engine.css';
import '../../../../src/pages/TablePage.css';
const user = '11111111-2222-4333-8444-555555555555';
const flop = [
  { rank: 'A', suit: 's' },
  { rank: 'K', suit: 'd' },
  { rank: '7', suit: 'c' },
] as any;
const hand = adaptServiceHandToPanel(
  {
    id: 'fixture-hand',
    table_id: 'fixture-table',
    table_name: 'Test Table',
    played_at: new Date().toISOString(),
    hand_number: 42,
    community_cards: ['As', 'Kd', '7c'],
    players: [],
    actions: [],
    winners: [],
    main_pot: 0,
    side_pots: [],
    game_type: 'NLH',
    stakes: '1/2',
  } as any,
  user
);
const converted = (r: any) =>
  r?.success ? { ...r, cards: canonicalCards(r.cards), diamondsSpent: r.diamonds_spent } : r;
function Fixture() {
  const [ghosts, setGhosts] = useState<any[]>([]);
  const [next, setNext] = useState(false);
  const [review, setReview] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [table, setTable] = useState('fixture-table');
  const reveal = useCallback(
    async (n?: number) => {
      const r = converted(await requestRabbitHunt(table, n ?? 42));
      if (n === undefined && r.success) setGhosts(r.cards);
      return r;
    },
    [table]
  );
  const receipt = useCallback(
    async (n: number) => converted(await readRabbitHuntReceipt(table, n)),
    [table]
  );
  return (
    <ToastProvider>
      <div style={{ padding: 12 }}>
        <button onClick={() => setNext(true)}>Next Hand</button>
        <button
          onClick={() => {
            setMounted(false);
            setReview(true);
          }}
        >
          Review Hand
        </button>
        <button onClick={() => setTable('other-table')}>Switch Table</button>
        <div className="table-surface" style={{ position: 'relative', height: 180, marginTop: 30 }}>
          <CommunityCards
            cards={next ? [] : flop}
            stage={next ? 'preflop' : 'showdown'}
            handId={next ? 43 : 42}
            rabbitCards={ghosts}
            rabbitHandId={42}
            rabbitStartIndex={next ? 3 : undefined}
            playSounds={false}
          />
        </div>
        <div style={{ position: 'relative', width: 66, height: 66, marginTop: 30 }}>
          {mounted && (
            <RabbitHunt
              isAvailable
              cardsAvailable={2}
              userId={user}
              rabbitDiamondCost={5}
              onReveal={() => reveal()}
            />
          )}
        </div>
        <HandDetailModal
          isOpen={review}
          onClose={() => setReview(false)}
          hands={[hand]}
          heroId={user}
          onRabbitHunt={reveal}
          onRabbitHuntReceipt={receipt}
          rabbitUserId={user}
        />
      </div>
    </ToastProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
