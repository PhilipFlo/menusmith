// Menusmith extractor for blue-oak-bistro.fixture — v1
// Source page: fixture://blue-oak-bistro/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 20 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  $('.menu-category').each((_, catEl) => {
    const $cat = $(catEl);
    const $heading = $cat.find('.heading-menu').first();
    const section = cleanText($heading.text()) || null;

    $cat.find('.menu-item.w-dyn-item').each((_, itemEl) => {
      const $item = $(itemEl);

      const nameRaw = $item.find('.menu-item-name').text() || '';
      const name = cleanText(nameRaw);
      if (!name) return;

      const descRaw = $item.find('.menu-item-desc').text() || '';
      const description = descRaw ? cleanText(descRaw) : null;

      const priceRaw = $item.find('.menu-item-price').text() || '';
      const price = parsePrice(priceRaw);

      const key = `${section}|${name}|${description ?? ''}|${price ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({ section, name, description, price });
    });
  });

  return items;
}
