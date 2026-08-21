const fs = require('fs');
const file = 'src/pages/CashierTradePage.tsx';
let code = fs.readFileSync(file, 'utf8');

// Add states
const stateTarget = `  const [requestsLoading, setRequestsLoading] = useState(false);`;
const stateReplacement = `  const [requestsLoading, setRequestsLoading] = useState(false);

  // Agent Role Management
  const [roleModalTarget, setRoleModalTarget] = useState<DownlineRow | null>(null);
  const [roleModalBusy, setRoleModalBusy] = useState(false);
  const [roleModalSelection, setRoleModalSelection] = useState<string>('player');

  // Bulk Transfer Results
  const [transferResults, setTransferResults] = useState<{ successes: string[]; failures: { name: string; error: string }[] } | null>(null);`;
code = code.replace(stateTarget, stateReplacement);

// Add grantable roles
const grantableRolesTarget = `  const respondToRequest = async (id: string, action: 'approve' | 'decline' | 'cancel') => {`;
const grantableRolesReplacement = `  const ROLE_LABEL: Record<string, string> = {
    owner: 'Club Owner',
    admin: 'Administrator',
    super_agent: 'Super Agent',
    agent: 'Agent',
    sub_agent: 'Sub Agent',
    player: 'Player',
  };

  const getGrantableRoles = (promoterRole: string, targetCurrentRole: string) => {
    if (promoterRole === 'owner') return ['admin', 'super_agent', 'agent', 'sub_agent', 'player'];
    if (promoterRole === 'admin') return ['super_agent', 'agent', 'sub_agent', 'player'];
    if (promoterRole === 'super_agent') return ['agent', 'sub_agent', 'player'];
    return [];
  };

  const submitRoleChange = async () => {
    if (!clubUuid || !roleModalTarget || !user?.id) return;
    setRoleModalBusy(true);
    try {
      const { data, error } = await supabase.rpc('promote_member', {
        p_club_id: clubUuid,
        p_target_user_id: roleModalTarget.userId,
        p_new_role: roleModalSelection,
        p_promoted_by: user.id
      });
      if (error) throw error;
      const res = data as any;
      if (!res.success) throw new Error(res.error || 'Failed to change role');
      toast?.success?.(res.message || 'Role updated successfully');
      setRoleModalTarget(null);
      loadClub();
    } catch (err: any) {
      toast?.error?.(err.message || 'Failed to update role');
    } finally {
      setRoleModalBusy(false);
    }
  };

  const respondToRequest = async (id: string, action: 'approve' | 'decline' | 'cancel') => {`;
code = code.replace(grantableRolesTarget, grantableRolesReplacement);

fs.writeFileSync(file, code);
