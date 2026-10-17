import { useEffect, useState } from 'react';

/** Hash router: #/forge (default), #/library, #/library/:id, #/fleet, #/about. */
export interface Route {
  page: 'forge' | 'library' | 'extractor' | 'fleet' | 'about' | 'notfound';
  id?: string;
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const [head, ...rest] = path.split('/');
  switch (head) {
    case '':
    case 'forge':
      return { page: 'forge' };
    case 'library':
      return rest.length ? { page: 'extractor', id: decodeURIComponent(rest.join('/')) } : { page: 'library' };
    case 'fleet':
      return { page: 'fleet' };
    case 'about':
      return { page: 'about' };
    default:
      return { page: 'notfound' };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const href = {
  forge: '#/forge',
  library: '#/library',
  extractor: (id: string) => `#/library/${encodeURIComponent(id)}`,
  fleet: '#/fleet',
  about: '#/about',
};
