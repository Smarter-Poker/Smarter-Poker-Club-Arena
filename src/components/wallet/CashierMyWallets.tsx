import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DynamicWallet from './DynamicWallet';
import WalletCashierModal from './WalletCashierModal';
import PlayerWalletModal from './PlayerWalletModal';
import DiamondWalletModal from './DiamondWalletModal';
import { DEFAULT_CASHIER_WALLET } from './cashierModes';
import UnionWalletModal, { type UnionWalletKey } from '../union/UnionWalletModal';
import UnionTreasuryDetailModal, {
  type TreasuryDetailMode,
} from '../union/UnionTreasuryDetailModal';
import Modal from '../common/Modal';
import { RakeReports } from '../admin/RakeReports';
import SpinActivationPanel from '../club/SpinActivationPanel';
import haptic from '../../services/HapticService';
import { withClubContext } from '../../utils/clubScopedPath';
import './CashierMyWallets.css';

/** The existing role-safe wallet directory belongs inside the Cashier. */
export default function CashierMyWallets({
  userId,
  clubId,
  role,
  variant = 'club',
}: {
  userId: string;
  clubId: string;
  role: string;
  variant?: 'club' | 'union';
}) {
  const navigate = useNavigate();
  const walletListId = useId();
  const [walletsExpanded, setWalletsExpanded] = useState(false);
  const [visibleWalletCount, setVisibleWalletCount] = useState(0);
  const [activeCashier, setActiveCashier] = useState<
    'club_bank' | 'promo_wallet' | 'agent_wallet' | null
  >(null);
  const [unionWalletModal, setUnionWalletModal] = useState<{
    key: UnionWalletKey;
    label: string;
    balance: number;
  } | null>(null);
  const [unionTreasuryModal, setUnionTreasuryModal] = useState<TreasuryDetailMode | null>(null);
  const [standaloneRakeModal, setStandaloneRakeModal] = useState(false);
  const [standaloneSpinsModal, setStandaloneSpinsModal] = useState(false);
  // Dan 2026-08-24: "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE
  // ALL TRANSACTIONS AND OTHER AVAILABLE DATA WHEN CLICKED." The row opens the
  // member's own statement - a read-only view, so it is not an activeCashier.
  const [showPlayerWallet, setShowPlayerWallet] = useState(false);
  const [showDiamondWallet, setShowDiamondWallet] = useState(false);

  return (
    <section className="cashier-my-wallets" aria-label="My Wallets">
      <button
        type="button"
        className="lobby-wallets-trigger"
        aria-expanded={walletsExpanded}
        aria-controls={walletListId}
        onClick={() => {
          haptic.selection();
          setWalletsExpanded((expanded) => !expanded);
        }}
      >
        <span className="lobby-wallets-trigger__icon" aria-hidden="true" />
        <span className="lobby-wallets-trigger__copy">
          <strong>My Wallets</strong>
          {/* THE COUNT, OR NOTHING AT ALL (Dan 2026-09-09): it
                      "shouldn't say LOADING BALANC. It should just have 5
                      BALANCES or how ever many wallets that user has only."

                      DynamicWallet knows how many rows this viewer gets before
                      a single balance has loaded - the row set comes from the
                      role, not from the money - and it now publishes that count
                      in a layout effect, so the real number is here for the
                      first painted frame. The empty string is only the frame
                      before that: an empty bay, never a word that has to be
                      taken back a moment later. */}
          <small>
            {visibleWalletCount > 0
              ? `${visibleWalletCount} ${visibleWalletCount === 1 ? 'Balance' : 'Balances'}`
              : ''}
          </small>
        </span>
        <span
          className={`lobby-wallets-trigger__chevron ${walletsExpanded ? 'is-expanded' : ''}`}
          aria-hidden="true"
        />
      </button>
      <div
        id={walletListId}
        className="lobby-wallets-content"
        data-expanded={walletsExpanded}
        hidden={!walletsExpanded}
      >
        <div className="lobby-wallets-content__inner">
          {/* The lobby renders its own compact Bad Beat Jackpot tile next
                  to the club identity. DynamicWallet therefore suppresses its
                  duplicate jackpot banner and supplies only the role-safe
                  balance tiles below it. */}
          <DynamicWallet
            userId={userId}
            clubId={clubId || ''}
            // The selected cashier entity owns these books.
            variant={variant}
            // WHO is looking. Decides which rows exist - see walletRows.ts.
            // The club's owner_id outranks a stale club_members row, which
            // is how a brand new owner sees their own Club Bank.
            role={role}
            compactLobby
            showAllLobbyWallets
            showBBJ={false}
            onVisibleWalletCountChange={setVisibleWalletCount}
            onBuyDiamonds={() => {
              haptic.medium();
              setShowDiamondWallet(true);
            }}
            // Dan 2026-08-23: "if they click on Club Bank, that should
            // open the Club Bank Cashier." The row only renders for owner,
            // co-owner, admin and super agent, and fn_can_use_club_bank
            // refuses everyone else server-side. The Chip Mint moved
            // INSIDE that cashier - there is no mint button out here any
            // more, and no mint at all once the club is in a union.
            onOpenPlayerWallet={() => setShowPlayerWallet(true)}
            onOpenPromoWallet={() => setActiveCashier('promo_wallet')}
            onOpenAgentWallet={() => setActiveCashier('agent_wallet')}
            onOpenClubBank={() => setActiveCashier('club_bank')}
            onOpenBBJ={() => {
              haptic.medium();
              navigate(`/clubs/${clubId}/jackpot`);
            }}
            onOpenUnionBank={(balance) => {
              setUnionWalletModal({ key: 'chips', label: 'Union Bank', balance });
            }}
            onOpenUnionRake={() => setUnionTreasuryModal('rake')}
            onOpenUnionBackupBBJ={() => setUnionTreasuryModal('backup')}
            onOpenUnionPromo={(balance) => {
              setUnionWalletModal({ key: 'promo', label: 'Promo Wallet', balance });
            }}
            onOpenUnionSpins={(balance) => {
              setUnionWalletModal({
                key: 'spin_reserve',
                label: 'Spins Treasury',
                balance,
              });
            }}
            onOpenClubRake={() => setStandaloneRakeModal(true)}
            onOpenClubSpins={() => setStandaloneSpinsModal(true)}
          />
        </div>
      </div>
      <WalletCashierModal
        isOpen={!!activeCashier}
        onClose={() => setActiveCashier(null)}
        clubId={clubId}
        role={role}
        walletType={activeCashier || DEFAULT_CASHIER_WALLET}
      />
      {unionWalletModal && (
        <UnionWalletModal
          isOpen={true}
          onClose={() => setUnionWalletModal(null)}
          unionId={clubId}
          walletKey={unionWalletModal.key}
          walletLabel={unionWalletModal.label}
          balance={unionWalletModal.balance}
        />
      )}
      {unionTreasuryModal && (
        <UnionTreasuryDetailModal
          isOpen={true}
          onClose={() => setUnionTreasuryModal(null)}
          unionId={clubId}
          mode={unionTreasuryModal}
          onSendFrom={
            unionTreasuryModal === 'backup'
              ? undefined
              : () => {
                  const isRake = unionTreasuryModal === 'rake';
                  setUnionTreasuryModal(null);
                  setUnionWalletModal({
                    key: isRake ? 'rake' : 'bbj',
                    label: isRake ? 'Rake Treasury' : 'BBJ Pool',
                    // The wallet modal fetches the true balance anyway, so 0 is fine
                    balance: 0,
                  });
                }
          }
        />
      )}
      {standaloneRakeModal && (
        <Modal
          isOpen={true}
          onClose={() => setStandaloneRakeModal(false)}
          title="Rake Treasury"
          size="large"
          showCloseButton
          className="cashier-my-wallets__treasury"
        >
          <div style={{ height: '70vh', overflowY: 'auto', padding: '0 12px 24px' }}>
            <RakeReports clubId={clubId} />
          </div>
        </Modal>
      )}
      {standaloneSpinsModal && (
        <Modal
          isOpen={true}
          onClose={() => setStandaloneSpinsModal(false)}
          title="Spins Wallet"
          size="medium"
          showCloseButton
          className="cashier-my-wallets__treasury"
        >
          <div style={{ padding: '0 12px 24px' }}>
            <SpinActivationPanel clubId={clubId} />
          </div>
        </Modal>
      )}
      <PlayerWalletModal
        isOpen={showPlayerWallet}
        onClose={() => setShowPlayerWallet(false)}
        clubId={clubId}
      />
      <DiamondWalletModal
        isOpen={showDiamondWallet}
        onClose={() => setShowDiamondWallet(false)}
        onBuyClick={() => navigate(withClubContext('/vip', clubId))}
      />
    </section>
  );
}
