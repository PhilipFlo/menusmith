// Minimal, near-free checks of the Token Factory API shape (model list, thinking toggle, JSON mode) and Tavily.
import 'dotenv/config';
import OpenAI from 'openai';
const c = new OpenAI({ baseURL: 'https://api.tokenfactory.nebius.com/v1/', apiKey: process.env.NEBIUS_API_KEY });
const models = await c.models.list();
console.log('nvidia models:', models.data.map((m) => m.id).filter((id) => /nvidia/i.test(id)));
const nano = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
for (const thinking of [false, true]) {
  const t0 = Date.now();
  const r: any = await c.chat.completions.create({
    model: nano, max_tokens: thinking ? 400 : 60, temperature: 0.2,
    messages: [{ role: 'user', content: 'Return JSON {"price": <number>} for the Norwegian price "kr 1 290,-".' }],
    response_format: { type: 'json_object' },
    // @ts-ignore vendor extension
    chat_template_kwargs: { enable_thinking: thinking },
  });
  const m = r.choices[0].message;
  console.log(`thinking=${thinking} ${Date.now() - t0}ms usage=${JSON.stringify(r.usage)} content=${JSON.stringify(m.content).slice(0, 160)} reasoning_content=${m.reasoning_content ? m.reasoning_content.length + ' chars' : 'none'}`);
}
const tv = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, body: JSON.stringify({ query: 'Villa Paradiso Frogner Oslo restaurant menu', max_results: 3 }) });
const tj: any = await tv.json();
console.log('tavily', tv.status, (tj.results || []).map((r: any) => r.url));
