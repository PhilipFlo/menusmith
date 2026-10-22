// Menusmith extractor for taqueria-luna.fixture — v2
// Source page: fixture://taqueria-luna/
// Written by nvidia/Nemotron-3-Ultra-550b-a55b in 1 round(s); f1=1 on 16 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
  const items = [];
  
  $('.shopify-section').each((i, sectionEl) => {
    const $section = $(sectionEl);
    const $grid = $section.find('ul.grid.product-grid');
    if (!$grid.length) return;
    
    const sectionTitleEl = $section.find('h2.title').first();
    if (!sectionTitleEl.length) return;
    const section = cleanText(sectionTitleEl.text());
    
    $grid.find('li.grid__item').each((j, itemEl) => {
      const $item = $(itemEl);
      
      const nameLink = $item.find('h3.card__heading a.full-unstyled-link').first();
      if (!nameLink.length) return;
      let name = cleanText(nameLink.text());
      name = name.replace(/^\d+\.\s*/, '').replace(/\s*\([\d,]+\)\s*$/, '');
      
      const descEl = $item.find('span.caption-large.light').first();
      const description = descEl.length ? cleanText(descEl.text()) : null;
      const finalDescription = description && description.length > 0 ? description : null;
      
      let priceText = '';
      const salePriceEl = $item.find('.price__sale .price-item--sale.price-item--last').first();
      if (salePriceEl.length) {
        priceText = cleanText(salePriceEl.text());
      } else {
        const regularPriceEl = $item.find('.price__regular .price-item--regular').first();
        if (regularPriceEl.length) {
          priceText = cleanText(regularPriceEl.text());
        }
      }
      const price = priceText ? parsePrice(priceText) : null;
      
      if (name) {
        items.push({ section, name, description: finalDescription, price });
      }
    });
  });
  
  return items;
}
