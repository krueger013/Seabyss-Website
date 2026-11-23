// Trace the camera ray against the same continuous elevation field used by
// the terrain mesh. The first intersection prevents selecting through a ridge.
export function traceSurfaceGround(ray,heightAt,boundary) {
  if (!ray) return null;
  const {at,direction}=ray;
  const [x,y,z]=at;
  const [dx,dy,dz]=direction;
  const limit=Math.min(
    1000,
    dx===0 ? Infinity : (Math.sign(dx)*boundary-x)/dx,
    dz===0 ? Infinity : (Math.sign(dz)*boundary-z)/dz
  );
  if (limit<=0) return null;
  const clearance=t=>y+dy*t-heightAt(x+dx*t,z+dz*t);
  let previous=0;
  while (previous<limit) {
    const next=Math.min(limit,previous+Math.min(1.25,.27+.025*previous));
    if (clearance(next)<=0) {
      let low=previous, high=next;
      for (let i=0;i<12;i++) {
        const middle=(low+high)/2;
        if (clearance(middle)>0) low=middle;
        else high=middle;
      }
      return {x:x+dx*high,z:z+dz*high};
    }
    previous=next;
  }
  return null;
}
