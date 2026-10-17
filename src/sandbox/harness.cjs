'use strict';
/**
 * Sandbox harness — runs ONE model-written extractor against ONE page.
 *
 * Launched by runner.ts as a separate Node process with:
 *   - an EMPTY environment (no API keys exist in this process to leak),
 *   - Node's permission model: no fs writes, no child processes, no workers,
 *     fs reads limited to this directory and node_modules,
 *   - a heap cap and a wall-clock kill from the parent.
 * Inside, the code runs in a fresh vm context that only sees `$` (cheerio),
 * `ctx`, and two pure helpers, with a CPU timeout.
 *
 * Two modes:
 *   html — extract($, ctx): $ is a cheerio root for the page
 *   json — extract(data, ctx): data is the parsed menu API response
 *
 * Protocol: JSON on stdin {code, html|json, url, mode}; one JSON line on stdout
 * {ok, items?, error?, ms}.
 */
const vm = require('node:vm');
const cheerio = require('cheerio');
const { parsePrice, cleanText } = require('./helpers.cjs');

const CPU_TIMEOUT_MS = 4000;
const MAX_ITEMS = 3000;

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Validation of the extractor's return value. Kept as SOURCE and evaluated inside
 * the vm context (see main) so it runs under the CPU timeout and on the context's
 * own intrinsics. Returns a JSON string of plain {section,name,description,price}.
 */
const SANITIZE_SRC = `function (raw, max) {
  if (!Array.isArray(raw)) throw new Error('extract() must return an array, got ' + typeof raw);
  var clean = function (v, n) { return typeof v === 'string' ? v.replace(/\\s+/g, ' ').trim().slice(0, n) : (typeof v === 'number' && isFinite(v) ? String(v).slice(0, n) : ''); };
  var out = [];
  for (var i = 0; i < raw.length && out.length < max; i++) {
    var it = raw[i];
    if (!it || typeof it !== 'object') continue;
    var name = clean(it.name, 200);
    if (!name) continue;
    var price = it.price;
    if (typeof price === 'string') price = parsePrice(price);
    if (typeof price !== 'number' || !isFinite(price)) price = null;
    out.push({ section: clean(it.section, 120) || null, name: name, description: clean(it.description, 500) || null, price: price, currency: clean(it.currency, 8) || null });
  }
  return JSON.stringify(out);
}`;

/**
 * "TypeError: Cannot read properties of undefined (reading 'text') at extractor.js:14:22"
 * — the message plus where in the GENERATED code it happened (line numbers are
 * offset by the one-line prelude), which is what the repair prompt needs.
 */
function describeError(e) {
  if (!e) return 'unknown error';
  const head = `${e.name || 'Error'}: ${e.message || String(e)}`;
  const stack = String(e.stack || '');
  const loc = stack.match(/extractor\.js:(\d+)(?::(\d+))?/);
  if (loc) {
    const line = Number(loc[1]) - 1;
    return `${head} (at line ${line}${loc[2] ? ', col ' + loc[2] : ''} of your code)`;
  }
  return head;
}

/**
 * Execution trace for the agent's debugger: every selector call the extractor makes,
 * with how many elements went in and came out. "find('> li.item') 0 of 12 calls
 * returned anything" pinpoints a wrong nesting assumption immediately.
 */
let lastTrace = null;
const TRACED = ['find', 'children', 'filter', 'closest', 'parents', 'parent', 'siblings', 'next', 'prev', 'nextAll', 'prevAll', 'nextUntil', 'prevUntil', 'not', 'has'];
function instrument($) {
  const stats = new Map();
  lastTrace = stats;
  for (const m of TRACED) {
    const orig = $.fn[m];
    if (typeof orig !== 'function') continue;
    $.fn[m] = function (sel, ...rest) {
      const out = orig.call(this, sel, ...rest);
      if (typeof sel === 'string') {
        const isRoot = this.length === 1 && this[0] && this[0].type === 'root';
        const key = isRoot && m === 'find' ? `$(${JSON.stringify(sel)})` : `.${m}(${JSON.stringify(sel)})`;
        const st = stats.get(key) || { calls: 0, empty: 0, inEls: 0, outEls: 0 };
        st.calls++;
        st.inEls += this.length;
        st.outEls += out.length;
        if (out.length === 0) st.empty++;
        stats.set(key, st);
      }
      return out;
    };
  }
  return stats;
}

function summarizeTrace(stats) {
  if (!stats || !stats.size) return undefined;
  return [...stats.entries()]
    .slice(0, 40)
    .map(([k, st]) =>
      st.calls === 1
        ? `${k} → ${st.outEls} element(s)`
        : `${k} called ${st.calls}× on ${st.inEls} element(s) → ${st.outEls} total${st.empty ? `, ${st.empty} call(s) returned nothing` : ''}`,
    );
}

async function main() {
  const t0 = Date.now();
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'bad input: ' + e.message, ms: 0 }) + '\n');
    return;
  }
  try {
    const isJson = input.mode === 'json';
    const sandbox = {
      ctx: Object.freeze({ url: String(input.url || '') }),
      parsePrice,
      cleanText,
      __result: undefined,
    };
    let trace = null;
    if (isJson) sandbox.data = JSON.parse(input.json || 'null');
    else {
      const $ = cheerio.load(input.html || '');
      trace = instrument($);
      sandbox.$ = $;
    }
    vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    // Remove binary buffers from the context: they allocate off-heap memory that
    // --max-old-space-size does not cap. Menu extraction never needs them.
    new vm.Script(
      ['ArrayBuffer', 'SharedArrayBuffer', 'Atomics', 'WebAssembly', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']
        .map((n) => `try { delete globalThis.${n}; } catch (e) {}`)
        .join('\n'),
    ).runInContext(sandbox);
    // The model's code AND the sanitising/serialising of its result run inside the
    // context under the CPU timeout, so getters, Proxies or toJSON hooks it defines
    // can never run on the host side. The host only ever receives a string.
    const script = new vm.Script(
      `"use strict";\n${input.code}\n;__result = (${SANITIZE_SRC})(extract(${isJson ? 'data' : '$'}, ctx), ${MAX_ITEMS});`,
      { filename: 'extractor.js' },
    );
    script.runInContext(sandbox, { timeout: CPU_TIMEOUT_MS });
    if (typeof sandbox.__result !== 'string') throw new Error('extractor result could not be serialised');
    const items = JSON.parse(sandbox.__result);
    process.stdout.write(JSON.stringify({ ok: true, items, ms: Date.now() - t0, trace: summarizeTrace(trace) }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: describeError(e), ms: Date.now() - t0, trace: summarizeTrace(lastTrace) }) + '\n');
  }
}

main();
