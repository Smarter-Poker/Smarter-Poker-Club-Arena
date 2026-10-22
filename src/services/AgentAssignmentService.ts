import { supabase } from '../lib/supabase';

export interface AssignmentPreviewMember {
  user_id: string;
  name: string;
  role: string;
  source_user_id: string | null;
  source_name: string;
}
export interface AssignmentPreview {
  club_id: string;
  review_token: string;
  destination: { user_id: string; name: string; role: string };
  members: AssignmentPreviewMember[];
  selected_count: number;
  affected_count: number;
}
export interface AssignmentHistoryRow {
  operation_id: string;
  created_at: string;
  actor_name: string;
  source_name: string;
  destination_name: string;
  moved: number;
  review: AssignmentPreview | null;
}
function isPreview(data: unknown): data is AssignmentPreview {
  if (!data || typeof data !== 'object') return false;
  const row = data as AssignmentPreview;
  return (
    typeof row.club_id === 'string' &&
    /^[a-f0-9]{32}$/.test(row.review_token) &&
    !!row.destination &&
    ['user_id', 'name', 'role'].every(
      (key) => typeof row.destination[key as keyof typeof row.destination] === 'string'
    ) &&
    Array.isArray(row.members) &&
    Number.isSafeInteger(row.selected_count) &&
    row.selected_count > 0 &&
    row.selected_count === row.members.length &&
    Number.isSafeInteger(row.affected_count) &&
    row.affected_count >= row.selected_count &&
    new Set(row.members.map((member) => member?.user_id)).size === row.members.length &&
    row.members.every(
      (member) =>
        !!member &&
        ['user_id', 'name', 'role', 'source_name'].every(
          (key) => typeof member[key as keyof AssignmentPreviewMember] === 'string'
        ) &&
        (member.source_user_id === null || typeof member.source_user_id === 'string')
    )
  );
}
export const AgentAssignmentService = {
  async preview(
    clubId: string,
    memberIds: string[],
    target: string,
    source?: string
  ): Promise<AssignmentPreview> {
    const { data, error } = await supabase.rpc('fn_preview_club_assignment', {
      p_club_id: clubId,
      p_member_user_ids: memberIds,
      p_agent_user_id: target,
      p_expected_agent_user_id: source ?? null,
    });
    if (error) throw error;
    const ids = new Set(memberIds);
    if (
      !isPreview(data) ||
      data.club_id !== clubId ||
      !/^[a-f0-9]{32}$/.test(data.review_token) ||
      data.destination?.user_id !== target ||
      !Array.isArray(data.members) ||
      data.members.length !== ids.size ||
      data.selected_count !== ids.size ||
      new Set(data.members.map((row: AssignmentPreviewMember) => row.user_id)).size !== ids.size ||
      !data.members.every(
        (row: AssignmentPreviewMember) =>
          ids.has(row.user_id) &&
          typeof row.name === 'string' &&
          typeof row.source_name === 'string'
      ) ||
      !Number.isSafeInteger(data.affected_count) ||
      data.affected_count < ids.size
    )
      throw new Error('Assignment Preview Could Not Be Verified');
    return data as AssignmentPreview;
  },
  async history(clubId: string, search: string, before?: { at: string; id: string }) {
    const { data, error } = await supabase.rpc('fn_club_assignment_history', {
      p_club_id: clubId,
      p_search: search,
      p_before_at: before?.at ?? null,
      p_before_id: before?.id ?? null,
      p_limit: 25,
    });
    if (error) throw error;
    if (
      !data ||
      !Array.isArray(data.rows) ||
      data.rows.length > 26 ||
      data.page_size !== 25 ||
      !data.rows.every(
        (row: AssignmentHistoryRow) =>
          !!row &&
          typeof row.operation_id === 'string' &&
          (row.review === null || (isPreview(row.review) && row.review.club_id === clubId)) &&
          Number.isFinite(Date.parse(row.created_at)) &&
          Number.isSafeInteger(row.moved) &&
          row.moved > 0 &&
          ['actor_name', 'source_name', 'destination_name'].every(
            (key) => typeof row[key as keyof AssignmentHistoryRow] === 'string'
          )
      )
    )
      throw new Error('Assignment History Could Not Be Verified');
    return {
      rows: data.rows.slice(0, 25) as AssignmentHistoryRow[],
      hasMore: data.rows.length > 25,
    };
  },
};
