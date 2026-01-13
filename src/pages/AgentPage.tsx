/**
 * ♠ CLUB ARENA — Agent Page (Legacy Redirect)
 * This legacy page has been deprecated in favor of AgentManagementPage
 */

import { useParams, Navigate } from 'react-router-dom';

export default function AgentPage() {
    const { clubId } = useParams();

    // Redirect to the new Agent Management Page
    return <Navigate to={`/clubs/${clubId}/agents`} replace />;
}
