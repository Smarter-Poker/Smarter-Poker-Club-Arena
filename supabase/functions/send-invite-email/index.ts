// Supabase Edge Function for sending invite emails
// Deploy with: supabase functions deploy send-invite-email

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

interface InviteEmailRequest {
  to: string;
  clubName: string;
  inviterName: string;
  inviteUrl: string;
  inviteCode: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { to, clubName, inviterName, inviteUrl, inviteCode }: InviteEmailRequest =
      await req.json();

    // Validate inputs
    if (!to || !clubName || !inviteUrl) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get Resend API key from env
    const resendApiKey = Deno.env.get('RESEND_API_KEY');

    if (!resendApiKey) {
      console.warn('RESEND_API_KEY not configured - email not sent');
      return new Response(
        JSON.stringify({ success: false, message: 'Email service not configured' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Send email via Resend
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Club Arena <invites@clubarena.poker>',
        to: [to],
        subject: `${inviterName} invited you to join ${clubName}`,
        html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h1 style="color: #4f46e5;">🎰 You're Invited!</h1>
                        <p>
                            <strong>${inviterName}</strong> has invited you to join 
                            <strong>${clubName}</strong> on Club Arena.
                        </p>
                        <p>
                            <a href="${inviteUrl}" style="
                                display: inline-block;
                                padding: 12px 24px;
                                background: linear-gradient(135deg, #4f46e5, #7c3aed);
                                color: white;
                                text-decoration: none;
                                border-radius: 8px;
                                font-weight: bold;
                            ">
                                Accept Invitation
                            </a>
                        </p>
                        <p style="color: #666; font-size: 14px;">
                            Or use invite code: <strong>${inviteCode}</strong>
                        </p>
                        <p style="color: #999; font-size: 12px;">
                            This invitation expires in 7 days.
                        </p>
                    </div>
                `,
      }),
    });

    if (!emailResponse.ok) {
      const errorBody = await emailResponse.text();
      console.error('Resend API error:', errorBody);
      throw new Error('Failed to send email');
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Edge function error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
