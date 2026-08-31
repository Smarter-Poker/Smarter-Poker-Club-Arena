import { useEffect, useState } from 'react';
import {
  ClubBBJShell,
  ClubWalletShell,
  type ClubWalletArtworkKind,
} from '../../components/wallet/ClubWalletArtwork';
import '../../components/wallet/DynamicWallet.css';
import './ClubWalletPreviewPage.css';

const wallets: ReadonlyArray<{
  kind: ClubWalletArtworkKind;
  label: string;
  baseValue: number;
  decimals?: number;
}> = [
  { kind: 'diamonds', label: 'Diamonds', baseValue: 493_385, decimals: 0 },
  { kind: 'club_bank', label: 'Club Bank', baseValue: 1_376_610.47 },
  { kind: 'promo_wallet', label: 'Promo Wallet', baseValue: 18_250 },
  { kind: 'agent_wallet', label: 'Agent Wallet', baseValue: 80_000 },
  { kind: 'player_wallet', label: 'Player Wallet', baseValue: 500_745.95 },
  { kind: 'union_bank', label: 'Union Bank', baseValue: 2_450_000 },
  { kind: 'rake_treasury', label: 'Rake Treasury', baseValue: 186_440.22 },
  { kind: 'backup_bbj', label: 'Back Up BBJ Wallet', baseValue: 63_250 },
  { kind: 'spins_wallet', label: 'Spins Treasury', baseValue: 95_000 },
];

const formatValue = (value: number, decimals = 2) =>
  value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

export default function ClubWalletPreviewPage() {
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setPulse((value) => value + 1), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="club-wallet-preview">
      <header className="club-wallet-preview__header">
        <span>#ClubButtons · Club Arena Only</span>
        <h1>Approved Dynamic Wallet Set</h1>
        <p>Nine Wallet Types And The BBJ Plaque. Values Below Are Live Text, Not Image Content.</p>
      </header>

      <section className="club-wallet-preview__bbj" aria-label="Bad Beat Jackpot Preview">
        <div className="dw__bbj">
          <ClubBBJShell />
          <span className="dw__bbj-label">Bad Beat Jackpot</span>
          <strong className="dw__bbj-amount">{formatValue(83_011.01 + pulse * 0.01)}</strong>
        </div>
      </section>

      <section className="club-wallet-preview__grid" aria-label="All Nine Wallet Types">
        {wallets.map(({ kind, label, baseValue, decimals }) => (
          <article
            key={kind}
            className="dw__row dw__row--wallet-art club-wallet-preview__tile"
            aria-label={`${label}: ${formatValue(baseValue + pulse * 0.01, decimals)}`}
          >
            <ClubWalletShell kind={kind} />
            <span className="dw__row-value">{formatValue(baseValue + pulse * 0.01, decimals)}</span>
          </article>
        ))}
      </section>
    </main>
  );
}
