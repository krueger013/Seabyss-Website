const format = 'universe-explorer/climate';
export const CLIMATE_FILE_LIMIT = 512 * 1024;

export function makeClimateFile(snapshot) {
  return JSON.stringify({format, version:1, snapshot}, null, 2);
}

export function readClimateFile(text) {
  try {
    const file = JSON.parse(text);
    if (file?.format !== format || file.version !== 1 || file.snapshot?.version !== 1) return null;
    if (!file.snapshot.model || typeof file.snapshot.model !== 'object') return null;
    return file.snapshot;
  } catch { return null; }
}

export function climateFilename(name) {
  const slug = (typeof name === 'string' ? name.slice(0, 60) : '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return 'climat-' + (slug || 'experience') + '.json';
}
