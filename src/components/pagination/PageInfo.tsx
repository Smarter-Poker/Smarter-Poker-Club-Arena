import React from 'react';
import './PageInfo.css';

interface PageInfoProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
}

export const PageInfo: React.FC<PageInfoProps> = ({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
}) => {
  const start = (currentPage - 1) * itemsPerPage + 1;
  const end = Math.min(currentPage * itemsPerPage, totalItems);

  return (
    <div className="page-info">
      Showing{' '}
      <strong>
        {start}-{end}
      </strong>{' '}
      Of <strong>{totalItems}</strong>
      <span className="page-number">
        Page {currentPage} Of {totalPages}
      </span>
    </div>
  );
};

export default PageInfo;
