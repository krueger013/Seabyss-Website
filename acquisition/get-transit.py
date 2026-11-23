import hashlib, io, json, urllib.request
from pathlib import Path
import numpy as np
from astropy.io import fits
from astropy.time import Time
name='tess2022244194134-s0056-0000000420814525-0243-s_lc.fits'
uri='mast:TESS/product/'+name
url='https://mast.stsci.edu/api/v0.1/Download/file/?uri='+uri
folder='tid/s0056/0000/0004/2081/4525/'
for candidate in [url,'https://stpubdata.s3.amazonaws.com/tess/public/'+folder+name,'https://archive.stsci.edu/missions/tess/'+folder+name]:
    try:
        req=urllib.request.Request(candidate, headers={'User-Agent':'SEABYSS astronomy atlas photometry'})
        with urllib.request.urlopen(req,timeout=30) as r: data=r.read(22_000_001)
        if not data.startswith(b'SIMPLE  =') or len(data)>22_000_000: raise ValueError('invalid FITS')
        print('Source:',candidate,len(data),flush=True)
        break
    except Exception as error:
        print(candidate,str(error),flush=True)
else: raise ValueError('unable to download FITS from MAST/mirrors')
with fits.open(io.BytesIO(data),checksum=True) as f:
    h=f[0].header; ext=f[1]; hdr=ext.header
    assert h['TICID']==420814525 and h['SECTOR']==56 and hdr['TIMESYS']=='TDB'
    assert hdr['BJDREFI']==2457000 and abs(hdr['BJDREFF'])<1e-10 and hdr['TIMEUNIT'].lower()=='d'
    assert 119<hdr['TIMEDEL']*86400<121
    assert 'electron' in ext.columns['PDCSAP_FLUX'].unit.lower()
    t=ext.data['TIME']; flux=ext.data['PDCSAP_FLUX']; err=ext.data['PDCSAP_FLUX_ERR']; q=ext.data['QUALITY']
    pivot=2840.8789; hrs=(t-pivot)*24
    window=np.isfinite(t)&(abs(hrs)<=4.25)
    keep=window&(q==0)&np.isfinite(flux)&np.isfinite(err)&(flux>0)&(err>0)
    hrs, flux, err = hrs[keep],flux[keep].astype(float),err[keep].astype(float)
    assert len(hrs)>190 and np.all(np.diff(hrs)>0)
    wings=abs(hrs)>=2.5; baseline=float(np.median(flux[wings]))
    assert np.sum(hrs<-2.5)>30 and np.sum(hrs>2.5)>30
    rel=flux/baseline
    depth=1-float(np.median(rel[abs(hrs)<.7]))
    assert .008 < depth < .025 and .998 < np.median(rel[hrs>2.5]) < 1.002
    ref=float(hdr['BJDREFI']+hdr['BJDREFF']+pivot)
    date=Time(ref,format='jd',scale='tdb').isot[:10]
    obj={'planetId':'hd-209458-b','targetName':'HD 209458 b','instrument':'TESS · SPOC · secteur 56','sourceTitle':'MAST / NASA · Courbe de lumière SPOC de TIC 420814525','sourceUrl':url,
         'missionUrl':'https://archive.stsci.edu/missions-and-data/tess','productUri':uri,'sourceSha256':hashlib.sha256(data).hexdigest(),'tic':420814525,'sector':56,
         'epoch':date+' · BJD_TDB '+str(ref),'referenceBjdTdb':ref,'observationDate':date,'cadenceSeconds':round(float(hdr['TIMEDEL']*86400),3),
         'processing':'Flux PDCSAP corrigé par SPOC, en électrons par seconde. Mesures à ±4,25 h du repère temporel, avec QUALITY = 0, flux et incertitude finis et positifs. Normalisation par la médiane des mesures à plus de 2,5 h du repère de chaque côté réunies. Aucun lissage, regroupement ni comblement des lacunes. Le zéro est le repère choisi près du milieu du transit.',
         'baselineElectronsPerSecond':round(baseline,3),'windowCount':int(window.sum()),'retainedCount':len(hrs),'normalizationCount':int(wings.sum()),
         'columns':['heures depuis le repère','flux relatif normalisé'],'points':[[round(float(x),8),round(float(v),8)] for x,v in zip(hrs,rel)],
         'relativeUncertainties':[round(float(v/baseline),8) for v in err]}
    print('Sector:',h['SECTOR'],'TIC:',h['TICID'],'BJD:',ref,'date:',date,'range:',np.min(hrs),np.max(hrs),'median depth:',depth,'counts:',obj['windowCount'],len(hrs))
    encoded=json.dumps(obj,ensure_ascii=False,separators=(',',':'))+'\n'
    assert len(encoded.encode())<40000
    Path('acquisition/transit-observation.json').write_text(encoded)
