const fs = require('fs');
const file = 'src/pages/CashierTradePage.tsx';
let code = fs.readFileSync(file, 'utf8');

// Inject "Manage Role" into footer
const footerTarget = `          {/* Footer actions — pinned */}
          <div className={styles.footer}>`;

const footerReplacement = `          {/* Footer actions — pinned */}
          <div className={styles.footer}>
            {selected.size === 1 && getGrantableRoles(myRole, list.find(r => selected.has(r.userId))?.role || 'player').length > 0 && (
              <button
                className={styles.footerBtn}
                style={{ background: '#4169E1' }}
                disabled={busy}
                onClick={() => setRoleModalTarget(list.find(r => selected.has(r.userId)) || null)}
              >
                Role
              </button>
            )}`;
code = code.replace(footerTarget, footerReplacement);

// Inject modals at the bottom before final </div>
const modalTarget = `      {/* Amount modal */}`;
const modalReplacement = `      {/* Role Assignment Modal */}
      {roleModalTarget && (
        <div className={styles.modalOverlay} onClick={() => !roleModalBusy && setRoleModalTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>
              Change Role: {roleModalTarget.name}
            </div>
            <div style={{ marginBottom: '1rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.9rem' }}>
              Current Role: {ROLE_LABEL[roleModalTarget.role] || roleModalTarget.role}
            </div>
            <select 
              value={roleModalSelection} 
              onChange={(e) => setRoleModalSelection(e.target.value)}
              style={{ width: '100%', padding: '10px', background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: '8px', marginBottom: '1rem' }}
            >
              {getGrantableRoles(myRole, roleModalTarget.role).map((role) => (
                <option key={role} value={role}>{ROLE_LABEL[role] || role}</option>
              ))}
            </select>
            <div className={styles.modalActions}>
              <button disabled={roleModalBusy} onClick={() => setRoleModalTarget(null)}>
                Cancel
              </button>
              <button
                className={styles.modalConfirm}
                disabled={roleModalBusy}
                onClick={submitRoleChange}
              >
                {roleModalBusy ? 'Working...' : 'Save Role'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Transfer Results Modal */}
      {transferResults && (
        <div className={styles.modalOverlay} onClick={() => setTransferResults(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <div className={styles.modalTitle} style={{ textAlign: 'center' }}>
              Transfer Results
            </div>
            
            <div style={{ margin: '1.5rem 0' }}>
              <div style={{ color: '#4ade80', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                ✓ {transferResults.successes.length} Successful
              </div>
              
              {transferResults.failures.length > 0 && (
                <div style={{ color: '#f87171', fontWeight: 'bold', marginTop: '1rem' }}>
                  ✕ {transferResults.failures.length} Failed
                </div>
              )}
              {transferResults.failures.length > 0 && (
                <div style={{ 
                  background: 'rgba(248, 113, 113, 0.1)', 
                  border: '1px solid rgba(248, 113, 113, 0.3)', 
                  borderRadius: '8px', 
                  padding: '10px',
                  marginTop: '0.5rem',
                  fontSize: '0.85rem'
                }}>
                  {transferResults.failures.map((f, i) => (
                    <div key={i} style={{ marginBottom: '4px' }}>
                      <span style={{ color: 'white' }}>{f.name}:</span> {f.error}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.modalActions} style={{ justifyContent: 'center' }}>
              <button
                className={styles.modalConfirm}
                style={{ width: '100%' }}
                onClick={() => setTransferResults(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Amount modal */}`;
code = code.replace(modalTarget, modalReplacement);

fs.writeFileSync(file, code);
