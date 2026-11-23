const FORMATS = [
  ['original', 'Original', 0],
  ['16:9', '16:9', 16 / 9],
  ['1:1', '1:1', 1],
  ['9:16', '9:16', 9 / 16]
];
const ALBUM_LIMIT = 12;
const MAX_EXPORT = 1920;
const frNumber = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1,signDisplay:'exceptZero'});
const frDate = new Intl.DateTimeFormat('fr-CA',{
  day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'
});
const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
const select = (root,attribute) => root.querySelector('[data-studio-'+attribute+']');
const dimensions = (width,height) => width+' × '+height+' px';
const timeLabel = stamp => frDate.format(stamp)+' UTC';

export function photoFrame(width,height,aspect,horizontal=0,vertical=0,maxSize=MAX_EXPORT) {
  const ratio=aspect>0?aspect:width/height;
  const cropWidth=Math.min(width,height*ratio);
  const cropHeight=Math.min(height,width/ratio);
  const x=(width-cropWidth)*(clamp(horizontal,-100,100)+100)/200;
  const y=(height-cropHeight)*(clamp(vertical,-100,100)+100)/200;
  const scale=Math.min(1,maxSize/Math.max(cropWidth,cropHeight));
  return {x,y,cropWidth,cropHeight,width:Math.max(1,Math.round(cropWidth*scale)),height:Math.max(1,Math.round(cropHeight*scale))};
}

function renderPhoto(canvas,source,frame,settings) {
  canvas.width=frame.width;
  canvas.height=frame.height;
  const context=canvas.getContext('2d',{alpha:false});
  const {width,height}=canvas;
  const brightness=2**settings.exposure;
  if ('filter' in context) context.filter='brightness('+brightness+')';
  context.drawImage(source,frame.x,frame.y,frame.cropWidth,frame.cropHeight,0,0,width,height);
  if ('filter' in context) context.filter='none';
  else if (brightness!==1) {
    const image=context.getImageData(0,0,width,height);
    for(let i=0;i<image.data.length;i+=4) {
      image.data[i]*=brightness;
      image.data[i+1]*=brightness;
      image.data[i+2]*=brightness;
    }
    context.putImageData(image,0,0);
  }
  if (!settings.stamp || Math.min(width,height)<90) return;
  const padding=Math.round(width*.05);
  const fontSize=Math.min(Math.round(height*.12),Math.max(14,Math.round(width*.037)));
  const textSize=Math.max(8,Math.round(fontSize*.43));
  const fade=context.createLinearGradient(0,height*.68,0,height);
  fade.addColorStop(0,'rgba(4,10,17,0)');
  fade.addColorStop(1,'rgba(4,10,17,0.94)');
  context.fillStyle=fade;
  context.fillRect(0,height*.68,width,height*.32);
  if (settings.title) {
    context.font='500 '+fontSize+'px "Instrument Serif", Georgia, serif';
    context.fillStyle='#fbf0dc';
    context.fillText(settings.title,padding,height-padding-1.45*textSize,width-padding*2);
  }
  context.fillStyle='#c4d4dc';
  context.font=textSize+'px Consolas, monospace';
  context.fillText(timeLabel(settings.created),padding,height-padding,width-padding*2);
}

function pngBlob(canvas) {
  return new Promise((resolve,reject)=>{
    canvas.toBlob(blob=>blob?resolve(blob):reject(Error('Impossible de créer le PNG.')),'image/png');
  });
}

let database;
function openDatabase() {
  if (!database) {
    database=new Promise((resolve,reject)=>{
      const request=indexedDB.open('universe-observation-album',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('photos',{keyPath:'id',autoIncrement:true});
      request.onsuccess=()=>{
        const db=request.result;
        db.onversionchange=()=>{db.close();database=null;};
        resolve(db);
      };
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('Album verrouillé par un autre onglet.'));
    }).catch(error=>{database=null;throw error;});
  }
  return database;
}

async function albumRequest(mode,makeRequest) {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction('photos',mode);
    const store=transaction.objectStore('photos');
    let result;
    transaction.oncomplete=()=>resolve(result);
    transaction.onabort=()=>reject(transaction.error||Error('Impossible de modifier l’album.'));
    makeRequest(store,value=>{result=value;});
  });
}

function addPhoto(photo) {
  return albumRequest('readwrite',(store,record)=>{
    const count=store.count();
    count.onsuccess=()=>{
      if (count.result>=ALBUM_LIMIT) {record('full');return;}
      const add=store.add(photo);
      add.onsuccess=()=>record(add.result);
    };
  });
}
function readPhotos() {
  return albumRequest('readonly',(store,record)=>{
    const request=store.getAll();
    request.onsuccess=()=>record(request.result.reverse());
  });
}
function removePhoto(id) {
  return albumRequest('readwrite',store=>store.delete(id));
}

function downloadPng(blob,title,created) {
  const link=document.createElement('a');
  const name=title.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  const url=URL.createObjectURL(blob);
  link.download=[(name||'universe-explorer')+'-'+new Date(created).toISOString().slice(0,10),'png'].join('.');
  link.href=url;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30_000);
}

export function createPhotoStudio(panel,{capture,caption=''}) {
  const root=document.createElement('section');
  root.className='photo-studio';
  root.setAttribute('aria-label','Cadrer et enregistrer la vue');
  root.innerHTML=`<div class="studio-stage">
      <p class="studio-status" data-studio-status role="status">Capture de la vue…</p>
      <figure class="studio-figure" data-studio-figure hidden>
        <div class="studio-image">
          <canvas data-studio-preview aria-label="Aperçu de la photographie"></canvas>
          <span class="studio-grid" data-studio-grid aria-hidden="true" hidden></span>
        </div>
        <figcaption data-studio-resolution></figcaption>
      </figure>
    </div>
    <div class="studio-tools" data-studio-tools hidden>
      <fieldset class="studio-formats">
        <legend>Format</legend><div>${FORMATS.map(([id,label])=>'<button type="button" data-studio-format="'+id+'" aria-pressed="false">'+label+'</button>').join('')}</div>
      </fieldset>
      <label class="studio-slider"><span>Exposition <output data-studio-ev>0 EV</output></span><input type="range" data-studio-exposure min="-2" max="2" step="0.1" value="0"></label>
      <label class="studio-slider" data-studio-pan-x-wrap hidden><span>Cadre horizontal</span><input type="range" data-studio-pan-x min="-100" max="100" value="0"></label>
      <label class="studio-slider" data-studio-pan-y-wrap hidden><span>Cadre vertical</span><input type="range" data-studio-pan-y min="-100" max="100" value="0"></label>
      <label class="studio-text"><span>Titre</span><input type="text" data-studio-title maxlength="64"></label>
      <div class="studio-options">
        <label><input type="checkbox" data-studio-stamp> Inscrire le titre et la date</label>
        <label><input type="checkbox" data-studio-guide> Guide des tiers</label>
      </div>
      <div class="studio-actions">
        <button type="button" data-studio-download class="studio-action studio-primary">Télécharger le PNG</button>
        <button type="button" data-studio-save class="studio-action">Garder dans l’album</button>
        <button type="button" data-studio-gallery class="studio-link">Ouvrir l’album photo</button>
      </div>
      <p role="status" class="studio-feedback" data-studio-feedback></p>
    </div>`;
  panel.append(root);

  let active=true,disposeGallery=()=>{},source,redraw=0,format=FORMATS[0][0],busy=false;
  const created=Date.now();
  const preview=select(root,'preview'), image=select(root,'figure'), feedback=select(root,'feedback');
  const title=select(root,'title'),exposure=select(root,'exposure'),stamp=select(root,'stamp');
  const horizontal=select(root,'pan-x'),vertical=select(root,'pan-y');
  const save=select(root,'save'),download=select(root,'download');
  title.value=caption.slice(0,64);

  function settings() {
    return {created,exposure:Number(exposure.value),title:title.value.trim(),stamp:stamp.checked};
  }
  function calculateFrame(size) {
    const ratio=FORMATS.find(([id])=>id===format)[2];
    return photoFrame(source.width,source.height,ratio,Number(horizontal.value),Number(vertical.value),size);
  }
  function refresh() {
    if (!source||!active) return;
    const frame=calculateFrame(MAX_EXPORT);
    image.style.setProperty('--studio-preview-width',(frame.width/frame.height*50)+'dvh');
    select(root,'status').hidden=true;
    image.hidden=false;
    select(root,'tools').hidden=false;
    select(root,'resolution').textContent=dimensions(frame.width,frame.height);
    select(root,'ev').textContent=frNumber.format(Number(exposure.value))+' EV';
    select(root,'pan-x-wrap').hidden=source.width-frame.cropWidth<1;
    select(root,'pan-y-wrap').hidden=source.height-frame.cropHeight<1;
    select(root,'grid').hidden=!select(root,'guide').checked;
    for (const button of root.querySelectorAll('[data-studio-format]')) {
      button.setAttribute('aria-pressed',String(button.dataset.studioFormat===format));
    }
    renderPhoto(preview,source,calculateFrame(1000),settings());
  }
  function queueRefresh() {
    if (redraw) return;
    redraw=requestAnimationFrame(()=>{redraw=0;refresh();});
  }

  const resetFeedback=()=>{feedback.textContent='';queueRefresh();};
  for (const input of [exposure,horizontal,vertical,title,stamp,select(root,'guide')]) input.oninput=resetFeedback;
  for (const button of root.querySelectorAll('[data-studio-format]')) {
    button.onclick=()=>{
      format=button.dataset.studioFormat;
      horizontal.value='0';
      vertical.value='0';
      resetFeedback();
    };
  }
  async function exportPhoto(keep) {
    if (busy||!source) return;
    busy=true;
    save.disabled=download.disabled=true;
    const values=settings();
    const frame=calculateFrame(MAX_EXPORT);
    const canvas=document.createElement('canvas');
    try {
      renderPhoto(canvas,source,frame,values);
      const blob=await pngBlob(canvas);
      if (!active) return;
      if (keep) {
        const id=await addPhoto({blob,title:values.title||caption||'Vue spatiale',created,width:frame.width,height:frame.height});
        if (active) feedback.textContent=id==='full'?'Album plein. Libère une place ou télécharge le PNG.':'Photo ajoutée à l’album.';
      } else {
        downloadPng(blob,values.title||caption,created);
        feedback.textContent='PNG prêt.';
      }
    } catch {
      if (active) feedback.textContent=keep?'Album indisponible. Tu peux télécharger le PNG.':'Le PNG n’a pas pu être créé.';
    } finally {
      save.disabled=download.disabled=false;
      busy=false;
      canvas.width=canvas.height=1;
    }
  }
  save.onclick=()=>exportPhoto(true);
  download.onclick=()=>exportPhoto(false);
  select(root,'gallery').onclick=()=>{
    root.hidden=true;
    disposeGallery=openPhotoGallery(panel,{
      onReturn:()=>{
        disposeGallery();
        root.hidden=false;
        select(root,'gallery').focus();
      }
    });
  };
  async function mount() {
    try {
      const captured=await capture();
      if (!active) return;
      if (!captured?.width||!captured?.height) throw Error('Image indisponible.');
      source=document.createElement('canvas');
      source.width=captured.width;
      source.height=captured.height;
      source.getContext('2d',{alpha:false}).drawImage(captured,0,0);
      refresh();
    } catch {
      if (active) select(root,'status').textContent='La vue n’a pas pu être capturée.';
    }
  }
  mount();
  return ()=>{
    active=false;
    cancelAnimationFrame(redraw);
    disposeGallery();
    root.remove();
    if (source) source.width=source.height=1;
  };
}

export function openPhotoGallery(panel,{onReturn}={}) {
  const gallery=document.createElement('section');
  gallery.className='studio-album';
  gallery.setAttribute('aria-label','Album des photographies');
  gallery.innerHTML=`<header class="studio-album-header">
      <h3>Album photo</h3><span data-studio-count></span>
      <button type="button" data-studio-return class="studio-link">Reprendre le cadrage</button>
    </header>
    <div data-studio-entries></div>
    <p class="studio-feedback" role="status" data-studio-album-status></p>`;
  panel.append(gallery);
  const back=select(gallery,'return'),list=select(gallery,'entries'),status=select(gallery,'album-status');
  back.hidden=!onReturn;
  back.onclick=()=>onReturn?.();
  if (onReturn) back.focus({preventScroll:true});
  let active=true;
  const urls=new Set();
  function imageOf(photo,alt) {
    const image=document.createElement('img');
    const url=URL.createObjectURL(photo.blob);
    urls.add(url);
    image.src=url;
    image.alt=alt;
    image.decoding='async';
    return image;
  }
  function clearImages() {
    for(const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    list.replaceChildren();
  }
  function showPhoto(photo) {
    clearImages();
    const view=document.createElement('article');
    view.className='studio-album-detail';
    view.innerHTML=`<div class="studio-photo-heading">
        <div><h4></h4><p></p></div>
        <button type="button" class="studio-link" data-studio-back>Retour à l’album</button>
      </div>
      <div class="studio-album-image"></div>
      <div class="studio-actions">
        <button type="button" class="studio-action studio-primary" data-studio-album-download>Télécharger le PNG</button>
        <button type="button" class="studio-action" data-studio-delete>Supprimer</button>
      </div>
      <div class="studio-delete-confirm" data-studio-confirm hidden>
        <p>Supprimer cette photo de l’album?</p>
        <button type="button" class="studio-action" data-studio-cancel>Annuler</button>
        <button type="button" class="studio-action" data-studio-delete-final>Supprimer la photo</button>
      </div>`;
    view.querySelector('h4').textContent=photo.title;
    view.querySelector('p').textContent=timeLabel(photo.created)+' · '+dimensions(photo.width,photo.height);
    view.querySelector('.studio-album-image').append(imageOf(photo,photo.title));
    list.append(view);
    const control=select(view,'back'), confirmation=select(view,'confirm');
    control.onclick=load;
    select(view,'album-download').onclick=()=>downloadPng(photo.blob,photo.title,photo.created);
    select(view,'delete').onclick=()=>{
      confirmation.hidden=false;
      select(view,'cancel').focus();
    };
    select(view,'cancel').onclick=()=>{
      confirmation.hidden=true;
      select(view,'delete').focus();
    };
    select(view,'delete-final').onclick=async()=>{
      const button=select(view,'delete-final');
      button.disabled=true;
      try {
        await removePhoto(photo.id);
        await load();
      } catch {
        if (active) status.textContent='La photo n’a pas pu être supprimée.';
      } finally {button.disabled=false;}
    };
    control.focus();
  }
  async function load() {
    status.textContent='Chargement de l’album…';
    try {
      const photos=await readPhotos();
      if (!active) return;
      clearImages();
      status.textContent=photos.length?'':'Les photos que tu gardes apparaîtront ici.';
      select(gallery,'count').textContent=photos.length+' / '+ALBUM_LIMIT;
      const grid=document.createElement('div');
      grid.className='studio-album-grid';
      for(const photo of photos) {
        const item=document.createElement('button');
        item.type='button';
        item.dataset.studioGalleryItem=String(photo.id);
        const thumbnail=imageOf(photo,'');
        thumbnail.loading='lazy';
        const label=document.createElement('strong');
        label.textContent=photo.title;
        const time=document.createElement('small');
        time.textContent=timeLabel(photo.created);
        item.append(thumbnail,label,time);
        item.onclick=()=>showPhoto(photo);
        grid.append(item);
      }
      list.append(grid);
    } catch {
      if (active) status.textContent='L’album n’est pas accessible dans ce navigateur.';
    }
  }
  load();
  return ()=>{
    active=false;
    clearImages();
    gallery.remove();
  };
}
