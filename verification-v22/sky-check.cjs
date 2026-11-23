const assert=require('node:assert/strict');
async function checkReleaseTwentyTwo(page) {
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  const act = control => touch ? control.tap() : control.click();
  const dialog = page.locator('#overlay');
  const item = selector => dialog.locator(selector);
  const sky = name => item('[data-earth-sky-' + name + ']');
  const view = sky('view');
  const atlas = async tab => {
    await act(page.locator('#atlas-open'));
    await act(item('button[data-atlas-view="' + tab + '"]'));
  };
  const coord = async axis => Number(await view.getAttribute('data-' + axis));
  const angle = async control => Number(await control.getAttribute('data-degrees'));
  const atUTC = async date => {
    await sky('date').fill(date);
    await sky('date').blur();
    await page.waitForFunction(ms => Number(document.querySelector('[data-earth-sky-view]').dataset.timeMs) === ms,
      Date.parse(date + 'Z'));
  };
  await atlas('earth');
  await item('[data-earth-lat]').fill('40.73');
  await item('[data-earth-lon]').fill('-73.92');
  await act(item('[data-earth-position] button[type=submit]'));
  await act(item('[data-earth-sky]'));
  await sky('dome').waitFor();
  assert.equal(await coord('latitude'), 40.73);
  assert.equal(await coord('longitude'), -73.92);
  await sky('target').selectOption('sun');
  await atUTC('2024-06-21T16:58');
  assert.ok(Math.abs(await angle(sky('altitude')) - 72.7) < 1);
  assert.ok(Math.abs(await angle(sky('azimuth')) - 180) < 3);
  const event = key => item('[data-earth-sky-event="' + key + '"]');
  // USNO New York, summer solstice 2024: 05:25 and 12:58 EDT.
  // https://aa.usno.navy.mil/calculated/rstt/oneday?date=2024-06-21&dst=true&lat=40.73&lon=-73.92&tz=5&tz_sign=-1
  for (const [key, minutes] of [['rise',565],['transit',1018]]) {
    const utc = new Date(Number(await event(key).getAttribute('data-time-ms')));
    assert.ok(Math.abs(utc.getUTCHours() * 60 + utc.getUTCMinutes() - minutes) <= 4);
  }
  await act(event('rise'));
  assert.ok(Math.abs(await angle(sky('altitude'))) < 2);
  await act(sky('map'));
  const fromMap = async selector => Number((await item(selector).inputValue()).replace(',','.'));
  assert.equal(await fromMap('[data-earth-lat]'), 40.73);
  assert.equal(await fromMap('[data-earth-lon]'), -73.92);
  await act(item('[data-earth-sky]'));
  await sky('site').selectOption('levis');
  await sky('target').selectOption('sun');
  await atUTC('2024-06-21T05:00');
  const compare = item('[data-earth-compare-open]');
  await act(compare);
  await item('[data-earth-compare-site]').selectOption('tromso');
  const here = await angle(item('[data-earth-compare-alt="a"]'));
  const there = await angle(item('[data-earth-compare-alt="b"]'));
  const difference = await angle(item('[data-earth-compare-difference]'));
  assert.ok(here < -10 && there > 0);
  assert.ok(Math.abs(Math.abs(difference) - Math.abs(there - here)) < .05);
  await act(compare);
  const chart = sky('chart');
  const sunCurve = await chart.evaluate(canvas => canvas.toDataURL());
  await sky('target').selectOption('moon');
  await chart.evaluate(() => new Promise(requestAnimationFrame));
  assert.ok(sunCurve !== await chart.evaluate(canvas => canvas.toDataURL()));

  await act(item('[data-earth-sky-day="next"]'));
  const utcInput = async () => Date.parse(await sky('date').inputValue() + 'Z');
  assert.equal(await utcInput(), Date.parse('2024-06-22T05:00Z'));
  const scrub = sky('scrub');
  const beforeScrub = await utcInput();
  await scrub.fill('720');
  assert.notEqual(await utcInput(), beforeScrub);
  await atUTC('2024-06-21T05:00');
  await act(sky('play'));
  await page.waitForFunction(() => Number(document.querySelector('[data-earth-sky-view]').dataset.timeMs) > Date.parse('2024-06-21T05:00Z'));
  await act(sky('play'));
  await atUTC('2024-06-21T05:00');
  if (touch) {
    const size = page.viewportSize();
    await page.setViewportSize({width:size.height, height:size.width});
    assert.equal(await sky('target').inputValue(), 'moon');
    assert.equal(await utcInput(), Date.parse('2024-06-21T05:00Z'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize(size);
  }
  await act(sky('save'));
  await page.reload();
  await act(page.locator('#journal-open'));
  await act(item('[data-journal-earth-sky]'));
  const record = item('[data-earth-sky-entry]').filter({hasText:/Lune/i}).first();
  await act(record.locator('[data-earth-sky-recall]'));
  assert.equal(await sky('site').inputValue(), 'levis');
  assert.equal(await sky('target').inputValue(), 'moon');
  assert.equal(await utcInput(), Date.parse('2024-06-21T05:00Z'));
  await act(sky('now'));
  assert.ok(Math.abs(Number(await view.getAttribute('data-time-ms')) - Date.now()) < 65000);
  await act(item('#close-dialog'));
  await act(page.locator('#journal-open'));
  await act(item('[data-journal-earth-sky]'));
  await act(record.locator('[data-earth-sky-remove]'));
  await record.waitFor({state:'hidden'});
  await act(item('#close-dialog'));
  await require('./surface-tracking-browser.cjs').checkSurfaceTracking(page);
}


module.exports={check:checkReleaseTwentyTwo};
