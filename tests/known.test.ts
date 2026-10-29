import { describe, expect, it } from 'vitest';
import { knownExtractor, mentionsBrand } from '../src/agent/pipeline.ts';
import type { StoredExtractor } from '../src/library/store.ts';

const x = (id: string, url: string, domain: string) => ({ meta: { id, url, domain }, code: '' }) as unknown as StoredExtractor;
const lib = [
  x('franklinbbq-com', 'https://franklinbbq.com/menu', 'franklinbbq.com'),
  x('joejuice-com-store-206', 'https://www.joejuice.com/store/206', 'joejuice.com'),
  x('semeny-no-sted-634damaskushusetrestaurant', 'https://semeny.no/sted/634damaskushusetrestaurant', 'semeny.no'),
  x('kinnara-no', 'https://www.kinnara.no/s/menu.pdf', 'kinnara.no'),
  x('kinnara-no-s-menu-pdf', 'https://www.kinnara.no/s/menu.pdf', 'kinnara.no'),
];

describe('library-first answers', () => {
  it('a one-restaurant domain matches from any of its pages', () => {
    expect(knownExtractor('https://www.franklinbbq.com/', lib)?.meta.id).toBe('franklinbbq-com');
    expect(knownExtractor('http://franklinbbq.com/menu/', lib)?.meta.id).toBe('franklinbbq-com');
  });
  it('a location page on a shared host needs the same path', () => {
    expect(knownExtractor('https://www.joejuice.com/Store/206/', lib)?.meta.id).toBe('joejuice-com-store-206');
    expect(knownExtractor('https://www.joejuice.com/store/300', lib)).toBeNull();
    expect(knownExtractor('https://semeny.no/sted/999other', lib)).toBeNull();
    // A bare homepage with exactly one menu saved for the site.
    expect(knownExtractor('https://peterluger.com/', [...lib, x('peterluger-com-pages-menus', 'https://peterluger.com/pages/menus', 'peterluger.com')])?.meta.id).toBe('peterluger-com-pages-menus');
    expect(knownExtractor('https://semeny.no/', lib)).toBeNull();
  });
  it('unknown sites and junk input are not matched', () => {
    expect(knownExtractor('https://example.com/', lib)).toBeNull();
    expect(knownExtractor('not a url', lib)).toBeNull();
  });
});

describe('public listing must name the restaurant', () => {
  it('matches domain brands against how listings write the name', () => {
    expect(mentionsBrand('Joe & The Juice — Menu & Prices', 'joejuice')).toBe(true);
    expect(mentionsBrand("Lou & Herbert's menu", 'louandherberts')).toBe(true);
    expect(mentionsBrand('Zuni Café, San Francisco', 'zunicafe')).toBe(true);
    expect(mentionsBrand("Katz's Delicatessen prices", 'katzsdeli')).toBe(true);
    expect(mentionsBrand('Alex Sushi Aker Brygge — meny', 'Alex Sushi')).toBe(true);
    expect(mentionsBrand('https://cdn.example/tcolv-hattiebs-menu.pdf', "Hattie B's Hot Chicken")).toBe(true);
  });
  it('rejects another restaurant’s listing', () => {
    expect(mentionsBrand('Golden Gate Pizza menu $12.99', 'no such restaurant xyz 123')).toBe(false);
    expect(mentionsBrand('Tony’s Pizza Napoletana menu', 'joespizza')).toBe(false);
    expect(mentionsBrand('anything', 'ab')).toBe(false);
    expect(mentionsBrand('Peter Pan Diner menu', 'Peter Luger Steak House')).toBe(false);
  });
});
