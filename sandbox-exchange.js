const FORMAT='universe-explorer/experiment';
export const EXPERIMENT_FILE_LIMIT=2*1024*1024;

export function makeExperimentFile(title,snapshot) {
  return JSON.stringify({format:FORMAT,version:1,title:title.trim().slice(0,52),snapshot},null,2);
}

export function readExperimentFile(text) {
  try {
    const file=JSON.parse(text);
    if (file?.format!==FORMAT || file.version!==1 || typeof file.title!=='string' ||
        !file.snapshot || typeof file.snapshot!=='object') return null;
    return {title:file.title.trim().slice(0,52)||'Expérience importée',snapshot:file.snapshot};
  } catch {return null;}
}

export function experimentFilename(title) {
  const slug=title.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return (slug||'experience')+'.json';
}
