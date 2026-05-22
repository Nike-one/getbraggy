// /api/unlock.js — Vercel serverless function (Edge runtime)
// Captures email after the user has seen the free preview and gates the rest of the
// analysis behind it. Uses the existing `users` table + `increment_user_uses` RPC,
// so the 1-per-email rule that used to live on /api/analyze.js now lives here.

import { isDisposableEmail } from './_disposable-domains.js';

export const config = {
  runtime: 'edge',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const { email } = body;

  // Dev bypass — same pattern as /api/analyze.js. See comments there for setup.
  const isDev =
    body.dev_key &&
    process.env.DEV_KEY &&
    body.dev_key === process.env.DEV_KEY;

  // Kill switch — bypassed in dev mode so testing still works while the site is "off"
  if (!isDev && process.env.BRAGGY_ACTIVE === 'false') {
    return new Response(
      JSON.stringify({ error: 'capacity', message: "We're at capacity right now. Try again soon." }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!email || !EMAIL_RE.test(email)) {
    return new Response(
      JSON.stringify({ error: 'Please enter a valid email address.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Disposable email block — same list analyze.js uses
  if (isDisposableEmail(email)) {
    return new Response(
      JSON.stringify({ error: 'Please use a real email — we block temporary email services to keep this fair for everyone.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 1-per-email enforcement — has this email already unlocked?
  // Skipped in dev mode so the same test email can unlock repeatedly.
  if (!isDev) {
    try {
      const checkRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=uses_count`,
        {
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          },
        }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows.length > 0 && rows[0].uses_count >= 1) {
          // Already unlocked — allow re-download, skip the increment.
          return new Response(
            JSON.stringify({ ok: true, already_unlocked: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    } catch (e) {
      console.error('unlock check failed', e);
      // If the check fails, allow the unlock — don't block legit users on a Supabase blip.
    }
  }

  // Record the unlock — atomic insert/increment via the same RPC analyze.js used to call.
  // After this, this email's uses_count is 1, so the next /api/unlock with the same email
  // will hit the 429 above. Skipped in dev mode so dev test emails don't fill the table.
  if (!isDev) {
    try {
      const supaRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/increment_user_uses`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ user_email: email }),
        }
      );
      if (!supaRes.ok) {
        const errBody = await supaRes.text();
        console.error('unlock rpc failed', supaRes.status, errBody);
        // Soft-fail: we still unlock the UI even if the write didn't land. The user already
        // received their free analysis from /api/analyze; gating the reveal on a Supabase
        // hiccup would be worse UX than letting one extra unlock slip through.
      }
    } catch (e) {
      console.error('unlock rpc threw', e);
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
