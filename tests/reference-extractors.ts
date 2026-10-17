/**
 * Hand-written reference extractors for the synthetic fixture sites, in the
 * exact contract the sandbox expects: a code string defining
 * `function extract($, ctx) { ... return [{section, name, description, price}] }`
 * with globals `parsePrice` and `cleanText`.
 *
 * `index` targets fixtures/sites/<slug>/index.html, `redesign` targets redesign.html.
 * They prove each fixture is extractable deterministically and that expected.json
 * matches the page. The `index` extractors are deliberately NOT robust to the
 * redesign — that's what drift detection is for.
 */
export const REFERENCE_EXTRACTORS: Record<string, { index: string; redesign: string }> = {
  'trattoria-sole': {
    index: `function extract($, ctx) {
  const out = [];
  $('.elementor-widget-price-list').each((_, w) => {
    const section = cleanText($(w).closest('.elementor-widget-wrap').find('.elementor-heading-title').first().text()) || null;
    $(w).find('.elementor-price-list-item').each((_, li) => {
      const $li = $(li);
      out.push({
        section,
        name: cleanText($li.find('.elementor-price-list-title').text()),
        description: cleanText($li.find('.elementor-price-list-description').text()) || null,
        price: parsePrice($li.find('.elementor-price-list-price').text()),
      });
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('.meny-kategori').each((_, s) => {
    const section = cleanText($(s).find('.wp-block-heading').first().text()) || null;
    $(s).find('.meny-rad').each((_, row) => {
      const $r = $(row);
      out.push({
        section,
        name: cleanText($r.find('.meny-rad__navn').text()),
        description: cleanText($r.find('.meny-rad__beskrivelse').text()) || null,
        price: parsePrice($r.find('.meny-rad__pris').text()),
      });
    });
  });
  return out;
}`,
  },

  'fjord-burger': {
    index: `function extract($, ctx) {
  const out = [];
  $('.menu-block .menu-section').each((_, s) => {
    const section = cleanText($(s).find('.menu-section-title').first().text()) || null;
    $(s).find('.menu-item').each((_, it) => {
      const $it = $(it);
      out.push({
        section,
        name: cleanText($it.find('.menu-item-title').text()),
        description: cleanText($it.find('.menu-item-description').text()) || null,
        // Squarespace renders the price twice (top + bottom); take one.
        price: parsePrice($it.find('.menu-item-price-top').first().text()),
      });
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('.user-items-list').each((_, s) => {
    const section = cleanText($(s).find('.list-section-title').text()) || null;
    $(s).find('.list-item').each((_, it) => {
      const $it = $(it);
      const ps = $it.find('.list-item-content__description p');
      const priceP = ps.filter((_, p) => $(p).find('strong').length > 0).first();
      const desc = ps.filter((_, p) => $(p).find('strong').length === 0).map((_, p) => $(p).text()).get().join(' ');
      out.push({
        section,
        name: cleanText($it.find('.list-item-content__title').text()),
        description: cleanText(desc) || null,
        price: parsePrice(priceP.text()),
      });
    });
  });
  return out;
}`,
  },

  'pho-hanoi-house': {
    index: `function extract($, ctx) {
  const out = [];
  $('[data-hook="section.container"]').each((_, s) => {
    const section = cleanText($(s).find('[data-hook="section.name"]').first().text()) || null;
    $(s).find('[data-hook="item.container"]').each((_, it) => {
      const $it = $(it);
      out.push({
        section,
        name: cleanText($it.find('[data-hook="item.name"]').text()),
        description: cleanText($it.find('[data-hook="item.description"]').text()) || null,
        price: parsePrice($it.find('[data-hook="item.price"]').text()),
      });
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('section.wixui-section').each((_, s) => {
    const $s = $(s);
    if (!$s.find('[data-testid="repeater"]').length) return;
    const section = cleanText($s.find('h2').first().text()) || null;
    $s.find('.wixui-repeater__item').each((_, it) => {
      const $it = $(it);
      out.push({
        section,
        name: cleanText($it.find('p span[style*="bold"]').first().text()),
        description: cleanText($it.find('p.font_9').text()) || null,
        price: parsePrice($it.find('p[style*="text-align:right"]').text()),
      });
    });
  });
  return out;
}`,
  },

  'blue-oak-bistro': {
    index: `function extract($, ctx) {
  const out = [];
  $('.menu-category').each((_, s) => {
    const section = cleanText($(s).find('.heading-menu').first().text()) || null;
    $(s).find('.w-dyn-item').each((_, it) => {
      const $it = $(it);
      out.push({
        section,
        name: cleanText($it.find('.menu-item-name').text()),
        description: cleanText($it.find('.menu-item-desc').text()) || null,
        price: parsePrice($it.find('.menu-item-price').text()), // "Glass $14 / Bottle $52" -> 14
      });
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  return $('.dish-card').map((_, it) => {
    const $it = $(it);
    return {
      section: cleanText($it.find('.dish-card__category').text()) || null,
      name: cleanText($it.find('.dish-card__title').text()),
      description: cleanText($it.find('.dish-card__body').text()) || null,
      price: parsePrice($it.find('.dish-card__price').text()),
    };
  }).get();
}`,
  },

  'kebab-kongen': {
    index: `function extract($, ctx) {
  const out = [];
  let section = null;
  $('table.meny tr').each((_, tr) => {
    const $tr = $(tr);
    if ($tr.hasClass('kategori')) { section = cleanText($tr.text()); return; }
    const $name = $tr.find('td.rett');
    if (!$name.length) return;
    out.push({
      section,
      name: cleanText($name.find('b').first().text()).replace(/^\\d+\\.\\s*/, ''),
      description: cleanText($name.find('small').text()) || null,
      price: parsePrice($tr.find('td.pris').text()),
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('.meny-kategori').each((_, s) => {
    const section = cleanText($(s).find('.meny-kategori__tittel').text()) || null;
    $(s).find('.rett').each((_, it) => {
      const $it = $(it);
      out.push({
        section,
        name: cleanText($it.find('.rett__navn').text()),
        description: cleanText($it.find('.rett__info-tekst').text()) || null,
        price: parsePrice($it.find('.rett__pris').text()),
      });
    });
  });
  return out;
}`,
  },

  'sushi-koi': {
    // Both versions read the schema.org Menu from JSON-LD (robust across the redesign).
    index: `function findMenu(node) {
  if (!node || typeof node !== 'object') return null;
  if (node['@type'] === 'Menu') return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) { const m = findMenu(v); if (m) return m; }
  return null;
}
function extract($, ctx) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data; try { data = JSON.parse($(el).text()); } catch (e) { return; }
    const menu = findMenu(data);
    if (!menu) return;
    for (const sec of menu.hasMenuSection || []) {
      for (const it of sec.hasMenuItem || []) {
        out.push({ section: sec.name || null, name: cleanText(it.name), description: it.description || null, price: parsePrice(it.offers && it.offers.price) });
      }
    }
  });
  return out;
}`,
    redesign: '',
  },

  'cafe-loft': {
    index: `function extract($, ctx) {
  const out = [];
  $('.meny-blokk').each((_, s) => {
    const section = cleanText($(s).find('h2').first().text()) || null;
    let cur = null;
    $(s).find('dl.meny').children().each((_, el) => {
      const $el = $(el);
      if (el.tagName === 'dt') { cur = { section, name: cleanText($el.text()), description: null, price: null }; out.push(cur); }
      else if (cur && $el.hasClass('beskrivelse')) cur.description = cleanText($el.text()) || null;
      else if (cur && $el.hasClass('pris')) cur.price = parsePrice($el.text()); // "Dagens pris" -> null
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('.menu-section').each((_, s) => {
    const section = cleanText($(s).find('.menu-section__heading').text()) || null;
    $(s).find('.menu-list__item').each((_, it) => {
      const $it = $(it);
      out.push({
        section,
        name: cleanText($it.find('.item-name').text()),
        description: cleanText($it.find('.item-desc').text()) || null,
        price: parsePrice($it.find('.item-price').text()),
      });
    });
  });
  return out;
}`,
  },

  'taqueria-luna': {
    index: `function extract($, ctx) {
  const out = [];
  $('.shopify-section').each((_, s) => {
    const $s = $(s);
    const grid = $s.find('ul.product-grid');
    if (!grid.length) return;
    const section = cleanText($s.find('h2.title').first().text()) || null;
    grid.children('li.grid__item').each((_, li) => {
      const $li = $(li);
      out.push({
        section,
        // Dawn renders the heading twice per card; the h5 one is the visible card title.
        name: cleanText($li.find('.card__heading.h5').first().text()),
        description: null,
        price: parsePrice($li.find('.price__regular .price-item--regular').first().text()),
      });
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('.featured-collection').each((_, s) => {
    const section = cleanText($(s).find('.section-header__title').text()) || null;
    $(s).find('.product-item').each((_, it) => {
      const $it = $(it);
      out.push({ section, name: cleanText($it.find('.product-item__title').text()), description: null, price: parsePrice($it.find('.price').text()) });
    });
  });
  return out;
}`,
  },

  'bao-street': {
    index: `function extract($, ctx) {
  const out = [];
  let section = null;
  $('#meny').children().each((_, el) => {
    const $el = $(el);
    if (el.tagName === 'h3') { section = cleanText($el.text()); return; }
    if (el.tagName !== 'p' || !$el.find('strong').length) return;
    const name = cleanText($el.find('strong').first().text());
    const price = parsePrice($el.find('em').last().text());
    const c = $el.clone(); c.find('strong, em').remove();
    const description = cleanText(c.text()).replace(/^[—–-]\\s*/, '') || null;
    out.push({ section, name, description, price });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('.menu-block').each((_, s) => {
    const section = cleanText($(s).find('.menu-block__title').text()) || null;
    $(s).find('.menu-entry').each((_, it) => {
      const $it = $(it);
      out.push({ section, name: cleanText($it.find('.entry-name').text()), description: cleanText($it.find('.entry-desc').text()) || null, price: parsePrice($it.find('.entry-price').text()) });
    });
  });
  return out;
}`,
  },

  'nonna-pizza': {
    index: `function extract($, ctx) {
  const out = [];
  $('.columns h2').each((_, h) => {
    const section = cleanText($(h).text());
    $(h).next('ul.menu-list').children('li').each((_, li) => {
      const $li = $(li);
      out.push({
        section,
        name: cleanText($li.find('.name').text()).replace(/\\s*\\([\\d,\\s]+\\)\\s*$/, ''), // strip allergens "(1,7)"
        description: cleanText($li.find('.desc').text()) || null,
        price: parsePrice($li.find('.price').text()),
      });
    });
  });
  return out;
}`,
    redesign: `function extract($, ctx) {
  const out = [];
  $('.menu-card').each((_, s) => {
    const section = cleanText($(s).find('.card-title').text()) || null;
    $(s).find('.card-line').each((_, it) => {
      const $it = $(it);
      out.push({ section, name: cleanText($it.find('b.dish').text()), description: cleanText($it.find('small.dish-note').text()) || null, price: parsePrice($it.find('em.cost').text()) });
    });
  });
  return out;
}`,
  },
};
REFERENCE_EXTRACTORS['sushi-koi']!.redesign = REFERENCE_EXTRACTORS['sushi-koi']!.index;
