// Menusmith extractor for sushi-koi.fixture — v1
// Source page: fixture://sushi-koi/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 24 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];

  // Try to parse JSON‑LD first (very stable)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (!data || data['@type'] !== 'Menu') return;

      const sections = data.hasMenuSection || [];
      sections.forEach(sec => {
        const section = sec.name ? cleanText(sec.name) : null;
        (sec.hasMenuItem || []).forEach(it => {
          const name = cleanText(it.name ?? '');
          if (!name) return;
          const description = it.description ? cleanText(it.description) : null;
          let price = null;
          const offers = it.offers;
          if (offers && offers.price != null) {
            price = parsePrice(String(offers.price));
          }
          items.push({section, name, description, price});
        });
      });
    } catch (_) {
      // ignore malformed JSON‑LD blocks
    }
  });

  // Fallback to DOM extraction if JSON‑LD yielded nothing
  if (items.length === 0) {
    $('.menu-group').each((_, group) => {
      const $group = $(group);
      const $title = $group.find('.menu-group__title');
      const section = $title.length ? cleanText($title.text()) : null;

      $group.find('.dish').each((_, dish) => {
        const $dish = $(dish);
        const $nameEl = $dish.find('.dish__name');
        const name = cleanText($nameEl.text());
        if (!name) return;

        const $descEl = $dish.find('.dish__desc');
        const description = $descEl.length ? cleanText($descEl.text()) : null;

        const $priceEl = $dish.find('.dish__price');
        const price = $priceEl.length ? parsePrice($priceEl.text()) : null;

        items.push({section, name, description, price});
      });
    });
  }

  // Remove exact duplicates (e.g., mobile/desktop copies)
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = JSON.stringify(it);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(it);
    }
  }
  return deduped;
}
