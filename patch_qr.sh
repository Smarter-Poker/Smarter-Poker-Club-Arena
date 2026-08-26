sed -i '' -e 's/value={inviteUrl}/value={inviteUrl || window.location.href}/' src/pages/InvitePage.tsx
