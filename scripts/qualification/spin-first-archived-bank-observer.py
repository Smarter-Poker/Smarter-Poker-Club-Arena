"""Narrow union-wallet MVCC receipt validation; no database/lifecycle access."""
from decimal import Decimal
import re
import uuid
RELATION='public.union_wallets'
UNION='fade0000-0000-0000-0000-000000000001'
FINANCIAL={'chip_balance','rake_wallet','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet'}

def require(value,message):
    if not value:raise ValueError(message)

def number(value,limit):
    require(isinstance(value,str) and re.fullmatch(r'0|[1-9][0-9]*',value) and int(value)<limit,'MVCC integer encoding differs')
    return int(value)

def observation(value,top,*,_permit_current=False):
    require(isinstance(value,dict) and set(value)=={'transaction_id','snapshot_xmax','isolation','rows'},'MVCC observation fields differ')
    t=number(value['transaction_id'],2**64);x=number(value['snapshot_xmax'],2**64)
    require(t>2 and value['transaction_id']==top and value['isolation']=='read committed'
        and t//2**32==x//2**32 and x>=t,'MVCC transaction/epoch differs')
    require(isinstance(value['rows'],list) and len(value['rows'])<=1,'MVCC scope cardinality differs')
    for row in value['rows']:
        require(isinstance(row,dict) and set(row)=={'projection','xmin','full_xid','eligible','status'},'MVCC row fields differ')
        projection=row['projection'];require(isinstance(projection,dict) and FINANCIAL|{'id','union_id'} <= set(projection)
            and all(k in ('id','user_id','club_id','union_id') or re.search(r'(balance|treasury|wallet|chip_pool|locked_chips|held_chips|credit_|diamonds|total_deposited|total_drawn|seeded_amount|surplus_returned|seed_returned_amount)',k) for k in projection),'MVCC financial projection differs')
        require(projection['union_id']==UNION and isinstance(projection['id'],str)
            and str(uuid.UUID(projection['id']))==projection['id'],'MVCC row identity differs')
        require(all(type(projection[k]) in (int,Decimal) and Decimal(projection[k]).is_finite() for k in set(projection)-{'id','user_id','club_id','union_id'}),'MVCC amount malformed')
        low=number(row['xmin'],2**32);full=number(row['full_xid'],2**64)
        require(low>=3 and full==(t//2**32)*2**32+low and type(row['eligible']) is bool,'MVCC version identity malformed')
        eligible=low>=t%2**32 and full<x
        require(row['eligible'] is eligible,'MVCC interval flag disagrees')
        if low<t%2**32:
            require(row['status'] is None,'MVCC old baseline status must remain unknown')
        else:
            # Check EVERY version, including phase0 and unchanged amounts/xmin.
            if _permit_current:
                require((full<x and row['status'] in ('committed','in progress')) or (full>=x and row['status'] is None),'MVCC negative-case status malformed')
            else:require(eligible and row['status']=='committed','MVCC own/unknown version refuses')
    return [r['projection'] for r in value['rows']]

def pair(before,after,top):
    old=observation(before,top);new=observation(after,top)
    require(len(old)==len(new),'MVCC insertion/deletion refuses')
    if not old:return 'unchanged empty scope'
    require(old[0]['id']==new[0]['id'],'MVCC replacement identity refuses')
    a,b=before['rows'][0],after['rows'][0]
    if a['xmin']==b['xmin']:
        require(old==new,'MVCC same version changed');return 'unchanged'
    require(b['eligible'] is True and b['status']=='committed','MVCC changed old/unknown version refuses')
    return 'external committed version'

def validate_history(history,top,before=None,inside=None,replay=None):
    require(isinstance(history,list) and len(history)==3,'MVCC all three phases required')
    projections=[observation(v,top) for v in history]
    for actual,expected in zip(projections,(before,inside,replay)):
        if expected is not None:require(actual==expected,'MVCC metadata/projection not same observation')
    return [pair(history[0],history[1],top),pair(history[1],history[2],top)]


def validate_own_fault(history,top,before,inside):
    require(isinstance(history,list) and len(history) in (2,3),'MVCC own fault phases differ')
    if len(history)==3:pair(history[0],history[1],top)
    require(observation(history[-2],top)==before,'MVCC own fault baseline differs')
    require(observation(history[-1],top,_permit_current=True)==inside,'MVCC own fault inside differs')
    require(len(inside)==1,'MVCC own fault current row missing')
    row=history[-1]['rows'][0]
    require(int(row['full_xid'])>=int(top) and row['status'] in ('in progress',None),'MVCC own fault version not current')
    if before:require(before[0]['id']==inside[0]['id'],'MVCC own fault identity replaced')
    return True
