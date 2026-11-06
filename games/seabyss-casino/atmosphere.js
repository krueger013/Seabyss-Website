/* Decorative abyss atmosphere. No game state or user input is handled here. */
(function () {
  'use strict';

  let scene = null;
  let host = null;
  let observer = null;
  let awake = false;
  let serial = 0;
  const strikeTimers = new Map();

  const cups = [
    [70, 149, 9, 5, 32], [93, 151, 8, 5, -29],
    [112, 134, 7, 4, -72], [109, 113, 6, 3, 35],
    [141, 171, 10, 6, -67], [134, 198, 11, 6, -64],
    [121, 224, 12, 7, -55], [105, 251, 13, 7, -56],
    [91, 280, 14, 8, -65], [84, 313, 15, 9, -83],
    [90, 346, 16, 9, 72], [106, 378, 17, 10, 61],
    [129, 410, 18, 11, 51]
  ];

  function tentacle(id, mirrored) {
    const suctionCups = cups.map(([x, y, rx, ry, angle], i) => `
      <g transform="translate(${x} ${y}) rotate(${angle})">
        <ellipse rx="${rx + 1.5}" ry="${ry + 1.5}" fill="#05272c"/>
        <ellipse rx="${rx}" ry="${ry}" fill="url(#${id}-cup)" stroke="#668e80" stroke-width="1"/>
        <ellipse rx="${rx * 0.62}" ry="${ry * 0.56}" fill="#0b3439" stroke="#224a49" stroke-width="1.1"/>
        <path d="M${-rx * 0.65},${-ry * 0.36} Q0,${-ry * 1.08} ${rx * 0.65},${-ry * 0.36}" fill="none" stroke="#b5ae78" stroke-opacity="${i % 3 ? '.42' : '.64'}" stroke-width="1.1"/>
      </g>`).join('');

    return `<svg class="kraken-art" viewBox="0 0 190 450" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${id}-skin" x1="0" y1="0" x2="1" y2=".25">
          <stop stop-color="#071d23"/><stop offset=".3" stop-color="#16474d"/>
          <stop offset=".53" stop-color="#306161"/><stop offset=".7" stop-color="#113b43"/><stop offset="1" stop-color="#061b26"/>
        </linearGradient>
        <linearGradient id="${id}-belly" x1="0" y1="0" x2="1" y2="0">
          <stop stop-color="#244c4a"/><stop offset=".6" stop-color="#54756a"/><stop offset="1" stop-color="#1b4443"/>
        </linearGradient>
        <linearGradient id="${id}-cup" x1="0" y1="0" x2="0" y2="1">
          <stop stop-color="#a6ad85"/><stop offset=".3" stop-color="#5b8d7b"/><stop offset=".65" stop-color="#244b4a"/><stop offset="1" stop-color="#0c2b33"/>
        </linearGradient>
        <linearGradient id="${id}-edge" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#7ccbc3" stop-opacity=".08"/><stop offset=".45" stop-color="#8edfd0" stop-opacity=".65"/><stop offset="1" stop-color="#c5b57c" stop-opacity=".18"/>
        </linearGradient>
        <filter id="${id}-shadow" x="-30%" y="-20%" width="160%" height="150%">
          <feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#000b12" flood-opacity=".9"/>
        </filter>
      </defs>
      <g ${mirrored ? 'transform="translate(190 0) scale(-1 1)"' : ''} filter="url(#${id}-shadow)">
        <path d="M104 451C51 397 45 350 60 300C75 251 122 224 133 174C147 116 118 69 81 84C53 96 60 139 83 143C100 147 110 134 105 124C101 116 89 118 89 126C72 114 82 101 96 108C115 118 108 150 87 158C50 173 23 143 27 114C31 62 83 38 123 62C172 91 179 146 162 199C144 257 100 294 105 338C112 380 148 408 175 451Z" fill="url(#${id}-skin)" stroke="#061c25" stroke-width="3" stroke-linejoin="round"/>
        <path d="M146 451C108 409 77 372 77 328C74 278 113 244 133 199C149 165 151 120 129 90C146 117 142 164 125 199C107 239 68 275 65 318C60 368 82 408 119 451Z" fill="url(#${id}-belly)" opacity=".78"/>
        <path d="M39 116C45 76 86 56 115 73C153 95 166 148 149 194C130 249 90 282 91 324C91 371 129 413 151 442" fill="none" stroke="url(#${id}-edge)" stroke-width="2.1"/>
        <path d="M38 126c4 21 27 35 48 23M57 308c-7 43 7 81 33 112" fill="none" stroke="#86bbb0" stroke-opacity=".19" stroke-width="1.5"/>
        ${suctionCups}
        <g fill="none" stroke="#0b2c32" stroke-width="1.25" opacity=".58">
          <path d="m41 104 8 3m-12 14 9 1m9-39 5 6m14-17 3 7m17-9-1 7m19-5-4 7m18 4-7 6m20 9-8 5m17 13-8 3m12 18-8 1m10 19-8-2m6 24-8-3m-1 21-7-3m-1 28-10-5m-3 24-9-6m-6 26-8-7m-6 29-9-7m-8 29-9-4m-5 27-9-2m6 30-11 1m20 25-11 3m22 23-11 5m27 20-12 7"/>
        </g>
        <g class="kraken-bioluminescence" fill="#80ddd1">
          <ellipse cx="44" cy="97" rx="1.3" ry="2.2" transform="rotate(25 44 97)"/>
          <ellipse cx="126" cy="88" rx="1.2" ry="2.5" transform="rotate(-33 126 88)"/>
          <ellipse cx="152" cy="150" rx="1.1" ry="2.8"/>
          <ellipse cx="139" cy="208" rx="1.2" ry="2.6" transform="rotate(24 139 208)"/>
          <ellipse cx="72" cy="301" rx="1.2" ry="2.8" transform="rotate(15 72 301)"/>
          <ellipse cx="106" cy="395" rx="1.1" ry="2.5" transform="rotate(-36 106 395)"/>
        </g>
      </g>
    </svg>`;
  }

  function updateWidth() {
    if (scene && host) scene.style.setProperty('--seabyss-stage-width', `${host.clientWidth}px`);
  }

  function mount(element) {
    if (!element || typeof element.appendChild !== 'function') return null;
    if (scene && host === element) return scene;
    if (observer) observer.disconnect();
    if (scene) scene.remove();
    if (host) host.classList.remove('seabyss-atmosphere-host');
    strikeTimers.forEach(clearTimeout);
    strikeTimers.clear();

    host = element;
    host.classList.add('seabyss-atmosphere-host');
    scene = document.createElement('div');
    scene.className = `seabyss-atmosphere${awake ? ' is-awake' : ''}`;
    scene.setAttribute('aria-hidden', 'true');
    const id = `seabyss-kraken-${++serial}`;
    scene.innerHTML = `
      <div class="abyss-wisp abyss-wisp-left"></div>
      <div class="abyss-wisp abyss-wisp-right"></div>
      <div class="kraken-arm kraken-arm-left"><div class="kraken-sway">${tentacle(`${id}-left`, false)}</div></div>
      <div class="kraken-arm kraken-arm-right"><div class="kraken-sway">${tentacle(`${id}-right`, true)}</div></div>
      <div class="abyss-edge-bubbles">${Array.from({ length: 8 }, (_, index) => `<i class="abyss-bubble" style="--bubble-index:${index};--bubble-delay:-${index * 2.7}s;--bubble-duration:${13 + index % 4 * 2}s;--bubble-size:${3 + index % 3 * 2}px"></i>`).join('')}</div>`;
    host.prepend(scene);
    updateWidth();
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateWidth);
      observer.observe(host);
    }
    return scene;
  }

  function setAwake(value) {
    awake = Boolean(value);
    if (scene) scene.classList.toggle('is-awake', awake);
  }

  function strike(reel) {
    if (!scene) return;
    const side = typeof reel === 'number' ? (reel < 2 ? 'left' : reel > 2 ? 'right' : 'both') : 'both';
    const arms = side === 'both' ? scene.querySelectorAll('.kraken-arm') : scene.querySelectorAll(`.kraken-arm-${side}`);
    arms.forEach((arm) => {
      clearTimeout(strikeTimers.get(arm));
      arm.classList.remove('is-striking');
      // Restart a short CSS animation even if two attacks land on the same arm.
      void arm.offsetWidth;
      arm.classList.add('is-striking');
      strikeTimers.set(arm, setTimeout(() => {
        arm.classList.remove('is-striking');
        strikeTimers.delete(arm);
      }, 1050));
    });
  }

  globalThis.SeabyssAtmosphere = Object.freeze({ mount, setAwake, strike });
}());
