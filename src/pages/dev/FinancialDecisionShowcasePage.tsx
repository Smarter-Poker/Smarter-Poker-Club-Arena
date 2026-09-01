import { useCallback, useState } from 'react';
import InsuranceModal, { type InsuranceOffer } from '../../components/table/InsuranceModal';
import RabbitHunt, { type RabbitHuntRevealResult } from '../../components/table/RabbitHunt';

const TEST_USER_ID = '11111111-2222-4333-8444-555555555555';

const OFFER: InsuranceOffer = {
  maxCoverage: 240,
  equityPercent: 76.25,
  premiumRate: 0.25,
  potAmount: 420,
  yourStack: 0,
  opponentStack: 0,
  yourCards: [
    { rank: 'A', suit: 's' },
    { rank: 'A', suit: 'h' },
  ],
  opponentCards: [
    { rank: 'K', suit: 'c' },
    { rank: 'Q', suit: 'c' },
  ],
  board: [
    { rank: 'A', suit: 'd' },
    { rank: 'J', suit: 'c' },
    { rank: '2', suit: 's' },
  ],
  outs: [
    { rank: 'T', suit: 'c' },
    { rank: '9', suit: 'c' },
  ],
  outPct: 4.55,
  timeoutSeconds: 25,
  atRisk: 160,
  heroName: 'Test Player',
};

/**
 * Browser-only Phase 5 fixture. Every callback is local state: no Supabase
 * writer, engine request, wallet mutation, or chip movement is reachable from
 * this page. It exists to exercise the production components in a real 375px
 * browser at the exact decision boundary where the live suite must stop.
 */
export default function FinancialDecisionShowcasePage() {
  const [showInsurance, setShowInsurance] = useState(true);
  const [insuranceRequests, setInsuranceRequests] = useState(0);
  const [insuranceStatus, setInsuranceStatus] = useState('Ready');
  const [declines, setDeclines] = useState(0);
  const [rabbitRequests, setRabbitRequests] = useState(0);

  const rejectInsurance = useCallback(async () => {
    setInsuranceRequests((count) => count + 1);
    setInsuranceStatus('Submitting');
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    setInsuranceStatus('Insurance Request Rejected. Please Try Again.');
    return false;
  }, []);

  const declineInsurance = useCallback(async () => {
    setDeclines((count) => count + 1);
    setShowInsurance(false);
    return true;
  }, []);

  const revealRabbit = useCallback(async (): Promise<RabbitHuntRevealResult> => {
    setRabbitRequests((count) => count + 1);
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    return {
      success: true,
      cards: [
        { rank: 'T', suit: 'c' },
        { rank: '9', suit: 'c' },
      ],
      diamondsSpent: 5,
      source: 'diamonds',
    };
  }, []);

  return (
    <main
      data-testid="financial-decision-showcase"
      style={{ minHeight: '100dvh', background: '#05080d', color: '#fff', padding: 16 }}
    >
      <h1>Financial Decision Browser Harness</h1>
      <output data-testid="insurance-request-count">{insuranceRequests}</output>
      <output data-testid="insurance-status">{insuranceStatus}</output>
      <output data-testid="decline-count">{declines}</output>
      <output data-testid="rabbit-request-count">{rabbitRequests}</output>
      <InsuranceModal
        isOpen={showInsurance}
        onClose={declineInsurance}
        onAccept={rejectInsurance}
        onDecline={declineInsurance}
        onDeclineForHand={declineInsurance}
        offer={OFFER}
      />
      {!showInsurance && (
        <RabbitHunt
          isAvailable={true}
          cardsAvailable={2}
          rabbitDiamondCost={5}
          userId={TEST_USER_ID}
          onReveal={revealRabbit}
        />
      )}
    </main>
  );
}
