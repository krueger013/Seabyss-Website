(() => {
  const money = value => (value / 100).toLocaleString(globalThis.SeabyssI18n?.locale || 'fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  function refresh() {
    document.getElementById('casino-balance').textContent = money(CasinoWallet.read());
    for (const [machine, key] of [['pirate', 'seabyss-casino-session-v1'], ['moon', 'seabyss-moon-session-v1'], ['nova', 'seabyss-nova-session-v1'], ['flowers', 'seabyss-flowers-session-v1'], ['monsters', 'seabyss-monsters-session-v1'], ['medieval', 'seabyss-medieval-session-v1'], ['feline', 'seabyss-feline-session-v1'], ['alien', 'seabyss-alien-session-v1'], ['alchemy', 'seabyss-alchemy-session-v1']]) {
      const resume = document.getElementById(machine + '-resume');
      resume.hidden = true;
      try {
        const saved = ['nova','flowers','monsters','medieval','feline','alien','alchemy'].includes(machine) ? CasinoWallet.readSession(key) || JSON.parse(localStorage.getItem(key)) : JSON.parse(localStorage.getItem(key));
        resume.hidden = !(saved?.state?.inBonus || (machine === 'alchemy' && (saved?.state?.bonus || saved?.brewReveal)) || (machine === 'alien' && (saved?.intro || saved?.summary)) || (machine === 'feline' && (saved?.state?.pendingWheel || saved?.wheelReveal || saved?.state?.reelLocks?.some(n => n > 0))));
      } catch (_) {}
    }
  }
  window.addEventListener('casino-wallet-changed', refresh);
  refresh(); window.addEventListener('focus', refresh); window.addEventListener('pageshow', refresh); window.addEventListener('storage', refresh);

  // Locale-only refresh: keep the same wagers, saved session and wallet values.
  window.addEventListener('seabyss:languagechange', () => {
    refresh();
  });
})();
