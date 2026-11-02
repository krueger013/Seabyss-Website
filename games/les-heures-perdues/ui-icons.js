/* Interface symbols for Les Heures perdues. */
(function (root) {
  'use strict';
  const paths = {
    compass: '<circle cx="16" cy="16" r="11.5"/><circle cx="16" cy="16" r="8.5" opacity=".45"/><path d="M16 1.5v5M16 25.5v5M1.5 16h5m19 0h5M5.75 5.75l3.5 3.5m13.5 13.5 3.5 3.5M5.75 26.25l3.5-3.5m13.5-13.5 3.5-3.5"/><path d="m20.5 11.5-2.8 6.2-6.2 2.8 2.8-6.2z"/><path d="m14.3 14.3 3.4 3.4"/><circle cx="16" cy="16" r="1" fill="currentColor" stroke="none"/>',
    map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16m6-14v16"/>',
    journal: '<path d="M6 3.5h13v17H6a2.5 2.5 0 0 1 0-5h13M3.5 18V6A2.5 2.5 0 0 1 6 3.5"/><path d="M8 7h7m-7 3h5M6 18h10"/>',
    'sound-on': '<path d="m10 5-5 4H2v6h3l5 4zM14 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    'sound-off': '<path d="m10 5-5 4H2v6h3l5 4zM15 9l6 6m0-6-6 6"/>',
    settings: '<path d="m9.3 3-.5 2.4-2 .9-2.2-.8-2.1 3.6 1.7 1.6v2.6l-1.7 1.6 2.1 3.6 2.2-.8 2 .9.5 2.4h4.2l.5-2.4 2-.9 2.2.8 2.1-3.6-1.7-1.6v-2.6l1.7-1.6-2.1-3.6-2.2.8-2-.9-.5-2.4z"/><circle cx="11.4" cy="12" r="3.2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    'zoom-in': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 5.3 5.3M7.5 10.5h6m-3-3v6"/>',
    'zoom-out': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 5.3 5.3M7.5 10.5h6"/>',
    fullscreen: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM4 2v4M2 4h4m14 14v4m-2-2h4"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/><circle cx="12" cy="14.5" r=".75" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    leaf: '<path d="M5 19C-1 8 10 3 21 3c0 11-5 22-16 16Zm-2 2L16 8m-5 5V8m0 5h5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    save: '<path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v6h9V3M7 21v-7h10v7m-4-15v1"/>'
  };
  function svg(name) {
    if (!Object.prototype.hasOwnProperty.call(paths, name)) return '';
    const size = name === 'compass' ? 32 : 24;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="ui-icon">' + paths[name] + '</svg>';
  }
  root.UIIcons = Object.freeze({ svg });
})(typeof window === 'undefined' ? globalThis : window);
