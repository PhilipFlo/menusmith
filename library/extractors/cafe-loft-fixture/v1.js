// Menusmith extractor for cafe-loft.fixture — v1
// Source page: fixture://cafe-loft/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 18 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  const seen = new Set();

  $('.meny-blokk').each((_, blokk) => {
    const $sectionEl = $(blokk).find('> h2');
    const section = $sectionEl.length ? cleanText($sectionEl.text()) : null;

    const $dl = $(blokk).find('> dl.meny');
    $dl.children().each((_, el) => {
      const $el = $(el);
      if (!$el.is('dt')) return;

      const nameRaw = $el.text();
      const name = cleanText(nameRaw);
      if (!name) return;

      let description = null;
      let $priceEl = null;

      $el.nextAll().each((_, sib) => {
        const $sib = $(sib);
        if ($sib.is('dt')) return false; // stop at next item

        if (!description && $sib.is('dd.beskrivelse')) {
          description = cleanText($sib.text());
        }
        if (!$priceEl && $sib.is('dd.pris')) {
          $priceEl = $sib;
        }
      });

      const priceStr = $priceEl ? $priceEl.text() : '';
      const price = priceStr ? parsePrice(priceStr) : null;

      const item = { section, name, description: description || null, price };
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    });
  });

  return items;
}
