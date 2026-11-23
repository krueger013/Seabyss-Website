import {createEarthSkyView} from './earth-sky-view.js';
import {createEarthSkyNotebook} from './earth-sky-notes.js';
import {createEarthSkyComparison} from './earth-sky-compare.js';

export function createEarthSkyWorkspace(host,{observation={},onMap,onRecall}={}) {
  let latest,comparison,notebook;
  const disposeView=createEarthSkyView(host,{
    initialSite:observation.site,initialTarget:observation.targetId,initialDate:observation.date,
    onMap,onSave:state=>notebook?.record(state) ?? false,
    onChange:state=>{latest=state;comparison?.update(state);}
  });
  comparison=createEarthSkyComparison(host.querySelector('[data-earth-sky-compare]'));
  if (latest) comparison.update(latest);
  notebook=createEarthSkyNotebook(host.querySelector('[data-earth-sky-notebook]'),{onRecall});
  return ()=>{comparison.dispose();notebook.dispose();disposeView();};
}
