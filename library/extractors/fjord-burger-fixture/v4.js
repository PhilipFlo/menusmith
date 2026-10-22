// Menusmith extractor for fjord-burger.fixture — v4
// Source page: fixture://fjord-burger/
// Written by nvidia/Nemotron-3-Ultra-550b-a55b in 1 round(s); f1=1 on 18 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  $('.menu[data-menu-index="0"] .menu-section').each((_, sectionEl) => {
    const $section = $(sectionEl);
    const sectionTitle = cleanText($section.find('.menu-section-title').first().text());
    const section = sectionTitle || null;

    $section.find('.menu-items .menu-item').each((_, itemEl) => {
      const $item = $(itemEl);
      const rawName = $item.find('.menu-item-title').first().text();
      const name = cleanText(rawName);
      if (!name) return;

      const descEl = $item.find('.menu-item-description').first();
      const description = descEl.length ? cleanText(descEl.text()) : null;

      const priceText = $item.find('.menu-item-price-top, .menu-item-price-bottom').first().text();
      const price = parsePrice(priceText);

      const key = `${section}|${name}|${description}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({ section, name, description, price });
    });
  });

  return items;
}
