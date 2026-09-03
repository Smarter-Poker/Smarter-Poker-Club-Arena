import React from 'react';
import './ButtonGroup.css';

interface ButtonGroupProps {
  children: React.ReactNode;
  orientation?: 'horizontal' | 'vertical';
  attached?: boolean;
}

export const ButtonGroup: React.FC<ButtonGroupProps> = ({
  children,
  orientation = 'horizontal',
  attached = false,
}) => {
  return (
    <div className={`button-group ${orientation} ${attached ? 'attached' : ''}`}>{children}</div>
  );
};

export default ButtonGroup;
