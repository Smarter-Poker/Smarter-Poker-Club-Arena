import React from 'react';
import './PromoCard.css';

interface PromoCardProps {
  title: string;
  description: string;
  badge?: string;
  imageUrl?: string;
  ctaText?: string;
  expiresAt?: Date;
  isNew?: boolean;
  onClick?: () => void;
}

export const PromoCard: React.FC<PromoCardProps> = ({
  title,
  description,
  badge,
  imageUrl,
  ctaText = 'Learn More',
  expiresAt,
  isNew = false,
  onClick,
}) => {
  const getTimeRemaining = () => {
    if (!expiresAt) return null;
    const now = new Date();
    const diff = expiresAt.getTime() - now.getTime();
    if (diff <= 0) return 'Expired';

    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);

    if (days > 0) return `${days}d ${hours}h left`;
    return `${hours}h left`;
  };

  return (
    <div className={`promo-card__promo-card ${isNew ? 'new' : ''}`} onClick={onClick}>
      {imageUrl && (
        <div className="promo-card__promo-image">
          <img loading="lazy" decoding="async" src={imageUrl} alt={title} />
        </div>
      )}

      <div className="promo-card__promo-content">
        {isNew && <span className="new-badge">NEW</span>}
        {badge && <span className="promo-badge">{badge}</span>}

        <h3>{title}</h3>
        <p>{description}</p>

        <div className="promo-footer">
          {expiresAt && <span className="promo-expires"> {getTimeRemaining()}</span>}
          <button className="promo-cta">{ctaText}</button>
        </div>
      </div>
    </div>
  );
};

export default PromoCard;
