/** Small display helpers shared by every screen. */

export function usd(n: number | null | undefined, digits = 4): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return `$${v.toFixed(digits)}`;
}

export function int(n: number | null | undefined): string {
  return typeof n === 'number' && isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

export function duration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  return typeof n === 'number' && isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—';
}

export function score(n: number | null | undefined): string {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(2) : '—';
}

export function price(n: number | null | undefined, currency?: string | null): string {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const s = Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86_400 * 14) return `${Math.round(s / 86_400)} d ago`;
  return date(iso);
}

/** "nvidia/Nemotron-3-Ultra-550b-a55b" → "Nemotron 3 Ultra". */
export function modelName(model: string | null | undefined): string {
  if (!model) return '—';
  const m = model.toLowerCase();
  if (m.includes('vl')) return 'Nemotron 3.5 Super VL';
  if (m.includes('lightning')) return 'Nemotron 3.5 Lightning';
  if (m.includes('nano')) return 'Nemotron 3 Nano';
  if (m.includes('ultra')) return 'Nemotron 3 Ultra';
  if (m.includes('super')) return 'Nemotron 3 Super';
  return model.replace(/^.*\//, '');
}

/** Tier used for colour-coding model chips. */
export function modelTier(model: string | null | undefined): 'nano' | 'super' | 'ultra' | 'other' {
  const m = (model || '').toLowerCase();
  if (m.includes('nano') || m.includes('lightning')) return 'nano';
  if (m.includes('ultra')) return 'ultra';
  if (m.includes('super')) return 'super';
  return 'other';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${int(n)} ${n === 1 ? one : many}`;
}
