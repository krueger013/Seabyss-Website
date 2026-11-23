import hashlib, io, json, re, time, urllib.request
from pathlib import Path
from PIL import Image, ImageOps
root=Path('acquisition')
out=root/'output'
out.mkdir(exist_ok=True)
rows=[]
for target,src in json.loads((root/'sources.json').read_text()):
    assert re.fullmatch(r'[a-z0-9-]+',target) and src.startswith('https://')
    req=urllib.request.Request(src,headers={'User-Agent':'Seabyss astronomy outreach (image attribution retained)'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req,timeout=40) as response:
                final=response.geturl()
                body=response.read(60*1024*1024+1)
            break
        except OSError:
            if attempt==2: raise
            time.sleep(2+attempt)
    assert len(body)<=60*1024*1024
    original=Image.open(io.BytesIO(body))
    assert original.format in ('JPEG','PNG','TIFF','WEBP') and min(original.size)>=128
    original=ImageOps.exif_transpose(original).convert('RGB')
    rec={'id':target,'source':src,'final':final,'original':original.size,'sha256':hashlib.sha256(body).hexdigest(),'assets':[]}
    for prefix,width,height,quality in [('deep-thumb-',640,400,78),('plate-',1100,1100,87)]:
        image=original.copy(); image.thumbnail((width,height),Image.Resampling.LANCZOS)
        path=out/(prefix+target+'.webp')
        image.save(path,format='WEBP',quality=quality,method=6)
        data=path.read_bytes()
        rec['assets'].append({'name':path.name,'width':image.width,'height':image.height,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    rows.append(rec)
    print(target,original.size,rec['assets'],flush=True)
(out/'images.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
