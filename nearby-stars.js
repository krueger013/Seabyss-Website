// J2000 sky directions (RECONS), trigonometric parallaxes (Reylé et al.,
// The 10 pc sample in the Gaia era, v2) and rounded stellar radii (NASA
// Exoplanet Archive, per-object overview). The star surfaces are schematic.
const positionSourceUrl = 'https://chara.gsu.edu/~thenry/RECONS/TOP100.posted.htm';
const distanceSourceUrl = 'https://gruze.org/10pc/';
const archive = 'https://exoplanetarchive.ipac.caltech.edu/overview/';
const lightYearsPerParsec = 3.261563777;

// ID, name, archive ID, designation, constellation, spectral type, RA (h),
// declination (degrees), parallax (mas), radius (solar), illustrative colour.
const stars = [
  ['lalande-21185', 'Lalande 21185', 'GJ 411', 'GJ 411 · HD 95735', 'Grande Ourse', 'M2 V',
    11.055611, 35.970000, 392.753, .40, '#ffb093',
    'À environ huit années-lumière, cette naine rouge fait partie des voisines immédiates du Soleil. Son rayon atteint environ deux cinquièmes du rayon solaire.'],
  ['epsilon-eridani', 'Epsilon Eridani', 'eps Eri', 'ε Eridani · GJ 144', 'Éridan', 'K2 V',
    3.548833, -9.458333, 310.577, .77, '#ffcfab',
    'Cette étoile orangée est plus petite et plus froide que le Soleil. Des astronomes ont détecté de la poussière froide autour d’elle.'],
  ['lacaille-9352', 'Lacaille 9352', 'GJ 887', 'GJ 887 · HD 217987', 'Poisson austral', 'M1 V',
    23.097778, -35.853056, 304.135, .50, '#ffb89e',
    'Depuis la Terre, cette naine rouge se trouve dans la direction du Poisson austral. Son diamètre vaut environ la moitié de celui du Soleil.'],
  ['ross-128', 'Ross 128', 'Ross 128', 'GJ 447 · FI Virginis', 'Vierge', 'M4 V',
    11.795667, .804444, 296.305, .22, '#ffa68b',
    'La petite étoile Ross 128 héberge une planète dont l’attraction imprime à l’étoile une oscillation mesurable. Un cycle dure environ dix jours.'],
  ['groombridge-34-a', 'Groombridge 34 A', 'GJ 15 A', 'GJ 15 A · GX Andromedae', 'Andromède', 'M1.5 V',
    .306361, 44.023056, 280.707, .39, '#ffb49a',
    'Cette naine rouge appartient à un système double. L’astre visité est la composante A, la plus lumineuse des deux.'],
  ['epsilon-indi-a', 'Epsilon Indi A', 'eps Ind A', 'ε Indi A · GJ 845 A', 'Indien', 'K4 V',
    22.056028, -56.786111, 274.843, .72, '#ffc8a4',
    'Cette étoile orangée se trouve dans le ciel austral. Son système comprend aussi un couple de naines brunes, des objets de masse intermédiaire entre planètes et étoiles.'],
  ['tau-ceti', 'Tau Ceti', 'tau Cet', 'τ Ceti · GJ 71', 'Baleine', 'G8.5 V',
    1.734472, -15.937500, 273.810, .83, '#ffe2bd',
    'Tau Ceti appartient à la même grande classe spectrale que le Soleil, le type G. Elle est plus petite et sa photosphère est un peu plus froide.'],
  ['luyten-star', 'Étoile de Luyten', 'GJ 273', 'GJ 273 · BD+05 1668', 'Petit Chien', 'M3.5 V',
    7.456806, 5.225833, 264.127, .33, '#ffac91',
    'L’étoile de Luyten se trouve dans la direction du Petit Chien. Les astronomes y ont détecté des planètes en mesurant les variations de sa vitesse le long de notre ligne de visée.']
];

export function createNearbyStars({body, skyPosition, solarRadius}) {
  return stars.map(([id, name, archiveId, designation, constellation, spectralType,
    raHours, decDegrees, parallaxMas, radiusSolar, color, description]) => {
    const distanceLY = 1000 * lightYearsPerParsec / parallaxMas;
    return body(id, name, 'star', 'Étoile · ' + spectralType, designation, radiusSolar * solarRadius,
      skyPosition(distanceLY, raHours, decDegrees), color, description, {
        parentId: 'milky-way', region: 'Voie lactée · ' + constellation, stellarNeighborhood: true,
        spectralType, constellation, distanceLY, radiusSolar, raHours, decDegrees, coordinateEpoch: 'J2000.0',
        sourceUrl: archive + encodeURIComponent(archiveId), positionSourceUrl, distanceSourceUrl
      });
  });
}
