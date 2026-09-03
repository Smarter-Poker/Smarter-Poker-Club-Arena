import React from 'react';
import './ListItem.css';

interface ListItemProps {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
}

export const ListItem: React.FC<ListItemProps> = ({ title, subtitle, left, right, onClick }) => {
  return (
    <div className={`list-item ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      {left && <div className="list-item-left">{left}</div>}
      <div className="list-item-content">
        <div className="list-item-title">{title}</div>
        {subtitle && <div className="list-item-subtitle">{subtitle}</div>}
      </div>
      {right && <div className="list-item-right">{right}</div>}
    </div>
  );
};

export default ListItem;
