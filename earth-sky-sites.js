// Shared observing coordinates for the globe and terrestrial sky. Longitudes
// are east-positive. Presets use a sea-level observer and an IANA time zone.
const places=[
  ['levis','Terrasse de Lévis','Québec et Canada',46.8124,-71.1802,'America/Toronto'],
  ['quebec','Vieux-Québec','Québec et Canada',46.8118,-71.2048,'America/Toronto'],
  ['montreal','Mont-Royal','Québec et Canada',45.5037,-73.5877,'America/Toronto'],
  ['perce','Village de Percé','Québec et Canada',48.5239,-64.2128,'America/Toronto'],
  ['forillon','Parc national Forillon','Québec et Canada',48.89,-64.35,'America/Toronto'],
  ['cap-breton','Hautes-Terres-du-Cap-Breton','Québec et Canada',46.73,-60.64,'America/Glace_Bay'],
  ['banff','Banff','Québec et Canada',51.1767,-115.5719,'America/Edmonton'],
  ['grand-canyon','Rive sud du Grand Canyon','Amériques',36.0587,-112.1077,'America/Phoenix'],
  ['cusco','Plaza de Armas, Cusco','Amériques',-13.5167,-71.9786,'America/Lima'],
  ['valparaiso','Quartier historique, Valparaíso','Amériques',-33.04064,-71.628,'America/Santiago'],
  ['paris','Trocadéro, Paris','Europe, Afrique et Asie',48.8614,2.2887,'Europe/Paris'],
  ['venice','Place Saint-Marc, Venise','Europe, Afrique et Asie',45.4341,12.3393,'Europe/Rome'],
  ['cape-town','Waterfront du Cap','Europe, Afrique et Asie',-33.9065,18.4187,'Africa/Johannesburg'],
  ['tokyo','Shibuya, Tokyo','Europe, Afrique et Asie',35.6595,139.7005,'Asia/Tokyo'],
  ['sydney','Circular Quay, Sydney','Océanie',-33.8607,151.2123,'Australia/Sydney'],
  ['tromso','Tromsø','Europe, Afrique et Asie',69.6492,18.9553,'Europe/Oslo'],
  ['quito','Quito','Amériques',-0.2202,-78.5125,'America/Guayaquil'],
  ['greenwich','Greenwich, Londres','Europe, Afrique et Asie',51.4779,-0.0015,'Europe/London']
];
export const EARTH_SKY_SITES=Object.freeze(places.map(([id,name,group,latitude,longitude,timeZone])=>
  Object.freeze({id,name,group,latitude,longitude,timeZone,elevationMeters:0})));

export function resolveEarthSkySite(value) {
  if (typeof value==='string') return EARTH_SKY_SITES.find(place=>place.id===value) || EARTH_SKY_SITES[0];
  if (!value || !Number.isFinite(value.latitude) || Math.abs(value.latitude)>90 ||
      !Number.isFinite(value.longitude) || Math.abs(value.longitude)>180) return EARTH_SKY_SITES[0];
  const latitude=value.latitude, longitude=value.longitude===180?-180:value.longitude;
  const known=EARTH_SKY_SITES.find(place=>Math.abs(place.latitude-latitude)<.0000051 && Math.abs(place.longitude-longitude)<.0000051);
  if (known) return known;
  let timeZone='UTC';
  if (typeof value.timeZone==='string' && value.timeZone.length<=64) {
    try {timeZone=new Intl.DateTimeFormat('fr-CA',{timeZone:value.timeZone}).resolvedOptions().timeZone;} catch {}
  }
  return {id:'custom',latitude,longitude,timeZone,
    name:typeof value.name==='string' && value.name.trim()?value.name.trim().slice(0,100):'Point sur la carte',
    elevationMeters:Number.isFinite(value.elevationMeters) && value.elevationMeters>=-500 && value.elevationMeters<=9000?value.elevationMeters:0};
}
