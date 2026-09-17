import { Link } from 'react-router-dom';

/** A platform page has no exact club/union week to certify. */
export function SettlementCronStatus() {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderRadius: 8,
        border: '1px solid #667085',
        fontSize: 13,
        color: '#e4e7ec',
      }}
    >
      <strong>Weekly Accounting</strong>
      <p style={{ margin: '6px 0' }}>
        Open A Club Or Union To View Its Recorded Accounting Status.
      </p>
      <Link to="/settlement-dashboard">View Accounting</Link>
    </div>
  );
}

export default SettlementCronStatus;
