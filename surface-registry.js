import { SURFACE_MISSIONS, surfaceStorageKey as defaultKey, visitedFor } from './surface-missions.js';
import { SURFACE_REGIONS } from './surface-regions.js';
import { SURFACE_SKY_SITES } from './surface-site-reference.js';

export function surfaceDefaultSite(worldId) {
  return SURFACE_SKY_SITES[worldId]?.[0] || null;
}

export function surfaceMission(worldId,regionId) {
  if (!Object.hasOwn(SURFACE_MISSIONS,worldId)) return null;
  const base=SURFACE_MISSIONS[worldId];
  if (!regionId || surfaceDefaultSite(worldId)?.id===regionId) return base;
  const region=(SURFACE_REGIONS[worldId]||[]).find(site=>site.id===regionId);
  return region ? {...base,title:region.name,zone:region.zone,places:region.places,region} : null;
}

export function surfaceStorageKey(worldId,regionId) {
  return !regionId || regionId===surfaceDefaultSite(worldId)?.id ?
    defaultKey(worldId) : defaultKey(worldId)+'.'+regionId;
}

export function readSurfaceSave(worldId,regionId) {
  if (!surfaceMission(worldId,regionId)) return null;
  try {return JSON.parse(localStorage.getItem(surfaceStorageKey(worldId,regionId)));}
  catch {return null;}
}

export function surfaceProgress(worldId,regionId) {
  const mission=surfaceMission(worldId,regionId);
  return mission ? visitedFor(mission,readSurfaceSave(worldId,regionId)?.visited).length : 0;
}

export function surfaceSiteIndex() {
  return Object.entries(SURFACE_MISSIONS).flatMap(([worldId,mission])=>{
    const original={...surfaceDefaultSite(worldId),worldId,name:mission.title,description:mission.zone,
      default:true,total:mission.places.length};
    return [original,...(SURFACE_REGIONS[worldId]||[]).map(region=>({
      ...region,worldId,default:false,total:region.places.length
    }))];
  });
}
