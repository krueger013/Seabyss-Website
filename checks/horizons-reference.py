import requests, time, csv
SITES = [
    ('Levis', -71.18, 46.81, '2026-11-23 18:00', '2026-11-23 18:01'),
    ('Cape Town', 18.42, -33.93, '2026-11-23 18:00', '2026-11-23 18:01'),
    ('Greenwich', 0.0, 51.4779, '2026-03-20 12:00', '2026-03-20 12:01'),
]
for site, lon, lat, start, stop in SITES:
    for body in ('10', '301'):
        params = dict(EPHEM_TYPE='OBSERVER', COMMAND=body, CENTER='coord@399', COORD_TYPE='GEODETIC',
            SITE_COORD=f'{lon},{lat},0', START_TIME=start, STOP_TIME=stop, STEP_SIZE='1 m',
            QUANTITIES='4', APPARENT='AIRLESS', CSV_FORMAT='YES', CAL_FORMAT='CAL',
            ANG_FORMAT='DEG', EXTRA_PREC='YES', OBJ_DATA='NO')
        response = requests.get('https://ssd.jpl.nasa.gov/api/horizons.api',
            params={'format':'json', **{k:"'"+str(v)+"'" for k,v in params.items()}},timeout=45)
        response.raise_for_status()
        doc = response.json()
        raw = doc.get('result','')
        if '$$SOE' not in raw:
            raise ValueError(doc.get('error',raw[:1500]))
        row = next(csv.reader([raw.split('$$SOE')[1].strip().splitlines()[0]]))
        assert 'Azi' in raw and 'Elev' in raw and len(row)>=5
        print(site, lon, lat, start, f'JPL={body}', 'AZ',row[-3].strip(), 'EL',row[-2].strip(), 'ORIGINAL',row,flush=True)
        print(response.url,flush=True)
        time.sleep(0.5)
