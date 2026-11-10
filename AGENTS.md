# Seabyss portal maintenance

- This public portal is published to the existing GitHub Pages site, www.seabyss.com. Preserve the CNAME and historical launcher/API resources.
- The portal and all fifteen games support French, English and Spanish. Keep `js/i18n.js`, `css/i18n.css`, the per-game `translations.js` files and language picker mounts when refreshing a game from its canonical local source.
- Translate new interface text, accessible names, narratives, card/item descriptions, dynamic messages and canvas labels. A newly added source phrase needs entries in both other languages; it is not automatically translated by an external service.
- Never localize serialized IDs, save keys, game rules, player-entered names or user data. Mark custom-name nodes `data-i18n-ignore`; use opaque template slots for names inside dynamic sentences.
- Keep the language selector in normal flow, usable on small portrait/landscape screens, with keyboard access and 44px touch targets. Preserve browser zoom, reduced motion and game state during language changes.
- Run `npm test` and `npm run check:locales` after localization changes. Browser checks, device tests and semantic DOM tests are distinct: report the actual verification performed.
- Preserve translated-name search and language propagation into iframes and new tabs. Do not reset or clear player saves for tests.
