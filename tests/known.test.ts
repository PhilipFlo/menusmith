import { describe, expect, it } from 'vitest';
import { knownExtractor } from '../src/agent/pipeline.ts';
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
  });
  it('unknown sites and junk input are not matched', () => {
    expect(knownExtractor('https://example.com/', lib)).toBeNull();
    expect(knownExtractor('not a url', lib)).toBeNull();
  });
});
