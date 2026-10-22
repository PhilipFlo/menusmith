// One-off check: can nvidia/Nemotron-3.5-Super-VL on Token Factory read a menu image?
import 'dotenv/config';
import { chat, Ledger } from '../src/llm/client.ts';
const url = process.argv[2]!;
const res = await fetch(url);
const buf = Buffer.from(await res.arrayBuffer());
const mime = res.headers.get('content-type') || 'image/png';
console.log('image', Math.round(buf.length / 1024), 'KB', mime);
const ledger = new Ledger(0.05);
const r = await chat({
  role: 'vision', json: true, thinking: false, maxTokens: 4000, label: 'vision-check',
  messages: [
    { role: 'system', content: 'Read the restaurant menu in the image. Return JSON {"items":[{"section":string|null,"name":string,"price":number|null}]}.' },
    // @ts-expect-error multimodal content parts
    { role: 'user', content: [{ type: 'text', text: 'Menu image:' }, { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }] },
  ],
}, ledger);
const items = (r.json as any)?.items || [];
console.log(r.model, r.promptTokens, '+', r.completionTokens, 'tok', '$' + r.costUsd.toFixed(4), items.length, 'items');
console.log(items.slice(0, 6));
