'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const games = JSON.parse(fs.readFileSync(path.join(root,'data/games.json'),'utf8'));
const pages = ['index.html','privacy.html',...new Set(games.map(game => game.url)), 'games/seabyss-casino/index.html'];
const packs = ['js/portal-translations.js','js/privacy-translations.js',...['dames','castle-war','petits-compagnons','marios-ghost','les-heures-perdues','seabyss-casino'].map(name => 'games/'+name+'/translations.js')];
let strings = 0, templates = 0;
for (const pack of packs) {
  let registrations = 0;
  const context = { SeabyssI18n:{register(data) {
    registrations++;
    assert(['fr','en','es'].includes(data.source),pack+': invalid source language');
    for (const [source,values] of Object.entries(data.strings || {})) {
      assert(source.trim(),pack+': empty source'); strings++;
      for (const language of ['fr','en','es']) if (language !== data.source) assert(typeof values[language] === 'string' && values[language].trim(),pack+': missing '+language+' for '+source);
    }
    for (const template of data.templates || []) {
      templates++;
      assert(typeof template.source === 'string',pack+': missing template source');
      const slots = new Set([...template.source.matchAll(/\{(\d+)\}/g)].map(match=>match[1]));
      for (const language of ['fr','en','es']) {
        const value = template[language] ?? (language === data.source ? template.source : undefined);
        assert(typeof value === 'string',pack+': missing '+language+' template '+template.source);
        for (const match of value.matchAll(/\{(\d+)\}/g)) assert(slots.has(match[1]),pack+': unknown slot '+match[0]+' in '+language+': '+template.source);
      }
    }
  }}, document:{addEventListener(){}},addEventListener(){},location:{pathname:'/index.html'}};
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root,pack),'utf8'),context,{filename:pack});
  assert(registrations > 0,pack+': no dictionary registered');
}
for (const page of pages) {
  const file = path.join(root,page), html = fs.readFileSync(file,'utf8');
  assert(html.includes('i18n.js'),page+': missing language runtime');
  assert(html.includes('translations.js'),page+': missing dictionary');
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const ref = match[1]; if (/^(?:https?:|data:|#)/.test(ref)) continue;
    assert(fs.existsSync(path.resolve(path.dirname(file),ref.split(/[?#]/)[0])),page+': missing '+ref);
  }
}
assert.equal(games.length,12);
assert.equal(new Set(games.map(game=>game.id)).size,12);
console.log('Validated '+pages.length+' pages, '+packs.length+' dictionaries, '+strings+' phrases and '+templates+' dynamic templates in FR / EN / ES.');
