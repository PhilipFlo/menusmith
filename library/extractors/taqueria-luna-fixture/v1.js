// Menusmith extractor for taqueria-luna.fixture — v1
// Source page: fixture://taqueria-luna/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 16 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  // Each product is represented by a <li class="grid__item"> inside the product grid
  $('li.grid__item').each((_, li) => {
    const $li = $(li);

    // ---- Name --------------------------------------------------------------
    const $nameLink = $li.find('h3.card__heading.h5 a.full-unstyled-link');
    if (!$nameLink.length) return; // safety guard
    let name = cleanText($nameLink.text());
    // strip leading numbering like "12. "
    name = name.replace(/^\d+\.\s*/, '');

    // ---- Price -------------------------------------------------------------
    let price = null;
    const $priceFirst = $li.find('.price-item').first(); // first price shown
    if ($priceFirst.length) {
      price = parsePrice(cleanText($priceFirst.text()));
    }

    // ---- Description -------------------------------------------------------
    // No description present in the markup for this menu
    const description = null;

    // ---- Section -----------------------------------------------------------
    // Find the nearest section heading (<h2 class="title inline-richtext h2">)
    const $sectionHeading = $li.closest('.section')
                               .find('h2.title.inline-richtext.h2')
                               .first();
    let section = null;
    if ($sectionHeading.length) {
      section = cleanText($sectionHeading.text());
    }

    // ---- Dedup -------------------------------------------------------------
    const key = `${section ?? ''}|${name}|${price ?? ''}`;
    if (name && !seen.has(key)) {
      seen.add(key);
      items.push({ section, name, description, price });
    }
  });

  return items;
}
