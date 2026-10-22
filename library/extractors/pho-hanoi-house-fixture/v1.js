// Menusmith extractor for pho-hanoi-house.fixture — v1
// Source page: fixture://pho-hanoi-house/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 30 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  $('[data-hook="item.container"]').each((_, el) => {
    const $item = $(el);

    // Determine section from nearest section container
    let section = null;
    const $sectionContainer = $item.closest('[data-hook="section.container"]');
    if ($sectionContainer.length) {
      const $heading = $sectionContainer.find('[data-hook="section.name"]');
      if ($heading.length) {
        section = cleanText($heading.text());
      }
    }

    // Name
    const $nameEl = $item.find('[data-hook="item.name"]');
    if (!$nameEl.length) return;
    const name = cleanText($nameEl.text());
    if (!name) return;

    // Price
    const $priceEl = $item.find('[data-hook="item.price"]');
    let price = null;
    if ($priceEl.length) {
      price = parsePrice(cleanText($priceEl.text()));
    }

    // Description
    const $descEl = $item.find('[data-hook="item.description"]');
    let description = null;
    if ($descEl.length) {
      description = cleanText($descEl.text());
    }

    // Deduplicate exact repeats
    const key = `${section ?? ''}|${name}|${description ?? ''}|${price ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({ section, name, description, price });
  });

  return items;
}
