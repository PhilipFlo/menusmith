import { useId, useMemo, useState } from 'react';
import type { MenuItem } from '../api.ts';
import { price } from '../format.ts';

export function ItemsTable({ items, maxHeight = 420, caption }: { items: MenuItem[]; maxHeight?: number; caption?: string }) {
  const [q, setQ] = useState('');
  const id = useId();
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((i) => `${i.section ?? ''} ${i.name} ${i.description ?? ''}`.toLowerCase().includes(s));
  }, [items, q]);
  const sections = useMemo(() => new Set(items.map((i) => i.section || '')).size, [items]);

  return (
    <div className="items">
      <div className="items-bar">
        <label htmlFor={id} className="sr-only">
          Filter dishes
        </label>
        <input id={id} className="input input-sm" type="search" placeholder={`Filter ${items.length} dishes…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted num small">
          {filtered.length} of {items.length} · {sections} {sections === 1 ? 'section' : 'sections'}
        </span>
      </div>
      <div className="table-wrap" style={{ maxHeight }}>
        <table className="table">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              <th scope="col">Section</th>
              <th scope="col">Dish</th>
              <th scope="col" className="right">
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((it, i) => (
              <tr key={i}>
                <td className="muted">{it.section || '—'}</td>
                <td>
                  <div className="dish">{it.name}</div>
                  {it.description && <div className="dish-desc">{it.description}</div>}
                </td>
                <td className="right num nowrap">{price(it.price, it.currency)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={3} className="muted center">
                  No dishes match “{q}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
