// /api/_lib.js — shared helpers for Braggy edge functions.
//
// Auth token flow:
//   /api/analyze runs the full abuse gauntlet (Turnstile, IP + fingerprint rate
//   limits, daily cap). When a request passes, it issues a short-lived signed
//   token in the `X-Braggy-Token` response header. /api/analyze-full and
//   /api/rewrite-bullets require that token, so they inherit analyze's abuse
//   protection without re-running Turnstile (Cloudflare tokens are single-use,
//   so the parallel/full calls can't re-verify the same turnstile_token).
//
// Token format: "<expiryMs>.<hex hmac-sha256 of expiryMs>". Stateless — no DB
// lookup, verifiable on any edge instance. Leaking one token only extends a
// single legit user's access until expiry; it cannot mint new tokens.

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — covers editor sessions and re-downloads

function tokenSecret() {
  // Dedicated secret if set; fall back to the Anthropic key so the flow works
  // with zero extra Vercel config. HMAC never reveals its key.
  return process.env.TOKEN_SECRET || process.env.ANTHROPIC_API_KEY || '';
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function signToken() {
  const secret = tokenSecret();
  if (!secret) return '';
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return `${exp}.${await hmacHex(secret, exp)}`;
}

export async function verifyToken(token) {
  const secret = tokenSecret();
  if (!secret || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = await hmacHex(secret, exp);
  if (sig.length !== expected.length) return false;
  // Constant-time-ish compare; not strictly necessary for HMAC but cheap
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function isDevRequest(body) {
  return Boolean(
    body && body.dev_key && process.env.DEV_KEY && body.dev_key === process.env.DEV_KEY
  );
}

// Anthropic SSE stream → plain-text stream of text deltas.
// Buffers across chunks so SSE lines split at chunk boundaries are not dropped,
// and flushes the TextDecoder to handle multibyte chars at stream end.
export function sseToTextStream(upstreamBody) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  const enqueueLine = (line, controller) => {
    if (!line.startsWith('data: ')) return;
    const jsonStr = line.slice(6).trim();
    if (!jsonStr || jsonStr === '[DONE]') return;
    try {
      const event = JSON.parse(jsonStr);
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        controller.enqueue(encoder.encode(event.delta.text));
      }
    } catch {}
  };

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';
      for (const line of lines) enqueueLine(line, controller);
    },
    flush(controller) {
      sseBuffer += decoder.decode();
      enqueueLine(sseBuffer, controller);
    },
  });

  upstreamBody.pipeTo(writable).catch(() => {});
  return readable;
}
