// Schwarzschild metric with r expressed in Rₛ = 2GM/c² and time in Rₛ/c.
// E. Gourgoulhon, Geometry and physics of black holes, sections 7 and 8.
// https://relativite.obspm.fr/blackholes/bholes.pdf

const C_METRES_PER_SECOND = 299792458;
const SOLAR_GM = 1.3271244e20;
const SOLAR_RADIUS_METRES = 2 * SOLAR_GM / C_METRES_PER_SECOND ** 2;
const TAU = 2 * Math.PI;
const CRITICAL_IMPACT = 3 * Math.sqrt(3) / 2;
const PHOTON_U = 2 / 3;
const CRITICAL_Q = 4 / 27;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const BLACK_HOLE_LIMITS = Object.freeze({
  horizon: 1,
  photonSphere: 1.5,
  isco: 3,
  criticalImpact: CRITICAL_IMPACT
});

export function schwarzschildRadiusKm(massSolar) {
  if (!Number.isFinite(massSolar) || massSolar <= 0) return null;
  const radius = SOLAR_RADIUS_METRES / 1000 * massSolar;
  return Number.isFinite(radius) ? radius : null;
}

export function schwarzschildTimeSeconds(massSolar) {
  if (!Number.isFinite(massSolar) || massSolar <= 0) return null;
  return SOLAR_RADIUS_METRES / C_METRES_PER_SECOND * massSolar;
}

// Leading-order geodesic deviation for a small radial separation in the
// freely falling frame. At a fixed r/Rₛ the gradient scales as 1/M².
export function radialTidalAcceleration(massSolar, radius, lengthMetres = 2) {
  const scale = schwarzschildRadiusKm(massSolar) * 1000;
  if (!(scale > 0) || !Number.isFinite(radius) || radius <= 0 ||
      !Number.isFinite(lengthMetres) || lengthMetres < 0 || lengthMetres > scale * radius * .01) return null;
  const acceleration = (C_METRES_PER_SECOND / scale) ** 2 * lengthMetres / radius ** 3;
  return Number.isFinite(acceleration) ? acceleration : null;
}

// Clock ratios are dτ/dt relative to a clock at infinity. A held position
// requires acceleration, whereas the circular orbit is a timelike geodesic.
export function hoverClockRate(radius) {
  return Number.isFinite(radius) && radius > 1 ? Math.sqrt(1 - 1 / radius) : null;
}

export function circularClockRate(radius) {
  return Number.isFinite(radius) && radius > 1.5 ? Math.sqrt(1 - 1.5 / radius) : null;
}

export function circularOrbit(radius) {
  const clockRate = circularClockRate(radius);
  if (clockRate === null) return null;
  const periodRs = TAU * Math.SQRT2 * radius ** 1.5;
  if (!Number.isFinite(periodRs)) return null;
  return {
    clockRate,
    periodRs,
    properPeriodRs: periodRs * clockRate,
    localSpeedC: 1 / (Math.SQRT2 * Math.sqrt(radius - 1)),
    stable: radius > 3,
    stability: radius > 3 ? 'stable' : radius === 3 ? 'marginal' : 'unstable'
  };
}

function validFall(startRadius, endRadius) {
  return Number.isFinite(startRadius) && startRadius > 1 && startRadius <= 1e12 &&
    Number.isFinite(endRadius) && endRadius >= 0 && endRadius <= startRadius;
}

function fallParameter(startRadius, radius) {
  return Math.atan2(Math.sqrt((startRadius - radius) / startRadius), Math.sqrt(radius / startRadius));
}

function fallProperTime(startRadius, parameter) {
  return startRadius ** 1.5 * (parameter + Math.sin(2 * parameter) / 2);
}

function fallReading(startRadius, radius, parameter) {
  const properTimeRs = fallProperTime(startRadius, parameter);
  if (radius === startRadius) return { radius, properTimeRs: 0, coordinateTimeRs: 0, arrivalSpeedC: 0 };
  if (radius <= 1) {
    return { radius, properTimeRs, coordinateTimeRs: Infinity, arrivalSpeedC: radius === 1 ? 1 : null };
  }
  const speed = Math.sqrt((startRadius - radius) / (radius * (startRadius - 1)));
  // Evaluate 2 atanh(speed) using the algebraic identity for 1 − speed² so a
  // rounded speed near 1 does not turn a finite exterior time into Infinity.
  const logGap = Math.log((startRadius / (startRadius - 1)) * ((radius - 1) / radius));
  const coordinateTimeRs = Math.sqrt(startRadius - 1) * (properTimeRs / Math.sqrt(startRadius) + 2 * parameter) +
    2 * Math.log1p(speed) - logGap;
  return { radius, properTimeRs, coordinateTimeRs, arrivalSpeedC: speed };
}

// Starting at rest, r = r₀ cos²(η). The infalling clock crosses the horizon
// in finite time. Schwarzschild coordinate time only charts the exterior.
export function radialFreeFall(startRadius, endRadius = 1) {
  if (!validFall(startRadius, endRadius)) return null;
  return {
    ...fallReading(startRadius, endRadius, fallParameter(startRadius, endRadius)),
    horizonProperTimeRs: fallProperTime(startRadius, fallParameter(startRadius, 1))
  };
}

export function radialFreeFallSample(startRadius, fraction, endRadius = 1) {
  if (!validFall(startRadius, endRadius) || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  if (fraction === 0 || startRadius === endRadius) return fallReading(startRadius, startRadius, 0);
  const endpoint = fallParameter(startRadius, endRadius);
  if (fraction === 1) return fallReading(startRadius, endRadius, endpoint);
  const goal = fraction * fallProperTime(startRadius, endpoint);
  let lower = 0, upper = endpoint;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (lower + upper) / 2;
    if (fallProperTime(startRadius, middle) < goal) lower = middle;
    else upper = middle;
  }
  const parameter = (lower + upper) / 2;
  const radius = clamp(startRadius * Math.cos(parameter) ** 2, endRadius, startRadius);
  return fallReading(startRadius, radius, parameter);
}

function simpsonSegment(integrand, start, end) {
  const step = end - start;
  return step / 6 * (integrand(start) + 4 * integrand(start + step / 2) + integrand(end));
}

function integrate(integrand, start, end) {
  const count = Math.max(1, Math.ceil((end - start) / .0025));
  const step = (end - start) / count;
  let angle = 0;
  for (let i = 0; i < count; i++) {
    angle += simpsonSegment(integrand, start + i * step, start + (i + 1) * step);
  }
  return angle;
}

function point(radius, angleFromInfinity, sign) {
  const angle = sign * (Math.PI - angleFromInfinity);
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), radius, angle };
}

// For a scattered ray the equation (du/dφ)² = b⁻² − u²(1 − u) has an
// exterior turning root uₜ < 2/3. The expanded form around the maximum
// avoids cancellation for impact parameters very near the critical value.
function turningInverse(impact) {
  if (impact < 3) {
    const proximity = (impact - CRITICAL_IMPACT) / impact;
    const deficit = CRITICAL_Q * proximity * (2 - proximity);
    let low = 0, high = PHOTON_U;
    for (let i = 0; i < 56; i++) {
      const middle = (low + high) / 2;
      if (middle ** 2 * (1 - middle) < deficit) low = middle;
      else high = middle;
    }
    return PHOTON_U - (low + high) / 2;
  }
  const target = 1 / impact ** 2;
  let low = 1 / impact, high = Math.min(PHOTON_U, low * 2);
  for (let i = 0; i < 56; i++) {
    const middle = (low + high) / 2;
    if (middle ** 2 * (1 - middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function escapedRay(impact, sign, startRadius, step, maxPoints) {
  const turning = turningInverse(impact);
  const closestRadius = 1 / turning;
  const width = Math.sqrt(2 - 3 * turning);
  // u = uₜ(1 − t²) removes the simple turning singularity. t = a sinh(z)
  // resolves the near-critical angle even when that turning root is nearly double.
  function integrand(z) {
    const t = width * Math.sinh(z), delta = turning * t * t;
    const factor = turning * width * width + (3 * turning - 1) * delta - delta * delta;
    return 2 * Math.sqrt(turning) * width * Math.cosh(z) / Math.sqrt(factor);
  }
  const turnAngle = integrate(integrand, 0, Math.asinh(1 / width));
  const deflection = Math.max(0, 2 * turnAngle - Math.PI);
  if (startRadius <= closestRadius) return { status: 'escaped', points: [], closestRadius, deflection, missed: true };
  const viewEnd = Math.asinh(Math.sqrt(1 - 1 / (turning * startRadius)) / width);
  const count = clamp(Math.ceil(viewEnd / step), 1, Math.floor((maxPoints - 1) / 2));
  const incoming = [], outgoing = [];
  let angle = 0, previous = 0;
  for (let i = 0; i <= count; i++) {
    const z = viewEnd * i / count;
    angle += simpsonSegment(integrand, previous, z);
    previous = z;
    const t = width * Math.sinh(z);
    const radius = i === count ? startRadius : 1 / (turning * (1 - t * t));
    incoming.push(point(radius, turnAngle - angle, sign));
    if (i) outgoing.push(point(radius, turnAngle + angle, sign));
  }
  return { status: 'escaped', points: incoming.reverse().concat(outgoing), closestRadius, deflection, missed: false };
}

function inwardRay(impact, sign, startRadius, step, maxPoints) {
  let inverse, integrand, from, end, start = 0;
  const atView = 1 / startRadius;
  const critical = impact === CRITICAL_IMPACT;
  if (critical) {
    if (startRadius <= 1.5) return { status: 'critical', points: [], closestRadius: 1.5, deflection: null, missed: true };
    // At bₖ the radial polynomial factors as (u−2/3)²(u+1/3).
    // Display sixteen e-folds of the asymptotic approach to the photon sphere.
    from = -Math.log1p(-atView / PHOTON_U);
    end = from + 16;
    inverse = z => PHOTON_U * -Math.expm1(-z);
    integrand = z => 1 / Math.sqrt(inverse(z) + 1 / 3);
  } else if (impact < 1) {
    from = atView; end = 1;
    inverse = u => u;
    integrand = u => impact / Math.sqrt(1 - impact ** 2 * u ** 2 * (1 - u));
  } else {
    // Resolve the central minimum of the radial polynomial from either side.
    const proximity = (CRITICAL_IMPACT - impact) / impact;
    const width = Math.sqrt(CRITICAL_Q * proximity * (2 + proximity));
    start = Math.asinh(-PHOTON_U / width);
    from = Math.asinh((atView - PHOTON_U) / width);
    end = Math.asinh((1 - PHOTON_U) / width);
    inverse = z => PHOTON_U + width * Math.sinh(z);
    integrand = z => {
      const t = Math.sinh(z);
      return Math.cosh(z) / Math.sqrt(1 + t * t * (inverse(z) + 1 / 3));
    };
  }
  let angle = integrate(integrand, start, from), previous = from;
  const count = clamp(Math.ceil((end - from) / step), 1, maxPoints - 1);
  const points = [point(startRadius, angle, sign)];
  for (let i = 1; i <= count; i++) {
    const z = from + (end - from) * i / count;
    angle += simpsonSegment(integrand, previous, z);
    previous = z;
    const radius = !critical && i === count ? 1 : 1 / inverse(z);
    points.push(point(radius, angle, sign));
  }
  return { status: critical ? 'critical' : 'captured', points, closestRadius: critical ? 1.5 : 1, deflection: null, missed: false };
}

/** An equatorial light ray from infinity passing a spherical, nonspinning black hole. */
export function traceLightRay(impact, { startRadius = 18, step = .01, maxPoints = 4000 } = {}) {
  if (!Number.isFinite(impact) || Math.abs(impact) > 1e6 || !Number.isFinite(startRadius) ||
      startRadius <= 1 || startRadius > 1e6 || !Number.isFinite(step) || step <= 0 || !Number.isInteger(maxPoints) || maxPoints < 3) return null;
  const magnitude = Math.abs(impact), sign = impact < 0 ? -1 : 1;
  const sampling = clamp(step, .001, .05), budget = Math.min(maxPoints, 10000);
  if (magnitude === 0) {
    const count = Math.min(budget, 128);
    const points = Array.from({ length: count }, (_, i) => {
      const radius = i === count - 1 ? 1 : startRadius - (startRadius - 1) * i / (count - 1);
      return { x: -radius, y: 0, radius, angle: Math.PI };
    });
    return { status: 'captured', points, closestRadius: 1, deflection: null, missed: false };
  }
  return magnitude > CRITICAL_IMPACT
    ? escapedRay(magnitude, sign, startRadius, sampling, budget)
    : inwardRay(magnitude, sign, startRadius, sampling, budget);
}
