import React from 'react';
import './Container.css';

interface ContainerProps {
  children: React.ReactNode;
  size?: 'small' | 'medium' | 'large' | 'full';
  padding?: boolean;
}

export const Container: React.FC<ContainerProps> = ({
  children,
  size = 'medium',
  padding = true,
}) => {
  return (
    <div className={`container size-${size} ${padding ? 'with-padding' : ''}`}>{children}</div>
  );
};

export default Container;
