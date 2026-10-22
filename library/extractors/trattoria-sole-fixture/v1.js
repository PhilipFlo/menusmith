// Menusmith extractor for trattoria-sole.fixture — v1
// Source page: fixture://trattoria-sole/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 25 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  $('.elementor-section').each((_, secEl) => {
    const $sec = $(secEl);
    const $heading = $sec.find('.elementor-heading-title').first();
    const section = $heading.length ? cleanText($heading.text()) : null;

    const $items = $sec.find('.elementor-price-list > .elementor-price-list-item');
    if (!$items.length) return;

    $items.each((_, li) => {
      const $li = $(li);

      // name
      let name = cleanText($li.find('.elementor-price-list-title').first().text());
      if (!name) return;
      // strip leading numbering (e.g., "12. ")
      name = name.replace(/^\d+\.\s*/, '');
      // strip trailing allergen codes like "(1,7)"
      name = name.replace(/\(\s*\d+(?:[,\s]\d+)*\s*\)$/g, '');
      name = cleanText(name); // trim again after removals
      if (!name) return;

      // description
      let desc = null;
      const $desc = $li.find('.elementor-price-list-description').first();
      if ($desc.length) {
        desc = cleanText($desc.text());
      }

      // price
      let price = null;
      const $price = $li.find('.elementor-price-list-price').first();
      if ($price.length) {
        const priceStr = cleanText($price.text());
        price = parsePrice(priceStr);
      }

      const key = `${section ?? ''}|${name}|${desc ?? ''}|${price ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ section, name, description: desc ?? null, price });
    });
  });

  return items;
}
