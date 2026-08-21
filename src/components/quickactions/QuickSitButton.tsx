import React from 'react';
import './QuickSitButton.css';

interface QuickSitButtonProps {
  tableId: string;
  tableName: string;
  stakes: string;
  availableSeats: number;
  defaultBuyIn?: number;
  onQuickSit?: (tableId: string, buyIn: number) => void;
}

export const QuickSitButton: React.FC<QuickSitButtonProps> = ({
  tableId,
  tableName,
  stakes,
  availableSeats,
  defaultBuyIn = 100,
  onQuickSit,
}) => {
  const handleClick = () => {
    if (availableSeats > 0) {
      onQuickSit?.(tableId, defaultBuyIn);
    }
  };

  const isDisabled = availableSeats === 0;

  return (
    <button
      className={`quick-sit-button ${isDisabled ? 'disabled' : ''}`}
      onClick={handleClick}
      disabled={isDisabled}
    >
      <div className="quick-sit-icon"></div>
      <div className="quick-sit-content">
        <span className="quick-sit-label">Quick Sit</span>
        <span className="quick-sit-info">
          {stakes} • {availableSeats} Seat{availableSeats !== 1 ? 's' : ''}
        </span>
      </div>
    </button>
  );
};

export default QuickSitButton;
