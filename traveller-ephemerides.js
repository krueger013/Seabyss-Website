// Sun-centred geometric states in the J2000 ecliptic frame. Table rows are
// [JD UTC, X/Y/Z in km, VX/VY/VZ in km/s] as published by NASA/JPL Horizons.
// Regenerate complete vector tables with windows/refresh-travellers.mjs.
const AU_KM = 149597870.7;
const DAY_MS = 86400000;
const DAY_SECONDS = 86400;
const UNIX_JD = 2440587.5;
const RAD = Math.PI / 180;
const SOLAR_GM = 0.0002959122082855911; // au³/day²
const fromJd = jd => (jd-UNIX_JD)*DAY_MS;

// BEGIN HORIZONS TABLES
const tables = {
  "voyager-1": {
    "sourceUrl": "https://kdejevoyager.cz/data/mission-maps/v1-position.txt",
    "historyUrl": "https://kdejevoyager.cz/data/mission-maps/v1-history.txt",
    "forecastDays": 180,
    "rows": [
      [2461032.5, -4761048032.076216, -20137031513.21655, 14569888712.94635, -2.072889750395216, -13.61110201714338, 9.834775579839365],
      [2461092.5, -4771792705.265919, -20207591742.90074, 14620870636.55135, -2.072442525270585, -13.61122943795432, 9.834178121807955],
      [2461152.5, -4782534807.603864, -20278152903.12841, 14671849460.20786, -2.071856365041856, -13.61143290367429, 9.833578080371382],
      [2461212.5, -4793273358.750652, -20348714931.50263, 14722825156.45415, -2.071066636796196, -13.61152698460825, 9.832969585082173],
      [2461272.5, -4804007781.223702, -20419276712.65717, 14773797712.52867, -2.070340328609628, -13.61137648757248, 9.832370383878011],
      [2461332.5, -4814738849.405165, -20489837795.71304, 14824767187.36311, -2.069749408670841, -13.61129394995915, 9.831781407944126],
      [2461353.5, -4818494016.878559, -20514534152.99306, 14842605785.71185, -2.069539361256397, -13.61133079552149, 9.83157604041093]
    ]
  },
  "voyager-2": {
    "sourceUrl": "https://kdejevoyager.cz/data/mission-maps/v2-position.txt",
    "historyUrl": "https://kdejevoyager.cz/data/mission-maps/v2-history.txt",
    "forecastDays": 180,
    "rows": [
      [2461016.5, 5859276073.864709, -15536737699.47986, -13127991060.794, 4.203491928879925, -9.341396859635374, -11.3213834124933],
      [2461076.5, 5881066548.44203, -15585163097.80309, -13186678668.70658, 4.203309231341296, -9.341239066385127, -11.32043867434297],
      [2461136.5, 5902856092.400715, -15633587913.99896, -13245361387.77465, 4.203189506396528, -9.341176881159795, -11.31950168333998],
      [2461196.5, 5924645561.302783, -15682012338.67852, -13304039288.89761, 4.203284259730393, -9.34106543109732, -11.31858222290291],
      [2461256.5, 5946435859.364818, -15730435523.50061, -13362712458.0881, 4.203430359221164, -9.340683934431137, -11.31766979337918],
      [2461316.5, 5968226432.45677, -15778856614.8372, -13421380894.03523, 4.203409708617499, -9.34030759209854, -11.31675696614285],
      [2461353.5, 5981663834.156515, -15808715478.90908, -13457557402.57229, 4.203382150205447, -9.340186009013108, -11.31619509004022]
    ]
  }
};
// END HORIZONS TABLES

// Osculating heliocentric elements. T is the time of the osculating
// conic's perihelion (JD TDB), not a prediction of the next physical passage.
const conics = {
  halley: {
    e:0.9680400, q:0.5707720, i:162.19560, node:59.23120, peri:112.13210, T:2474036.64170,
    referenceMs:Date.UTC(2026,10,21), source:'Minor Planet Center · MPC 191592',
    sourceUrl:'https://astro.vanbuitenen.nl/comet/1'
  },
  oumuamua: {
    e:1.201133796102373, q:0.2559115812959116, i:122.7417062847286, node:24.59690955523242,
    peri:241.8105360304898, T:2458006.007321375, referenceMs:Date.UTC(2017,10,23)-69184,
    source:'NASA/JPL SBDB · solution 16',
    sourceUrl:'https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=1I&full-prec=true'
  }
};
const conicRange = {startMs:Date.UTC(2025,0,1), endMs:Date.UTC(2028,0,1)};

export function travellerCoverage(id) {
  if (Object.hasOwn(tables,id)) {
    const {rows,forecastDays} = tables[id];
    return {startMs:fromJd(rows[0][0]),endMs:fromJd(rows.at(-1)[0]+forecastDays)};
  }
  return Object.hasOwn(conics,id) ? {...conicRange} : null;
}

function observedState(table,jd) {
  const {rows} = table;
  const last = rows.at(-1);
  const axis = [0,1,2];
  if (jd >= last[0]) {
    const seconds = (jd-last[0])*DAY_SECONDS;
    return {
      positionAu:axis.map(i=>(last[i+1]+seconds*last[i+4])/AU_KM),
      velocityAuDay:axis.map(i=>last[i+4]*DAY_SECONDS/AU_KM),
      referenceMs:fromJd(last[0]),quality:seconds?'Extrapolation à vitesse constante':'Vecteur Horizons',
      source:'NASA/JPL Horizons',sourceUrl:table.sourceUrl
    };
  }
  const index = rows.findIndex(row=>row[0]>jd);
  const a = rows[index-1], b = rows[index];
  const seconds = (b[0]-a[0])*DAY_SECONDS;
  const t = (jd-a[0])/(b[0]-a[0]), t2=t*t, t3=t*t2;
  // Cubic Hermite matches the supplied velocities and positions at each knot.
  const positionAu = axis.map(i=>((2*t3-3*t2+1)*a[i+1]+(t3-2*t2+t)*seconds*a[i+4]
    +(-2*t3+3*t2)*b[i+1]+(t3-t2)*seconds*b[i+4])/AU_KM);
  const velocityAuDay = axis.map(i=>((6*t2-6*t)*(a[i+1]-b[i+1])/seconds
    +(3*t2-4*t+1)*a[i+4]+(3*t2-2*t)*b[i+4])*DAY_SECONDS/AU_KM);
  return {positionAu,velocityAuDay,referenceMs:fromJd(a[0]),quality:jd===a[0]?'Vecteur Horizons':'Interpolation Horizons',
    source:'NASA/JPL Horizons',sourceUrl:table.historyUrl || table.sourceUrl};
}

function conicState(el,jd) {
  const {e,q} = el;
  const a = q/Math.abs(1-e), motion=Math.sqrt(SOLAR_GM/(a*a*a));
  // Modern covered epochs use TDB ≈ UTC + 69.184 s (periodic terms <2 ms).
  const mean = motion*(jd+69.184/DAY_SECONDS-el.T);
  const closed = e<1;
  let anomaly = closed ? mean : Math.asinh(mean/e);
  for (let i=0;i<18;i++) {
    const residual = closed ? anomaly-e*Math.sin(anomaly)-mean : e*Math.sinh(anomaly)-anomaly-mean;
    const gradient = closed ? 1-e*Math.cos(anomaly) : e*Math.cosh(anomaly)-1;
    const step=residual/gradient;
    anomaly-=step;
    if (Math.abs(step)<1e-13) break;
  }
  const co = closed?Math.cos(anomaly):Math.cosh(anomaly);
  const si = closed?Math.sin(anomaly):Math.sinh(anomaly);
  const minor = Math.sqrt(Math.abs(1-e*e));
  const derivative=motion/(closed?1-e*co:e*co-1);
  const omega=el.peri*RAD, node=el.node*RAD, inclination=el.i*RAD;
  const cn=Math.cos(node),sn=Math.sin(node),cw=Math.cos(omega),sw=Math.sin(omega);
  const ci=Math.cos(inclination),sinI=Math.sin(inclination);
  function rotate(x,y) {
    const u=x*cw-y*sw, v=x*sw+y*cw;
    return [cn*u-sn*v*ci,sn*u+cn*v*ci,v*sinI];
  }
  return {positionAu:rotate(a*(closed?co-e:e-co),a*minor*si),
    velocityAuDay:rotate(-a*si*derivative,a*minor*co*derivative),
    quality:'Estimation képlérienne à deux corps',source:el.source,sourceUrl:el.sourceUrl,referenceMs:el.referenceMs};
}

export function travellerState(id,instant) {
  const ms=instant instanceof Date ? instant.getTime() : instant;
  const range=travellerCoverage(id);
  if (!range || !Number.isFinite(ms) || ms<range.startMs || ms>range.endMs) return null;
  const jd=UNIX_JD+ms/DAY_MS;
  return Object.hasOwn(tables,id) ? observedState(tables[id],jd) : conicState(conics[id],jd);
}

