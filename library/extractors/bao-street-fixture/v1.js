// Menusmith extractor for bao-street.fixture — v1
// Source page: fixture://bao-street/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 13 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const $meny = $('#meny');
  let currentSection = null;
  const items = [];
  const seen = new Set();

  $meny.find('h3, p').each(function () {
    const $el = $(this);
    if ($el.is('h3')) {
      currentSection = cleanText($el.text());
      return;
    }
    if (!$el.is('p')) return;

    const $strong = $el.find('strong');
    if (!$strong.length) return;

    const name = cleanText($strong.text());
    if (!name) return;

    const $em = $el.find('em');
    const priceRaw = $em.text();
    const price = parsePrice(priceRaw);

    // description: clone p, strip strong and em, get remaining text
    const $clone = $el.clone();
    $clone.find('strong, em').remove();
    let desc = cleanText($clone.text());
    if (desc) {
      // remove leading dash/unicode dash and spaces
      desc = desc.replace(/^[\u2014\-–]\s*/, '');
      if (desc === '') desc = null;
    } else {
      desc = null;
    }

    const section = currentSection !== null ? currentSection : null;
    const key = `${section}|${name}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      section,
      name,
      description: desc,
      price
    });
  });

  return items;
}
