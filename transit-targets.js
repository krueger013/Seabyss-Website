// These catalogue families contain confirmed transiting planets. The transit
// system flag carries that information on subsequently added catalogue entries.
const transitHosts = new Set(['trappist-1','kepler-62','kepler-186','hd-189733','55-cancri']);
const positive = value => Number.isFinite(value) && value > 0;

export function isTransitPlanet(body) {
  return !!body && body.kind === 'planet' && !body.simulated &&
    (body.transitSystem === true || transitHosts.has(body.parentId)) &&
    positive(body.radius) && positive(body.orbitRadiusKm) && positive(body.orbitPeriodDays);
}

export function transitTarget(objects,id) {
  const selected = objects.find(body => body.id === id);
  const planet = selected?.kind === 'star'
    ? objects.find(body => body.parentId === id && isTransitPlanet(body)) : selected;
  if (!isTransitPlanet(planet)) return null;
  const star = objects.find(body => body.id === planet.parentId);
  if (star?.kind !== 'star' || star.simulated || !positive(star.radius) ||
      planet.radius >= star.radius || planet.orbitRadiusKm <= star.radius+planet.radius) return null;
  return {planet,star,radiusRatio:planet.radius/star.radius,axis:planet.orbitRadiusKm/star.radius,
    periodHours:planet.orbitPeriodDays*24};
}
