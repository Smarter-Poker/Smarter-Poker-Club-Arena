const fs = require('fs');
const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

const searchStr = `                  <button
                    onClick={async () => {
                      setIsSavingNotice(true);
                      try {
                        const { error } = await supabase
                          .from('clubs')
                          .update({ description: noticeDraft.trim() })
                          .eq('id', resolvedClubId);
                        if (error) throw error;
                        setClub((prev) =>
                          prev ? { ...prev, description: noticeDraft.trim() } : prev
                        );
                        setIsEditingNotice(false);
                      } catch (e) {
                        toast.error('Failed to save welcome message');
                      } finally {
                        setIsSavingNotice(false);
                      }
                    }}
                    disabled={isSavingNotice}
                  >`;

const replaceStr = `                  <button
                    onClick={() => {
                      const newDesc = noticeDraft.trim();
                      setClub((prev) =>
                        prev ? { ...prev, description: newDesc } : prev
                      );
                      setIsEditingNotice(false);
                      toast.success('Successfully updated');
                      
                      // Fire-and-forget
                      supabase
                        .from('clubs')
                        .update({ description: newDesc })
                        .eq('id', resolvedClubId)
                        .then(({ error }) => {
                          if (error) {
                            toast.error('Failed to save welcome message to server');
                          }
                        });
                    }}
                    disabled={isSavingNotice}
                  >`;

if (code.includes(searchStr)) {
  code = code.replace(searchStr, replaceStr);
  fs.writeFileSync(file, code);
  console.log("Replaced");
} else {
  console.log("Could not find search string");
}
