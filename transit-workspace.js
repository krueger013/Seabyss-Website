import {createTransitLab} from './transit-lab.js';
import {createTransitNotebook} from './transit-notebook.js';

export function createTransitWorkspace(host,{objects,initialId,initialImpact,onVisit,onRecall,onObservation}) {
  let notebook;
  const disposeLab=createTransitLab(host,{objects,initialId,initialImpact,onVisit,onObservation,
    observedId:'hd-209458-b',onRecord:measurement=>notebook.record(measurement)});
  notebook=createTransitNotebook(host.querySelector('[data-transit-notebook]'),{objects,onRecall});
  return ()=>{ notebook.dispose();disposeLab?.(); };
}
