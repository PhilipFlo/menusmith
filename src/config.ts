import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type Role = 'triage' | 'oracle' | 'forge' | 'escalate' | 'vision';
export type LlmMode = 'live' | 'record' | 'replay';

/**
 * Model routing — the cheapest model that can do each job well.
 *   triage  : yes/no + link picking, called many times      → Nemotron 3 Nano
 *   oracle  : read a whole menu page into structured JSON    → Nemotron 3 Super
 *   forge   : write and repair extractor code (reasoning)    → Nemotron 3 Super
 *   escalate: repairs that Super couldn't fix                 → Nemotron 3 Ultra
 * Each role has a fallback chain used when a model is unavailable or rate-limited.
 */
export const MODELS: Record<Role, string[]> = {
  triage: [
    process.env.MENUSMITH_MODEL_TRIAGE || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    'nvidia/Nemotron-3_5-Lightning',
  ],
  oracle: [
    process.env.MENUSMITH_MODEL_ORACLE || 'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/Nemotron-3-Ultra-550b-a55b',
  ],
  // Code writing starts on Super (reasoning on) and escalates to Ultra when repairs stall.
  forge: [
    process.env.MENUSMITH_MODEL_FORGE || 'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/Nemotron-3-Ultra-550b-a55b',
  ],
  escalate: [
    process.env.MENUSMITH_MODEL_ESCALATE || 'nvidia/Nemotron-3-Ultra-550b-a55b',
    'nvidia/nemotron-3-super-120b-a12b',
  ],
  // Image / scanned-PDF menus — NVIDIA's own vision-language model on Token Factory.
  vision: [process.env.MENUSMITH_MODEL_VISION || 'nvidia/Nemotron-3.5-Super-VL'],
};

/** USD per 1M tokens [input, output] — Token Factory public catalog, Oct 2026. */
export const PRICES: Record<string, [number, number]> = {
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': [0.06, 0.24],
  'nvidia/Nemotron-3_5-Lightning': [0.06, 0.24],
  'nvidia/nemotron-3-super-120b-a12b': [0.3, 0.9],
  'nvidia/Nemotron-3-Ultra-550b-a55b': [1, 3],
  'nvidia/Nemotron-3.5-Super-VL': [0.3, 0.9],
};

export const config = {
  nebiusApiKey: process.env.NEBIUS_API_KEY || '',
  nebiusBaseUrl: process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1/',
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  llmMode: (process.env.MENUSMITH_LLM as LlmMode) || 'live',
  port: Number(process.env.PORT || 8790),
  cassetteDir: resolve(process.env.MENUSMITH_CASSETTES || resolve(ROOT, 'cassettes')),
  libraryDir: resolve(process.env.MENUSMITH_LIBRARY || resolve(ROOT, 'library')),
  cacheDir: resolve(process.env.MENUSMITH_CACHE || resolve(ROOT, '.cache')),
  /** Max repair rounds after the first attempt. */
  maxRepairs: Number(process.env.MENUSMITH_MAX_REPAIRS || 4),
};

export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES[model] || [1, 3];
  return (promptTokens * p[0] + completionTokens * p[1]) / 1_000_000;
}

/** "nvidia/Nemotron-3-Ultra-550b-a55b" → "Nemotron 3 Ultra". */
export function modelName(id: string): string {
  const m = id.match(/nemotron[-_ ]?(\d(?:[._]\d)?)[-_ ]?(nano|super|ultra|lightning)?(?:[-_ ]?(vl))?/i);
  if (!m) return id.split('/').pop() || id;
  const ver = m[1]!.replace('_', '.');
  const size = m[2] ? ' ' + m[2][0]!.toUpperCase() + m[2].slice(1).toLowerCase() : '';
  return `Nemotron ${ver}${size}${m[3] ? ' VL' : ''}`;
}
