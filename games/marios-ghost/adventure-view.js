(function(root){
 'use strict';
 function draw(v){
  const {ctx,assets,world:w,camera,viewW,glow,soft}=v,t=w.time,s=w.level.trialSpec,q=w.trial;
  const prop=(index,x,feet,width)=>{const img=assets['secret-props-v3'],box=root.GhostArt?.['secret-props-v3']?.[index]?.box;if(!img||!box)return;const height=box[3]/box[2]*width;ctx.drawImage(img,...box,x-width/2,feet-height,width,height);};
  if(w.zone==='main'){
   const a=s.altar,x=a.x-camera;
   if(x>-90&&x<viewW+90){glow(x,a.feet-38,68,q.complete?'#e8ce8d':'#83c5cc',.25);prop(0,x,a.feet,56);ctx.save();ctx.translate(x,a.feet);for(let i=0;i<3;i++){const angle=t*.5+i*Math.PI*2/3;glow(Math.cos(angle)*25,-70+Math.sin(angle)*6,6,'#e6d297',q.active?.14:.55);}ctx.restore();}
   for(const b of s.beacons){const x=b.x-camera,y=b.feet-50,lit=q.complete||q.active&&b.index<q.lit,next=q.active&&b.index===q.lit;if(x<-100||x>viewW+100)continue;ctx.save();ctx.globalAlpha=lit||next?1:.37;prop(lit?7:6,x,b.feet,42);
    if(lit||next){glow(x,y,lit?65:50,lit?'#edd395':'#99dce6',.42+Math.sin(t*4+b.index)*.05);if(next){ctx.save();ctx.translate(x,y-5);ctx.rotate(Math.PI/4+Math.sin(t*2+b.index)*.09);ctx.strokeStyle='#c4f0ec';ctx.fillStyle='#b4e3df33';ctx.fillRect(-7,-7,14,14);ctx.strokeRect(-10,-10,20,20);ctx.restore();}else if(!soft)for(let j=0;j<3;j++){const phase=(t*.65+j*.33+b.index*.2)%1;glow(x+Math.sin(t*2+j*3)*5,y-phase*18,3,'#f7d397',(1-phase)*.4);}}
    ctx.fillStyle=lit?'#f0d491':'#b5d0ce';ctx.font='16px Georgia';ctx.textAlign='center';ctx.fillText(['I','II','III'][b.index],x,y-24);if(next){ctx.strokeStyle='#b6dede66';ctx.beginPath();ctx.arc(x,y,21+Math.sin(t*3)*2,0,Math.PI*2);ctx.stroke();}ctx.restore();
   }
  }
  if(!soft)for(const e of w.echoes){ctx.save();ctx.globalCompositeOperation='screen';root.GhostHeroView.draw(ctx,assets,e.character,e.player,t,e.player.x+17-camera,e.player.y+58,67,e.life/.19*.32,true);ctx.restore();}
 }
 function impacts(v){const {ctx,world:w,camera,soft}=v;for(const hit of w.impacts){const q=1-hit.life/.24;ctx.save();ctx.translate(hit.x-camera,hit.y);ctx.globalAlpha=(1-q)*.85;ctx.strokeStyle=hit.power===2?'#f8dc94':hit.color;ctx.lineWidth=soft?1:2;const radius=7+q*(hit.power===2?40:28);ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.stroke();for(let i=0;i<6;i++){const a=i*Math.PI/3+.3;ctx.beginPath();ctx.moveTo(Math.cos(a)*(radius+3),Math.sin(a)*(radius+3));ctx.lineTo(Math.cos(a)*(radius+10),Math.sin(a)*(radius+10));ctx.stroke();}ctx.restore();}}
 root.GhostAdventureView={draw,impacts};
})(window);

