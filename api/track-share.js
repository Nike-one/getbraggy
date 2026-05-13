// /api/track-share.js — Vercel serverless function (Edge runtime)
// Logs share events to Supabase so we can measure virality per score bucket.
// Fully optional — share-roast.js works without this endpoint (it fire-and-forgets).
//
// Required Supabase table (see SQL in INTEGRATION.md):
//   share_events (id, channel, score, created_at)

export const config = {
  runtime: 'edge',
};

const VALID_CHANNELS = new Set(['native', 'x', 'linkedin', 'copy']);

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { channel, score } = body;

  // Validate — silently 204 on bad input rather than 4xx, since this is fire-and-forget
  // from the client and we don't want console noise on edge cases.
  if (!VALID_CHANNELS.has(channel)) {
    return new Response(null, { status: 204 });
  }
  const n = Number(score);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return new Response(null, { status: 204 });
  }

  // Best-effort insert. If Supabase is down, we still return 204 — the user already
  // shared, no point surfacing the error to the client.
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/share_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ channel, score: Math.round(n) }),
    });
  } catch (e) {
    console.error('track-share insert failed', e);
  }

  return new Response(null, { status: 204 });
}
