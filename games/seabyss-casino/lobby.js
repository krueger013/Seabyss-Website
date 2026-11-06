(() => {
  const money = value => (value / 100).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  function refresh() {
    document.getElementById('casino-balance').textContent = money(CasinoWallet.read());
    for (const [machine, key] of [['pirate', 'seabyss-casino-session-v1'], ['moon', 'seabyss-moon-session-v1'], ['nova', 'seabyss-nova-session-v1']]) {
      const resume = document.getElementById(machine + '-resume');
      resume.hidden = true;
      try {
        const saved = machine === 'nova' ? CasinoWallet.readSession(key) || JSON.parse(localStorage.getItem(key)) : JSON.parse(localStorage.getItem(key));
        resume.hidden = !saved?.state?.inBonus;
      } catch (_) {}
    }
  }
  refresh(); window.addEventListener('focus', refresh); window.addEventListener('pageshow', refresh); window.addEventListener('storage', refresh);
})();
