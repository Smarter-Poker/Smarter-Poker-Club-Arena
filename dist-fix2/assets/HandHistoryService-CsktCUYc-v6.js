import{s as c,r as _}from"./index-h-O4AoEP-v6.js";import"./vendor-react-ChGGaEAk-v6.js";import"./vendor-supabase-BLlQ2fJ4-v6.js";class m{async getHand(e){const{data:a,error:t}=await c.from("hands").select(`
                *,
                hand_players (
                    seat,
                    user_id,
                    hole_cards,
                    final_hand,
                    result,
                    is_winner
                ),
                hand_actions (
                    player_id,
                    action,
                    amount,
                    street,
                    created_at
                ),
                tables (
                    name,
                    game_type,
                    stakes
                )
            `).eq("id",e).maybeSingle();if(t||!a)return null;const d=(a.hand_players||[]).map(r=>r.user_id),i=await this.fetchProfileMap(d);return this.mapHandRecord(a,i)}async getPlayerHands(e,a=50){const{data:t,error:d}=await c.from("hand_players").select(`
                hands (
                    *,
                    hand_players (
                        seat,
                        user_id,
                        hole_cards,
                        final_hand,
                        result,
                        is_winner
                    ),
                    tables (
                        name,
                        game_type,
                        stakes
                    )
                )
            `).eq("user_id",e).order("created_at",{ascending:!1}).limit(a);if(d||!t)return[];const i=t.flatMap(n=>{var o;return(((o=n.hands)==null?void 0:o.hand_players)||[]).map(l=>l.user_id)}),r=await this.fetchProfileMap(i);return t.map(n=>{const s=n;return this.mapHandRecord(s.hands,r)}).filter(n=>n!==null)}async getTableHands(e,a=100){const{data:t,error:d}=await c.from("hands").select(`
                *,
                hand_players (
                    seat,
                    user_id,
                    hole_cards,
                    final_hand,
                    result,
                    is_winner
                ),
                tables (
                    name,
                    game_type,
                    stakes
                )
            `).eq("table_id",e).order("created_at",{ascending:!1}).limit(a);if(d||!t)return[];const i=t.flatMap(n=>(n.hand_players||[]).map(o=>o.user_id)),r=await this.fetchProfileMap(i);return t.map(n=>this.mapHandRecord(n,r)).filter(n=>n!==null)}async getRecentWinningHands(e,a=10){const{data:t,error:d}=await c.from("hand_players").select(`
                hands (
                    *,
                    hand_players (
                        seat,
                        user_id,
                        hole_cards,
                        final_hand,
                        result,
                        is_winner
                    ),
                    tables (
                        name,
                        game_type,
                        stakes
                    )
                )
            `).eq("user_id",e).eq("is_winner",!0).order("created_at",{ascending:!1}).limit(a);if(d||!t)return[];const i=t.flatMap(n=>{var o;return(((o=n.hands)==null?void 0:o.hand_players)||[]).map(l=>l.user_id)}),r=await this.fetchProfileMap(i);return t.map(n=>{const s=n;return this.mapHandRecord(s.hands,r)}).filter(n=>n!==null)}async searchHands(e){let a=c.from("hands").select(`
                *,
                hand_players (
                    seat,
                    user_id,
                    hole_cards,
                    final_hand,
                    result,
                    is_winner
                ),
                tables (
                    name,
                    game_type,
                    stakes,
                    club_id
                )
            `).order("created_at",{ascending:!1});if(e.tableId&&(a=a.eq("table_id",e.tableId)),e.startDate&&(a=a.gte("created_at",e.startDate)),e.endDate&&(a=a.lte("created_at",e.endDate)),e.minPot&&(a=a.gte("pot_size",e.minPot)),e.clubId){const{data:s}=await c.from("tables").select("id").eq("club_id",e.clubId),o=(s||[]).map(l=>l.id);if(o.length===0)return[];a=a.in("table_id",o)}a=a.limit(e.limit||50);const{data:t,error:d}=await a;if(d||!t)return[];const i=t.flatMap(s=>(s.hand_players||[]).map(l=>l.user_id)),r=await this.fetchProfileMap(i);return t.map(s=>this.mapHandRecord(s,r)).filter(s=>s!==null)}mapHandRecord(e,a){if(!e)return null;const t=e.tables||{name:"Unknown",game_type:"NLH",stakes:"1/2"},d=(e.hand_players||[]).map(r=>{var s;const n=a==null?void 0:a.get(r.user_id);return{seat:r.seat,user_id:r.user_id,username:(n==null?void 0:n.username)||((s=r.user_id)==null?void 0:s.slice(0,8))||"Unknown",avatar_url:(n==null?void 0:n.avatar_url)||null,position:this.getPositionName(r.seat,e.button_seat||1,(e.hand_players||[]).length),hole_cards:r.hole_cards||[],final_hand:r.final_hand||void 0,result:r.result||0,is_winner:r.is_winner||!1}}),i=(e.hand_actions||[]).map(r=>({player_id:r.player_id,action:r.action,amount:r.amount||void 0,street:r.street,timestamp:new Date(r.created_at).getTime()}));return{id:e.id,serial_number:e.serial_number||e.id,table_id:e.table_id,table_name:t.name||"Unknown",played_at:e.created_at,hand_number:e.hand_number||1,total_hands:e.total_hands||1,main_pot:e.pot_size||0,side_pots:e.side_pots||[],community_cards:e.community_cards||[],players:d,actions:i,game_type:t.game_type||"NLH",stakes:t.stakes||"1/2"}}async fetchProfileMap(e){const a=new Map;if(e.length===0)return a;try{const t=[...new Set(e)],{data:d}=await c.from("profiles").select("id, username, avatar_url").in("id",t);for(const i of d||[])a.set(i.id,{username:i.username,avatar_url:i.avatar_url})}catch(t){_(t,"HandHistoryService.fetchProfileMap")}return a}getPositionName(e,a,t){const d=this.getPositionOrder(t),i=(e-a+t)%t;return d[i]||"MP"}async saveHandToSupabase(e,a){try{const{data:t,error:d}=await c.from("hands").insert({table_id:e,hand_number:a.handNumber,pot_size:a.pot,community_cards:a.communityCards,created_at:new Date().toISOString()}).select("id").maybeSingle();if(d||!t){d==null||d.message;return}const i=t.id,r=a.players.map(s=>{var o;return{hand_id:i,user_id:s.id,seat:s.seat,hole_cards:s.holeCards||[],result:s.result||0,is_winner:a.winners.some(l=>l.playerId===s.id),final_hand:((o=a.winners.find(l=>l.playerId===s.id))==null?void 0:o.hand)||null}});r.length>0&&await c.from("hand_players").insert(r);const n=a.actions.map((s,o)=>{const l=a.players.find(u=>u.seat===s.seat);return{hand_id:i,player_id:(l==null?void 0:l.id)||"",action:s.action,amount:s.amount||0,street:s.street,created_at:new Date(Date.now()+o).toISOString()}});n.length>0&&await c.from("hand_actions").insert(n),`${a.handNumber}${i}`}catch(t){_(t,"HandHistoryService.saveHandToSupabase")}}getPositionOrder(e){return e<=2?["BTN","BB"]:e<=3?["BTN","SB","BB"]:e<=6?["BTN","SB","BB","UTG","MP","CO"]:["BTN","SB","BB","UTG","UTG+1","MP","MP+1","HJ","CO"]}}const w=new m;export{w as default,w as handHistoryService};
