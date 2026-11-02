(function(root){
  'use strict';
  const rooms=[
    {name:'La crypte aux chandelles',relic:'Le médaillon des veilleurs',kind:'torches',background:'crypt-v3',entry:[590,620],shortcut:[1120,620],hint:'Certaines pierres sonnent creux. Un éclair de lanterne révèle ce qu’elles cachent.',clue:'Deux flammes veillent sur le coffre. Offre-leur un peu de ta lumière.',grounds:[[0,430],[560,360],[1060,390]],ledges:[[260,510,180],[520,410,180],[820,500,180],[1120,430,230]],moving:[],torches:[[345,510],[610,410]],chest:[1230,430],urns:[280,1130]},
    {name:'Le cœur du vieux chêne',relic:'La graine de lune',kind:'spring',background:'grotto-v3',entry:[1475,410],shortcut:[1920,620],hint:'Le vieux chêne garde son secret dans les hauteurs. Cherche une lueur entre les racines.',clue:'Les champignons bleus rendent tes sauts plus grands. Le trésor sommeille au-dessus des racines.',grounds:[[0,500],[720,730]],ledges:[[330,510,180],[600,420,170],[850,320,230],[1150,430,170]],moving:[],torches:[],chest:[965,320],pads:[[460,620]],urns:[260,1200]},
    {name:'Le sanctuaire englouti',relic:'La perle des profondeurs',kind:'lever',background:'grotto-v3',entry:[2350,410],shortcut:[2910,620],hint:'La pluie ne couvre pas tous les murmures. Éclaire les pierres du vieux pont.',clue:'Le levier réveille le pont noyé. Les dalles flottantes te mèneront au coffre.',grounds:[[0,350],[650,200],[1130,320]],ledges:[[1150,500,230]],moving:[[900,525,160,70,35,.9]],torches:[],chest:[1260,500],lever:[235,620],bridge:[[350,570,300]],urns:[140,1200]},
    {name:'La bibliothèque oubliée',relic:'Le grimoire des étoiles',kind:'ordered',background:'crypt-v3',entry:[1715,305],shortcut:[1955,620],hint:'Un livre oublié parle d’une porte derrière les pierres les plus hautes.',clue:'Éveille les runes dans l’ordre : I, puis II, puis III. De la plus basse à la plus haute.',grounds:[[0,1450]],ledges:[[270,510,190],[550,405,190],[850,300,180],[1130,400,230]],moving:[],torches:[[360,510],[640,405],[940,300]],chest:[1250,400],urns:[170,1020]},
    {name:'Le trésor de l’éclipse',relic:'La couronne de l’aube',kind:'guardian',background:'crypt-v3',entry:[3520,390],shortcut:[4240,620],hint:'La lune gravée sur les remparts ne ressemble pas aux autres pierres.',clue:'Ces dalles s’effritent sous tes pas. Le dernier gardien protège la couronne.',grounds:[[0,450],[620,280],[1080,370]],ledges:[[460,510,140],[740,405,170],[1010,500,160]],moving:[],torches:[],chest:[1320,620],crumble:[0,1,2],guard:['vampire',1200,551,1135,1300],urns:[240,1130]}
  ];
  const enrichments=[
    {ledges:[[1140,350,150],[1660,325,140],[3420,315,150]],urns:[[300,620,'light'],[1210,510,'light'],[3260,620,'heart']],pad:[2200,620]},
    {ledges:[[1130,310,150],[2070,325,150],[2890,330,150]],urns:[[310,620,'light'],[1070,510,'heart'],[4050,620,'light']],pad:[4030,620]},
    {ledges:[[2030,320,140],[2970,300,150],[3990,315,150]],urns:[[270,620,'light'],[2010,510,'heart'],[3800,620,'light']],lift:[3970,440,140,0,70,.8]},
    {ledges:[[1150,305,140],[2400,275,150],[4220,290,150]],urns:[[280,620,'light'],[2060,500,'light'],[4100,620,'heart']],lift:[2910,440,150,0,75,.85]},
    {ledges:[[1190,290,150],[2200,290,150],[3680,290,150]],urns:[[280,620,'light'],[2140,500,'heart'],[4170,620,'light']],pad:[3070,620]}
  ];
  function enrich(level){
    const spec=rooms[level.id],extras=enrichments[level.id],origin=level.width+400,secretWidth=1450;
    level.mainWidth=level.width;level.width=origin+secretWidth;level.zoneBounds={main:{min:0,max:level.mainWidth},secret:{min:origin,max:origin+secretWidth}};
    for(const p of level.platforms)p.zone='main';for(const c of level.coins)c.zone='main';for(const e of level.enemies){e.zone='main';e.walkDistance=0;}for(const h of level.hazards)h.zone='main';
    level.legacyCounts={coins:level.coins.length,enemies:level.enemies.length};
    const addCoins=(x,y,w,zone)=>{for(let cx=x+30;cx<x+w-15;cx+=55)level.coins.push({x:cx,y:y-37,type:'light',zone});};
    extras.ledges.forEach(([x,y,w],i)=>{level.platforms.push({id:'extra'+i,x,y,w,h:32,solid:false,zone:'main'});addCoins(x,y,w,'main');});
    if(extras.lift){const [x,y,w,ampX,ampY,speed]=extras.lift;level.platforms.push({id:'extra-lift',x,y,baseX:x,baseY:y,w,h:32,solid:false,moving:true,ampX,ampY,speed,zone:'main'});}
    level.pads=extras.pad?[{x:extras.pad[0],y:extras.pad[1],zone:'main'}]:[];
    level.urns=[];const addUrn=(x,feet,type,zone)=>{const id=level.urns.length;level.urns.push({id,x,y:feet-36,feet,w:30,h:36,zone,broken:false});const count=type==='heart'?1:3;for(let i=0;i<count;i++)level.coins.push({x:x+15+(i-(count-1)/2)*18,y:feet-51,type,zone,urn:id});};
    extras.urns.forEach(([x,y,type])=>addUrn(x,y,type,'main'));
    spec.grounds.forEach(([x,w],i)=>{level.platforms.push({id:'sg'+i,x:origin+x,y:620,w,h:200,solid:true,zone:'secret'});addCoins(origin+x,620,w,'secret');});
    spec.ledges.forEach(([x,y,w],i)=>{level.platforms.push({id:'sp'+i,x:origin+x,y,w,h:32,solid:false,zone:'secret',crumble:spec.crumble?.includes(i)||false,collapse:0});addCoins(origin+x,y,w,'secret');});
    spec.moving.forEach(([x,y,w,ampX,ampY,speed],i)=>level.platforms.push({id:'sm'+i,x:origin+x,y,baseX:origin+x,baseY:y,w,h:32,solid:false,moving:true,ampX,ampY,speed,zone:'secret'}));
    spec.bridge?.forEach(([x,y,w],i)=>level.platforms.push({id:'bridge'+i,x:origin+x,y,w,h:32,solid:false,zone:'secret',leverBridge:true}));
    spec.pads?.forEach(([x,y])=>level.pads.push({x:origin+x,y,zone:'secret'}));
    spec.urns.forEach(x=>addUrn(origin+x,620,'light','secret'));
    if(spec.guard){const [type,x,y,min,max]=spec.guard;level.enemies.push({id:level.enemies.length,type,x:origin+x,y,baseY:y,min:origin+min,max:origin+max,w:40,h:69,dir:-1,hp:2,maxHp:2,phase:0,hit:0,attackAt:2.5,dead:false,zone:'secret',walkDistance:0});}
    level.secret={...spec,origin,width:secretWidth,entry:{x:spec.entry[0],feet:spec.entry[1]},shortcut:{x:spec.shortcut[0],feet:spec.shortcut[1]},spawn:{x:origin+105,y:562},exit:{x:origin+80,feet:620},chest:{x:origin+spec.chest[0],feet:spec.chest[1]},torches:spec.torches.map(([x,feet],i)=>({x:origin+x,y:feet-49,feet,index:i})),lever:spec.lever?{x:origin+spec.lever[0],feet:spec.lever[1]}:null};
    level.sign={x:200,feet:620,text:spec.hint};
    return level;
  }
  const api={enrich,rooms};root.GhostExploration=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
