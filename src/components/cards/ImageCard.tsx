import React from 'react';
import './ImageCard.css';

interface ImageCardProps {
  imageUrl: string;
  title: string;
  subtitle?: string;
  badge?: string;
  onClick?: () => void;
  aspectRatio?: '16:9' | '4:3' | '1:1';
}

export const ImageCard: React.FC<ImageCardProps> = ({
  imageUrl,
  title,
  subtitle,
  badge,
  onClick,
  aspectRatio = '16:9',
}) => {
  return (
    <div className={`image-card aspect-${aspectRatio.replace(':', '-')}`} onClick={onClick}>
      <div className="image-wrapper">
        <img loading="lazy" decoding="async" src={imageUrl} alt={title} />
        {badge && <span className="image-badge">{badge}</span>}
      </div>
      <div className="image-content">
        <h4>{title}</h4>
        {subtitle && <p>{subtitle}</p>}
      </div>
    </div>
  );
};

export default ImageCard;
