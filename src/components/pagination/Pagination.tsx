import React from 'react';
import './Pagination.css';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  showFirstLast?: boolean;
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  onPageChange,
  showFirstLast = true,
}) => {
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const showPages = 5;
    let start = Math.max(1, currentPage - Math.floor(showPages / 2));
    const end = Math.min(totalPages, start + showPages - 1);

    if (end - start < showPages - 1) {
      start = Math.max(1, end - showPages + 1);
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    return pages;
  };

  return (
    <div className="pagination">
      {showFirstLast && (
        <button disabled={currentPage === 1} onClick={() => onPageChange(1)}>
          ««
        </button>
      )}
      <button disabled={currentPage === 1} onClick={() => onPageChange(currentPage - 1)}>
        ‹
      </button>

      {getPageNumbers().map((page, idx) => (
        <button
          key={idx}
          className={page === currentPage ? 'active' : ''}
          onClick={() => typeof page === 'number' && onPageChange(page)}
          disabled={typeof page !== 'number'}
        >
          {page}
        </button>
      ))}

      <button disabled={currentPage === totalPages} onClick={() => onPageChange(currentPage + 1)}>
        ›
      </button>
      {showFirstLast && (
        <button disabled={currentPage === totalPages} onClick={() => onPageChange(totalPages)}>
          »»
        </button>
      )}
    </div>
  );
};

export default Pagination;
