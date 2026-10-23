import { mediaUrl } from '../../utils/mediaBase';

/** The approved chrome-and-blue bolt, shared with the game's own artwork. */
export default function LightningGamesIcon() {
  return (
    <img
      className="lt-lightning-icon"
      src={mediaUrl('images/throwables/stylized/lightning_bolt-192-242cf8769546.webp')}
      alt="Lightning Games"
      title="Lightning Games"
      width={14}
      height={20}
    />
  );
}
