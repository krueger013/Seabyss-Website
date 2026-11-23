// The Windows single-file edition supplies the same assets as embedded URLs.
export function assetUrl(name) {
  if (globalThis.universeAssets) {
    const embedded = globalThis.universeAssets[name];
    if (!embedded) throw new Error('Ressource embarquée introuvable : ' + name);
    return embedded;
  }
  return new URL('assets/' + name, document.baseURI).href;
}
