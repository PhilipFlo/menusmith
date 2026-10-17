import { z } from 'zod';
import { chat, type Ledger } from '../llm/client.ts';
import type { Emit, MenuItem } from '../types.ts';
import { normName } from './evaluate.ts';

/**
 * JUDGE: when an extractor returns items the oracle didn't list but that do occur
 * on the page, Nemotron Nano decides for each one: a real dish the oracle missed,
 * or junk (a promo banner, a combo teaser, opening hours, a heading)?
 * Returns the normalised names judged NOT to be menu items.
 */

const Verdicts = z.object({ verdicts: z.array(z.object({ i: z.number(), dish: z.boolean() })) });

function context(text: string, name: string, span = 160): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(name.toLowerCase().slice(0, 40));
  if (at < 0) return '';
  return text.slice(Math.max(0, at - span), at + name.length + span).replace(/\s+/g, ' ');
}

export async function judgeExtras(items: MenuItem[], pageText: string, ledger: Ledger, emit?: Emit): Promise<Set<string>> {
  if (!items.length) return new Set();
  const list = items.slice(0, 20).map((it, i) => ({ i, name: it.name, price: it.price, context: context(pageText, it.name) }));
  const r = await chat(
    {
      role: 'triage',
      label: 'judge',
      json: true,
      thinking: false,
      maxTokens: 800,
      messages: [
        {
          role: 'system',
          content:
            'You check items scraped from a restaurant menu page. For each, decide if it is a real orderable dish or drink listed on the menu (dish:true), or NOT (dish:false: a promotion/combo banner repeated outside the menu, a section heading, opening hours, an address, a newsletter or cookie text, a duplicate with garbled text). Return JSON {"verdicts":[{"i":0,"dish":true},…]} covering every item.',
        },
        { role: 'user', content: JSON.stringify(list) },
      ],
    },
    ledger,
    emit,
  );
  const parsed = Verdicts.safeParse(r.json);
  const rejected = new Set<string>();
  if (!parsed.success) return rejected;
  for (const v of parsed.data.verdicts) if (!v.dish && list[v.i]) rejected.add(normName(list[v.i]!.name));
  return rejected;
}
