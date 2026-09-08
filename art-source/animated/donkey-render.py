"""Original procedural 3D donkey atlas. Analytic ellipsoids, lit and shadowed in 3D."""
import numpy as np
from PIL import Image
from pathlib import Path
S=627
Y,X=np.mgrid[0:S,0:S].astype(float)
X=(X-S/2)/180;Y=(S/2-Y)/180
D=np.stack([X,Y,np.full_like(X,8)],-1)
LIGHT=np.array([-0.65,0.8,1.2]);LIGHT/=np.linalg.norm(LIGHT)
def render(pose):
 objects=[]
 def ell(c,r,col,angle=0):
  a=np.deg2rad(angle);R=np.array([[np.cos(a),-np.sin(a),0],[np.sin(a),np.cos(a),0],[0,0,1.]])
  objects.append((np.array(c),np.array(r),np.array(col)/255,R))
 gray=[123,131,145];pale=[204,201,193];dark=[48,44,43]
 # The ears, head, cheeks, brow, and muzzle are modeled volumes.
 for side in [-1,1]:
  tilt=side*(-13+(4 if pose==3 else 0))
  ell((side*.43,.95,-.15),(.22,.72,.19),gray,tilt)
  ell((side*.43,.98,.025),(.115,.53,.065),[174,145,143],tilt)
 ell((0,.02,0),(.63,.75,.46),gray)
 for side in [-1,1]:
  ell((side*.46,-.20,.18),(.22,.40,.27),gray)
 # Rounded forelock, sculpted in separate strands.
 for i in range(7):ell(((i-3)*.092,.67+(.09 if i%2 else 0),.19),(.095,.26,.12),dark,(i-3)*-7)
 for side in [-1,1]:
  wink=pose==3 and side==1
  ell((side*.265,.25,.385),(.185,.22 if not wink else .055,.115),[230,233,231],side*-7)
  if not wink:
   ell((side*.25,.25,.485),(.092,.128,.052),[69,44,30])
   ell((side*.25,.25,.526),(.052,.086,.025),[10,13,17])
   ell((side*.25-.028,.295,.55),(.027,.039,.013),[255,255,255])
  ell((side*.27,.475,.41),(.22,.045,.07),dark,side*(-8 if pose!=2 else 9))
 # A braying mouth and hinged lower muzzle are distinct shapes per pose.
 openh=[.07,.13,.30,.08][pose]
 ell((0,-.48,.36),(.48,.28+openh,.25),[173,169,158])
 ell((0,-.45,.58),(.37,openh,.055),[47,28,29])
 if pose in [1,2]:
  for i in range(4):ell(((i-1.5)*.115,-.45+openh*.52,.625),(.052,.058,.016),[251,244,221])
  ell((0,-.45-openh*.60,.62),(.18,.06,.025),[204,108,115])
 ell((0,-.265,.42),(.50,.255,.29),pale)
 for side in [-1,1]:
  ell((side*.265,-.255,.665),(.072,.042,.024),[61,57,56],side*15)
  ell((side*.38,-.34,.60),(.06,.028,.025),[174,165,150],side*10)
 Z=np.full((S,S),-100.);RGB=np.zeros((S,S,3));N=np.zeros((S,S,3));P=np.zeros((S,S,3));mat=np.zeros((S,S,3))
 for c,r,col,R in objects:
  q=(D-c)@R;v=np.array([0,0,-1.])@R
  a=np.sum((v/r)**2);b=2*np.sum(q*v/(r*r),-1);cc=np.sum((q/r)**2,-1)-1;disc=b*b-4*a*cc
  t=(-b-np.sqrt(np.maximum(0,disc)))/(2*a);z=8-t;mask=(disc>=0)&(z>Z)
  points=D+np.array([0,0,-1])*t[...,None];local=(points-c)@R;n=(local/(r*r))@R.T;n/=np.maximum(1e-9,np.linalg.norm(n,axis=-1)[...,None])
  Z[mask]=z[mask];N[mask]=n[mask];P[mask]=points[mask];mat[mask]=col
 hit=Z>-99
 diffuse=np.maximum(0,np.sum(N*LIGHT,-1));shadow=np.zeros((S,S),bool)
 origin=P+N*.008
 for c,r,col,R in objects:
  q=(origin-c)@R;v=LIGHT@R;a=np.sum((v/r)**2);b=2*np.sum(q*v/(r*r),-1);cc=np.sum((q/r)**2,-1)-1;disc=b*b-4*a*cc
  t=(-b-np.sqrt(np.maximum(0,disc)))/(2*a);shadow|=(disc>0)&(t>.005)
 diffuse*=np.where(shadow,.22,1.)
 half=LIGHT+np.array([0,0,1]);half/=np.linalg.norm(half)
 spec=np.maximum(0,np.sum(N*half,-1))**36*.22
 rim=np.maximum(0,-N[...,0])*.09
 intensity=.37+.69*diffuse+rim
 rgb=np.clip(mat*intensity[...,None]+spec[...,None],0,1)
 rgba=np.concatenate([(rgb*255).astype('uint8'),(hit*255).astype('uint8')[...,None]],-1)
 return Image.fromarray(rgba)
out=Image.new('RGBA',(1254,1254))
for i in range(4):out.paste(render(i),(i%2*S,i//2*S))
output = Path(__file__).resolve().parent
out.save(output / 'donkey.png')
print('Rendered four original 3D donkey poses')
