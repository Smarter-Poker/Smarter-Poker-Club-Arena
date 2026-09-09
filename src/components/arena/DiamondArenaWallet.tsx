import { lazy, Suspense, useState } from 'react';

const DiamondWalletModal = lazy(() => import('../wallet/DiamondWalletModal'));
const DiamondTopUpModal = lazy(() =>
  import('../vip/DiamondTopUpModal').then((module) => ({ default: module.DiamondTopUpModal }))
);

/** Opens the shared wallet over the lobby without navigating the active table. */
export default function DiamondArenaWallet() {
  const [view, setView] = useState<'closed' | 'wallet' | 'top-up'>('closed');
  return (
    <>
      <button className="btn btn-primary" onClick={() => setView('wallet')}>
        Open Diamond Wallet
      </button>
      <Suspense fallback={<p role="status">Loading Diamond Wallet</p>}>
        {view === 'wallet' && (
          <DiamondWalletModal
            isOpen
            onClose={() => setView('closed')}
            onBuyClick={() => setView('top-up')}
          />
        )}
        {view === 'top-up' && <DiamondTopUpModal isOpen onClose={() => setView('wallet')} />}
      </Suspense>
    </>
  );
}
