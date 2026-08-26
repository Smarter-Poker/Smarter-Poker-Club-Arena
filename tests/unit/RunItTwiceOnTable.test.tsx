import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { bestFive, cardKey } from '../../src/utils/handEvaluator';
import { normalizeCards } from '../../src/utils/tableGeometry';
import { TableModalsLayer } from '../../src/components/table/TableModalsLayer';
import { CommunityCards } from '../../src/components/table/CommunityCards';
import { createPotToWinnerEvent } from '../../src/components/table/ChipAnimation';
import { ToastProvider } from '../../src/components/common/Toast';
import type { Card } from '../../src/components/table/CardImage';
import type { RitResultData } from '../../src/components/table/RunItTwice';

describe('Run It Twice / Three Times on Table Felt', () => {
  describe('Modal Suppression', () => {
    it('does not render RunItTwiceResult popup modal in TableModalsLayer when RIT completes', () => {
      const ritResult: RitResultData = {
        runs: 2,
        boards: [
          ['7c', '8h', 'Js', '4h', '2c'],
          ['7c', '8h', 'Js', '4h', '5h'],
        ],
        distribution: { player1: 101.51, player2: 0.81 },
        perBoardWinners: [['player1'], ['player1']],
        potTotal: 114.36,
      };

      const { container } = render(
        <ToastProvider>
          <TableModalsLayer
            // RIT
            showRIT={false}
            ritIsChooser={false}
            ritOpponent="Opponent"
            ritTimer={10}
            ritChosenRuns={2}
            ritMaxRuns={2}
            ritPlayerCount={2}
            onRITChooserDecide={async () => {}}
            onRITAccept={async () => {}}
            onRITDecline={async () => {}}
            ritResult={ritResult}
            onRitResultClose={() => {}}
            ritResolveName={(uid) => uid}
            // BBJ
            showBBJ={false}
            bbjAmount={0}
            showBBJCelebration={false}
            bbjCelebrationData={{
              totalPayout: 0,
              loser: { userId: '', username: '', share: 0, handName: '' },
              winner: { userId: '', username: '', share: 0, handName: '' },
              tableSharePerPlayer: 0,
              tablePlayers: [],
            }}
            onBBJCelebrationComplete={() => {}}
            // Basic table props
            blinds="1/2"
            tableId="test-table"
            tableName="Test Table"
            isTournament={false}
            currentBet={0}
            heroSeat={1}
            players={[]}
            waitListPlayers={[]}
            handHistory={[]}
            showHandHistory={false}
            onCloseHandHistory={() => {}}
            safeBB={(b) => 2}
            winnerParticle={{ active: false, origin: { x: 0, y: 0 }, intensity: 1 }}
            userSettings={
              {
                autoMuck: true,
                autoMuckWinners: false,
                autoPostBlinds: true,
                fourColorDeck: false,
              } as any
            }
            v8Settings={{ show_stack_in_bb: false } as any}
            onUpdateSettings={() => {}}
            showSettings={false}
            onCloseSettings={() => {}}
            // Modals
            showGameRules={false}
            onCloseGameRules={() => {}}
            showClubProfile={false}
            onCloseClubProfile={() => {}}
            showSitOut={false}
            onSitOutOption={() => {}}
            onCloseSitOut={() => {}}
            showWaitlist={false}
            onCloseWaitlist={() => {}}
            onJoinWaitlist={() => {}}
            onLeaveWaitlist={() => {}}
            waitlistEntries={[]}
            waitlistCount={0}
            isUserOnWaitlist={false}
            userWaitlistPosition={null}
            showInsurance={false}
            insuranceOffers={[]}
            onInsuranceAccept={async () => {}}
            onInsuranceDecline={() => {}}
            insuranceTimer={10}
            showThrowables={false}
            onCloseThrowables={() => {}}
            onSelectThrowable={() => {}}
            throwTargetSeat={null}
            throwTargetName=""
            throwTargetPlayerId=""
            throwTargetPosition={{ x: 0, y: 0 }}
            showDiamondWallet={false}
            onCloseDiamondWallet={() => {}}
            diamondBalance={100}
            showCashier={false}
            onCloseCashier={() => {}}
            showBuyIn={false}
            onCloseBuyIn={() => {}}
            onConfirmBuyIn={async () => {}}
            minBuyIn={40}
            maxBuyIn={200}
            defaultBuyIn={100}
            showRabbitHunt={false}
            rabbitCards={[]}
            onCloseRabbitHunt={() => {}}
            showLeaveConfirm={false}
            onConfirmLeave={() => {}}
            onCancelLeave={() => {}}
            heroCurrentBet={0}
            showLeaderboard={false}
            onCloseLeaderboard={() => {}}
            leaderboardEntries={[]}
            showTimeBankStore={false}
            onCloseTimeBankStore={() => {}}
            timeBankInventory={5}
            onPurchaseTimeBanks={async () => {}}
            chipAnimations={[]}
            floatingBets={[]}
            potWinFloats={[]}
            soundService={{} as any}
          />
        </ToastProvider>
      );

      // Verify that no .rit-result or .rit-result__overlay popup dialog is rendered
      expect(container.querySelector('.rit-result')).toBeNull();
      expect(container.querySelector('.rit-result__overlay')).toBeNull();
    });
  });

  describe('Multi-board Hand Evaluation & Identification', () => {
    it('accurately identifies winning hands and highlighted board card indices on Run 1 and Run 2', () => {
      // Player hole cards: Ac Kd (Hold'em)
      const heroCards: Card[] = [
        { rank: 'A', suit: 'c' },
        { rank: 'K', suit: 'd' },
      ];

      // Run 1 Board: As Kh 2d 7c 9s -> Two Pair, Aces and Kings, with 9 kicker
      const run1Board = normalizeCards(['As', 'Kh', '2d', '7c', '9s']) as Card[];
      const eval1 = bestFive(heroCards, run1Board, 'NLH');

      expect(eval1).not.toBeNull();
      expect(eval1!.name).toBe('Two Pair');

      // The played cards from board: As (index 0), Kh (index 1), and 9s (index 4)
      const playedKeys1 = new Set(eval1!.cards.map(cardKey));
      const highlighted1 = run1Board
        .map((c, idx) => (playedKeys1.has(cardKey(c)) ? idx : -1))
        .filter((idx) => idx >= 0);

      expect(highlighted1).toEqual([0, 1, 4]);

      // Run 2 Board: Qs Js 10s 4d 3c -> Straight, Ace High (Broadway)
      const run2Board = normalizeCards(['Qs', 'Js', 'Ts', '4d', '3c']) as Card[];
      const eval2 = bestFive(heroCards, run2Board, 'NLH');

      expect(eval2).not.toBeNull();
      expect(eval2!.name).toBe('Straight');

      // The played cards from board: Qs (index 0), Js (index 1), Ts (index 2)
      const playedKeys2 = new Set(eval2!.cards.map(cardKey));
      const highlighted2 = run2Board
        .map((c, idx) => (playedKeys2.has(cardKey(c)) ? idx : -1))
        .filter((idx) => idx >= 0);

      expect(highlighted2).toEqual([0, 1, 2]);
    });

    it('accurately identifies 3 distinct runs in Run It Three Times (RIT3)', () => {
      const playerHole: Card[] = [
        { rank: 'K', suit: 'h' },
        { rank: 'K', suit: 'd' },
      ];

      // Run 1: 5s 7h 5c Ah Kd -> Full House (Kings full of Fives)
      const run1 = normalizeCards(['5s', '7h', '5c', 'Ah', 'Kd']) as Card[];
      const eval1 = bestFive(playerHole, run1, 'NLH');
      expect(eval1!.name).toBe('Full House');

      // Run 2: 3h 7h Td 9d Jd -> Pair of Kings
      const run2 = normalizeCards(['3h', '7h', 'Td', '9d', 'Jd']) as Card[];
      const eval2 = bestFive(playerHole, run2, 'NLH');
      expect(eval2!.name).toBe('Pair');

      // Run 3: 2h 2c Kh Td Kd -> Four of a Kind, Kings
      const run3 = normalizeCards(['2h', '2c', 'Kh', 'Td', 'Kd']) as Card[];
      const eval3 = bestFive(playerHole, run3, 'NLH');
      expect(eval3!.name).toBe('Four of a Kind');
    });

    it('evaluates Omaha RIT runs respecting the 2-from-hand / 3-from-board rule', () => {
      // Omaha holding: Ah Kh Qh Jh (4 hearts)
      const omahaHole: Card[] = [
        { rank: 'A', suit: 'h' },
        { rank: 'K', suit: 'h' },
        { rank: 'Q', suit: 'h' },
        { rank: 'J', suit: 'h' },
      ];

      // Board has only 2 hearts: 2h 3h 9c Tc 4s -> CANNOT make a flush in Omaha
      const runBoard = normalizeCards(['2h', '3h', '9c', 'Tc', '4s']) as Card[];
      const evalOmaha = bestFive(omahaHole, runBoard, 'PLO4');

      expect(evalOmaha).not.toBeNull();
      expect(evalOmaha!.name).not.toBe('Flush');
      expect(evalOmaha!.name).toBe('High Card');
    });
  });

  describe('Pot Push & Chip Animation during Multi-board Runouts', () => {
    it('creates accurate chip animation fans to each winner based on their individual net pot shares', () => {
      const potCenter = { x: 200, y: 300 };
      const winner1Pos = { x: 100, y: 500 };
      const winner2Pos = { x: 300, y: 500 };

      const share1 = 101.51;
      const share2 = 0.81;

      const fan1 = createPotToWinnerEvent(potCenter, winner1Pos, share1);
      const fan2 = createPotToWinnerEvent(potCenter, winner2Pos, share2);

      expect(fan1.length).toBeGreaterThanOrEqual(3);
      expect(fan2.length).toBeGreaterThanOrEqual(3);

      expect(Math.abs(fan1[0].to.x - winner1Pos.x)).toBeLessThanOrEqual(15);
      expect(Math.abs(fan2[0].to.x - winner2Pos.x)).toBeLessThanOrEqual(15);
    });
  });

  describe('CommunityCards Multi-Run Rendering', () => {
    it('renders community cards for a given run with proper stage and highlights', () => {
      const cards: Card[] = [
        { rank: 'A', suit: 's' },
        { rank: 'K', suit: 'h' },
        { rank: 'Q', suit: 'd' },
        { rank: 'J', suit: 'c' },
        { rank: 'T', suit: 's' },
      ];

      const { container } = render(
        <CommunityCards
          cards={cards}
          stage="river"
          highlightedIndices={[0, 1, 2, 3, 4]}
          winningHandName="Royal Flush"
          deckStyle="4color"
        />
      );

      expect(container.querySelectorAll('.community-cards__card').length).toBe(5);
      expect(container.querySelectorAll('.community-cards__card--highlighted').length).toBe(5);
      expect(container.textContent).toContain('Royal Flush');
    });
  });
});
