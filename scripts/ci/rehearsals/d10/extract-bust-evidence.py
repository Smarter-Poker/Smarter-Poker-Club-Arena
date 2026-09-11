"""Read the sealed accepted settlement receipts; never write standings or money."""
from pathlib import Path
from datetime import datetime
from decimal import Decimal
import hashlib,json

base=Path(__file__).resolve().parent
data=json.loads((base/'live-event-tables.json').read_text())
core=json.loads((base/'live-event-core.json').read_text())
players={p['user_id']:p for p in core['players']}
table_ids={t['id'] for t in data['tables']}
latest={}
for receipt in data['settlement_receipts']:
    result=receipt['result'] or {}
    if receipt['status']!='succeeded' or not receipt['completed_at'] or result.get('success') is not True:continue
    assert receipt['table_id'] in table_ids and result['table_id']==receipt['table_id']
    assert result['hand_id']==receipt['hand_id']
    for stack in result['request']['stacks']:
        user=stack['user_id']
        if user not in players or Decimal(str(stack['stack']))!=0 or Decimal(str(stack['stack_before']))<=0:continue
        assert Decimal(str(result['written'][user]))==0
        item={'userId':user,'tableId':receipt['table_id'],'receiptHandId':receipt['hand_id'],
              'handNumber':result['hand_number'],'committedAt':receipt['completed_at'],
              'stackBefore':stack['stack_before'],'written':0,
              'receiptSha256':hashlib.sha256(json.dumps(receipt,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
        if user not in latest or datetime.fromisoformat(item['committedAt'])>datetime.fromisoformat(latest[user]['committedAt']):latest[user]=item
winner='5a0cd7e0-174a-466f-ba1d-6d2c80d9252a'
assert winner not in latest and set(latest)==set(players)-{winner}
ranked=sorted(latest.values(),key=lambda r:(datetime.fromisoformat(r['committedAt']),Decimal(str(r['stackBefore'])),r['userId']),reverse=True)
for place,row in enumerate(ranked,2):row['truePlace']=place;row['paidRecordPlace']=players[row['userId']]['position']
expected=[('1c0dee1e-8ab9-4d42-897e-e1dd6da9f4be',8215053,'42.16'),('c6dc3bfa-d9dd-4174-9704-d4a0a285f876',8214451,'30.35'),('00000000-0000-0000-0000-000000000025',8214314,'21.85'),('2d6c5e7a-7352-4d1d-aecf-c5237d626e3d',8213802,'15.73'),('165df98e-f59d-46aa-bc74-a974c0ded83f',8213440,'11.36')]
for row,(user,hand,owed) in zip(ranked,expected):
    assert (row['userId'],row['handNumber'])==(user,hand)
    row['makeGoodOwed']=owed
out={'eventId':core['tournament']['id'],'source':'settlement_idempotency_keys succeeded accepted request plus written zero','inputSha256':hashlib.sha256((base/'live-event-tables.json').read_bytes()).hexdigest(),'winnerId':winner,'finishers':ranked,'makeGoodTotal':'121.45','noStandingsOrMoneyWrites':True}
(base/'bust-evidence-receipt.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'busts':len(ranked),'allFiveMakeGoodHandsMatch':True,'makeGoodTotal':'121.45'}))
