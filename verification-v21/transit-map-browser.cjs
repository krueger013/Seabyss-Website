'use strict';
const assert = require('node:assert/strict');

async function checkTransitMap(page) {
  const touch=await page.evaluate(()=>navigator.maxTouchPoints>0);
  const act=selector=>touch?page.locator(selector).tap():page.locator(selector).click();
  if(await page.locator('#overlay').isVisible()) await act('#close-dialog');
  await act('#system-open');
  const view=page.locator('#system-view'), scope=view.locator('[data-system-scope]');
  const planet=view.locator('[data-system-target]'), bar=view.locator('[data-system-scale]');
  const action=view.locator('[data-system-transit]'), clock=view.locator('#sim-pause');
  const rate=view.locator('#sim-rate');
  const paused=await clock.getAttribute('aria-pressed')==='true', speed=await rate.inputValue();
  if(!paused) await act('#sim-pause');
  const names=view.locator('#sim-names'), hadNames=await names.getAttribute('aria-pressed')==='true';
  if(!hadNames) await act('#sim-names');
  const ruler = async () => bar.evaluate(node=>node.getBoundingClientRect().width/Number(node.dataset.au));
  const mark=view.locator('[data-system-marker]'), time=view.locator('[data-system-marker-elapsed]');
  await scope.selectOption('sun');
  await planet.selectOption('earth');
  assert.equal(await bar.isVisible(),false);
  assert.equal(await action.isVisible(),false);
  await scope.selectOption('hd-209458');
  await planet.selectOption('hd-209458-b');
  assert.equal(await action.getAttribute('aria-label'),'Observer le transit de HD 209458 b');
  await scope.selectOption('trappist-1');
  assert.equal(await mark.isVisible(),false);
  assert.equal(await action.isVisible(),false);
  await planet.selectOption('trappist-1-e');
  await bar.waitFor();
  assert.equal(await action.isVisible(),true);
  assert.match(await bar.innerText(),/UA/);
  const beginning=await ruler();
  await act('[data-system-zoom="in"]');
  assert.ok(Math.abs((await ruler())/beginning-1.23)<.005);
  await act('[data-system-frame]');
  await act('[data-system-orbit-focus]');
  assert.equal(await view.locator('[data-system-orbit-focus]').getAttribute('aria-pressed'),'true');
  assert.ok(await ruler()>beginning*1.25);
  assert.equal(await view.locator('[data-system-body]:visible').count(),2);
  const plot=view.locator('[data-system-plot]');
  const capture=()=>plot.evaluateHandle(canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height));
  async function markerPosition(plain,marked) {
    try {
      const point=await page.evaluate(({a,b})=>{
        if (a.width!==b.width || a.height!==b.height) return null;
        let x=0,y=0,count=0;
        for (let i=0;i<b.data.length;i+=4) {
          const [r,g,blue]=[b.data[i],b.data[i+1],b.data[i+2]];
          if (Math.abs(r-195)+Math.abs(g-229)+Math.abs(blue-240)>105 ||
              Math.abs(a.data[i]-r)+Math.abs(a.data[i+1]-g)+Math.abs(a.data[i+2]-blue)<85) continue;
          x+=(i/4)%b.width;y+=Math.floor(i/4/b.width);count++;
        }
        return count ? [x/count,y/count] : null;
      },{a:plain,b:marked});
      assert.ok(point,'Le losange doit être dessiné dans la carte orbitale.');
      return point;
    } finally {await Promise.all([plain.dispose(),marked.dispose()]);}
  }
  const simulatedDay=async()=>Number(await view.locator('#sim-elapsed').getAttribute('data-days'));
  await page.waitForTimeout(140);
  const day=await simulatedDay();
  const unmarked=await capture();
  await act('[data-system-marker]');
  const initialPoint=await markerPosition(unmarked,await capture());
  assert.equal(await mark.getAttribute('aria-pressed'),'true');
  assert.equal(Number(await time.getAttribute('data-days')),0);
  await rate.selectOption('3');
  await act('#sim-pause');
  await page.waitForFunction(()=>Number(document.querySelector('[data-system-marker-elapsed]').dataset.days)>.24);
  await act('#sim-pause');
  await page.waitForTimeout(160);
  const elapsed=await time.getAttribute('data-days');
  assert.ok(Math.abs(day+Number(elapsed)-await simulatedDay())<1e-6);
  const size=page.viewportSize();
  if(touch) {
    await page.setViewportSize({width:size.height,height:size.width});
    assert.equal(await time.getAttribute('data-days'),elapsed);
    assert.equal(await mark.getAttribute('aria-pressed'),'true');
    await page.setViewportSize(size);
  }
  for(const locator of [bar,action,mark,view.locator('[data-system-orbit-focus]'),clock]) {
    const box=await locator.boundingBox();
    assert.ok(box && box.x>=-1 && box.y>=-1 && box.x+box.width<=size.width+1 && box.y+box.height<=size.height+1);
  }
  const marked=await capture();
  await act('[data-system-marker]');
  assert.equal(await time.isVisible(),false);
  const finalPoint=await markerPosition(await capture(),marked);
  assert.ok(Math.hypot(finalPoint[0]-initialPoint[0],finalPoint[1]-initialPoint[1])<3,
    'Le repère doit conserver sa position initiale pendant que la planète poursuit sa révolution.');
  await act('[data-system-orbit-focus]');
  assert.ok(await view.locator('[data-system-body]:visible').count()>2);
  await rate.selectOption(speed);
  if(!hadNames) await act('#sim-names');
  if(!paused) await act('#sim-pause');
}

module.exports={checkTransitMap};
