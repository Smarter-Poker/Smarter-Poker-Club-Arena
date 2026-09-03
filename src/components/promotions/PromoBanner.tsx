import React from 'react';
import './PromoBanner.css';

interface PromoBannerProps {
  title: string;
  subtitle?: string;
  ctaText?: string;
  backgroundGradient?: string;
  iconEmoji?: string;
  onCta?: () => void;
  onDismiss?: () => void;
}

export const PromoBanner: React.FC<PromoBannerProps> = ({
  title,
  subtitle,
  ctaText,
  backgroundGradient = 'linear-gradient(90deg, #7c3aed, #db2777)',
  iconEmoji = '',
  onCta,
  onDismiss,
}) => {
  return (
    <div className="promo-banner" style={{ background: backgroundGradient }}>
      <div className="banner-icon">{iconEmoji}</div>

      <div className="banner-content">
        <h4>{title}</h4>
        {subtitle && <p>{subtitle}</p>}
      </div>

      {ctaText && (
        <button className="banner-cta" onClick={onCta}>
          {ctaText}
        </button>
      )}

      {onDismiss && (
        <button className="banner-dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
};

export default PromoBanner;
