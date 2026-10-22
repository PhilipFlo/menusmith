// Menusmith extractor for nonna-pizza.fixture — v1
// Source page: fixture://nonna-pizza/
// Written by nvidia/nemotron-3-super-120b-a12b in 2 round(s); f1=1 on 18 reference items.
// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.
// --- end menusmith header ---
function extract($, ctx) {
    const items = [];

    $('.columns h2').each((_, heading) => {
        const section = cleanText($(heading).text());

        // get all elements after this heading until the next heading,
        // then keep only the menu lists
        $(heading)
            .nextUntil('h2')
            .filter('ul.menu-list')
            .each((_, ul) => {
                $(ul)
                    .find('li')
                    .each((_, li) => {
                        const $li = $(li);
                        const $name = $li.find('.name');
                        const $desc = $li.find('.desc');
                        const $price = $li.find('.price');

                        let name = cleanText($name.text());
                        if (!name) return; // skip empty

                        // strip leading numbering like "12. "
                        name = name.replace(/^\s*\d+[\.\s]*/, '');
                        // strip trailing allergen codes like "(1,7)"
                        name = name.replace(/\s*\([^)]*\)\s*$/, '');
                        name = cleanText(name);

                        const description = $desc.length ? cleanText($desc.text()) : null;
                        const priceText = $price.length ? $price.text().trim() : '';
                        const price = priceText ? parsePrice(priceText) : null;

                        items.push({ section, name, description, price });
                    });
            });
    });

    return items;
}
