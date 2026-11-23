import { climateAtLatitude } from './climate-model.js';
import { CRYO_CELLS, cryoCellIndex } from './cryosphere-geography.js';

const EARTH_AREA_KM2=510064472;
const GIGATONNES_PER_METRE_KM2=.001;
// Inventories are calibrated in metres of global sea-level equivalent.
// World Ocean Assessment, chapter 5k, and IPCC AR6 WGI, section 9.5.1.
const REFERENCE_METRES={antarctica:58,greenland:7.4,otherGlaciers:.32};
const SNOW_CAP=.45;
const SNOW_MELT=.003;
const GLACIER_MELT=.008;
const TEMPERATURE_LAPSE=.0065;
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));

function iceRegion({latitude,longitude}) {
  if(latitude<-60) return 'antarctica';
  if(latitude>=60 && latitude<=84 && longitude>=-72 && longitude<=-11 &&
    longitude>=-60-Math.max(0,latitude-68)*.8 && longitude<=-18-Math.max(0,70-latitude)*1.4) return 'greenland';
  return 'otherGlaciers';
}

function groundArea({landFraction,areaFraction}) {return landFraction*areaFraction*EARTH_AREA_KM2;}

function buildGeography(cells) {
  let ocean=0,land=0;
  const weights={antarctica:0,greenland:0,otherGlaciers:0};
  const columns=cells.map(cell=>{
    const earthArea=cell.areaFraction*EARTH_AREA_KM2;
    const landArea=groundArea(cell),oceanArea=earthArea-landArea;
    const region=iceRegion(cell);
    const coverage=landArea>0 ? clamp((cell.glacierFraction??0)/cell.landFraction,0,1) : 0;
    const elevation=Math.max(0,cell.elevation??0);
    const weight=landArea*coverage*(.28+Math.min(elevation,4000)/2000);
    land+=landArea;
    ocean+=oceanArea;
    weights[region]+=weight;
    return {cell,landArea,oceanArea,region,coverage,elevation,weight};
  });
  for(const column of columns) {
    const {landArea,region,weight}=column;
    column.initial=weight>0 ? REFERENCE_METRES[region]*ocean*weight/(weights[region]*landArea) : 0;
    column.maximum=landArea>0 ? Math.max(20,column.initial*1.22) : 0;
  }
  return {columns,ocean,land};
}

// Integrate only the part of a linearly interpolated period above 0 °C.
// Positive degree days drive surface melt after seasonal snow has melted.
// https://issm.jpl.nasa.gov/documentation/pdd/
function positiveDegreeDays(first,last,days) {
  if(first>=0 && last>=0) return (first+last)*.5*days;
  if(first<=0 && last<=0) return 0;
  const warm=Math.max(first,last);
  return .5*warm**2*days/Math.abs(first-last);
}

function freezeShare(first,last) {
  if(first<=0 && last<=0) return 1;
  if(first>=0 && last>=0) return 0;
  return -Math.min(first,last)/Math.abs(first-last);
}

function forcingAt(cached,measurement,latitude) {
  if(!cached.has(latitude)) cached.set(latitude,climateAtLatitude(measurement,latitude));
  return cached.get(latitude);
}

function hasClimate(measurement) {
  return Array.isArray(measurement?.bands) && measurement.bands.length===48 &&
    measurement.bands.every(({temperature,ice,water})=>[temperature,ice,water].every(Number.isFinite));
}

function measuredCoverage(newIce,column) {
  const initial=column.initial;
  if(initial<=0) return Math.min(.65,newIce/3);
  return Math.min(1,column.coverage*(newIce/initial)**.66);
}

function fallbackIndex(cells,latitude,longitude) {
  let nearest=-1,best=Infinity;
  for(let i=0;i<cells.length;i++) {
    const cell=cells[i],dx=((longitude-cell.longitude+180)%360+360)%360-180;
    const delta=(latitude-cell.latitude)**2+dx**2;
    if(delta<best) {best=delta;nearest=i;}
  }
  return nearest;
}

export class CryosphereModel {
  #cells;
  #columns;
  #ocean;
  #land;
  #initialGt;
  #grounded;
  #snow;

  constructor(cells=CRYO_CELLS) {
    this.#cells=cells;
    const {columns,ocean,land}=buildGeography(cells);
    this.#columns=columns;
    this.#ocean=ocean;
    this.#land=land;
    this.#grounded=Float64Array.from(columns,column=>column.initial);
    this.#snow=new Float64Array(columns.length);
    this.#initialGt=columns.reduce((sum,column)=>sum+column.initial*column.landArea*GIGATONNES_PER_METRE_KM2,0);
  }

  advance(before,after,days) {
    if(!Number.isFinite(days) || days<0 || days>36525 || !hasClimate(before) || !hasClimate(after)) return false;
    if(days===0) return true;
    const first=new Map(),last=new Map();
    for(let i=0;i<this.#columns.length;i++) {
      const column=this.#columns[i];
      if(!column.landArea) continue;
      const {latitude}=column.cell;
      const a=forcingAt(first,before,latitude),b=forcingAt(last,after,latitude);
      const localA=a.temperature-TEMPERATURE_LAPSE*column.elevation;
      const localB=b.temperature-TEMPERATURE_LAPSE*column.elevation;
      const frost=freezeShare(localA,localB);
      const positive=positiveDegreeDays(localA,localB,days);
      const available=clamp((a.ice+a.water+b.ice+b.water)*.5,0,1);
      // Uniform nominal cold-season snowfall, reduced in very cold air.
      // The melt factors and water inventory operate in metres water equivalent.
      const moisture=Math.max(.16,Math.exp(Math.min(0,(localA+localB)*.5)/20));
      const snowfall=.00065*frost*days*available*moisture;
      const snowBeforeMelt=this.#snow[i]+snowfall;
      const snowLeft=Math.max(0,snowBeforeMelt-positive*SNOW_MELT);
      const meltDegreeDays=Math.max(0,positive-snowBeforeMelt/SNOW_MELT);
      const previousIce=this.#grounded[i];
      const iceMelt=meltDegreeDays*GLACIER_MELT*measuredCoverage(previousIce,column);
      const consolidated=Math.max(0,snowLeft-SNOW_CAP);
      this.#grounded[i]=clamp(previousIce-iceMelt+consolidated,0,column.maximum);
      this.#snow[i]=Math.min(SNOW_CAP,snowLeft);
    }
    return true;
  }

  measure(measurement) {
    const forcing=new Map(),valid=hasClimate(measurement);
    let northSeaIceAreaKm2=0,southSeaIceAreaKm2=0,landIceAreaKm2=0,snowAreaKm2=0,groundedSnowGt=0;
    const iceByRegion={antarctica:0,greenland:0,otherGlaciers:0};
    const cells=this.#columns.map((column,i)=>{
      const {cell,landArea,oceanArea,region}=column;
      const seaIce=oceanArea>0&&valid?clamp(forcingAt(forcing,measurement,cell.latitude).ice,0,1):0;
      const landIceMeters=this.#grounded[i];
      const landIce=measuredCoverage(landIceMeters,column),snow=clamp(this.#snow[i]/.075,0,1);
      if(cell.latitude>=0) northSeaIceAreaKm2+=seaIce*oceanArea;
      else southSeaIceAreaKm2+=seaIce*oceanArea;
      landIceAreaKm2+=landIce*landArea;
      snowAreaKm2+=snow*landArea;
      iceByRegion[region]+=landIceMeters*landArea*GIGATONNES_PER_METRE_KM2;
      groundedSnowGt+=this.#snow[i]*landArea*GIGATONNES_PER_METRE_KM2;
      return {...cell,seaIce,landIce,snow,landIceMeters,snowMeters:this.#snow[i]};
    });
    const groundedIceGt=iceByRegion.antarctica+iceByRegion.greenland+iceByRegion.otherGlaciers;
    const groundedChangeGt=groundedIceGt+groundedSnowGt-this.#initialGt;
    const seaIceAreaKm2=northSeaIceAreaKm2+southSeaIceAreaKm2;
    // Continental mass gain draws the same mass from the ocean. Floating ice
    // is already supported by seawater and contributes no first-order level change.
    const oceanWaterChangeGt=-groundedChangeGt;
    const seaLevelMeters=this.#ocean>0 ? oceanWaterChangeGt/(this.#ocean*GIGATONNES_PER_METRE_KM2) : 0;
    return {cells,seaLevelMeters,seaIceAreaKm2,northSeaIceAreaKm2,southSeaIceAreaKm2,landIceAreaKm2,snowAreaKm2,
      seaIceFraction:this.#ocean>0?seaIceAreaKm2/this.#ocean:0,landIceFraction:this.#land>0?landIceAreaKm2/this.#land:0,
      oceanAreaKm2:this.#ocean,landAreaKm2:this.#land,groundedIceGt,groundedSnowGt,groundedChangeGt,oceanWaterChangeGt,
      waterInventoryGt:this.#initialGt,antarcticaIceGt:iceByRegion.antarctica,greenlandIceGt:iceByRegion.greenland,
      otherGlaciersIceGt:iceByRegion.otherGlaciers};
  }

  sample(readings,latitude,longitude) {
    if(!Number.isFinite(latitude) || latitude<-90 || latitude>90 || !Number.isFinite(longitude)) return null;
    const index=this.#cells===CRYO_CELLS ? cryoCellIndex(latitude,longitude) : fallbackIndex(this.#cells,latitude,longitude);
    return readings?.cells?.[index]??null;
  }

  serialize() {
    return {version:1,grounded:Array.from(this.#grounded),snow:Array.from(this.#snow)};
  }

  static restore(snapshot,cells=CRYO_CELLS) {
    if(snapshot?.version!==1 || !Array.isArray(snapshot.grounded) || !Array.isArray(snapshot.snow) ||
      snapshot.grounded.length!==cells.length || snapshot.snow.length!==cells.length) return null;
    const model=new CryosphereModel(cells);
    for(let i=0;i<cells.length;i++) {
      const {maximum,landArea}=model.#columns[i],grounded=snapshot.grounded[i],snow=snapshot.snow[i];
      if(!Number.isFinite(grounded)||grounded<0||grounded>maximum ||
        !Number.isFinite(snow)||snow<0||snow>(landArea>0?SNOW_CAP:0)) return null;
      model.#grounded[i]=grounded;
      model.#snow[i]=snow;
    }
    return model;
  }
}
