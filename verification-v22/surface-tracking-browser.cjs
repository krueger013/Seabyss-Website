'use strict';
const assert=require('node:assert/strict');

async function checkSurfaceTracking(page) {
  const touch=await page.evaluate(()=>navigator.maxTouchPoints>0);
  const act=selector=>touch?page.locator(selector).tap():page.locator(selector).click();
  const panel=page.locator('[data-sky-surface-panel]');
  const badge=page.locator('[data-sky-surface-toggle]');
  const release=page.locator('[data-sky-surface-release]');
  const terrain=page.locator('[data-surface-canvas]');
  const openPanel=()=>act('[data-sky-surface-toggle]');
  const date=page.locator('[data-sky-surface-date]');
  const rate=page.locator('[data-sky-surface-rate]');
  if(await page.locator('#overlay').isVisible()) await act('#close-dialog');
  await act('#atlas-open');
  await act('button[data-atlas-view="surfaces"]');
  await act('[data-surface-region="apollo-11"]');
  await terrain.waitFor();
  if(await page.locator('[data-surface-skip]').isVisible()) await act('[data-surface-skip]');
  await openPanel();
  await act('[data-sky-surface-event="apollo"]');
  assert.equal(await panel.locator('[data-sky-surface-comparison]').isVisible(),false);
  await act('[data-sky-surface-look="earth"]');
  assert.equal(await release.isVisible(),false,'Une visée ponctuelle doit laisser la caméra libre.');
  await openPanel();
  await act('[data-sky-surface-track="earth"]');
  assert.equal(await release.getAttribute('data-target'),'earth');
  assert.match(await page.locator('[data-surface-heading]').textContent(),/272°/);
  await openPanel();
  await rate.selectOption('86400');
  await rate.focus();
  await page.waitForTimeout(280);
  assert.equal(await rate.evaluate(node=>node===document.activeElement),true);
  await act('[data-sky-surface-close]');
  await page.waitForFunction(()=>Number(document.querySelector('[data-sky-surface-toggle]').dataset.ephemerisTime)
    > Date.parse('1969-07-21T20:17:40Z'));
  assert.doesNotMatch(await page.locator('[data-surface-heading]').textContent(),/272°/);
  const size=page.viewportSize();
  if(touch) {
    await page.setViewportSize({width:size.height,height:size.width});
    assert.equal(await release.getAttribute('data-target'),'earth');
    await page.setViewportSize(size);
  }
  const box=await release.boundingBox();
  assert.ok(box && box.x>=0 && box.y>=0 && box.x+box.width<=size.width+1 && box.y+box.height<=size.height+1);
  const point=await terrain.evaluate(canvas=>{
    const b=canvas.getBoundingClientRect();
    for(const vertical of [.5,.6,.4]) for(const horizontal of [.45,.5,.65,.35,.75]) {
      const x=b.x+horizontal*b.width,y=b.y+vertical*b.height;
      if(document.elementFromPoint(x,y)===canvas) return {x,y};
    }
    return null;
  });
  assert.ok(point);
  if(touch) {
    const session=await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+28,y:point.y+11}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    } finally {await session.detach();}
  } else {
    await page.mouse.move(point.x,point.y);await page.mouse.down();
    await page.mouse.move(point.x+28,point.y+11,{steps:3});await page.mouse.up();
  }
  await release.waitFor({state:'hidden'});
  await openPanel();
  await date.fill('1969-07-27T08:17');await date.dispatchEvent('change');
  await act('[data-sky-surface-track="sun"]');
  // The Sun is above 88 degrees here. A camera capped at the old 83-degree
  // limit would leave an entirely dark centre in the lunar sky.
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('[data-surface-canvas]');
    const context=canvas.getContext('2d'),x=Math.floor(canvas.width/2),y=Math.floor(canvas.height/2);
    const pixels=context.getImageData(x-1,y-1,3,3).data;
    for(let i=0;i<pixels.length;i+=4) if(pixels[i]>150 && pixels[i+1]>140 && pixels[i+2]>110) return true;
    return false;
  });
  await act('[data-sky-surface-release]');
  assert.equal(await release.isVisible(),false);
  await openPanel();
  await date.fill('1969-08-02T20:00');await date.dispatchEvent('change');
  await act('[data-sky-surface-track="sun"]');
  await openPanel();
  await rate.selectOption('86400');
  await act('[data-sky-surface-close]');
  await release.waitFor({state:'hidden',timeout:15000});
  assert.match(await page.locator('#toast').innerText(),/Soleil.*sous l.horizon/);
  await openPanel();
  assert.equal(await panel.locator('[data-sky-surface-look="sun"]').isDisabled(),true);
  assert.equal(await panel.locator('[data-sky-surface-track="sun"]').isVisible(),false);
  await act('[data-sky-surface-now]');
  await act('[data-sky-surface-close]');
  assert.equal(await badge.getAttribute('aria-expanded'),'false');
  await act('[data-surface-exit]');
  await terrain.waitFor({state:'hidden'});
}

module.exports={checkSurfaceTracking};
