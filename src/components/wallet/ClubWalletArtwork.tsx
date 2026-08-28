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

/** Canonical Club Arena wallet-art mapping. Dynamic values stay out of the images. */
export const CLUB_WALLET_ARTWORK: Record<ClubWalletArtworkKind, string> = {
  diamonds: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-diamonds-square-v1.webp`,
  club_bank: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-club-bank-square-v1.webp`,
  promo_wallet: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-promo-wallet-square-v1.webp`,
  union_promo: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-promo-wallet-square-v1.webp`,
  agent_wallet: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-agent-wallet-square-v1.webp`,
  player_wallet: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-player-wallet-square-v1.webp`,
  union_bank: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-union-bank-square-v1.webp`,
  rake_treasury: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-rake-treasury-square-v1.webp`,
  union_rake: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-rake-treasury-square-v1.webp`,
  backup_bbj: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-backup-bbj-wallet-square-v1.webp`,
  union_backup_bbj: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-backup-bbj-wallet-square-v1.webp`,
  spins_wallet: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-spins-treasury-square-v1.webp`,
  union_spins: `${CLUB_BUTTONS_ASSET_ROOT}/wallets/square/wallet-spins-treasury-square-v1.webp`,
};

export const CLUB_BBJ_ARTWORK = `${CLUB_BUTTONS_ASSET_ROOT}/bbj/bbj-dynamic-plaque-v1.webp`;

export function ClubWalletShell({ kind }: { kind: ClubWalletArtworkKind }) {
  return (
    <img className="dw__row-shell" src={CLUB_WALLET_ARTWORK[kind]} alt="" aria-hidden="true" />
  );
}

export function ClubBBJShell({ className = 'dw__bbj-shell' }: { className?: string }) {
  return <img className={className} src={CLUB_BBJ_ARTWORK} alt="" aria-hidden="true" />;
}
