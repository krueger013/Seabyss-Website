(function(root){
  'use strict';
  const exploration=root.GhostExploration||(typeof require!=='undefined'?require('./exploration.js'):null);
  const definitions = [
    {
      id:0, name:'Le cimetière oublié', asset:'graveyard', subtitle:'Brume & lanternes', weather:'mist', color:'#7eaca4', ground:'#172b32',
      description:'Réveille les lanternes entre les tombes. Les fantômes n’aiment pas beaucoup la lumière…',
      intro:'Suis les lumières. Un second saut en plein vol t’emmènera plus loin.', width:4400,
      grounds:[[0,860],[1010,850],[2040,900],[3110,1290]],
      ledges:[[390,510,180],[690,420,160],[1130,510,200],[1510,440,200],[1800,520,140],[2240,510,160],[2510,410,190],[2810,500,170],[3320,510,190],[3620,430,180]],
      moving:[], thorns:[[1325,65],[2420,65],[3450,70]],
      enemies:[['ghost',670,546,540,800],['ghost',1490,480,1250,1660],['wolf',2180,576,2090,2370],['bat',2860,385,2670,3010],['ghost',3520,525,3390,3700]],
      shards:[[770,370],[2600,360],[3700,380]], checkpoints:[1630,3070+100], hearts:[[1210,470],[3370,470]], goal:4220
    },
    {
      id:1, name:'La forêt des hurlements', asset:'forest', subtitle:'Racines & crocs', weather:'leaves', color:'#83b996', ground:'#142e2c',
      description:'Bondis de racine en racine sous la pleine lune. Évite les loups ou chasse-les avec ta lanterne.',
      intro:'Les loups accélèrent à ton approche. Saute sur leur dos ou utilise X.', width:4850,
      grounds:[[0,690],[870,750],[1850,880],[2910,740],[3870,980]],
      ledges:[[370,510,170],[640,440,170],[1000,510,210],[1360,410,200],[1640,510,180],[2000,510,170],[2290,400,190],[2640,500,170],[3000,510,170],[3320,420,180],[3660,510,180],[4010,500,200],[4310,410,190]],
      moving:[[1740,520,130,0,35,1.1]], thorns:[[1160,75],[2150,70],[3190,90],[4180,75]],
      enemies:[['wolf',470,576,300,640],['wolf',1160,576,930,1530],['bat',1510,345,1330,1690],['ghost',2080,480,1910,2280],['wolf',2460,576,2310,2680],['wolf',3210,576,3000,3560],['bat',3780,420,3600,3940],['wolf',4380,576,4290,4580]],
      shards:[[1440,360],[2380,350],[4400,360]],checkpoints:[1900,3940], hearts:[[2050,470],[4070,460]], goal:4670
    },
    {
      id:2, name:'Les marais de la lune', asset:'marsh', subtitle:'Pluie & passages mouvants', weather:'rain', color:'#92b6ca', ground:'#1b303e',
      description:'La pluie brouille les pistes. Emprunte les pierres mouvantes au-dessus des eaux englouties.',
      intro:'Les pierres flottantes te transportent. Observe leur mouvement avant de sauter.',width:4900,
      grounds:[[0,610],[900,630],[1840,670],[2800,620],[3720,1180]],
      ledges:[[340,510,180],[1020,500,170],[1350,405,150],[1950,510,170],[2260,410,180],[2900,500,200],[3230,405,170],[3880,510,190],[4220,410,180]],
      moving:[[690,545,150,70,0,.9],[1610,530,150,70,25,1],[2590,530,140,65,15,.8],[3510,530,150,65,25,1.1]],
      thorns:[[1180,70],[2140,65],[3070,70],[4100,70]],
      enemies:[['ghost',440,490,310,590],['bat',1110,430,930,1320],['ghost',1480,475,1360,1650],['ghost',2160,480,1950,2350],['bat',2690,410,2540,2850],['ghost',3190,470,2910,3330],['bat',3640,400,3510,3840],['wolf',4450,576,4320,4660]],
      shards:[[1420,355],[2350,360],[4300,360]],checkpoints:[1880,3790], hearts:[[2010,470],[3970,470]], goal:4720
    },
    {
      id:3, name:'L’abbaye des âmes', asset:'abbey', subtitle:'Vitraux & murmures', weather:'petals', color:'#b49ec1', ground:'#282435',
      description:'Les vitraux éclairent les derniers chemins. Monte vers les éclats et traverse les arches hantées.',
      intro:'Les vampires résistent à deux éclairs. Garde tes distances et laisse ta lanterne se recharger.',width:5100,
      grounds:[[0,750],[940,730],[1890,820],[2940,800],[3960,1140]],
      ledges:[[360,510,180],[640,400,160],[1030,510,180],[1320,400,180],[1620,305,190],[1990,500,170],[2280,390,170],[2570,490,160],[3020,500,170],[3320,395,180],[3620,300,180],[4040,510,180],[4330,400,170],[4650,500,150]],
      moving:[[1770,515,140,35,45,.9],[2800,510,150,50,20,1],[3820,500,140,35,30,1.2]], thorns:[[1210,80],[2160,80],[3200,85],[4490,90]],
      enemies:[['ghost',540,470,370,690],['vampire',1140,551,990,1450],['bat',1700,240,1510,1850],['vampire',2130,551,1950,2510],['ghost',2480,440,2300,2650],['bat',3010,405,2900,3220],['vampire',3420,551,3240,3670],['ghost',3740,270,3550,3880],['vampire',4330,551,4140,4650]],
      shards:[[1700,255],[2360,340],[3700,250]],checkpoints:[1940,4010],hearts:[[2050,460],[4100,470]],goal:4920
    },
    {
      id:4, name:'Le château écarlate', asset:'castle', subtitle:'L’éclipse & le dernier sceau', weather:'embers', color:'#b78396', ground:'#302333',
      description:'Franchis les remparts et affronte le gardien vampire. Le cinquième sceau rendra l’aube au royaume.',
      intro:'Le gardien protège le dernier portail. Esquive ses orbes et illumine sa cape avec X.',width:5500,
      grounds:[[0,750],[960,750],[1940,820],[3010,2490]],
      ledges:[[370,510,180],[670,400,170],[1080,500,170],[1370,390,190],[1670,500,160],[2040,500,180],[2340,390,190],[2650,490,160],[3120,500,190],[3450,390,180],[3770,490,170],[4090,480,170],[4740,490,160]],
      moving:[[830,520,130,25,35,1],[1810,520,130,30,40,1.1],[2860,520,150,45,20,.9]], thorns:[[1180,75],[2160,80],[3270,85],[3930,75]],
      enemies:[['wolf',510,576,320,680],['bat',900,390,750,1100],['vampire',1340,551,1050,1610],['wolf',2190,576,1990,2440],['bat',2570,350,2390,2750],['vampire',3290,551,3080,3570],['ghost',3850,430,3680,4050],['boss',4690,510,4390,4940]],
      shards:[[1450,340],[2420,340],[3540,340]], checkpoints:[2000,4200],hearts:[[2100,460],[4230,570]], goal:5290
    }
  ];
  function buildLevel(id){
    const d=definitions[id]; if(!d) throw new RangeError('Niveau inconnu');
    const platforms=d.grounds.map(([x,w],i)=>({id:'g'+i,x,y:620,w,h:200,solid:true}));
    d.ledges.forEach(([x,y,w],i)=>platforms.push({id:'p'+i,x,y,w,h:32,solid:false}));
    d.moving.forEach(([x,y,w,ampX,ampY,speed],i)=>platforms.push({id:'m'+i,x,y,baseX:x,baseY:y,w,h:32,solid:false,moving:true,ampX,ampY,speed}));
    const coins=[];
    d.grounds.forEach(([x,w])=>{for(let cx=x+110;cx<x+w-60;cx+=145)coins.push({x:cx,y:572,type:'light'});});
    d.ledges.forEach(([x,y,w])=>{for(let cx=x+35;cx<x+w-15;cx+=55)coins.push({x:cx,y:y-37,type:'light'});});
    d.shards.forEach(([x,y])=>coins.push({x,y,type:'shard'}));
    d.hearts.forEach(([x,y])=>coins.push({x,y,type:'heart'}));
    const enemies=d.enemies.map(([type,x,y,min,max],i)=>({id:i,type,x,y,baseY:y,min,max,w:type==='wolf'?62:type==='boss'?66:40,h:type==='wolf'?44:type==='vampire'?69:type==='boss'?110:42,dir:-1,hp:type==='boss'?8:type==='vampire'?2:1,maxHp:type==='boss'?8:type==='vampire'?2:1,phase:i*.89,hit:0,attackAt:2.5,dead:false}));
    return exploration.enrich({...d,platforms,coins,enemies,hazards:d.thorns.map(([x,w])=>({x,y:602,w,h:18})),checkpoints:d.checkpoints.map(x=>({x,y:620,active:false}))});
  }
  const api={definitions,buildLevel};root.GhostLevels=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
