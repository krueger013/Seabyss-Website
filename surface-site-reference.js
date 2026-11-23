export const surfaceSite = (id,name,latitude,longitude,elevationKm=0) =>
  Object.freeze({id,name,latitude,longitude,elevationKm});

const site=surfaceSite;
export const SURFACE_SKY_SITES = Object.freeze({
  moon:Object.freeze([
    site('imbrium','Mer des Pluies',34.72,-14.91),
    site('apollo-11','Site d’Apollo 11',.67416,23.47314,-1.926),
    site('chang-e-4','Face cachée · site de Chang’e 4',-45.4561,177.5885,-5.927)
  ]),
  mars:Object.freeze([site('valles','Valles Marineris',-13.74,-59.20)]),
  europa:Object.freeze([site('conamara','Chaos de Conamara',9.7,87.3)]),
  titan:Object.freeze([site('kraken','Kraken Mare',68,50)]),
  mercury:Object.freeze([site('caloris','Bassin Caloris',31.65,161.98)]),
  enceladus:Object.freeze([site('baghdad','Baghdad Sulcus',-86.91,129.46)]),
  ganymede:Object.freeze([site('arbela','Arbela Sulcus',-34,-4)])
});
