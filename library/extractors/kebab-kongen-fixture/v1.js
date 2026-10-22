// Menusmith extractor for kebab-kongen.fixture — v1
// Source page: fixture://kebab-kongen/
// Written by nvidia/nemotron-3-super-120b-a12b in 1 round(s); f1=1 on 22 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
    const items = [];
    let currentSection = null;

    // Locate the menu table body as described in the prompt
    const $menu = $('body > center > table#hoved > tbody > tr > td > table.meny > tbody');
    if (!$menu.length) return items; // fallback: try a broader selector
    if (!$menu.find('tr').length) {
        // If the specific selector fails, try to find any table with class 'meny'
        const $alt = $('table.meny tbody');
        if ($alt.length) $menu = $alt;
        else return items;
    }

    $menu.find('tr').each((_, tr) => {
        const $tr = $(tr);

        // Detect category/header rows
        if ($tr.hasClass('kategori')) {
            const txt = cleanText($tr.text());
            if (txt) currentSection = txt;
            return;
        }

        // Process menu item rows: they contain both .rett and .pris cells
        const $rett = $tr.find('td.rett');
        const $pris = $tr.find('td.pris');
        if (!$rett.length || !$pris.length) return;

        // ---- Name ----
        const $nameEl = $rett.find('b');
        let rawName = $nameEl ? $nameEl.text() : '';
        // Remove leading numbering like "1. "
        rawName = rawName.replace(/^\s*\d+\.\s*/, '');
        // Remove trailing allergen codes like "(1,7)"
        rawName = rawName.replace(/\s*\([^)]*\)$/g, '');
        const name = cleanText(rawName);
        if (!name) return; // skip items with empty name

        // ---- Description ----
        const $descEl = $rett.find('small');
        let description = $descEl ? cleanText($descEl.text()) : null;
        if (description === '') description = null;

        // ---- Price ----
        const priceStr = $pris.text();
        const price = parsePrice(priceStr); // parsePrice returns first price or null

        items.push({
            section: currentSection !== null ? currentSection : null,
            name,
            description: description ?? null,
            price
        });
    });

    // Deduplicate exact repeats (e.g., mobile + desktop copies)
    const seen = new Set();
    const unique = [];
    for (const itm of items) {
        const key = `${itm.section || ''}|${itm.name}|${itm.description || ''}|${itm.price !== null ? itm.price : ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(itm);
        }
    }
    return unique;
}
