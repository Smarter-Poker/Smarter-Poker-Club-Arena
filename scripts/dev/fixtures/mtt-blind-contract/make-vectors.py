import json
from pathlib import Path
level=dict(level=1,smallBlind=25,bigBlind=50,ante=0,durationMinutes=4)
v=[]
def case(name,structure,valid,stack=10000):v.append(dict(name=name,structure=structure,stack=stack,valid=valid))
for name,x in [('empty',[]),('null',None),('object',{}),('scalar',[1]),('null_row',[None])]:case(name,x,False)
for field,values in dict(smallBlind=[None,False,'',-1,100,'0x10','NaN',' 25 ','\t25\t',9007199254740992],bigBlind=[None,False,0,-1,'Infinity'],ante=[None,False,-1,'oops'],isBreak=['false',1,None],durationMinutes=[None,0,-1,'forever',False]).items():
 for i,value in enumerate(values):case(field+str(i),[{**level,field:value}],False)
case('decreasing_small',[level,{**level,'smallBlind':20,'bigBlind':100}],False)
case('decreasing_big',[level,{**level,'bigBlind':40}],False)
case('unmarked_zero',[{**level,'smallBlind':0,'bigBlind':0}],False)
case('first_break',[{**level,'smallBlind':0,'bigBlind':0,'isBreak':True},level],False)
case('funded_break',[level,{**level,'isBreak':True}],False)
for stack in [None,0,-1]:case('stack'+str(stack),[level],False,stack)
for duration,speed in [(1,'hyper_turbo'),(2,'hyper_turbo'),(3,'turbo'),(4,'turbo'),(5,'turbo'),(6,'standard'),(8,'standard'),(10,'standard'),(12,'slow'),(15,'slow')]:
 case('clock'+str(duration),[{**level,'durationMinutes':duration}],True);v[-1]['speed']=speed
for name,structure in [
 ('short_deck',[{**level,'smallBlind':0}]),
 ('numeric_strings',[{**level,'smallBlind':'25','bigBlind':'50','durationMinutes':'4'}]),
 ('seconds',[dict(smallBlind=25,bigBlind=50,duration=120)]),
 ('snake_minutes',[dict(smallBlind=25,bigBlind=50,duration_minutes=5)]),
 ('fallback_seconds',[{**level,'durationMinutes':0,'duration':180}]),
 ('null_primary_snake',[{**level,'durationMinutes':None,'duration_minutes':5}]),
 ('breaks',[level,dict(smallBlind=0,bigBlind=0,ante=0,durationMinutes=5,isBreak=True),{**level,'smallBlind':50,'bigBlind':100}]),
 ('fractional_blinds',[{**level,'smallBlind':0.5,'bigBlind':1}]),
 ('omitted_ante',[dict(smallBlind=25,bigBlind=50,durationMinutes=4)]),
]:case(name,structure,True)
Path(__file__).with_name('vectors.json').write_text(json.dumps(v,indent=2)+'\n')
print(len(v))
