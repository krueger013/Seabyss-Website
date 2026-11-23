// Seasonal zonal energy-balance model. Air temperature is in °C, flux in W/m²,
// heat capacity in J/(m² K), and the spatial coordinate x is sin(latitude).
// North & Coakley (1979): https://ntrs.nasa.gov/citations/19790063666
// Guendelman & Kaspi (2022): https://doi.org/10.1029/2022AV000684
const DEG=Math.PI/180;
const DAY=86400;
const EARTH_YEAR=365.256;
const SOLAR_CONSTANT=1361;
const STEFAN_BOLTZMANN=5.670374419e-8;
const BANDS=48;
const DX=2/BANDS;
const MIN_TEMP=-273.15;
const MAX_TEMP=2400;
const STANDARD_MIXING_DEPTH=11.5;
const LOCAL_CLIMATE_FIELDS=['temperature','ice','albedo','olr','water'];
export const CLIMATE_RANGES=Object.freeze(Object.fromEntries(Object.entries({
  solarLuminosity:[.01,300],semiMajorAxis:[.04,40],eccentricity:[0,.8],
  obliquity:[0,90],perihelionLongitude:[0,360],epochAnomaly:[0,360],period:[2,20000],
  pressure:[0,20],co2:[1,20000],water:[0,1],heatTransport:[0,1.6],
  iceAlbedo:[.25,.90],oceanMixingDepth:[1,150],geothermalFlux:[0,400]
}).map(([key,value])=>[key,Object.freeze(value)])));
export const CLIMATE_DEFAULTS=Object.freeze({solarLuminosity:1,semiMajorAxis:1,eccentricity:.0167,
  obliquity:23.44,perihelionLongitude:282.9,epochAnomaly:0,period:null,
  pressure:1,co2:420,water:1,heatTransport:.60,iceAlbedo:.60,oceanMixingDepth:STANDARD_MIXING_DEPTH,geothermalFlux:0});

const bands=Array.from({length:BANDS},(_,i)=>{
  const x=-1+(i+.5)*DX;
  return {x,latitude:Math.asin(x)/DEG,albedo:.28+.075*(3*x*x-1)/2,
    lowEdge:1-(-1+i*DX)**2,highEdge:1-(-1+(i+1)*DX)**2};
});
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const smooth=value=>{
  const t=clamp(value,0,1);
  return t*t*(3-2*t);
};
const inRange=(value,min,max)=>Number.isFinite(value) && value>=min && value<=max;
const normalize=angle=>(angle%360+360)%360;

function readOptions(current,patch) {
  if (!patch || typeof patch!=='object' || Array.isArray(patch)) return null;
  for (const [key,value] of Object.entries(patch)) {
    if (!Object.hasOwn(CLIMATE_RANGES,key)) return null;
    if (key==='period' && value===null) continue;
    if (!inRange(value,...CLIMATE_RANGES[key])) return null;
  }
  return Object.freeze({...current,...patch});
}

function orbitalPeriod(options) {return options.period ?? options.semiMajorAxis**1.5*EARTH_YEAR;}

function solarOrbit(options,day) {
  const e=options.eccentricity,period=orbitalPeriod(options);
  const mean=normalize(options.epochAnomaly+(day%period)*360/period)*DEG;
  let eccentric=mean;
  for (let i=0;i<10;i++) {
    const change=(eccentric-e*Math.sin(eccentric)-mean)/(1-e*Math.cos(eccentric));
    eccentric-=change;
    if (Math.abs(change)<1e-12) break;
  }
  const distance=options.semiMajorAxis*(1-e*Math.cos(eccentric));
  const trueAnomaly=Math.atan2(Math.sqrt(1-e*e)*Math.sin(eccentric),Math.cos(eccentric)-e);
  const longitude=normalize(trueAnomaly/DEG+options.perihelionLongitude);
  const declination=Math.asin(Math.sin(options.obliquity*DEG)*Math.sin(longitude*DEG))/DEG;
  return {distance,longitude,declination,irradiance:SOLAR_CONSTANT*options.solarLuminosity/distance**2};
}

/** Diurnal mean over a latitude circle with polar day and night handled explicitly. */
export function dailyInsolation(latitude,declination,irradiance=SOLAR_CONSTANT) {
  const lat=latitude*DEG,dec=declination*DEG;
  const s=Math.sin(lat)*Math.sin(dec),c=Math.cos(lat)*Math.cos(dec);
  if (s>=c) return irradiance*s;
  if (s<=-c) return 0;
  const sunset=Math.acos(-s/c);
  return irradiance/Math.PI*(sunset*s+c*Math.sin(sunset));
}

/** Geometric daylight normalized to a 24-hour day, with no refraction. */
export function daylightHours(latitude,declination) {
  if (!inRange(latitude,-90,90) || !inRange(declination,-90,90)) return null;
  // Solar altitude has sin(h) = s + c cos(hour angle). See WMO No. 8, ch. 7.
  const lat=latitude*DEG,dec=declination*DEG;
  const s=Math.sin(lat)*Math.sin(dec),c=Math.cos(lat)*Math.cos(dec);
  if (Math.abs(s)<1e-14 && c<1e-14) return 12;
  if (s>=c) return 24;
  if (s<=-c) return 0;
  return 24*Math.acos(-s/c)/Math.PI;
}

/** Interpolate the equal-area bands, while calculating sunlight at the actual latitude. */
export function climateAtLatitude(measurement, latitude) {
  if (!inRange(latitude,-90,90) || !Array.isArray(measurement?.bands) || measurement.bands.length!==BANDS) return null;
  const coordinate=clamp((Math.sin(latitude*DEG)+1)/DX-.5,0,BANDS-1);
  const low=Math.floor(coordinate),high=Math.ceil(coordinate),blend=coordinate-low;
  const readings={latitude};
  for (const key of LOCAL_CLIMATE_FIELDS) {
    const first=measurement.bands[low][key],last=measurement.bands[high][key];
    readings[key]=first+(last-first)*blend;
  }
  const insolation=dailyInsolation(latitude,measurement.solarDeclination,measurement.solarIrradiance);
  return {...readings,insolation,absorbed:insolation*(1-readings.albedo),
    daylightHours:daylightHours(latitude,measurement.solarDeclination)};
}

function surfaceHeatCapacity(options) {
  // Effective energy storage of ground plus a water column. Water storage is
  // proportional to mixed-layer depth (density × specific heat × depth).
  // https://brian-rose.github.io/ClimateLaboratoryBook/courseware/seasonal-cycle/
  return 1.5e7+4.7e7*options.water*(options.oceanMixingDepth/STANDARD_MIXING_DEPTH);
}

function radiationParameters(options) {
  // Logarithmic concentration perturbation about the Earth benchmark. The
  // coefficient follows Myhre et al. 1998 (10.1029/98GL01908). The pressure
  // response assumes an Earth-like atmosphere and fades to bare radiation.
  const atmosphere=Math.min(1,options.pressure**.65);
  const co2=5.35*Math.log(options.co2/420)*atmosphere;
  const pressure=14*Math.log(Math.max(1,options.pressure));
  return {atmosphere,scale:1-(co2+pressure)/238};
}

function radiation(temperature,params) {
  const kelvin=temperature-MIN_TEMP;
  const black=STEFAN_BOLTZMANN*kelvin**4;
  // Linear Earth empirical OLR near the present climate. Join continuously to
  // T⁴ outside that climate range for cold airless and very hot experiments.
  const fit=temperature<-45 ? 120*(kelvin/228.15)**4
    : temperature>45 ? 300*(kelvin/318.15)**4 : 210+2*temperature;
  return ((1-params.atmosphere)*black+params.atmosphere*fit)*params.scale;
}

function feedbackIce(temperature,water,current,days) {
  if (water===0) return 0;
  // Surface ice is an areal fraction of the available water. A narrow overlap
  // around the seawater freezing point avoids noise where a cell barely thaws.
  const grows=water*smooth((-1.8-temperature)/8);
  const remains=water*smooth((1.2-temperature)/8);
  const target=clamp(current,grows,remains);
  const timescale=target>current ? 75 : 45;
  return clamp(current+(target-current)*-Math.expm1(-days/timescale),0,water);
}

export class ClimateModel {
  #options;
  #day;
  #temperature;
  #ice;
  #upper=new Float64Array(BANDS);
  #rhs=new Float64Array(BANDS);

  constructor(options={}) {
    this.#options=readOptions(CLIMATE_DEFAULTS,options);
    if (!this.#options) throw new RangeError('Paramètres climatiques invalides.');
    this.reset();
  }

  get options() {return this.#options;}

  configure(patch) {
    const options=readOptions(this.#options,patch);
    if (!options) return false;
    this.#options=options;
    for (let i=0;i<BANDS;i++) this.#ice[i]=Math.min(options.water,this.#ice[i]);
    return true;
  }

  reset() {
    this.#day=0;
    const season=solarOrbit(this.#options,0).declination/23.44;
    this.#temperature=Float64Array.from(bands,({x})=>27-54*Math.abs(x)**3+5*x*clamp(season,-1,1));
    this.#ice=Float64Array.from(this.#temperature,temperature=>this.#options.water*smooth((-1.8-temperature)/8));
    return this;
  }

  advance(days) {
    if (!inRange(days,0,36525) || this.#day+days>1e9) return false;
    if (days===0) return true;
    const options=this.#options,rad=radiationParameters(options);
    const capacity=surfaceHeatCapacity(options);
    const transport=options.heatTransport/(DX*DX);
    const maxStep=Math.min(2,Math.max(.25,orbitalPeriod(options)/96));
    const steps=Math.ceil(days/maxStep),dt=days/steps;
    const timestep=dt*DAY/capacity;
    const start=this.#day;
    for (let step=0;step<steps;step++) {
      const orbit=solarOrbit(options,start+(step+.5)*dt);
      for (let i=0;i<BANDS;i++) {
        const band=bands[i],temp=this.#temperature[i];
        const incoming=dailyInsolation(band.latitude,orbit.declination,orbit.irradiance);
        const albedo=band.albedo+(options.iceAlbedo-band.albedo)*this.#ice[i];
        const outward=radiation(temp,rad);
        const slope=(radiation(temp+.05,rad)-outward)/.05;
        const lower=-timestep*transport*band.lowEdge;
        const upper=-timestep*transport*band.highEdge;
        const central=1-lower-upper+timestep*slope;
        // Implicit, conservative diffusion at each cell face. A first-order
        // implicit approximation of infrared cooling keeps high-flux steps stable.
        const divisor=central-(i>0 ? lower*this.#upper[i-1] : 0);
        // Supply the specified heat from below uniformly, independent of day or latitude.
        const source=temp+timestep*(incoming*(1-albedo)+options.geothermalFlux-outward+slope*temp);
        this.#upper[i]=upper/divisor;
        this.#rhs[i]=(source-(i>0 ? lower*this.#rhs[i-1] : 0))/divisor;
      }
      for (let i=BANDS-1;i>=0;i--) {
        this.#temperature[i]=clamp(this.#rhs[i]-(i<BANDS-1 ? this.#upper[i]*this.#temperature[i+1] : 0),MIN_TEMP,MAX_TEMP);
        this.#ice[i]=feedbackIce(this.#temperature[i],options.water,this.#ice[i],dt);
      }
    }
    this.#day=start+days;
    return true;
  }

  measure() {
    const options=this.#options,orbit=solarOrbit(options,this.#day),rad=radiationParameters(options);
    let totalTemp=0,totalIce=0,totalSun=0,totalAbsorbed=0,totalOLR=0;
    const measurements=bands.map(({latitude,albedo:backgroundAlbedo},i)=>{
      const temperature=this.#temperature[i],ice=this.#ice[i];
      const insolation=dailyInsolation(latitude,orbit.declination,orbit.irradiance);
      const albedo=backgroundAlbedo+(options.iceAlbedo-backgroundAlbedo)*ice;
      const absorbed=insolation*(1-albedo);
      const olr=radiation(temperature,rad);
      totalTemp+=temperature;totalIce+=ice;totalSun+=insolation;totalAbsorbed+=absorbed;totalOLR+=olr;
      return {latitude,temperature,ice,albedo,insolation,absorbed,olr,water:options.water-ice};
    });
    return {day:this.#day,meanTemperature:totalTemp/BANDS,minTemperature:Math.min(...this.#temperature),
      maxTemperature:Math.max(...this.#temperature),iceFraction:totalIce/BANDS,
      energyImbalance:(totalAbsorbed-totalOLR)/BANDS+options.geothermalFlux,meanInsolation:totalSun/BANDS,
      absorbedFlux:totalAbsorbed/BANDS,outgoingFlux:totalOLR/BANDS,orbitalPeriod:orbitalPeriod(options),
      geothermalFlux:options.geothermalFlux,meanAlbedo:(totalSun-totalAbsorbed)/totalSun,
      heatCapacity:surfaceHeatCapacity(options),solarIrradiance:orbit.irradiance,
      orbitalDistance:orbit.distance,solarLongitude:orbit.longitude,solarDeclination:orbit.declination,
      limitReached:this.#temperature.includes(MAX_TEMP),bands:measurements};
  }

  serialize() {
    return {version:1,options:{...this.#options},day:this.#day,
      temperature:Array.from(this.#temperature),ice:Array.from(this.#ice)};
  }

  static restore(snapshot) {
    if (snapshot?.version!==1 || !inRange(snapshot.day,0,1e9) ||
        !Array.isArray(snapshot.temperature) || snapshot.temperature.length!==BANDS ||
        !Array.isArray(snapshot.ice) || snapshot.ice.length!==BANDS) return null;
    const options=readOptions(CLIMATE_DEFAULTS,snapshot.options);
    if (!options || !Array.from(snapshot.temperature).every(temp=>inRange(temp,MIN_TEMP,MAX_TEMP)) ||
        !Array.from(snapshot.ice).every(ice=>inRange(ice,0,options.water))) return null;
    const model=new ClimateModel(options);
    model.#day=snapshot.day;
    model.#temperature=Float64Array.from(snapshot.temperature);
    model.#ice=Float64Array.from(snapshot.ice);
    return model;
  }
}
