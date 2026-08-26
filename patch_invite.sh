sed -i '' -e 's/await loadClubInfo();/navigate(\`\/clubs\/\${club.slug || club.id}\`);/' src/pages/InvitePage.tsx
