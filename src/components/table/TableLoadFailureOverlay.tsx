import { useNavigate } from 'react-router-dom';

interface TableLoadFailureOverlayProps {
  tableLoadFailure: 'missing' | 'unreachable';
  exitDestination: () => string;
}

export function TableLoadFailureOverlay({
  tableLoadFailure,
  exitDestination,
}: TableLoadFailureOverlayProps) {
  const navigate = useNavigate();

  return (
    <div
      className="table-load-failure-overlay"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(5, 8, 14, 0.92)',
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        className="table-load-failure-box"
        style={{
          maxWidth: 420,
          width: '100%',
          textAlign: 'center',
          background: '#141a24',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 14,
          padding: '22px 20px',
          color: '#e8edf5',
          boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
        }}
      >
        <h2
          className="table-load-failure__title"
          style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700 }}
        >
          {tableLoadFailure === 'missing' ? 'This Table Has Closed' : 'Cannot Reach This Table'}
        </h2>
        <p
          className="table-load-failure__body"
          style={{
            margin: '0 0 18px',
            fontSize: 14,
            lineHeight: 1.5,
            color: 'rgba(232,237,245,0.75)',
          }}
        >
          {tableLoadFailure === 'missing'
            ? 'That Game Has Finished And The Table Was Taken Down. Nothing Was Charged And No Seat Was Taken.'
            : 'We Could Not Load This Table After Five Tries. Your Connection May Be Down.'}
        </p>
        <div
          className="table-load-failure__actions"
          style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}
        >
          {tableLoadFailure === 'unreachable' && (
            <button
              type="button"
              className="table-load-failure__btn table-load-failure__btn--primary"
              onClick={() => window.location.reload()}
              style={{
                minHeight: 44,
                padding: '0 18px',
                borderRadius: 10,
                border: 'none',
                background: '#2f6fed',
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
          )}
          <button
            type="button"
            className="table-load-failure__btn"
            onClick={() => navigate(exitDestination())}
            style={{
              minHeight: 44,
              padding: '0 18px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.22)',
              background: 'transparent',
              color: '#e8edf5',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Back To Lobby
          </button>
        </div>
      </div>
    </div>
  );
}
