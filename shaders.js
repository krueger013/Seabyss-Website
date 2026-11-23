// Camera coordinates use positive Z in front of the observer.
export const quadVertex = `
attribute vec2 aCorner;
uniform vec4 uBounds;
varying vec2 vClip;
void main() {
  vClip = mix(uBounds.xy, uBounds.zw, aCorner);
  gl_Position = vec4(vClip, 0., 1.);
}`;

const optics = `
precision highp float;
varying vec2 vClip;
uniform mat3 uToWorld;
uniform vec2 uScale;
uniform vec2 uAxis;
const float PI = 3.14159265;
vec3 cameraRay() { return normalize(vec3((vClip - uAxis) * uScale, 1.)); }
vec2 mapUV(vec3 n) {
  return vec2(fract(.5 + atan(n.x,n.z)/(2.*PI)), .5 - asin(clamp(n.y,-1.,1.))/PI);
}
`;

const noise = `
float hash(vec3 p) {
  p = fract(p * .1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float field(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f*f*(3.-2.*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p) {
  return field(p)*.52 + field(p*2.08+7.)*.265 + field(p*4.31+15.)*.14 + field(p*9.1)*.075;
}
`;

export const skyFragment = optics + `
uniform sampler2D uSky;
uniform float uLocal;
void main() {
  vec3 d = uToWorld * cameraRay();
  vec3 sky = texture2D(uSky, mapUV(d)).rgb;
  gl_FragColor = vec4(mix(vec3(.009,.014,.026),sky,uLocal),1.);
}`;

export const cloudFragment = optics + `
uniform vec3 uCenter;
uniform sampler2D uVolume, uDetail;
uniform float uDetailReady;
vec3 atlasSlice(vec2 pixel,float layer) {
  vec2 cell=vec2(mod(layer,8.),floor(layer/8.));
  return texture2D(uVolume,(cell+(pixel*95.+.5)/96.)/vec2(8.,6.)).rgb;
}
void main(){
  vec3 eye=-uToWorld*uCenter;
  vec3 ray=uToWorld*cameraRay();
  float closest=-dot(ray,eye);
  vec3 impact=eye+ray*closest;
  float disc=1.-dot(impact,impact);
  if(disc<=0.)discard;
  float halfWidth=sqrt(disc), first=max(0.,closest-halfWidth), end=closest+halfWidth;
  if(end<=first)discard;
  float stepSize=(end-first)/48.;
  vec3 pos=eye+ray*(first+.5*stepSize),delta=ray*stepSize, light=vec3(0.);
  for(int i=0;i<48;i++){
    float level=clamp((pos.z*.5+.5)*47.,0.,47.);
    vec2 uv=clamp(vec2(.5+pos.x*.5,.5-pos.y*.5),0.,1.);
    vec3 a=atlasSlice(uv,floor(level)),b=atlasSlice(uv,min(47.,floor(level)+1.));
    light+=mix(a,b,fract(level));
    pos+=delta;
  }
  vec3 colour=1.-exp(-light*stepSize*3.85);
  if(uDetailReady>.5 && ray.z<-.45) {
    float hit=-eye.z/ray.z;
    vec2 xy=(eye+ray*hit).xy;
    if(hit>0. && max(abs(xy.x),abs(xy.y))<1.) {
      vec3 residual=texture2D(uDetail,vec2(.5+xy.x*.5,.5-xy.y*.5)).rgb-128./255.;
      float visible=min(1.,max(colour.r,max(colour.g,colour.b))*9.1);
      colour=max(vec3(0.),colour+residual*.73*visible*clamp((-ray.z-.45)*2.,0.,1.));
    }
  }
  gl_FragColor=vec4(colour,1.);
}`;

export const memberVertex = `
precision highp float;
attribute vec4 aMember, aLight;
uniform mat3 uFromWorld;
uniform vec3 uCenter;
uniform vec2 uScale,uAxis;
uniform float uFocal,uPixel,uFade;
varying vec4 vColour;
varying float vSpikes;
void main(){
  vec3 p=uCenter+uFromWorld*aMember.xyz;
  if(p.z<.03){gl_Position=vec4(3.,3.,0.,1.);}
  else {gl_Position=vec4(uAxis+p.xy/(p.z*uScale),0.,1.);}
  gl_PointSize=clamp(aMember.w*uFocal/max(.03,p.z)*1.9,2.15,74.)*uPixel;
  vColour=vec4(aLight.rgb,aLight.a*uFade);
  vSpikes=smoothstep(.034,.050,aMember.w);
}`;

export const memberFragment = `
precision mediump float;
varying vec4 vColour;
varying float vSpikes;
void main(){
  vec2 p=gl_PointCoord*2.-1.;float r2=dot(p,p);
  if(r2>1.)discard;
  float core=exp(-r2*89.),halo=.57*exp(-r2*21.)+.09*exp(-r2*4.);
  p=mat2(.990,-.140,.140,.990)*p;
  float spike=exp(-min(abs(p.x),abs(p.y))*94.)*exp(-sqrt(r2)*3.5)*vSpikes*.64;
  vec3 colour=vColour.rgb*(halo+spike)+mix(vColour.rgb,vec3(1.),.60)*core;
  gl_FragColor=vec4(colour*vColour.a,1.);
}`;

export const starVertex = `
precision highp float;
attribute vec4 aStar;
attribute vec2 aTone;
uniform mat3 uFromWorld;
uniform vec3 uEye;
uniform vec2 uScale, uAxis;
uniform float uPixel, uLocal, uTransit;
varying float vTone, vAlpha, vStretch;
varying vec2 vAxis;
void main() {
  vec3 pos = mod(aStar.xyz-uEye+4.,8.)-4.;
  float fade=1.-smoothstep(3.25,4.,max(abs(pos.x),max(abs(pos.y),abs(pos.z))));
  float distance = length(pos);
  vec3 dir = uFromWorld*pos;
  if(dir.z <= 0.) { gl_Position=vec4(3.,3.,0.,1.); } else {
    gl_Position=vec4(dir.xy/(dir.z*uScale)+uAxis,0.,1.);
  }
  float magnitude=clamp(aStar.w/max(distance,.015), .32, 3.8);
  vStretch=1.+uTransit*clamp(length(dir.xy)/max(.05,dir.z),0.,1.5)*2.1;
  vAxis=normalize(vec2(dir.x,-dir.y)+.00001);
  gl_PointSize = clamp(2.+magnitude*2.7,2.,13.)*uPixel*vStretch;
  vTone=aTone.x;
  vAlpha=clamp(magnitude*1.14,.07,1.)*uLocal*aTone.y*fade;
}`;

export const starFragment = `
precision mediump float;
varying float vTone, vAlpha, vStretch;
varying vec2 vAxis;
void main() {
  vec2 p=gl_PointCoord*2.-1.;
  float across=dot(p,vec2(-vAxis.y,vAxis.x))*vStretch;
  float along=dot(p,vAxis);
  float r2=across*across+along*along;
  if(r2>=1.) discard;
  vec3 c=mix(vec3(.61,.77,1.),vec3(.96,.96,1.),smoothstep(.14,.66,vTone));
  c=mix(c,vec3(1.,.82,.61),smoothstep(.77,.96,vTone));
  float alpha=(exp(-11.*r2)+.14*exp(-4.*r2))*(1.-smoothstep(.6,1.,r2));
  gl_FragColor=vec4(c,vAlpha*alpha);
}`;

export const bodyFragment = optics + noise + `
uniform vec3 uCenter, uLight, uColor, uPole;
uniform mat3 uBodyFrame;
uniform sampler2D uEarth, uWeather, uNight;
uniform vec2 uLayerReady;
uniform float uType, uSpin, uCloudDrift, uVenusWind, uEarthReady, uPixelWidth;
uniform float uLunarDisk;
uniform float uSolarDisk;

// Small overlapping bowls give crater rims distinct sunlit and shadowed sides.
float craters(vec3 p, vec3 sun) {
  vec3 base=floor(p);
  float shade=0.;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++) {
    vec3 cell=base+vec3(float(x),float(y),float(z));
    float h=hash(cell);
    vec3 delta=p-cell-vec3(h,hash(cell+53.),hash(cell+91.));
    float radius=.17+.27*hash(cell+23.);
    float d=length(delta)/radius;
    float edge=exp(-33.*(d-.9)*(d-.9));
    shade+=edge*(.07-.15*dot(normalize(delta+.00001),sun))
          -.06*(1.-smoothstep(.4,.91,d));
  }
  return shade;
}

// Relative optical depth of Saturn's rings. Distinct C, B and A bands share
// one profile between the ring plane and the shadow cast onto the globe.
float ringDepth(float r) {
  float c=.25*smoothstep(1.22,1.29,r)*(1.-smoothstep(1.50,1.53,r));
  float b=.88*smoothstep(1.51,1.55,r)*(1.-smoothstep(1.93,1.95,r));
  float a=.65*smoothstep(1.99,2.01,r)*(1.-smoothstep(2.255,2.27,r));
  float gap=(r-2.215)/.008;
  float encke=1.-.73*exp(-gap*gap);
  return (c+b+a)*encke*(.91+.045*sin(r*153.)+.035*sin(r*359.+2.)+.025*sin(r*87.));
}
vec3 rotateEarth(vec3 p,float a) {
  return vec3(p.x*cos(a)+p.z*sin(a),p.y,p.z*cos(a)-p.x*sin(a));
}
float cloudDensity(vec3 p,float wind) {
  float m=texture2D(uWeather,mapUV(rotateEarth(uBodyFrame*p,wind))).r;
  return smoothstep(.09,1.,m)*uLayerReady.x;
}
void main() {
  vec3 ray=cameraRay(), wray=uToWorld*ray;
  float reach=dot(uCenter,ray);
  float offset=length(cross(uCenter,ray));
  float boundary=max(uPixelWidth,.00005);
  bool globe=offset < 1. && reach>0.;
  float hit=globe ? reach-sqrt(max(0.,1.-offset*offset)) : 1.e8;
  if(globe && hit<0.) hit=reach+sqrt(max(0.,1.-offset*offset));
  vec3 worldCenter=uToWorld*uCenter;
  // Ring plane and sphere share a depth comparison for front/back occlusion.
  vec4 foregroundRing=vec4(0.);
  vec3 normal=uPole;
  if(uType==6.) {
    float denom=dot(wray,normal);
    if(abs(denom)>.0001) {
      float ringHit=dot(worldCenter,normal)/denom;
      vec3 point=wray*ringHit-worldCenter;
      float r=length(point);
      if(ringHit>0. && ringHit<hit && r>=1.22 && r<2.28) {
        float depth=ringDepth(r);
        float face=abs(dot(uLight,normal));
        float transmission=dot(uLight,normal)*denom>0.? .81:1.;
        vec3 rings=mix(vec3(.46,.39,.34),vec3(.93,.865,.765),depth)
          *(.77+.23*sqrt(face))*transmission;
        if(dot(point,uLight)<0.) rings*=mix(.085,1.,smoothstep(.95,1.02,length(cross(point,uLight))));
        float op=1.-exp(-2.05*depth/max(.21,abs(denom)));
        if(!globe) { gl_FragColor=vec4(rings,op); return; }
        foregroundRing=vec4(rings,op);
      }
    }
  }
  bool emitting=uType==9.;
  bool atmosphere=uType==1. || uType==4. || uType==8. || uType==10. || uType==11.;
  if(!globe) {
    if(reach<=0.) discard;
    float h=max(0.,offset-1.);
    if(emitting) {
      float intensity=.38*exp(-11.*h)+.12*exp(-2.5*h);
      if(intensity<.003) discard;
      gl_FragColor=vec4(mix(uColor,vec3(1.),.15),intensity); return;
    }
    if(!atmosphere || h>.095) discard;
    vec3 tangent=normalize(uToWorld*(ray*reach-uCenter));
    float mu=dot(tangent,uLight);
    float day=smoothstep(-.26,.43,mu);
    vec3 air=uType==4.?vec3(.86,.46,.24):mix(vec3(.79,.31,.14),vec3(.31,.65,1.),smoothstep(-.22,.09,mu));
    float alpha=(.94*exp(-h*192.)+.17*exp(-h*57.))*day;
    if(uType==11.) air=vec3(.94,.79,.52);
    if(uType==10.) {
      air=mix(vec3(.89,.63,.34),vec3(.56,.66,.77),smoothstep(.003,.028,h));
      alpha=(.73*exp(-h*80.)+.14*exp(-h*36.))*day;
    }
    gl_FragColor=vec4(air,alpha); return;
  }
  vec3 n=normalize(uToWorld*(ray*hit-uCenter));
  float facing=abs(dot(n,wray));
  float lambert=dot(n,uLight);
  vec3 bodyNormal=uBodyFrame*n;
  vec3 spinning=rotateEarth(bodyNormal,uSpin);
  vec3 base=uColor;
  float hotCracks=0.;
  float scale=field(spinning*4.);
  bool sea=false;
  if(uType==1.) {
    vec3 earth=texture2D(uEarth,mapUV(spinning)).rgb;
    float pat=fbm(spinning*4.8);
    vec3 land=mix(vec3(.15,.25,.13),vec3(.54,.43,.27),pat);
    vec3 temporary=mix(vec3(.038,.17,.29),land,smoothstep(.48,.50,pat));
    temporary=mix(temporary,vec3(.85,.89,.87),.7*smoothstep(.55,.66,fbm(spinning*11.+8.)));
    base=mix(temporary,earth,uEarthReady);
    sea=base.b>base.r*1.38 && base.b>base.g*1.05;
  } else if(uType==2. || uType==3. || uType==4.) {
    float detail=fbm(spinning*6.);
    base*=.63+detail*.68+.12*field(spinning*84.);
    if(uType==2. || uType==3.) {
      if(uEarthReady>.5) {
        base=texture2D(uEarth,mapUV(spinning)).rgb;
      } else {
        base*=.81+.37*smoothstep(.36,.56,scale);
        base+=craters(spinning*13.,uLight)+.55*craters(spinning*37.,uLight);
      }
    } else {
      base=mix(base,vec3(.76,.74,.67),.76*smoothstep(.90,.986,abs(n.y)+detail*.04));
      base*=.80+.28*smoothstep(.31,.52,detail);
      if(uEarthReady>.5) base=texture2D(uEarth,mapUV(spinning)).rgb;
    }
  } else if(uType==5. || uType==6. || uType==7. || uType==8.) {
    float latitude=bodyNormal.y;
    float wind=field(vec3(spinning.x*8.,latitude*25.,spinning.z*8.));
    float band=sin(latitude*43.+wind*1.05+.7*sin(latitude*17.));
    float fine=sin(latitude*113.+wind*2.5);
    if(uType==5.) {
      base=mix(vec3(.56,.36,.275),vec3(.93,.84,.72),.5+.45*band+.055*fine);
      float lon=atan(spinning.x,spinning.z);
      float spot=length(vec2((lon-.22)*2.8,(latitude+.24)*12.));
      base=mix(base,vec3(.74,.43,.31),.9*(1.-smoothstep(.58,1.,spot)));
      if(uEarthReady>.5) base=texture2D(uEarth,mapUV(spinning)).rgb;
    } else if(uType==6.) {
      base=mix(vec3(.68,.56,.40),vec3(.91,.81,.62),.46+.24*band+.07*fine+.15*wind);
      if(uEarthReady>.5) {
        base=mix(base,texture2D(uEarth,mapUV(spinning)).rgb,.88);
      }
    }
    else {
      float contrast=uType==8.?.066:.027;
      base*=.94+contrast*band+.048*wind;
      if(uType==8.) {
        vec2 storm=vec2(spinning.x*.82+spinning.z*.57,latitude+.24);
        float oval=exp(-dot(storm*vec2(5.,14.),storm*vec2(5.,14.)))*smoothstep(.1,.7,spinning.z);
        base*=1.-.27*oval;
      }
    }
    base*=.93+.10*wind;
  } else if(uType>=12.) {
    float plates=fbm(spinning*3.8+vec3(1.4,5.2,2.));
    float fine=field(spinning*62.);
    float crack=1.-smoothstep(.005,.031,abs(plates-.51+.045*(fine-.5)));
    if(uType==12.) {
      base=mix(vec3(.13,.086,.084),vec3(.39,.22,.16),plates);
      hotCracks=crack*crack*(.56+.44*fine);
    } else if(uType==13.) {
      base=mix(vec3(.53,.69,.79),vec3(.88,.97,.99),plates)-crack*vec3(.27,.18,.07);
    } else if(uType==14.) {
      float strata=sin(spinning.y*41.+plates*16.+fine);
      base*=.67+.5*plates+.12*strata;
    } else {
      base=mix(vec3(.02,.12,.27),vec3(.11,.38,.62),plates);
    }
  } else if(uType==11.) {
    vec3 air=rotateEarth(bodyNormal,uVenusWind);
    float eddy=fbm(air*vec3(3.8,7.,3.8)+vec3(0.,air.y*air.y*3.3,0.));
    float folds=.5+.5*sin(air.y*17.+eddy*6.);
    base=mix(vec3(.71,.55,.37),vec3(.98,.90,.72),.34+.38*eddy+.26*folds);
  } else if(uType==10.) {
    // Titan's high-altitude haze obscures its rocky/icy surface in visible light.
    base=mix(vec3(.85,.63,.34)*(1.+.028*n.y),texture2D(uEarth,mapUV(spinning)).rgb,uEarthReady);
  } else if(emitting) {
    float cells=fbm(spinning*66.);
    // The observation is a single Earth-facing image. Unseen longitudes
    // receive quiet photospheric granulation and approximate limb darkening.
    if (uSolarDisk>.5) {
      base=mix(uColor,vec3(1.,.98,.90),.24)*(.98+.04*cells);
      gl_FragColor=vec4(base*(.42+.58*facing),1.); return;
    }
    float network=fbm(spinning*12.), mottling=smoothstep(.22,.78,cells);
    float spots=smoothstep(.63,.76,network)*smoothstep(.35,.65,cells);
    base=mix(uColor*.69,mix(uColor,vec3(1.,.99,.90),.60),mottling);
    gl_FragColor=vec4(base*(.58+.44*sqrt(facing))*(1.-.72*spots),1.); return;
  } else {
    base*=.80+.3*fbm(spinning*9.);
  }
  float daylight=max(lambert,0.);
  vec3 surface=base*(.025+.98*pow(daylight,.69));
  if(uLunarDisk>.5) {
    // Lunar-Lambert disk function. The regolith looks flatter near full phase.
    float lunarDisk=2.*daylight/max(.003,daylight+facing);
    surface=base*(.018+.982*pow(mix(daylight,lunarDisk,.65),.65));
  }
  surface+=hotCracks*vec3(1.04,.34,.042);
  if(uType==1.) {
    // Intersect a distinct cloud shell (shown slightly above true scale).
    // The solar ray samples that same field on the way out of the atmosphere.
    float shellRadius=1.0028;
    float cloudHit=reach-sqrt(max(0.,shellRadius*shellRadius-offset*offset));
    vec3 cloudN=normalize(uToWorld*(ray*cloudHit-uCenter));
    float wind=uSpin+uCloudDrift;
    float cloud=cloudDensity(cloudN,wind);
    float solarHit=sqrt(max(0.,lambert*lambert+shellRadius*shellRadius-1.))-lambert;
    float shadow=cloudDensity(normalize(n+uLight*solarHit),wind);
    float lit=smoothstep(-.075,.14,lambert);
    float earthLight=.032+.99*pow(max(lambert,0.),.53);
    surface=base*earthLight*(1.-shadow*.40*lit);
    surface+=vec3(.003,.009,.022)*(.4+.6*lit);
    if(sea) {
      float spec=max(0.,dot(reflect(-uLight,n),-wray));
      surface+=vec3(1.,.89,.72)*(.22*pow(spec,85.)+.055*pow(spec,16.))*lit;
    }
    float cities=texture2D(uNight,mapUV(spinning)).r*uLayerReady.y;
    surface+=vec3(1.,.68,.31)*pow(cities,.77)*(1.-smoothstep(-.26,.025,lambert))*.91;
    float cloudLight=pow(max(dot(cloudN,uLight),0.),.45);
    vec3 clouds=mix(vec3(.055,.080,.115),vec3(1.,.985,.95),cloudLight);
    float edgeCloud=cloudDensity(normalize(cloudN+uLight*.0023),wind);
    clouds*=1.+.33*(cloud-edgeCloud)*lit;
    surface=mix(surface,clouds,cloud*.96);
    float atmospherePath=pow(1.-facing,2.9);
    float sunlit=smoothstep(-.23,.4,lambert);
    vec3 scattering=mix(vec3(.35,.12,.065),vec3(.18,.43,.78),smoothstep(-.11,.18,lambert));
    surface=surface*(1.-.26*atmospherePath*sunlit)+scattering*atmospherePath*(.03+.69*sunlit);
  }
  if(uType==10.) {
    float fringe=pow(1.-facing,3.)*(.06+.45*clamp(lambert+.3,0.,1.));
    surface=base*(.07+.94*pow(daylight,.49))+vec3(.75,.60,.38)*fringe;
  } else if(atmosphere && uType!=1.) {
    vec3 air=uType==11.?vec3(.77,.60,.36):uType==4.?vec3(.70,.34,.18):vec3(.18,.45,.76);
    surface+=air*pow(1.-facing,3.3)*(.035+.70*max(0.,lambert+.25));
  }
  if(uType==6.) {
    float incidence=dot(normal,uLight);
    if(abs(incidence)>.01) {
      float crossing=-dot(n,normal)/incidence;
      if(crossing>0.) surface*=exp(-ringDepth(length(n+uLight*crossing))*1.5);
    }
    surface=mix(surface,foregroundRing.rgb,foregroundRing.a);
  }
  // The adjacent atmospheric shell already covers the apparent limb.
  float edge=atmosphere?1.:smoothstep(0.,max(.00015,min(.018,boundary)),1.-offset);
  gl_FragColor=vec4(surface,edge);
}`;

export const galaxyFragment = optics + `
uniform vec3 uCenter, uDiskNormal;
uniform sampler2D uDiskMap;
uniform float uDiskReady, uStyle;

vec3 volume(vec3 ray, vec3 origin, vec2 axes, float falloff, vec3 colour) {
  vec3 scale=vec3(1./axes.x,1./axes.x,1./axes.y);
  vec3 dir=ray*scale, offset=origin*scale;
  float t=max(0.,-dot(dir,offset)/dot(dir,dir));
  float radius=length(offset+dir*t);
  float value=exp(-radius*falloff);
  return colour*value;
}
void main() {
  vec3 direction=uToWorld*cameraRay(), center=uToWorld*uCenter;
  vec3 east=normalize(cross(vec3(0.,1.,0.),uDiskNormal)), north=cross(uDiskNormal,east);
  vec3 ray=vec3(dot(direction,east),dot(direction,north),dot(direction,uDiskNormal));
  vec3 origin=-vec3(dot(center,east),dot(center,north),dot(center,uDiskNormal));
  float inner=uStyle>.9?1.:.7;
  vec3 light=volume(ray,origin,vec2(.24,.107)*inner,3.1,vec3(.91,.73,.56))
            +volume(ray,origin,vec2(.055,.036)*inner,2.7,vec3(.62,.52,.39));
  // Sample the dusty, thin disk along a short column. Its geometry keeps a
  // finite edge-on thickness. The central stellar bulge is projected in 3D.
  vec3 axis=vec3(1./1.19,1./1.19,1./.090);
  vec3 d=ray*axis, o=origin*axis;
  float a=dot(d,d), mid=-dot(o,d)/a;
  vec3 nearPoint=o+d*mid;
  float halfWidth=sqrt(max(0.,1.-dot(nearPoint,nearPoint))/a);
  if(halfWidth>0. && mid+halfWidth>0.) {
    float start=max(0.,mid-halfWidth), stepLength=(mid+halfWidth-start)/7.;
    vec3 disk=vec3(0.); float density=0.;
    for(int i=0;i<7;i++) {
      vec3 p=origin+ray*(start+(float(i)+.5)*stepLength);
      float height=exp(-abs(p.z)*66.);
      vec2 uv=p.xy/2.4+.5;
      disk+=texture2D(uDiskMap,uv).rgb*height;
      density+=height;
    }
    float column=density*stepLength;
    vec3 diskColour=disk/max(.00001,density);
    if(abs(ray.z)>.055) {
      vec3 midplane=origin+ray*(-origin.z/ray.z);
      vec3 structure=texture2D(uDiskMap,midplane.xy/2.4+.5).rgb;
      diskColour=mix(diskColour,structure,smoothstep(.055,.27,abs(ray.z))*.82);
    }
    light+=diskColour*(1.-exp(-column*39.))*1.12*uDiskReady;
  }
  gl_FragColor=vec4(light/(1.+.28*light),1.);
}`;
