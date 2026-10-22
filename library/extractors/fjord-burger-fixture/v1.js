// Menusmith extractor for fjord-burger.fixture — v1
// Source page: fixture://fjord-burger/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 18 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  $('.menu').each((_, menuEl) => {
    $('.menu-section', menuEl).each((_, secEl) => {
      const section = cleanText($('.menu-section-title', secEl).text()) || null;

      $('.menu-item', secEl).each((_, itEl) => {
        const nameRaw = $('.menu-item-title', itEl).text();
        const name = cleanText(nameRaw);
        if (!name) return;

        const descRaw = $('.menu-item-description', itEl).text();
        const description = descRaw ? cleanText(descRaw) : null;

        let price = null;
        const priceTop = $('.menu-item-price-top', itEl).text();
        const priceBot = $('.menu-item-price-bottom', itEl).text();

        if (priceTop) {
          const p = parsePrice(priceTop);
          if (p !== null) price = p;
        }
        if (price === null && priceBot) {
          const p = parsePrice(priceBot);
          if (p !== null) price = p;
        }

        const key = `${section ?? ''}|${name}|${description ?? ''}|${price ?? ''}`;
        if (seen.has(key)) return;
        seen.add(key);

        items.push({ section, name, description, price });
      });
    });
  });

  return items;
}
