// Original, transparent illustrations created for Seabyss Casino.
// Semantic names live in the game engine; art is decorative inside labelled cells.
(function (root) {
  'use strict';
  const ids = ['skull', 'chest', 'compass', 'anchor', 'rum', 'ten', 'wild', 'scatter'];
  const artwork = {};
  for (const id of ids) {
    const label = id === 'wild' ? 'WILD' : id === 'scatter' ? 'SCATTER' : '';
    artwork[id] = `<span class="symbol-art symbol-${id}" aria-hidden="true"><img class="symbol-image" src="assets/icon-${id}-v2.png" alt="" draggable="false" decoding="async">${label ? `<span class="symbol-tag">${label}</span>` : ''}</span>`;
    if (typeof Image !== 'undefined') {
      const image = new Image();
      image.src = `assets/icon-${id}-v2.png`;
      image.decode?.().catch(() => {});
    }
  }
  root.SeabyssSymbols = Object.freeze(artwork);
})(globalThis);
