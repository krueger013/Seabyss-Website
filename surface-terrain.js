import { assetUrl } from './assets.js';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const rgb = values => 'rgb(' + values.map(value => Math.round(value * 255)).join(',') + ')';
const mist = (a, b, t) => a.map((value,i) => mix(value,b[i],t));

// The traversable sites are imagined landscapes at a local scale. Relief,
// rock colours and sky conditions differ independently for each world.
export const SURFACE_PROFILES = Object.freeze({
  moon: Object.freeze({
    kind:0, seed:77, ground:[.39,.375,.37], rough:[.69,.65,.60], sky:[.012,.016,.026],
    haze:[.09,.106,.14], dust:0.000045, stars:1, sun:[-.62,.34], sunColor:[1,.89,.75],
    planet:{name:'earth',heading:.29,elevation:.22,radius:.057}
  }),
  mars: Object.freeze({
    kind:1, seed:178, ground:[.44,.195,.123], rough:[.83,.51,.32], sky:[.25,.128,.097],
    haze:[.67,.41,.27], dust:.00085, stars:0, sun:[-.49,.34], sunColor:[1,.83,.66],
    planet:null
  }),
  europa: Object.freeze({
    kind:2, seed:93, ground:[.31,.40,.48], rough:[.77,.84,.80], sky:[.010,.025,.045],
    haze:[.135,.22,.26], dust:.00013, stars:.9, sun:[-.66,.29], sunColor:[.87,.95,1],
    planet:{name:'jupiter',heading:.27,elevation:.22,radius:.105}
  }),
  titan: Object.freeze({
    kind:3, seed:61, ground:[.18,.098,.087], rough:[.40,.235,.142], sky:[.33,.134,.065],
    haze:[.69,.371,.172], dust:.00125, stars:0, sun:[-.60,.18], sunColor:[1,.68,.33],
    planet:{name:'saturn',heading:.27,elevation:.24,radius:.078}
  }),
  mercury: Object.freeze({
    kind:4, seed:233, ground:[.37,.333,.296], rough:[.81,.704,.562], sky:[.009,.010,.016],
    haze:[.105,.102,.095], dust:0.000039, stars:1, sun:[-.4,.29], sunColor:[1,.91,.76],
    planet:null
  }),
  enceladus: Object.freeze({
    kind:5, seed:479, ground:[.47,.62,.73], rough:[.93,.985,1], sky:[.006,.014,.025],
    haze:[.13,.194,.23], dust:0.000056, stars:1, sun:[.42,.19], sunColor:[.88,.97,1],
    planet:{name:'saturn',heading:.37,elevation:.26,radius:.2}
  }),
  ganymede: Object.freeze({
    kind:6, seed:349, ground:[.31,.263,.246], rough:[.76,.70,.64], sky:[.009,.012,.024],
    haze:[.11,.11,.14], dust:0.000042, stars:1, sun:[-.83,.38], sunColor:[1,.94,.87],
    planet:{name:'jupiter',heading:.19,elevation:.29,radius:.064}
  })
});

function hash(x, z, seed) {
  let n = Math.imul(x,374761393) + Math.imul(z,668265263) + Math.imul(seed,2246822519);
  n = Math.imul(n ^ (n >>> 13),1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function noise(x, z, seed) {
  const i=Math.floor(x), j=Math.floor(z), u=smooth(x-i), v=smooth(z-j);
  return mix(mix(hash(i,j,seed),hash(i+1,j,seed),u),mix(hash(i,j+1,seed),hash(i+1,j+1,seed),u),v);
}

function mound(x,z,cx,cz,wide,deep) {
  const a=(x-cx)/wide, b=(z-cz)/deep;
  return Math.exp(-a*a-b*b);
}

function crater(x,z,cx,cz,radius,depth) {
  const range=Math.hypot(x-cx,z-cz)/radius;
  const rim=(range-.97)*7;
  return -depth*(1-smooth(clamp(range,0,1))) + depth*.31*Math.exp(-rim*rim) +
    depth*.10*Math.exp(-range*range*38);
}

function fissure(x,bend,width,depth,shoulder) {
  const offset=x-bend;
  const channel=Math.exp(-((offset/width)**2));
  const bank=Math.exp(-(((Math.abs(offset)-width*1.6)/(width*.66))**2));
  return -depth*channel + shoulder*bank;
}

function iceValley(x,z) {
  return x-(23+.14*(z-95)+10*Math.sin(z*.021));
}

const regionalRelief = {
  plains(x,z,seed) {
    return crater(x,z,97,205,49,7) + crater(x,z,-96,126,27,3.4) +
      mound(x,z,-185,270,130,98)*7 + (noise(x*.04,z*.038,seed+71)-.5)*.7;
  },
  craters(x,z,seed) {
    const center=26+(hash(4,7,seed)-.5)*66;
    return crater(x,z,center,168,82,24) + crater(x,z,-135,233,53,16) +
      crater(x,z,178,310,90,31) + crater(x,z,-68,66,14,2.8) +
      mound(x,z,-292,450,133,98)*28;
  },
  canyon(x,z,seed) {
    const edge=31+.13*z+18*Math.sin(z*.014+hash(2,3,seed)*TAU);
    const trench=fissure(x,edge,31,19,13)*mound(x,z,13,191,268,195);
    const left=42*mound(x,z,-124,203,95,91), right=37*mound(x,z,144,195,104,103);
    const strata=(noise(x*.036,z*.028,seed+67)-.5)*Math.min(5,(left+right)*.15);
    return trench+left+right+strata;
  },
  highlands(x,z,seed) {
    const offset=(hash(5,3,seed)-.5)*85;
    const left=40*mound(x,z,-95+offset,151,60,84);
    const right=34*mound(x,z,132+offset,216,92,106);
    const crest=87*mound(x,z,26+offset,375,131,82);
    const ridges=Math.abs(2*noise(x*.042,z*.042,seed+81)-1);
    return (left+right+crest)*(.79+.21*ridges);
  },
  fissures(x,z,seed) {
    const bend=x-20-15*Math.sin(z*.026+hash(5,6,seed)*TAU);
    const cracks=fissure(bend,0,6,7,4.2)+fissure(bend,-57,5.1,9,4.8)+fissure(bend,58,5.7,6,3.3);
    const ribs=1.4*Math.sin(bend*.22)+.53*Math.sin(bend*.49+.5);
    return (cracks+ribs)*mound(x,z,0,147,225,175)+
      mound(x,z,135,236,69,86)*23+mound(x,z,-151,284,89,111)*19;
  },
  dunes(x,z,seed) {
    const wind=noise(x*.013,z*.014,seed+41)*TAU;
    const wave=x*.128+z*.039+wind;
    const swell=2.6+7*mound(x,z,45,211,149,139);
    return (Math.sin(wave)+.31*Math.sin(2*wave+.4))*swell+
      mound(x,z,-172,338,97,127)*30+mound(x,z,149,459,157,118)*36;
  },
  shores(x,z,seed) {
    const edge=123+8*Math.sin(x*.03+hash(0,8,seed)*TAU)+.22*x;
    const bankDistance=z-edge;
    const channel=mound(x,z,-49,195,109,98);
    const bank=mound(x,bankDistance,0,0,224,18)*4.5;
    return -24*channel+bank+mound(x,z,125,116,89,65)*17+
      mound(x,z,180,396,132,111)*26;
  }
};

const regionalPalettes = {
  plains:[[.33,.33,.36],.10],
  craters:[[.61,.52,.45],.16],
  canyon:[[.68,.37,.21],.22],
  highlands:[[.65,.59,.55],.24],
  fissures:[[.61,.78,.86],.22],
  dunes:[[.37,.23,.16],.18],
  shores:[[.39,.31,.25],.20]
};

const regionSettings = new WeakMap();
function settingsForRegion(region) {
  if (!region || typeof region!=='object' || !Object.hasOwn(regionalRelief,region.shape)) return null;
  let settings=regionSettings.get(region);
  if (!settings) {
    const seed=Number.isInteger(region.seed)?region.seed:198;
    const scale=Number.isFinite(region.scale)?clamp(region.scale,.5,1.5):1;
    const angle=(hash(7,3,seed)-.5)*.7;
    settings={seed,scale,cos:Math.cos(angle),sin:Math.sin(angle),key:region.shape+':'+seed+':'+scale};
    regionSettings.set(region,settings);
  }
  return settings;
}

function regionalHeight(world,region,settings,x,z) {
  const {seed,scale,cos,sin}=settings;
  const east=x*cos+z*sin, north=z*cos-x*sin;
  const undulation=(noise(x*.014,z*.014,seed)-.5)*4.1+(noise(x*.087,z*.087,seed+1)-.5)*.42;
  const range=Math.hypot(x,z);
  const skyline=(noise(x*.0018,z*.0018,seed+3)-.38)*83*smooth(clamp((range-185)/520,0,1));
  const height=(undulation+regionalRelief[region.shape](east,north,seed)+skyline)*scale;
  return world.kind===3 && region.shape==='shores' ? Math.max(-2.15,height) : height;
}

export function terrainHeight(worldId, x, z, region) {
  const world = SURFACE_PROFILES[worldId] || SURFACE_PROFILES.moon;
  const settings=settingsForRegion(region);
  if (settings) return regionalHeight(world,region,settings,x,z);
  const seed=world.seed;
  const rolling=(noise(x*.008,z*.008,seed)-.5)*9 + (noise(x*.024,z*.024,seed+1)-.5)*3;
  const grain=(noise(x*.103,z*.103,seed+2)-.5)*.66 + (noise(x*.34,z*.34,seed+3)-.5)*.11;
  const range = Math.hypot(x,z);
  const far = smooth(clamp((range-155)/570,0,1));
  const skyline = (noise(x*.0014,z*.0014,seed+4)-.42)*far;
  if (world.kind === 0) {
    return rolling + grain + skyline*158 + crater(x,z,66,155,57,19) +
      crater(x,z,-136,217,92,29) + crater(x,z,175,350,125,43) +
      mound(x,z,-114,272,93,65)*25 + mound(x,z,97,365,93,87)*37 +
      mound(x,z,-331,840,180,140)*90 - range*.002;
  }
  if (world.kind === 1) {
    const sinuosity=x-21-15*Math.sin(z*.011);
    const gully=Math.exp(-((sinuosity/28)**2))*mound(x,z,0,154,400,140);
    const shelf=48*mound(x,z,-153,182,105,120)+53*mound(x,z,180,245,117,79);
    const strata=(noise(x*.022,z*.028,seed+7)-.48)*Math.min(17,shelf*.24);
    return rolling+grain + skyline*231 + shelf + strata - 8*gully +
      145*mound(x,z,-370,700,197,150)+75*mound(x,z,336,659,190,107) - range*.003;
  }
  if (world.kind === 2) {
    const ridge = 1-Math.abs(2*noise(x*.032+z*.024,z*.011,seed+5)-1);
    const toe = smooth(clamp(range/130,0,1));
    const crackRange=(x-18-10*Math.sin(z*.024)) / 7;
    const fracture=Math.exp(-crackRange*crackRange)*mound(x,z,0,115,100,90);
    return rolling*.49 + grain*.7 + skyline*66 + 7*toe*ridge*ridge-5*fracture +
      mound(x,z,-81,200,51,95)*12 + mound(x,z,181,280,83,75)*24 + 
      mound(x,z,401,1010,210,124)*64 - range*.001;
  }
  if (world.kind === 4) {
    const radial=mound(x,z,76,210,165,204);
    const fracture=fissure(x,40+(z-45)*.41,5,6,2)+fissure(x,-64-(z-200)*.45,6,4,1.4);
    const hollow=crater(x,z,-110,155,10,2.3)+crater(x,z,-89,167,13,3.6)+crater(x,z,-99,137,7,1.1);
    return rolling*.74+grain+skyline*126+fracture*radial+hollow+crater(x,z,97,247,65,18)+
      crater(x,z,-238,385,119,39)+mound(x,z,-375,701,215,130)*116+mound(x,z,232,510,150,63)*30;
  }
  if (world.kind === 5) {
    const channel=iceValley(x,z);
    const waves=1.8*Math.sin(z*.045-x*.07+rolling*.2);
    const activity=mound(x,z,0,145,270,151);
    const trenches=fissure(channel,0,8,11,7)+fissure(channel,-67,9,8,4)+fissure(channel,69,11,7,4);
    return rolling*.75+grain*.74+waves+skyline*67+trenches*activity+
      mound(x,z,-157,318,83,91)*25+mound(x,z,114,328,72,96)*30+mound(x,z,88,663,116,114)*56;
  }
  if (world.kind === 6) {
    const bandX=x-z*.32+9*Math.sin(z*.019);
    const ribs=(Math.cos(bandX*.28)*2.1+Math.cos(bandX*.54)*.75)*mound(x,z,-45,175,193,214);
    return rolling+grain+skyline*92+ribs+mound(x,z,-218,306,91,118)*36+
      crater(x,z,151,246,53,13)+crater(x,z,107,156,22,5)+crater(x,z,269,407,91,18)+
      mound(x,z,234,636,260,131)*72;
  }
  const shoreZ=(z-119)*1.04-(x-38)*.26, shoreX=x-40+.21*(z-119);
  const basin=Math.exp(-((shoreX/49)**2)-((shoreZ/82)**2));
  const dunes=Math.sin(x*.155+z*.038+noise(x*.018,z*.017,seed+5)*2.8);
  const relief=2.8*mound(x,z,-105,132,75,125)+12*mound(x,z,170,272,120,83);
  const floor=rolling*.63+grain*.32+relief+dunes*(.59+relief*.16)-basin*9+skyline*91;
  return Math.max(-2.15,floor);
}

function orientation(heading,pitch) {
  const cosH=Math.cos(heading), sinH=Math.sin(heading);
  const cosP=Math.cos(pitch), sinP=Math.sin(pitch);
  return {
    right:[cosH,0,-sinH], up:[-sinH*sinP,cosP,-cosH*sinP],
    forward:[sinH*cosP,sinP,cosH*cosP]
  };
}

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

const rockSites = {
  moon:[[12,64,2.5,2.8],[-105,127,3.2,2.1],[-41,263,4.2,2.5]],
  mars:[[-83,136,4.6,2.3],[124,187,3.5,1.8],[-14,265,2.8,1]],
  europa:[[10,66,2.4,2.4],[-98,140,3.2,2.0],[126,179,5.8,5.3],[-51,254,4.3,2.7]],
  titan:[[-97,134,2.2,1.1],[120,173,2.0,1.4],[119,171,1.5,.9]],
  mercury:[[17,62,1.45,.9],[71,121,2.4,1.7],[-111,153,3.1,1.1],[39,246,3.9,2.0]],
  enceladus:[[14,55,2,1.3],[-77,144,2.9,2.5],[109,228,4.8,4.1],[102,224,2.7,3.2],[111,220,2.9,1.7]],
  ganymede:[[16,62,2.5,1.3],[-82,126,1.7,1.9],[103,151,2.9,1.7],[102,245,4.2,2.7]]
};
function terrainKey(worldId,region) {
  const settings=settingsForRegion(region);
  return settings ? worldId+':'+settings.key : worldId;
}

const rocksBySite = new Map();
function rocks(worldId,region) {
  const key=terrainKey(worldId,region);
  if(rocksBySite.has(key))return rocksBySite.get(key);
  const profile=SURFACE_PROFILES[worldId];
  const settings=settingsForRegion(region);
  const seed=settings?.seed??profile.seed;
  const placements=settings?[]:rockSites[worldId].slice();
  if(settings) {
    const count=region.shape==='dunes'?3:6;
    for(let i=0;i<count;i++) {
      const x=(hash(i,14,seed)-.5)*200,z=43+hash(i,21,seed)*208;
      const rise=.9+hash(i,37,seed)*2.8,tall=rise*(.42+hash(i,38,seed)*.43);
      if (!(profile.kind===3 && region.shape==='shores' && terrainHeight(worldId,x,z,region)<-2.12)) placements.push([x,z,rise,tall]);
    }
  }
  for(let i=0;i<153;i++) {
    const near=i<33;
    const range=near ? 46 : 510;
    const x=(hash(i,1,seed)-.5)*range;
    const z=(hash(i,2,seed)-(near ? .25 : .5))*range;
    const scale=.2+hash(i,4,seed)**3*(near?1.55:3.0);
    if(Math.hypot(x,z)<3 || (profile.kind===3 && (!settings || region.shape==='shores') && terrainHeight(worldId,x,z,region)<-2.12) ||
        (!settings && profile.kind===5 && Math.abs(iceValley(x,z))<6) ||
        (settings && region.shape==='dunes' && hash(i,19,seed)<.66))continue;
    placements.push([x,z,scale,scale*(.39+hash(i,5,seed)*.8)]);
  }
  const terrainRocks=placements.map(([x,z,rise,tall],i)=>{
    const y=terrainHeight(worldId,x,z,region);
    const angle=hash(i,17,seed)*TAU;
    return {x,z,y,rise,tall,i,angle};
  });
  rocksBySite.set(key,terrainRocks);
  return terrainRocks;
}

function skyDirection(heading,elevation) {
  return [Math.sin(heading)*Math.cos(elevation),Math.sin(elevation),Math.cos(heading)*Math.cos(elevation)];
}

function screenProject(camera, relative) {
  const depth=dot(camera.axes.forward,relative);
  if (depth <= .12) return {x:-1,y:-1,depth,visible:false};
  const x=camera.width*.5+dot(camera.axes.right,relative)*camera.focal/depth;
  const y=camera.height*.5-dot(camera.axes.up,relative)*camera.focal/depth;
  return {x,y,depth,visible:x>=0 && y>=0 && x<=camera.width && y<=camera.height};
}

const stars=Array.from({length:750},(_,i)=>({
  at:skyDirection(hash(i,1,11)*TAU,Math.asin(hash(i,2,11))),
  bright:hash(i,3,11)**3
}));
const texturedSkyBodies=new Set(['earth','mars','mercury','jupiter','saturn','io','callisto','ganymede','europa']);

function texturePlanet(name, image, appearance) {
  const size=168;
  const canvas=Object.assign(document.createElement('canvas'),{width:size,height:size});
  const ctx=canvas.getContext('2d');
  const target=ctx.createImageData(size,size);
  let map=null, tw=0, th=0;
  if (image?.naturalWidth) {
    tw=image.naturalWidth; th=image.naturalHeight;
    const input=Object.assign(document.createElement('canvas'),{width:tw,height:th});
    const context=input.getContext('2d');
    context.drawImage(image,0,0);
    map=context.getImageData(0,0,tw,th).data;
  }
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const nx=(x+.5-size/2)/(size*.5), ny=(y+.5-size/2)/(size*.5), r2=nx*nx+ny*ny;
    if(r2>1)continue;
    const nz=Math.sqrt(1-r2), longitude=Math.atan2(nx,nz), latitude=Math.asin(-ny);
    let texLon=.35*TAU+longitude,texLat=latitude;
    if(appearance?.observer) {
      const {subLat,subLon,sinPose,cosPose}=appearance.observer;
      const north=nx*sinPose-ny*cosPose, east=nx*cosPose+ny*sinPose;
      texLat=Math.asin(clamp(north*Math.cos(subLat)+nz*Math.sin(subLat),-1,1));
      texLon=subLon+Math.atan2(east,nz*Math.cos(subLat)-north*Math.sin(subLat));
    }
    const sx=Math.floor((((.5+texLon/TAU)%1+1)%1)*tw);
    const sy=clamp(Math.floor((.5-texLat/Math.PI)*th),0,th-1);
    const band=.5+.29*Math.sin(y*.49)+.17*Math.sin(y*.17);
    const defaultColor=name==='earth'?[43+70*band,92+59*band,136+60*band]:[140+95*band,109+86*band,87+80*band];
    const sunlight=appearance?.sun ?? [-.65,-.26,.71];
    const diffuse=clamp(nx*sunlight[0]-ny*sunlight[1]+nz*sunlight[2],0,1);
    const strength=appearance ? .014+.986*diffuse**.47 : .17+.83*diffuse;
    const rim=Math.pow(1-nz,4);
    const source=(sy*tw+sx)*4, dest=(y*size+x)*4;
    for(let channel=0;channel<3;channel++) target.data[dest+channel]=
      mix((map?map[source+channel]:defaultColor[channel])*strength,
        (name==='earth'?[120,180,235][channel]:180)*strength,rim*.44);
    target.data[dest+3]=clamp((1-r2)*47,0,1)*255;
  }
  ctx.putImageData(target,0,0);
  return canvas;
}

function drawSun(context,p,radius,air,light,width,height,cover=0) {
  const glow=context.createRadialGradient(p.x,p.y,0,p.x,p.y,radius*(air?22:7));
  const glowFactor=1-cover*.73;
  glow.addColorStop(0,air?'rgba(255,214,163,'+(.54*glowFactor)+')':'rgba(255,244,217,'+(.31*glowFactor)+')');
  glow.addColorStop(.13,air?'rgba(255,188,123,'+(.28*glowFactor)+')':'rgba(255,233,203,'+(.12*glowFactor)+')');
  glow.addColorStop(1,'rgba(232,141,89,0)');
  context.fillStyle=glow;
  context.fillRect(0,0,width,height);
  context.beginPath();
  context.arc(p.x,p.y,radius,0,TAU);
  context.fillStyle=air?'rgba(255,236,199,'+(.55+.35*light)+')':'#fff9e6';
  context.fill();
}

function drawRealBodies(context, profile, camera, light, ephemeris, skyTextures) {
  const air=profile.kind===1 || profile.kind===3;
  const bodies=ephemeris.objects.slice().sort((a,b)=>b.distanceKm-a.distanceKm);
  for (const body of bodies) {
    if (body.altitude < -body.angularDiameter/2) continue;
    const direction=body.direction ?? skyDirection(body.azimuth,body.altitude);
    const p=screenProject(camera,direction);
    if (p.depth<.16) continue;
    const radius=camera.focal*Math.tan(body.angularDiameter*.5)/p.depth;
    if(p.x<-radius*3 || p.x>camera.width+radius*3 || p.y<-radius*3 || p.y>camera.height+radius*3) continue;
    if (body.id==='sun') {
      drawSun(context,p,radius,air,light,camera.width,camera.height,ephemeris.solarOccultation?.coveredFraction);
      continue;
    }
    if(radius<.58) {
      const bright=clamp(.22+1.1*Math.sqrt(radius)*(body.illuminatedFraction ?? 1),.22,.9);
      context.fillStyle='rgba(255,236,205,'+(bright*(air ? .65*(1-light) : 1))+')';
      context.fillRect(p.x-.45,p.y-.45,.9,.9);
      continue;
    }
    const right=[Math.cos(body.azimuth),0,-Math.sin(body.azimuth)];
    const up=[-Math.sin(body.azimuth)*Math.sin(body.altitude),Math.cos(body.altitude),-Math.cos(body.azimuth)*Math.sin(body.altitude)];
    const sun=body.lightDirection ? [
      dot(right,body.lightDirection),dot(up,body.lightDirection),-dot(direction,body.lightDirection)
    ] : [0,0,1];
    const pole=body.northPole;
    const pose=pole ? Math.atan2(dot(pole,right),dot(pole,up)) : 0;
    const observer=Number.isFinite(body.subObserverLatitude) && Number.isFinite(body.subObserverLongitude) ? {
      subLat:body.subObserverLatitude,subLon:body.subObserverLongitude,
      sinPose:Math.sin(pose),cosPose:Math.cos(pose)
    } : undefined;
    context.save();
    context.translate(p.x,p.y);
    const rotation=Math.atan2(-dot(camera.axes.up,right),dot(camera.axes.right,right));
    context.rotate(rotation);
    context.globalAlpha=air ? (profile.kind===3 ? .12+.25*(1-light) : .78) : 1;
    if (body.id==='saturn') {
      context.save();
      context.rotate(pose);
      context.scale(1,pole ? Math.max(.018,Math.abs(dot(pole,direction))) : .31);
      for(let line=0;line<6;line++) {
        context.beginPath();
        context.strokeStyle=line===3?'#75574275':'#d8aa7a85';
        context.lineWidth=radius*.11;
        context.arc(0,0,radius*(1.30+.15*line),0,TAU);
        context.stroke();
      }
      context.restore();
    }
    context.drawImage(skyTextures(body.id,{sun,observer}),-radius,-radius,radius*2,radius*2);
    context.restore();
  }
}

function drawSky(context, profile, camera, light, skyTextures, ephemeris) {
  const {width,height,axes,focal,pitch}=camera;
  const horizon=height*.5 + focal*Math.tan(pitch);
  const scale=Math.max(height,width*.5);
  const air=profile.kind===1 || profile.kind===3;
  if(ephemeris && !air) context.fillStyle='#000106';
  else {
    const gradient=context.createLinearGradient(0,horizon-scale*.62,0,horizon+scale*.15);
    const intensity=ephemeris ? .035+.965*light : .42+.58*light;
    gradient.addColorStop(0,rgb(profile.sky.map(c=>c*intensity)));
    gradient.addColorStop(.69,rgb(mist(profile.sky,profile.haze,profile.stars ? .25 : .48).map(c=>c*intensity)));
    gradient.addColorStop(1,rgb(profile.haze.map(c=>c*intensity)));
    context.fillStyle=gradient;
  }
  context.fillRect(0,0,width,height);
  const intensity=ephemeris ? ((ephemeris.showDayStars || light<.09) && profile.kind!==3 ? 1 : 0) : ephemeris===null ? 0 : profile.stars;
  if(intensity>0) {
    for(const star of ephemeris?.stars ?? stars) {
      if(dot(axes.forward,star.at)<.4)continue;
      const p=screenProject(camera,star.at);
      if(!p.visible)continue;
      const twinkle=star.bright;
      context.fillStyle='rgba('+(star.colour || '209,227,249')+','+((.13+twinkle*.68)*intensity)+')';
      const size=.55+twinkle*1.15;
      context.fillRect(p.x,p.y,size,size);
    }
  }
  if (ephemeris!==undefined) {
    if (ephemeris) drawRealBodies(context,profile,camera,light,ephemeris,skyTextures);
    return;
  }
  const sun=screenProject(camera,skyDirection(...profile.sun));
  if (sun.depth > .22) {
    const radius=focal*(profile.stars ? .015 : .026)*(1/sun.depth);
    const glow=context.createRadialGradient(sun.x,sun.y,0,sun.x,sun.y,radius*(profile.stars?8:19));
    glow.addColorStop(0,'rgba(255,220,160,'+(.37*light)+')');
    glow.addColorStop(.10,'rgba(252,177,117,'+(.17*light)+')');
    glow.addColorStop(1,'rgba(232,141,89,0)');
    context.fillStyle=glow;
    context.fillRect(0,0,width,height);
    context.beginPath();
    context.arc(sun.x,sun.y,radius,0,TAU);
    context.fillStyle='rgba(255,236,199,'+(light*(profile.stars?1:.67))+')';
    context.fill();
  }
  if(!profile.planet)return;
  const celestial=profile.planet;
  const p=screenProject(camera,skyDirection(celestial.heading,celestial.elevation));
  if(p.depth<=.27)return;
  const radius=focal*celestial.radius/p.depth;
  if(p.x<-radius*3 || p.y<-radius*2 || p.x>width+radius*3 || p.y>height+radius*2)return;
  const vapor=profile.kind===3 ? .43 : 1;
  context.save();
  context.globalAlpha=vapor*(.65+.35*light);
  if(celestial.name==='saturn') {
    context.translate(p.x,p.y);
    context.rotate(-.30);
    context.scale(1,.31);
    for(let line=0;line<7;line++) {
      context.beginPath();
      context.strokeStyle=line===4?'rgba(91,61,39,.45)':'rgba(216,153,94,.62)';
      context.lineWidth=radius*.07;
      context.arc(0,0,radius*(1.20+.12*line),0,TAU);
      context.stroke();
    }
    context.restore();
    context.save();
    context.globalAlpha=vapor*(.65+.35*light);
  }
  context.drawImage(skyTextures(celestial.name),p.x-radius,p.y-radius,radius*2,radius*2);
  context.restore();
}

function compile(gl, vertex, fragment) {
  const program=gl.createProgram();
  const shaders=[];
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
      const shader=gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader,source);
      gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program,shader);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    return program;
  } catch(error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for(const shader of shaders)gl.deleteShader(shader);
  }
}

const vertex = `
attribute vec3 relief;
attribute vec4 material;
uniform vec3 eye, right, up, forward;
uniform vec2 scale;
varying vec3 surface, slope, v;
varying float mineral;
void main() {
  surface=relief;
  slope=material.xyz;
  mineral=material.w;
  v=relief-eye;
  float depth=dot(forward,v);
  gl_Position=vec4(dot(right,v)*scale.x,dot(up,v)*scale.y,1.00002*depth-.24,depth);
}`;

const fragment = `
precision highp float;
uniform vec3 base, fleck, haze, sunRay, sunColor;
uniform float density, light, kind, clock, liquid;
uniform sampler2D groundShadow;
varying vec3 surface, slope, v;
varying float mineral;
float noise(vec2 a) {
  vec2 i=floor(a),q=fract(a);
  q=q*q*(3.-2.*q);
  vec4 n=fract(sin(vec4(dot(i,vec2(127.1,311.7)))+vec4(0.,127.1,311.7,438.8))*43758.5453);
  return mix(mix(n.x,n.y,q.x),mix(n.z,n.w,q.x),q.y);
}
void main() {
  vec2 p=surface.xz;
  float d=length(v);
  vec3 n=normalize(slope);
  float diffuse=max(0.,dot(n,sunRay));
  float broad=noise(p*.091), grains=noise(p*1.26), grit=noise(p*13.);
  float rock=smoothstep(.68,.87,grains*.71+grit*.29);
  float material=.25+broad*.36+(grains-.5)*.20+(grit-.5)*.17;
  if(kind>1.5 && kind<2.5) {
    float crease=abs(sin(p.x*.38+p.y*.21+broad*6.3));
    material-=.34*(1.-smoothstep(.01,.22,crease))*(1.-mineral);
  }
  if(kind>.5 && kind<1.5)material+=.13*sin(surface.y*1.56+p.y*.008);
  if(kind>3.5 && kind<4.5) {
    float scoria=pow(noise(p*.057+3.),3.);
    material+=scoria*.46-rock*.14;
  }
  if(kind>4.5 && kind<5.5) {
    float grainsOnIce=abs(sin(p.y*.73-p.x*.49+broad*3.));
    material+=.31*grainsOnIce+.19*broad;
  }
  if(kind>5.5) {
    float iceLine=14.*sin(p.y*.019);
    float boundary=smoothstep(-19.,31.,p.x-.32*p.y+iceLine-40.+19.*broad);
    material+=.29*(1.-boundary)-.24*boundary+.16*abs(sin(p.x*.26-p.y*.08));
  }
  vec3 color=mix(base,fleck,clamp(material+rock*.42+mineral*.19,0.,1.));
  color*= mix(.43,.24,mineral)+.73*diffuse;
  color*= .065+.935*light;
  color=mix(color,color*sunColor,.31);
  if(liquid>.5 && surface.y<-2.13 && mineral<.1) {
    float wave=noise(p*.25+vec2(clock*.07,-clock*.025))*.13;
    float fresnel=pow(1.-abs(normalize(v).y),4.);
    color=mix(vec3(.057,.034,.031),vec3(.274,.141,.063),fresnel+wave)*(.4+.6*light);
  }
  if(mineral<.05)color*=1.-.59*texture2D(groundShadow,.5+p/560.).a;
  float fade=1.-exp(-d*density);
  gl_FragColor=vec4(mix(color,haze*(.42+.58*light),fade*.94),1.);
}`;

function terrainMesh(worldId,region) {
  const values=[0];
  for(let value=3.4;value<6800;) {
    values.push(value);
    // The walkable area ends at 335 m in either direction. Extend the
    // same spacing beyond it before switching to coarser distant ridges.
    value+=value<141 ? 3.4 : value<347 ? 5.4 : Math.min(340,value*.1);
  }
  const positive=values.slice(1);
  const axis=positive.slice().reverse().map(value=>-value).concat(values);
  const count=axis.length;
  const items=rocks(worldId,region), sides=7, rockTriangles=sides*3;
  const points=new Float32Array((count*count+items.length*rockTriangles*3)*7);
  const faces=new Uint16Array((count-1)*(count-1)*6+items.length*rockTriangles*3);
  const stride=.78;
  let at=0, index=0;
  for(let zi=0;zi<count;zi++) for(let xi=0;xi<count;xi++) {
    const x=axis[xi],z=axis[zi];
    const riseX=(terrainHeight(worldId,x+stride,z,region)-terrainHeight(worldId,x-stride,z,region))/(2*stride);
    const riseZ=(terrainHeight(worldId,x,z+stride,region)-terrainHeight(worldId,x,z-stride,region))/(2*stride);
    points.set([x,terrainHeight(worldId,x,z,region),z,-riseX,1,-riseZ,0],at);
    at+=7;
    if(zi>=count-1 || xi>=count-1)continue;
    const a=zi*count+xi, b=a+1, c=a+count, d=c+1;
    faces.set([a,c,b,b,c,d],index);
    index+=6;
  }
  for(const stone of items) {
    const {x,z,y,rise,tall,i,angle}=stone;
    const rings=[[],[]];
    for(let side=0;side<sides;side++) {
      const a=angle+side*TAU/sides;
      const width=(.73+hash(i,side,775)*.52)*rise, dx=Math.cos(a)*width, dz=Math.sin(a)*width;
      rings[0].push([x+dx,y-tall*.36,z+dz]);
      rings[1].push([x+dx*.77,y+tall*(.49+.34*hash(i,side,158)),z+dz*.69]);
    }
    const peak=[x+Math.cos(angle)*rise*.27,y+tall,z+Math.sin(angle)*rise*.16];
    const face=(a,b,c)=>{
      const u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]);
      const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      const dotProduct=dot(n,[a[0]+b[0]+c[0]-x*3,a[1]+b[1]+c[1]-(y+tall*.12)*3,a[2]+b[2]+c[2]-z*3]);
      const length=Math.hypot(...n)||1;
      const direction=n.map(v=>v*(dotProduct<0?-1:1)/length);
      for(const point of [a,b,c]) {
        const centre=[x,y+tall*.30,z];
        const shape=point.map((v,i)=>(v-centre[i])/(i===1?tall:rise));
        const shapeLength=Math.hypot(...shape)||1;
        faces[index++]=at/7;
        points.set([...point,...direction.map((v,i)=>mix(v,shape[i]/shapeLength,.47)),.89],at);
        at+=7;
      }
    };
    for(let side=0;side<sides;side++) {
      const next=(side+1)%sides;
      const a=rings[0][side],b=rings[0][next],c=rings[1][side],d=rings[1][next];
      face(a,b,c);
      face(b,d,c);
      face(c,d,peak);
    }
  }
  return {points,faces};
}

function groundShadows(worldId,profile,region) {
  const size=1024, scale=size/560;
  const canvas=Object.assign(document.createElement('canvas'),{width:size,height:size});
  const context=canvas.getContext('2d');
  const [heading,elevation]=profile.sun, darkAngle=heading+Math.PI;
  if(elevation<=0) return canvas;
  const dx=Math.sin(darkAngle),dz=Math.cos(darkAngle);
  for(const stone of rocks(worldId,region)) {
    const length=Math.min(35,stone.tall/Math.tan(elevation)*.75);
    const reach=(stone.rise+length*.62)*scale;
    context.save();
    context.translate((stone.x+dx*length*.50+280)*scale,(stone.z+dz*length*.50+280)*scale);
    context.rotate(Math.atan2(dz,dx));
    context.scale(1,stone.rise*scale/reach);
    const shadow=context.createRadialGradient(0,0,0,0,0,reach);
    shadow.addColorStop(0,'rgba(0,0,0,.83)');
    shadow.addColorStop(.57,'rgba(0,0,0,.48)');
    shadow.addColorStop(1,'rgba(0,0,0,0)');
    context.fillStyle=shadow;
    context.fillRect(-reach,-reach,reach*2,reach*2);
    context.restore();
  }
  return canvas;
}

function createGpu() {
  const target=document.createElement('canvas');
  try {
    const gl=target.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false,depth:true});
    if(!gl)return null;
    const program=compile(gl,vertex,fragment);
    const uniforms=Object.fromEntries('eye right up forward scale base fleck haze sunRay sunColor density light kind clock liquid'.split(' ').map(key=>[key,gl.getUniformLocation(program,key)]));
    const vertices=gl.createBuffer(), triangle=gl.createBuffer(), shadow=gl.createTexture();
    const relief=gl.getAttribLocation(program,'relief'), material=gl.getAttribLocation(program,'material');
    let activeId=null, shadowKey='', count=0;
    const data=new Map();
    function render(worldId,region,camera,profile,light,time,dpr) {
      if(gl.isContextLost())return false;
      const width=Math.round(camera.width*dpr), height=Math.round(camera.height*dpr);
      if (target.width!==width || target.height!==height) {target.width=width;target.height=height;}
      gl.viewport(0,0,width,height);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER,vertices);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,triangle);
      const siteKey=terrainKey(worldId,region);
      if(activeId!==siteKey) {
        const mesh=data.get(siteKey)??terrainMesh(worldId,region);
        data.delete(siteKey);
        data.set(siteKey,mesh);
        if (data.size>4) data.delete(data.keys().next().value);
        gl.bufferData(gl.ARRAY_BUFFER,mesh.points,gl.STATIC_DRAW);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,mesh.faces,gl.STATIC_DRAW);
        count=mesh.faces.length;
        activeId=siteKey;
      }
      const [az,el]=profile.sun;
      const directionKey=siteKey+':'+(el<0 ? 'dark' : Math.round(az*17)+','+Math.round(el*24));
      if(directionKey!==shadowKey) {
        gl.bindTexture(gl.TEXTURE_2D,shadow);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,groundShadows(worldId,profile,region));
        shadowKey=directionKey;
      }
      gl.enableVertexAttribArray(relief);
      gl.enableVertexAttribArray(material);
      gl.vertexAttribPointer(relief,3,gl.FLOAT,false,28,0);
      gl.vertexAttribPointer(material,4,gl.FLOAT,false,28,12);
      for(const [name,value] of Object.entries({...camera.axes,eye:camera.at,base:profile.ground,
        fleck:profile.rough,haze:profile.haze,sunRay:skyDirection(...profile.sun),sunColor:profile.sunColor})) {
        gl.uniform3fv(uniforms[name],value);
      }
      gl.uniform2f(uniforms.scale,camera.focal*2/camera.width,camera.focal*2/camera.height);
      gl.uniform1f(uniforms.density,profile.dust);
      gl.uniform1f(uniforms.light,light);
      gl.uniform1f(uniforms.kind,profile.kind);
      gl.uniform1f(uniforms.clock,time);
      gl.uniform1f(uniforms.liquid,Number(profile.liquid));
      gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_SHORT,0);
      return true;
    }
    return {target,render,dispose(){gl.deleteProgram(program);gl.deleteBuffer(vertices);gl.deleteBuffer(triangle);gl.deleteTexture(shadow);data.clear();}};
  } catch { return null; }
}

function drawSoftwareTerrain(context,worldId,region,camera,profile,light) {
  const {width,height,focal,at,heading}=camera;
  const sun=skyDirection(...profile.sun), columns=65, rows=77;
  const horizontal=width/(2*focal)+.11;
  const half = Math.min(1.53,Math.atan(horizontal)+.35);
  const sin=Math.sin(heading),cos=Math.cos(heading);
  const rays=Array.from({length:columns},(_,i)=>{
    const angle=(i/(columns-1)*2-1)*half;
    const s=Math.sin(angle),c=Math.cos(angle);
    return [sin*c+cos*s,cos*c-sin*s];
  });
  let previous=null;
  for(let row=rows-1;row>=0;row--) {
    const distance=.23*Math.pow(27500,row/(rows-1));
    const samples=rays.map(([dx,dz])=>{
      const x=at[0]+dx*distance,z=at[2]+dz*distance;
      const y=terrainHeight(worldId,x,z,region);
      return {x,z,y,p:screenProject(camera,[x-at[0],y-at[1],z-at[2]])};
    });
    if(previous)for(let column=0;column<columns-1;column++) {
      const a=samples[column],b=samples[column+1],c=previous[column+1],d=previous[column];
      if(a.p.depth<=.12 || b.p.depth<=.12 || c.p.depth<=.12 || d.p.depth<=.12)continue;
      if(Math.max(a.p.y,b.p.y,c.p.y,d.p.y)<0 || Math.min(a.p.y,b.p.y,c.p.y,d.p.y)>height ||
        Math.max(a.p.x,b.p.x,c.p.x,d.p.x)<0 || Math.min(a.p.x,b.p.x,c.p.x,d.p.x)>width) continue;
      const ex=b.x-a.x,ey=b.y-a.y,ez=b.z-a.z;
      const fx=d.x-a.x,fy=d.y-a.y,fz=d.z-a.z;
      const n=[fz*ey-fy*ez,fx*ez-fz*ex,fy*ex-fx*ey];
      if(n[1]<0)for(let i=0;i<3;i++)n[i]=-n[i];
      const diffuse=Math.max(0,dot(n,sun)/(Math.hypot(...n)||1));
      const broad=noise(a.x*.09,a.z*.09,37), fine=noise(a.x*1.31,a.z*1.31,53);
      const pigment=.20+.50*broad+.22*fine;
      const shade=(.45+.62*diffuse)*(.065+.935*light);
      let color=mist(profile.ground,profile.rough,pigment).map(value=>value*shade);
      if(profile.liquid && a.y<-2.13 && b.y<-2.13)color=[.19,.09,.043].map(value=>value*(.55+.45*light));
      const fill=rgb(mist(color,profile.haze.map(value=>value*(.42+.58*light)),.94*(1-Math.exp(-distance*profile.dust))));
      context.beginPath();
      context.moveTo(a.p.x,a.p.y);
      context.lineTo(b.p.x,b.p.y);
      context.lineTo(c.p.x,c.p.y);
      context.lineTo(d.p.x,d.p.y);
      context.closePath();
      context.fillStyle=context.strokeStyle=fill;
      context.lineWidth=.75;
      context.fill();
      context.stroke();
    }
    previous=samples;
  }
  const candidates = rocks(worldId,region).map(stone=>{
    const p=screenProject(camera,[stone.x-at[0],stone.y+stone.tall*.58-at[1],stone.z-at[2]]);
    return {stone,p};
  }).filter(({stone,p})=>p.visible && p.depth>1.5 && stone.rise*focal/p.depth>1);
  candidates.sort((a,b)=>b.p.depth-a.p.depth);
  for (const {stone,p} of candidates) {
    if (occluded(worldId,camera.at,[stone.x,stone.y+stone.tall*.58,stone.z],region))continue;
    const size=stone.rise*focal/p.depth, rockHeight=stone.tall*focal/p.depth;
    const tint=mist(profile.ground,profile.rough,.54);
    const color=brightness=>rgb(mist(tint.map(value=>value*brightness*(.065+.935*light)),profile.haze,
      .94*(1-Math.exp(-p.depth*profile.dust))));
    context.beginPath();
    context.fillStyle='rgba(9,13,17,'+(.28*Math.exp(-p.depth*profile.dust))+')';
    context.ellipse(p.x+size*.56,p.y+rockHeight*.39,size*1.32,Math.max(.52,size*.20),-.06,0,TAU);
    context.fill();
    context.beginPath();
    context.moveTo(p.x-size*.95,p.y+rockHeight*.44);
    context.lineTo(p.x-size*.76,p.y-rockHeight*.11);
    context.lineTo(p.x-size*.22,p.y-rockHeight*.46);
    context.lineTo(p.x+size*.51,p.y-rockHeight*.31);
    context.lineTo(p.x+size,p.y+rockHeight*.37);
    context.closePath();
    context.fillStyle=color(.37);
    context.fill();
    context.beginPath();
    context.moveTo(p.x-size*.95,p.y+rockHeight*.44);
    context.lineTo(p.x-size*.76,p.y-rockHeight*.11);
    context.lineTo(p.x-size*.22,p.y-rockHeight*.46);
    context.lineTo(p.x+size*.38,p.y+rockHeight*.10);
    context.closePath();
    context.fillStyle=color(.86);
    context.fill();
  }
}

function occluded(worldId,from,to,region) {
  for(let i=1;i<=8;i++) {
    const t=i/9;
    const ground=terrainHeight(worldId,mix(from[0],to[0],t),mix(from[2],to[2],t),region);
    if(ground>mix(from[1],to[1],t)+.8)return true;
  }
  return false;
}

const plumeVents=[[29,123,61],[34,149,75],[30,100,49]];

function drawIcePlumes(context,camera,light,time,region) {
  const brightness=.46+light*.54;
  for(const [ventX,ventZ,height] of plumeVents) {
    const base=terrainHeight('enceladus',ventX,ventZ,region);
    const center=screenProject(camera,[ventX-camera.at[0],base+height*.55-camera.at[1],ventZ-camera.at[2]]);
    if(center.depth<2 || center.x<-120 || center.x>camera.width+120)continue;
    function project(x,y,z) {
      const p=screenProject(camera,[x-camera.at[0],y-camera.at[1],z-camera.at[2]]);
      return p.visible && !occluded('enceladus',camera.at,[x,y,z],region) ? p : null;
    }
    // A narrow illuminated core gives the stream continuity when its grains
    // are smaller than a pixel in the distant and mobile views.
    let previous=null;
    for(let band=1;band<=19;band++) {
      const fraction=band/20, drift=fraction*fraction*height*.33;
      const point=project(ventX+drift,base+fraction*height,ventZ);
      if (point && previous) {
        const broadening=camera.focal/point.depth;
        context.lineCap='round';
        context.lineWidth=clamp(broadening*(.15+fraction*1.4),.7,5);
        context.strokeStyle='rgba(212,243,255,'+((1-fraction)**1.2*brightness*.41)+')';
        context.beginPath();
        context.moveTo(previous.x,previous.y);
        context.lineTo(point.x,point.y);
        context.stroke();
      }
      previous=point;
    }
    for(let particle=0;particle<54;particle++) {
      const fraction=((hash(particle,ventZ,133)+time*(.26+.38*hash(particle,11,741)))%1+1)%1;
      const spread=(hash(particle,13,421)-.5)*fraction*height*.53;
      const x=ventX+fraction*fraction*height*.33+spread,z=ventZ+spread*.54;
      const y=base+fraction*height;
      const point=project(x,y,z);
      if(!point)continue;
      const radius=clamp(camera.focal/point.depth*(.14+fraction*.58),.44,4.1);
      context.fillStyle='rgba(201,236,255,'+((1-fraction)**1.35*brightness*(.24+.41*hash(particle,5,997)))+')';
      context.beginPath();
      context.ellipse(point.x,point.y,radius*.67,radius*1.52,-.18,0,TAU);
      context.fill();
    }
  }
}

export function createSurfaceTerrain(canvas,{onInvalidate}={}) {
  const context=canvas.getContext('2d',{alpha:false});
  const images=new Map();
  const reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let gpu=null, camera=null, worldId=null, activeRegion=null, previous='', disposed=false;
  function skyTextures(name,appearance) {
    let entry=images.get(name);
    if(!entry) {
      entry={image:null,key:null,texture:null};
      images.set(name,entry);
      if (texturedSkyBodies.has(name)) {
        const image=new Image();
        image.onload=()=>{
          if(disposed)return;
          entry.image=image;entry.key=null;previous='';onInvalidate?.();
        };
        image.src=assetUrl(name+'-day.webp');
      }
    }
    const key=appearance ? [
      ...appearance.sun,...Object.values(appearance.observer ?? {})
    ].map(value=>Math.round(value*100)).join(',') : '';
    if(entry.key!==key) {
      try {entry.texture=texturePlanet(name,entry.image,appearance);}
      catch {entry.texture=texturePlanet(name,null,appearance);}
      entry.key=key;
    }
    return entry.texture;
  }
  function draw(id,{x=0,z=0,heading=0,pitch=0,eyeHeight,eye,time=0,light=1,sky,region}={}) {
    if(disposed)return;
    const width=Math.round(canvas.clientWidth),height=Math.round(canvas.clientHeight);
    if(width<4 || height<4)return;
    worldId=SURFACE_PROFILES[id]?id:'moon';
    activeRegion=settingsForRegion(region)?region:null;
    const base=SURFACE_PROFILES[worldId];
    const sun=sky?.objects.find(object=>object.id==='sun');
    const palette=activeRegion && regionalPalettes[activeRegion.shape];
    const profile={...base,sun:sun?[sun.azimuth,sun.altitude]:base.sun,
      liquid:base.kind===3 && (!activeRegion || activeRegion.shape==='shores')};
    if(palette) {
      profile.ground=mist(base.ground,palette[0],palette[1]);
      profile.rough=mist(base.rough,palette[0],palette[1]*.78);
    }
    if (sun) {
      const altitude=sun.altitude;
      const air=base.kind===1 || base.kind===3;
      const twilight=air ? -.09 : -sun.angularDiameter*.5;
      const sunlit=Math.sqrt(clamp((altitude-twilight)/.65,0,1));
      const uncovered=1-(sky.solarOccultation?.coveredFraction || 0);
      light=air ? .11+.89*sunlit*uncovered : sunlit*uncovered;
    }
    const dpr=Math.min(globalThis.devicePixelRatio||1,1.6,1440/width,1000/height);
    const hasPlumes=worldId==='enceladus'&&(!activeRegion||activeRegion.plumes===true);
    const motionTime=reducedMotion?.matches?0:time;
    const internals=[width,height,dpr,x,z,heading,pitch,eyeHeight??eye??2.4,light,terrainKey(worldId,activeRegion),hasPlumes,
      sky?.date?.valueOf(),sky?.site?.latitude,sky?.site?.longitude,sky?.showDayStars,sky?.stars?.length,
      profile.liquid?Math.floor(motionTime*6):hasPlumes?Math.floor(motionTime*8):0].join(',');
    if(internals===previous)return;
    previous=internals;
    if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)) {
      canvas.width=Math.round(width*dpr);
      canvas.height=Math.round(height*dpr);
    }
    if(gpu===null)gpu=createGpu()||false;
    const absoluteEye=terrainHeight(worldId,x,z,activeRegion)+(eyeHeight??eye??2.4);
    const focal=Math.min(width*1.25,Math.max(height*.78,width*.66));
    camera={at:[x,absoluteEye,z],axes:orientation(heading,pitch),heading,pitch,width,height,focal};
    context.setTransform(dpr,0,0,dpr,0,0);
    drawSky(context,profile,camera,light,skyTextures,sky);
    if(gpu && gpu.render(worldId,activeRegion,camera,profile,light,motionTime,Math.min(dpr,1160/width,810/height))) {
      context.drawImage(gpu.target,0,0,width,height);
    } else drawSoftwareTerrain(context,worldId,activeRegion,camera,profile,light);
    if(hasPlumes) drawIcePlumes(context,camera,light,Math.floor(motionTime*8)/8,activeRegion);
  }
  function project({x,z,y}) {
    if(!camera)return {x:-1,y:-1,depth:0,visible:false};
    const height=y??terrainHeight(worldId,x,z,activeRegion);
    const project=screenProject(camera,[x-camera.at[0],height-camera.at[1],z-camera.at[2]]);
    if(!project.visible)return project;
    if(occluded(worldId,camera.at,[x,height,z],activeRegion))return {...project,visible:false};
    return project;
  }
  function screenGroundRay(x,y) {
    if(!camera)return null;
    const {width,height,focal,at,axes}=camera;
    const horizontal=(x-width*.5)/focal, vertical=(height*.5-y)/focal;
    const vector=axes.forward.map((value,i)=>value+axes.right[i]*horizontal+axes.up[i]*vertical);
    const length=Math.hypot(...vector);
    return {at:at.slice(),direction:vector.map(value=>value/length)};
  }
  function dispose() {
    disposed=true;
    gpu?.dispose?.();
    images.clear();
  }
  return {draw,project,screenGroundRay,dispose};
}
