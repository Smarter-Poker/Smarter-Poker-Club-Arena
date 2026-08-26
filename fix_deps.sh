#!/bin/bash
awk '
BEGIN { in_use_effect = 0; buffer = ""; in_load = 0; load_func = "" }
{
    if ($0 ~ /^[[:space:]]*useEffect\(\(\) => \{/) {
        if (!in_load) {
            in_use_effect = 1;
        }
    }
    
    if ($0 ~ /^[[:space:]]*const loadClubInfo = useCallback/) {
        in_load = 1;
    }
    
    if (in_load) {
        load_func = load_func $0 "\n";
        if ($0 ~ /^[[:space:]]*\}, \[clubId, inviteCode, user\?\.id, toast\]\);/) {
            in_load = 0;
        }
    } else if (in_use_effect) {
        buffer = buffer $0 "\n";
        if ($0 ~ /^[[:space:]]*\}, \[clubId, inviteCode, loadClubInfo\]\);/) {
            in_use_effect = 0;
            # We delay printing buffer until load_func is printed
        }
    } else {
        # normal print, but if load_func is ready, we print it FIRST
        if (load_func != "") {
            print load_func;
            print buffer;
            load_func = "";
            buffer = "";
        }
        print $0;
    }
}
' src/pages/InvitePage.tsx > temp.tsx
mv temp.tsx src/pages/InvitePage.tsx
