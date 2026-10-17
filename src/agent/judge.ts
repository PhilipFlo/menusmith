import { z } from 'zod';
import { chat, type Ledger } from '../llm/client.ts';
import type { Emit, MenuItem } from '../types.ts';
import { normName } from './evaluate.ts';

/**
 * ARBITRATION: the oracle (an LLM reading) and the extractor (code) can disagree
 * about what counts as a menu item — add-on options, combo banners, a dish the
 * oracle skimmed past. When they do, Nemotron Nano rules on each disputed item:
 * an orderable dish or drink, or not?
 *
 *   - items only the extractor found:  accepted → added to the reference (the oracle missed them)
 *                                      rejected → stay errors for the extractor
 *   - items only the oracle listed:     rejected → removed from the reference (the oracle over-reached)
 *                                      accepted → stay as misses for the extractor
 */

const Verdicts = z.object({ verdicts: z.array(z.object({ i: z.number(), dish: z.boolean() })) });

function context(text: string, name: string, span = 140): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(name.toLowerCase().replace(/\s*\(duplicate\)$/, '').slice(0, 40));
  if (at < 0) return '';
  return text.slice(Math.max(0, at - span), at + name.length + span).replace(/\s+/g, ' ');
}

export interface Arbitration {
  /** Normalised names ruled NOT to be dishes. */
  rejected: Set<string>;
  /** Extractor-only items ruled to be real dishes (the oracle missed them). */
  accepted: MenuItem[];
  disputed: number;
}

const MAX_DISPUTED = 90;

export async function arbitrate(
  extractorOnly: MenuItem[],
  oracleOnly: MenuItem[],
  pageText: string,
  ledger: Ledger,
  emit?: Emit,
): Promise<Arbitration> {
  const ex = extractorOnly.filter((i) => !/\(duplicate\)$/.test(i.name)).slice(0, Math.ceil(MAX_DISPUTED / 2));
  const or = oracleOnly.slice(0, MAX_DISPUTED - ex.length);
  const list = [...ex.map((it) => ({ it, from: 'code' as const })), ...or.map((it) => ({ it, from: 'reading' as const }))];
  if (!list.length) return { rejected: new Set(), accepted: [], disputed: 0 };

  const r = await chat(
    {
      role: 'triage',
      label: 'arbitrate',
      json: true,
      thinking: false,
      maxTokens: 2500,
      messages: [
        {
          role: 'system',
          content:
            'Two readers of a restaurant menu disagree about some items. For each item decide: is it an orderable dish or drink on the menu (dish:true), or NOT (dish:false) — e.g. an add-on/option/modifier that only exists as a choice inside another dish (extra sauce, size, protein choice, "Ekstra …" with price 0 or as a sub-choice), a promotion banner, a heading, opening hours, garbled duplicate text. Standalone sides and drinks that can be ordered on their own ARE dishes. Return JSON {"verdicts":[{"i":0,"dish":true},…]} for every item.',
        },
        {
          role: 'user',
          content: JSON.stringify(list.map(({ it }, i) => ({ i, section: it.section ?? null, name: it.name, price: it.price, context: context(pageText, it.name) }))),
        },
      ],
    },
    ledger,
    emit,
  );
  const parsed = Verdicts.safeParse(r.json);
  const rejected = new Set<string>();
  const accepted: MenuItem[] = [];
  if (!parsed.success) return { rejected, accepted, disputed: list.length };
  for (const v of parsed.data.verdicts) {
    const entry = list[v.i];
    if (!entry) continue;
    if (!v.dish) rejected.add(normName(entry.it.name));
    else if (entry.from === 'code') accepted.push(entry.it);
  }
  return { rejected, accepted, disputed: list.length };
}
