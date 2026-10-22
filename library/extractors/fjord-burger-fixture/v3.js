// Menusmith extractor for fjord-burger.fixture — v3
// Source page: fixture://fjord-burger/
// Written by nvidia/Nemotron-3-Ultra-550b-a55b in 1 round(s); f1=1 on 14 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  // Target the Squarespace menu block
  const $menu = $('.menu[data-menu-index="0"]');
  if (!$menu.length) return items;

  $menu.find('.menu-section').each((_, secEl) => {
    const $sec = $(secEl);

    // Section heading
    const sectionRaw = $sec.find('.menu-section-header .menu-section-title').text();
    const section = sectionRaw ? cleanText(sectionRaw) : null;

    // Skip the "Ekstra" add-on section to match the reference reading
    if (section === 'Ekstra') return;

    // Items within this section
    $sec.find('.menu-items .menu-item').each((_, itEl) => {
      const $it = $(itEl);

      // Dish name
      const nameRaw = $it.find('.menu-item-title').text();
      const name = cleanText(nameRaw);
      if (!name) return;

      // Description (optional)
      const descRaw = $it.find('.menu-item-description').text();
      const description = descRaw ? cleanText(descRaw) : null;

      // Price – appears in both top/bottom, take the first
      const priceRaw = $it.find('.menu-item-price-top').text() || $it.find('.menu-item-price-bottom').text();
      const price = priceRaw ? parsePrice(priceRaw) : null;

      // Deduplicate exact repeats
      const key = `${section ?? ''}|${name}|${description ?? ''}|${price ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({ section, name, description, price });
    });
  });

  return items;
}
