(() => {
  'use strict';
  const wallet = CasinoWallet;
  const panel = document.createElement('section');
  panel.className = 'hourly-gift';
  panel.setAttribute('aria-label', 'Cadeau horaire du casino');
  panel.innerHTML = `<span class="gift-emblem" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 13h22v6H5zM8 19v10h16V19M16 13v16M16 13c-11 0-10-10-5-9 4 0 5 9 5 9Zm0 0c11 0 10-10 5-9-4 0-5 9-5 9Z"/></svg></span><div class="gift-copy"><span class="gift-eyebrow">LE CADEAU DU CASINO</span><strong>50 $ chaque heure</strong><span id="gift-message" role="status">Un cadeau commun aux neuf machines.</span></div><div class="gift-action"><button type="button" id="claim-hourly-gift">RÉCUPÉRER 50 $ <span aria-hidden="true">↗</span></button><span id="gift-countdown" aria-live="off"></span></div>`;
  document.querySelector('header').after(panel);
  const button = document.getElementById('claim-hourly-gift');
  const timer = document.getElementById('gift-countdown');
  const message = document.getElementById('gift-message');
  let busy = false, pending = false;
  function countdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    return (h ? `${h}:` : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function render() {
    const reward = wallet.rewardStatus();
    button.disabled = pending || busy || !reward.available;
    panel.classList.toggle('gift-ready', reward.available);
    button.innerHTML = pending ? 'RÉCUPÉRATION…' : reward.available ? 'RÉCUPÉRER 50 $ <span aria-hidden="true">↗</span>' : 'PROCHAIN CADEAU <span aria-hidden="true">◷</span>';
    timer.textContent = reward.available ? busy ? 'Disponible après ce tour ou cette démo' : 'Disponible maintenant' : `Dans ${countdown(reward.remaining)}`;
  }
  window.CasinoRewards = Object.freeze({ setBusy(value) { busy = !!value; render(); }, isClaiming() { return pending; } });
  button.addEventListener('click', async () => {
    if (pending || busy || !wallet.rewardStatus().available) return;
    pending = true; render();
    try {
      const result = await wallet.claimHourlyReward();
      message.textContent = result.claimed ? '50,00 $ ajoutés à votre solde. Bon jeu !' : 'Cadeau déjà récupéré. Le prochain arrive bientôt.';
      window.dispatchEvent(new Event('casino-wallet-changed'));
    } catch (error) {
      message.textContent = error.code === 'REWARD_LOCK_UNAVAILABLE' ? 'Ouvrez le casino dans un navigateur récent avec le stockage autorisé.' : 'Cadeau non récupéré. Autorisez le stockage du navigateur puis réessayez.';
    } finally { pending = false; render(); }
  });
  window.addEventListener('storage', render);
  window.addEventListener('focus', render);
  window.addEventListener('pageshow', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  setInterval(() => { if (!document.hidden) render(); }, 1000);
  render();
})();
