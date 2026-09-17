import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useDiamondGamesEntry } from '../../hooks/useDiamondGamesEntry';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import './DiamondBustPrompt.css';

/** The server excludes seats still in play, including an all-in zero stack. */
export default function DiamondBustPrompt({ clubId }: { clubId: string | null | undefined }) {
  const { user } = useAuthUser();
  const { entry } = useDiamondGamesEntry(clubId);
  const navigate = useNavigate();
  const key = `diamond-spins-bust:${user?.id ?? ''}:${clubId ?? ''}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const eligible = entry?.bust_prompt === true && entry.member_chips === 0 && entry.diamonds >= 25;
  useEffect(() => {
    if (entry && entry.member_chips !== null && entry.member_chips > 0) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* Session storage is an optional dismissal hint. */
      }
      setDismissed(null);
    }
  }, [entry, key]);
  let stored = false;
  try {
    stored = sessionStorage.getItem(key) === 'dismissed';
  } catch {
    /* Render without the optional hint. */
  }
  const close = () => {
    setDismissed(key);
    try {
      sessionStorage.setItem(key, 'dismissed');
    } catch {
      /* In-memory dismissal still works. */
    }
  };
  return (
    <Modal
      isOpen={Boolean(user?.id && clubId && eligible && dismissed !== key && !stored)}
      onClose={close}
      ariaLabel="Diamond Spins"
      showCloseButton={false}
      size="small"
      className="diamond-bust-prompt"
    >
      <SpadeConsole
        crest="diamond"
        title="Diamond Spins"
        eyebrow="Out Of Chips?"
        pill={`${entry?.diamonds ?? 0} Diamonds`}
        plates={{
          secondary: { label: 'Not Now', onClick: close },
          primary: {
            label: 'Play Diamond Spins',
            onClick: () => {
              close();
              navigate(`/clubs/${clubId}/wheel`);
            },
          },
        }}
      >
        <p className="sc-copy">
          You Have Diamonds Ready To Play. Entries Start At 25 Diamonds, With Chip Prizes Paid Into
          Your Club Wallet.
        </p>
        <button
          type="button"
          className="diamond-bust-prompt__earn"
          onClick={() => {
            close();
            navigate(`/clubs/${clubId}/earn-diamonds`);
          }}
        >
          Earn Diamonds Daily
        </button>
      </SpadeConsole>
    </Modal>
  );
}
