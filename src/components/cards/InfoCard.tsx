import React from 'react';
import './InfoCard.css';

interface InfoCardProps {
  title: string;
  description?: string;
  icon?: string;
  variant?: 'default' | 'highlighted' | 'warning';
  children?: React.ReactNode;
}

export const InfoCard: React.FC<InfoCardProps> = ({
  title,
  description,
  icon,
  variant = 'default',
  children,
}) => {
  return (
    <div className={`info-card variant-${variant}`}>
      {icon && <div className="info-icon">{icon}</div>}
      <div className="info-content">
        <h4>{title}</h4>
        {description && <p>{description}</p>}
        {children}
      </div>
    </div>
  );
};

export default InfoCard;
