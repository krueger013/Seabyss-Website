/* Seabyss presentation localization. Game state and user-entered values stay untouched. */
(() => {
  'use strict';
  const LANGS = ['fr', 'en', 'es'], KEY = 'seabyss.language.v1';
  const dictionaries = new Map(), folded = new Map(), patterns = [], cache = new Map(), originals = new WeakMap();
  const attributes = ['title', 'aria-label', 'placeholder', 'alt'];
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  const ignored = node => node.parentElement?.closest('script,style,code,pre,textarea,[contenteditable],[data-i18n-ignore],[data-no-translate],[translate="no"],.seabyss-language');
  let language = 'fr';
  try { const stored = localStorage.getItem(KEY); if (LANGS.includes(stored)) language = stored; } catch (_) {}
  const requested = new URL(location.href).searchParams.get('lang');
  if (LANGS.includes(requested)) { language = requested; try { localStorage.setItem(KEY, language); } catch (_) {} }
  const locale = () => ({fr:'fr-CA',en:'en-US',es:'es-ES'}[language]);
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function translate(value, depth = 0) {
    if (typeof value !== 'string' || !value.trim() || !/\p{L}/u.test(value) || depth > 5) return value;
    const key = language + '\0' + value;
    if (cache.has(key)) return cache.get(key);
    const source = normalize(value), entry = dictionaries.get(source);
    let translated = entry?.[language];
    if (translated === undefined) {
      for (const pattern of patterns) {
        const match = pattern.regex.exec(source);
        if (!match || pattern[language] === undefined) continue;
        const values = new Map(pattern.indices.map((index, position) => [index, match[position + 1]]));
        translated = pattern[language].replace(/\{(\d+)\}/g, (_, index) => {
          const captured = values.get(Number(index)) ?? '';
          return pattern.opaque?.includes(Number(index)) ? captured : translate(captured, depth + 1);
        });
        break;
      }
    }
    if (translated === undefined) {
      // Case variants occur in HUDs and object hints; preserve the requested case.
      const lower = source.toLocaleLowerCase();
      const variant = folded.get(lower);
      if (variant?.[language] !== undefined) {
        translated = variant[language];
        if (source === source.toLocaleUpperCase()) translated = translated.toLocaleUpperCase(locale());
        else if (source === lower) translated = translated.toLocaleLowerCase(locale());
      }
    }
    const result = translated === undefined ? value : value.match(/^\s*/u)[0] + translated + value.match(/\s*$/u)[0];
    if (cache.size > 10000) cache.clear();
    cache.set(key, result);
    return result;
  }

  function register(pack) {
    const sourceLanguage = pack.source || 'fr';
    for (const [original, translations] of Object.entries(pack.strings || {})) {
      const source = normalize(original), values = typeof translations === 'string' ? {[language]:translations} : translations;
      dictionaries.set(source, {...dictionaries.get(source), [sourceLanguage]:source, ...values});
      folded.set(source.toLocaleLowerCase(), dictionaries.get(source));
    }
    for (const template of pack.templates || []) {
      const source = normalize(template.source), indices = [];
      let regex = '', cursor = 0;
      for (const match of source.matchAll(/\{(\d+)\}/g)) {
        regex += escapeRegex(source.slice(cursor, match.index)) + '(.*?)';
        indices.push(Number(match[1])); cursor = match.index + match[0].length;
      }
      regex += escapeRegex(source.slice(cursor));
      patterns.push({...template, [sourceLanguage]:template[sourceLanguage] ?? source, regex:new RegExp('^' + regex + '$', 'u'), indices, specificity:source.replace(/\{\d+\}/g,'').length});
    }
    patterns.sort((a,b) => b.specificity - a.specificity);
    cache.clear();
    if (document.body) scan(document.body);
    scan(document.head);
  }

  function localizeText(node) {
    if (ignored(node)) return;
    const previous = originals.get(node);
    const source = previous && node.nodeValue === previous.output ? previous.source : node.nodeValue;
    const output = translate(source);
    originals.set(node, {source,output});
    if (node.nodeValue !== output) node.nodeValue = output;
  }
  function localizeAttributes(element) {
    if (element.closest('script,style,[data-i18n-ignore],[data-no-translate],[translate="no"],.seabyss-language')) return;
    let records = originals.get(element);
    if (!records) { records = {}; originals.set(element,records); }
    for (const name of attributes) {
      if (!element.hasAttribute(name)) continue;
      const current = element.getAttribute(name), record = records[name];
      const source = record && current === record.output ? record.source : current;
      const output = translate(source); records[name] = {source,output};
      if (current !== output) element.setAttribute(name,output);
    }
    // Meta copy is visible in previews and browser search results.
    if (element.matches('meta[name="description"],meta[property="og:title"],meta[property="og:description"]')) {
      const current = element.getAttribute('content'), record = records.content;
      const source = record && current === record.output ? record.source : current;
      const output = translate(source); records.content = {source,output};
      if (current !== output) element.setAttribute('content',output);
    }
  }
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) { localizeText(root); return; }
    if (root.nodeType !== 1) return;
    localizeAttributes(root);
    const walker = document.createTreeWalker(root, 5);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeType === 3) localizeText(walker.currentNode);
      else localizeAttributes(walker.currentNode);
    }
    mountPickers(root);
  }
  function mountPickers(root) {
    const mounts = [...root.querySelectorAll('[data-language-picker]:not([data-language-mounted])')];
    if (root.matches('[data-language-picker]:not([data-language-mounted])')) mounts.unshift(root);
    for (const mount of mounts) {
      mount.dataset.languageMounted = 'true';
      const label = document.createElement('label'); label.className = 'seabyss-language'; label.setAttribute('translate','no');
      const caption = document.createElement('span'); caption.textContent = '◎'; caption.setAttribute('aria-hidden','true');
      const select = document.createElement('select');
      for (const [code,name] of [['fr','Français'],['en','English'],['es','Español']]) {
        const option = document.createElement('option'); option.value = code; option.textContent = name; option.lang = code; select.append(option);
      }
      select.value = language; select.setAttribute('aria-label', {fr:'Choisir la langue',en:'Choose language',es:'Elegir idioma'}[language]);
      select.addEventListener('change', () => setLanguage(select.value));
      select.addEventListener('keydown', event => event.stopPropagation());
      label.append(caption,select); mount.append(label);
    }
  }
  function broadcast() {
    for (const frame of document.querySelectorAll('iframe')) {
      try { frame.contentWindow?.postMessage({type:'seabyss-language',language},location.origin); } catch (_) {}
    }
  }
  function setLanguage(next, persist = true) {
    if (!LANGS.includes(next)) return;
    language = next; cache.clear(); document.documentElement.lang = language;
    if (persist) {
      try { localStorage.setItem(KEY,language); } catch (_) {}
      try { const url = new URL(location.href); url.searchParams.set('lang',language); history.replaceState(null,'',url); } catch (_) {}
    }
    scan(document.head); scan(document.body);
    for (const picker of document.querySelectorAll('.seabyss-language select')) {
      picker.value = language; picker.setAttribute('aria-label',{fr:'Choisir la langue',en:'Choose language',es:'Elegir idioma'}[language]);
    }
    broadcast();
    window.dispatchEvent(new CustomEvent('seabyss:languagechange',{detail:{language}}));
  }
  function localizedUrl(value) {
    const url = new URL(value,document.baseURI);
    if (url.origin === location.origin) url.searchParams.set('lang',language);
    return url.href;
  }
  window.SeabyssI18n = {register,t:translate,setLanguage,url:localizedUrl,scan,get language(){return language;},get locale(){return locale();}};
  document.documentElement.lang = language;
  // Canvas text is presentation-only. Numeric state, card IDs and saves are never rewritten.
  for (const Type of [window.CanvasRenderingContext2D,window.OffscreenCanvasRenderingContext2D]) {
    if (!Type) continue;
    for (const method of ['fillText','strokeText','measureText']) {
      const original = Type.prototype[method];
      if (typeof original !== 'function') continue;
      Type.prototype[method] = function(text,...args) { return original.call(this,translate(String(text)),...args); };
    }
  }
  function start() {
    scan(document.head); scan(document.body);
    const observer = new MutationObserver(records => {
      const roots = new Set();
      for (const record of records) {
        if (record.type === 'characterData') localizeText(record.target);
        else if (record.type === 'attributes') localizeAttributes(record.target);
        else for (const node of record.addedNodes) roots.add(node);
      }
      for (const root of roots) scan(root);
    });
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:[...attributes,'content']});
    document.addEventListener('click', event => {
      const link = event.target.closest?.('a[href]');
      if (!link || link.hasAttribute('download')) return;
      const url = new URL(link.href,document.baseURI);
      if (url.origin === location.origin && /(?:\.html|\/)$/i.test(url.pathname) && !link.getAttribute('href').startsWith('#')) link.href = localizedUrl(link.href);
    },true);
    document.addEventListener('load', event => { if (event.target.tagName === 'IFRAME') broadcast(); },true);
  }
  window.addEventListener('storage', event => { if (event.key === KEY && LANGS.includes(event.newValue)) setLanguage(event.newValue,false); });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'seabyss-language') return;
    if (event.source !== window.parent) return;
    if (event.data.language !== language) setLanguage(event.data.language,false);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
