export type ClubWalletArtworkKind =
  | 'diamonds'
  | 'club_bank'
  | 'promo_wallet'
  | 'union_promo'
  | 'agent_wallet'
  | 'player_wallet'
  | 'union_bank'
  | 'rake_treasury'
  | 'union_rake'
  | 'backup_bbj'
  | 'union_backup_bbj'
  | 'spins_wallet'
  | 'union_spins';

const CLUB_BUTTONS_ASSET_ROOT = `${import.meta.env.BASE_URL}assets/club-buttons`;

type ClubWalletArtworkSources = {
  desktop: string;
  mobile: string;
};

const walletSources = (filename: string): ClubWalletArtworkSources => ({
  desktop: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/desktop/${filename}-v1.webp`,
  mobile: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/mobile/${filename}-v1.webp`,
});

/**
 * Canonical Club Arena wallet-art mapping. The artwork supplies only the
 * icon, title and frame; every balance remains live DOM text in the empty bay.
 */
export const CLUB_WALLET_ARTWORK: Record<ClubWalletArtworkKind, ClubWalletArtworkSources> = {
  diamonds: walletSources('wallet-diamonds'),
  club_bank: walletSources('wallet-club-bank'),
  promo_wallet: walletSources('wallet-promo-wallet'),
  union_promo: walletSources('wallet-promo-wallet'),
  agent_wallet: walletSources('wallet-agent-wallet'),
  player_wallet: walletSources('wallet-player-wallet'),
  union_bank: walletSources('wallet-union-bank'),
  rake_treasury: walletSources('wallet-rake-treasury'),
  union_rake: walletSources('wallet-rake-treasury'),
  backup_bbj: walletSources('wallet-backup-bbj-wallet'),
  union_backup_bbj: walletSources('wallet-backup-bbj-wallet'),
  spins_wallet: walletSources('wallet-spins-treasury'),
  union_spins: walletSources('wallet-spins-treasury'),
};

export const CLUB_BBJ_ARTWORK = `${CLUB_BUTTONS_ASSET_ROOT}/bbj/bbj-dynamic-plaque-v1.webp`;

export function ClubWalletShell({ kind }: { kind: ClubWalletArtworkKind }) {
  const artwork = CLUB_WALLET_ARTWORK[kind];

  return (
    <picture className="dw__row-picture" aria-hidden="true">
      <source media="(max-width: 640px)" srcSet={artwork.mobile} />
      <img className="dw__row-shell" src={artwork.desktop} alt="" />
    </picture>
  );
}

export function ClubBBJShell({ className = 'dw__bbj-shell' }: { className?: string }) {
  return <img className={className} src={CLUB_BBJ_ARTWORK} alt="" aria-hidden="true" />;
}
