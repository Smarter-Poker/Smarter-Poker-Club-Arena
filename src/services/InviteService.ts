/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📨 INVITE SERVICE — Club Invitation Management
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { resolveClubUUID } from '../utils/clubIdResolver';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClubInvite {
  id: string;
  clubId: string;
  inviteeEmail?: string;
  inviteCode: string;
  inviterId: string;
  status: 'pending' | 'accepted' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface SendInviteParams {
  clubId: string;
  clubName: string;
  email: string;
  inviterName: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const InviteService = {
  /**
   * Generate a unique invite code
   */
  generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const randomBytes = crypto.getRandomValues(new Uint8Array(8));
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(randomBytes[i] % chars.length);
    }
    return code;
  },

  /**
   * Create an invite link for a club
   */
  async createInvite(clubId: string, inviterId: string, email?: string): Promise<ClubInvite> {
    const code = this.generateCode();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7-day expiry

    const { data, error } = await supabase
      .from('club_invites')
      .insert({
        club_id: clubId,
        inviter_id: inviterId,
        invitee_email: email || null,
        invite_code: code,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Invite creation returned no data');

    return {
      id: data.id,
      clubId: data.club_id,
      inviteeEmail: data.invitee_email,
      inviteCode: data.invite_code,
      inviterId: data.inviter_id,
      status: data.status,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
    };
  },

  /**
   * Get the invite URL for a code
   */
  getInviteUrl(code: string): string {
    const baseUrl = window.location.origin;
    return `${baseUrl}/invite?code=${code}`;
  },

  /**
   * Send email invite via Supabase Edge Function
   */
  async sendEmailInvite(params: SendInviteParams): Promise<boolean> {
    try {
      // Create the invite first
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const invite = await this.createInvite(params.clubId, user.id, params.email);
      const inviteUrl = this.getInviteUrl(invite.inviteCode);

      // Call edge function to send email
      const { error } = await supabase.functions.invoke('send-invite-email', {
        body: {
          to: params.email,
          clubName: params.clubName,
          inviterName: params.inviterName,
          inviteUrl: inviteUrl,
          inviteCode: invite.inviteCode,
        },
      });

      if (error) {
        console.error('Failed to send invite email:', error);
        // Don't throw - invite was still created, just log it
        return false;
      }

      // Update invite to mark email sent
      await supabase
        .from('club_invites')
        .update({ email_sent_at: new Date().toISOString() })
        .eq('id', invite.id);

      return true;
    } catch (error: unknown) {
      console.error('Failed to send email invite:', error);
      throw error;
    }
  },

  /**
   * Get pending invites for a club
   */
  async getClubInvites(clubId: string): Promise<ClubInvite[]> {
    const { data, error } = await supabase
      .from('club_invites')
      .select('id, club_id, invitee_email, invite_code, inviter_id, status, created_at, expires_at')
      .eq('club_id', await resolveClubUUID(clubId))
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    return (data || []).map((row) => ({
      id: row.id,
      clubId: row.club_id,
      inviteeEmail: row.invitee_email,
      inviteCode: row.invite_code,
      inviterId: row.inviter_id,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  },

  /**
   * Validate an invite code
   */
  async validateCode(code: string): Promise<ClubInvite | null> {
    const { data, error } = await supabase
      .from('club_invites')
      .select('id, club_id, invitee_email, invite_code, inviter_id, status, created_at, expires_at')
      .eq('invite_code', code)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: data.id,
      clubId: data.club_id,
      inviteeEmail: data.invitee_email,
      inviteCode: data.invite_code,
      inviterId: data.inviter_id,
      status: data.status,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
    };
  },

  /**
   * Mark invite as accepted
   */
  async acceptInvite(inviteId: string): Promise<void> {
    const { error } = await supabase
      .from('club_invites')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', inviteId);

    if (error) throw error;
  },

  /**
   * Cancel/expire an invite
   */
  async cancelInvite(inviteId: string): Promise<void> {
    const { error } = await supabase
      .from('club_invites')
      .update({ status: 'expired' })
      .eq('id', inviteId);

    if (error) throw error;
  },

  /**
   * Copy invite link to clipboard
   */
  async copyInviteLink(code: string): Promise<boolean> {
    try {
      const url = this.getInviteUrl(code);
      await navigator.clipboard.writeText(url);
      return true;
    } catch (err) {
      console.error('[InviteService] Error:', err);
      return false;
    }
  },
};

export default InviteService;
