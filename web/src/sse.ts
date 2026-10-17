/**
 * Minimal, robust Server-Sent Events client for POST endpoints.
 * EventSource only supports GET, so we read the response body as a stream and
 * parse the text/event-stream framing ourselves (per the WHATWG spec):
 *   - lines end in \n, \r\n or \r
 *   - "event:" sets the event name, "data:" lines are joined with \n, "id:" sets the id
 *   - lines starting with ":" are comments
 *   - a blank line dispatches the event (events without data are dropped)
 */

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export interface SseParser {
  push(chunk: string): void;
  end(): void;
}

export function createSseParser(onMessage: (m: SseMessage) => void): SseParser {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  let sawCR = false;

  const dispatch = () => {
    if (data.length) onMessage({ event: event || 'message', data: data.join('\n'), id });
    event = '';
    data = [];
  };

  const line = (l: string) => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    // "retry" and unknown fields are ignored.
  };

  return {
    push(chunk: string) {
      // A "\r\n" pair may be split across chunks: drop a leading "\n" right after a trailing "\r".
      if (sawCR && chunk.startsWith('\n')) chunk = chunk.slice(1);
      sawCR = false;
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '\n' || ch === '\r') {
          line(buffer.slice(start, i));
          if (ch === '\r') {
            if (i + 1 < buffer.length) {
              if (buffer[i + 1] === '\n') i++;
            } else {
              sawCR = true;
            }
          }
          start = i + 1;
        }
      }
      buffer = buffer.slice(start);
    },
    end() {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    },
  };
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * POST JSON and stream the SSE response. Resolves when the stream ends.
 * Non-streaming error responses ({error} JSON) are thrown as HttpError.
 */
export async function postSse(
  url: string,
  body: unknown,
  onMessage: (m: SseMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/event-stream')) {
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) message = j.error;
    } catch {
      /* not JSON */
    }
    throw new HttpError(message, res.status);
  }
  if (!res.body) throw new HttpError('The server returned an empty stream', res.status);

  const parser = createSseParser(onMessage);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) parser.push(value);
    }
    parser.end();
  } finally {
    reader.releaseLock();
  }
}

/** Parse an SSE data payload as JSON, returning null on malformed input. */
export function parseData<T>(m: SseMessage): T | null {
  try {
    return JSON.parse(m.data) as T;
  } catch {
    return null;
  }
}
