// Menusmith extractor for fjord-burger.fixture — v2
// Source page: fixture://fjord-burger/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 19 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  // Each menu section is a Squarespace "user-items-list-section"
  $('section.user-items-list-section').each((_, secEl) => {
    const $sec = $(secEl);

    // Section title comes from the strong inside .list-section-title
    const sectionRaw = $('.list-section-title strong', $sec).text();
    const section = sectionRaw ? cleanText(sectionRaw) : null;

    // Menu items are list items inside the simple list
    $('.user-items-list-simple > .list-item', $sec).each((_, itEl) => {
      const $it = $(itEl);

      // Dish name
      const nameRaw = $('.list-item-content__title', $it).text();
      const name = cleanText(nameRaw);
      if (!name) return;

      // Description: all <p> texts that do NOT contain the price <strong>
      let desc = '';
      $('.list-item-content__description p', $it).each((_, p) => {
        const $p = $(p);
        if ($p.find('strong').length) return; // skip price paragraph
        desc += ' ' + $p.text();
      });
      const description = desc ? cleanText(desc) : null;

      // Price: first <strong> inside the description
      const priceTxt = $('.list-item-content__description strong', $it).text();
      const price = priceTxt ? parsePrice(priceTxt) : null;

      // Dedup
      const key = `${section ?? ''}|${name}|${description ?? ''}|${price ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({ section, name, description, price });
    });
  });

  return items;
}
