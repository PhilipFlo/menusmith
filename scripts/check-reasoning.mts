// Where does Token Factory put Nemotron's reasoning? Print the raw message keys.
import 'dotenv/config';
const r = await fetch('https://api.tokenfactory.nebius.com/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
  body: JSON.stringify({ model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', max_tokens: 300, messages: [{ role: 'user', content: 'Is 17 prime? One word.' }], chat_template_kwargs: { enable_thinking: true } }),
});
const j: any = await r.json();
const m = j.choices[0].message;
console.log(Object.keys(m), Object.keys(j.choices[0]));
for (const k of Object.keys(m)) console.log(k, '=>', JSON.stringify(m[k])?.slice(0, 200));
