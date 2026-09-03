import React from 'react';
import './Icon.css';

interface IconProps {
  name: string;
  size?: 'small' | 'medium' | 'large';
  color?: string;
}

const ICONS: Record<string, string> = {
  home: '',
  settings: '',
  user: '',
  users: '',
  search: '',
  plus: '+',
  minus: '-',
  close: '×',
  check: '',
  warning: '',
  info: '',
  star: '',
  heart: '❤',
  trophy: '',
  chip: '',
  diamond: '',
  cards: '',
  fire: '',
};

export const Icon: React.FC<IconProps> = ({ name, size = 'medium', color }) => {
  return (
    <span className={`icon size-${size}`} style={{ color }}>
      {ICONS[name] || '●'}
    </span>
  );
};

export default Icon;
