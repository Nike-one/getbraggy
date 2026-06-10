// /api/analyze.js — Vercel serverless function
// Proxies Anthropic API and records user activity in Supabase.
// API key is read from process.env.ANTHROPIC_API_KEY (set in Vercel dashboard).

import { isDisposableEmail } from './_disposable-domains.js';
import { signToken, sseToTextStream } from './_lib.js';

// Daily platform-wide cap — protects against viral spikes
const DAILY_CAP = 30;

export const config = {
  runtime: 'edge',
};

const SYSTEM_PROMPT = `You are Braggy — a brutally honest recruiter-perception engine for Indian professionals. The user will paste their résumé. Return JSON only, no preamble, no markdown.

Your job:

1. SCORE the résumé 0-100 using four sub-scores (each 0-25):
   A. SPECIFICITY: concrete numbers, percentages, scope, named tools per bullet.
   B. ACTION-ORIENTATION: strong action verbs vs "responsible for"/"worked on"/passive.
   C. OUTCOME-ORIENTATION: measurable result vs task list.
   D. DENSITY: filler-free, no buzzwords, no redundancy.
   Compute each independently. Sum = total. Weak résumé scores 20-40, good 70-95, exceptional 95+.

   score_reason format: cite sub-scores then one recruiter implication. Example: "Specificity 8/25, Action 12/25, Outcome 6/25, Density 14/25 -> 40. Reads like a task list with no proof of impact."

2. PROFILE CHIPS: 3-4 short tags from résumé content. Examples: "Senior Backend", "7+ yrs", "Fintech", "Bangalore", "Team Lead". Omit uncertain tags rather than guess.

3. RECRUITER REACTION: One paragraph simulating what a recruiter thinks in the first 6 seconds. Human voice, blunt, honest. Gut-reaction read, not a score breakdown.

4. RED FLAGS: Exactly 2-3 specific issues that hurt candidacy. Concrete — not "lacks metrics" but "6 of 8 experience bullets contain zero numbers". One plain-English sentence each.

5. MARKET REALITY PARTIAL: One sentence teasing market positioning. Must include a ₹ range. Example: "At current presentation, you're pricing yourself ₹4-6L below your actual market."

6. REWRITES PREVIEW: Pick the SINGLE WEAKEST bullet and rewrite it as a teaser. Just one entry. Same three rules apply: source-grounded only (no invented activities), tilde-prefix for estimates (\`~12\`), qualitative fallback if no number basis. Under 25 words. No jargon ("leveraged", "spearheaded", "synergized").

Return strictly this JSON and nothing else:

{
  "score": <number 0-100>,
  "score_reason": "<sub-scores then recruiter implication>",
  "profile_chips": ["<tag>", "<tag>", "<tag>"],
  "recruiter_reaction": "<paragraph>",
  "red_flags": ["<specific flag>", "<specific flag>"],
  "market_reality_partial": "<one sentence with ₹ range>",
  "rewrites": [{"before": "...", "after": "..."}]
}

Rules:
- Output JSON only. No \`\`\`json fences. No commentary before or after.
- Honest, not flattering. Weak résumé scores 20-40.
- Plain English. Average graduate understands every word.
- Never invent the user's job title, company, methodologies, datasets, evaluation frameworks, or activities not mentioned by the user. Numbers may be approximated only for activities mentioned — format \`~N\` (tilde prefix). Never use [estimate] text anywhere.
- red_flags: exactly 2-3. Specific. Give actual count or pattern.
- profile_chips: 3-4 max. Omit uncertain.
- rewrites array contains EXACTLY ONE entry (the single worst bullet).
- All field values plain text — no markdown inside values.`;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse body first — needed before we can check dev_key
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Dev bypass — set DEV_KEY env var in Vercel, then in browser console run
  // localStorage.setItem('braggy_dev_key', '<same-key>') to bypass all rate limits
  // while testing in production. Wrong/missing key falls through to normal flow.
  const isDev =
    body.dev_key &&
    process.env.DEV_KEY &&
    body.dev_key === process.env.DEV_KEY;

  // Kill switch — flip BRAGGY_ACTIVE to "false" in Vercel env vars to put site in waitlist mode
  if (!isDev && process.env.BRAGGY_ACTIVE === 'false') {
    return new Response(
      JSON.stringify({ error: 'capacity', message: "We're at capacity right now. Drop your email — you'll be first when we top up." }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { email, resume, fingerprint, turnstile_token } = body;

  // email is OPTIONAL on this endpoint now.
  // The new flow: analyze runs without email → preview shown → email captured via /api/unlock.
  // Email may still arrive here for backwards-compat or internal calls; if so, validate it like before.
  if (!resume) {
    return new Response(JSON.stringify({ error: 'Résumé required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // === ABUSE LAYER 1: Disposable email blocking (only if email is provided) ===
  if (email && isDisposableEmail(email)) {
    return new Response(
      JSON.stringify({ error: 'Please use a real email — we block temporary email services to keep this fair for everyone.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // === ABUSE LAYER 2: Cloudflare Turnstile verification (skipped in dev mode) ===
  if (!isDev && process.env.TURNSTILE_SECRET_KEY) {
    if (!turnstile_token) {
      return new Response(
        JSON.stringify({ error: 'Please complete the verification check and try again.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    try {
      const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: turnstile_token,
        }),
      });
      const tsData = await tsRes.json();
      if (!tsData.success) {
        console.error('turnstile failed', tsData);
        return new Response(
          JSON.stringify({ error: 'Verification failed. Refresh the page and try again.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } catch (e) {
      console.error('turnstile error', e);
      // If Turnstile is down, allow request — don't block legit users
    }
  }

  if (resume.length < 100) {
    return new Response(
      JSON.stringify({ error: 'Your résumé looks too short. Paste the full thing — we need at least a few bullets to work with.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (resume.length > 15000) {
    return new Response(
      JSON.stringify({ error: 'Your résumé is unusually long. Trim it to under 15,000 characters and try again.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // === ABUSE LAYER 3 + 4: IP rate limit, fingerprint check, and daily cap (skipped in dev mode) ===
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
             req.headers.get('x-real-ip') ||
             'unknown';
  const fp = fingerprint || 'no-fingerprint';

  if (!isDev) {
    try {
      const abuseRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/check_abuse`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ p_ip: ip, p_fingerprint: fp }),
        }
      );
      if (abuseRes.ok) {
        const stats = await abuseRes.json();

        // Daily cap — auto-pause if platform hits limit.
        // Skippable when the user has claimed a share-to-skip bypass (frontend posts
        // `share_bypass: true` after they click a share button on the capacity screen).
        // Per-fingerprint and per-IP rate limits below still apply, so a single
        // bypass-claim cannot be exploited for repeated analyses.
        if (stats.total_today >= DAILY_CAP && !body.share_bypass) {
          return new Response(
            JSON.stringify({
              error: 'capacity',
              message: "We've hit today's free analysis cap. Come back tomorrow — your spot is saved.",
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // IP rate limit — 5 per IP per 24h (allows households + shared WiFi)
        if (stats.ip_count >= 5) {
          return new Response(
            JSON.stringify({
              error: 'rate_limited',
              message: "We've hit the limit for this network today. Try again in 24 hours, or use a different connection.",
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Fingerprint rate limit — 1 per browser per 24h
        if (stats.fp_count >= 1) {
          return new Response(
            JSON.stringify({
              error: 'rate_limited',
              message: "This browser already ran an analysis today. Try again in 24 hours.",
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    } catch (e) {
      console.error('abuse check failed', e);
      // If check fails, allow request — don't block legit users
    }
  }

  // The 1-per-email gate has moved to /api/unlock.js — it now governs the full-analysis
  // unlock, not the free preview. Free previews are protected by IP rate limit + fingerprint
  // limit + the global daily cap (above), which are enough to stop abuse without making
  // first-touch users pay with their email.

  // Log to abuse_log so IP and fingerprint counts are accurate for next request.
  // Skipped in dev mode so dev tests don't pollute the table or burn quota for the next
  // legit visitor on the same IP. p_email is null when no email was supplied (the common
  // case in the new flow).
  if (!isDev) {
    try {
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/log_abuse`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ p_ip: ip, p_fingerprint: fp, p_email: email || null }),
        }
      );
    } catch (e) {
      console.error('abuse log failed', e);
    }
  }

  // Call Anthropic
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 900,
        stream: true,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [
          { role: 'user', content: `Here is my résumé:\n\n${resume}` },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('anthropic error', aiRes.status, errText);

      // Auto-switch to capacity mode on credit exhaustion or hard rate limits
      const errLower = errText.toLowerCase();
      const isCreditExhausted =
        errLower.includes('credit_balance_too_low') ||
        errLower.includes('credit balance') ||
        errLower.includes('billing') ||
        errLower.includes('insufficient') ||
        errLower.includes('quota');
      const isHardRateLimit = aiRes.status === 429;

      if (isCreditExhausted || isHardRateLimit) {
        // Save this email to the waitlist so they're queued when we top up.
        // In the new flow most analyze calls have no email — that's fine, just skip.
        if (email) {
          try {
            await fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': process.env.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
                'Prefer': 'resolution=merge-duplicates',
              },
              body: JSON.stringify({ email, source: 'auto_capacity' }),
            });
          } catch {}
        }

        return new Response(
          JSON.stringify({
            error: 'capacity',
            message: "We're at capacity right now. We've saved your spot — you'll be the first to know when we top up.",
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ error: "Something broke on our side. Try again in a minute — your résumé is fine." }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Stream Anthropic SSE → extract text deltas → pipe to client as plain text.
    // Client accumulates the full JSON string, then parses it when the stream ends.
    //
    // This request passed all abuse checks, so issue a signed token in the headers.
    // The client passes it to /api/analyze-full and /api/rewrite-bullets, which
    // require it — that's how those endpoints inherit this one's abuse protection.
    const authToken = await signToken();

    return new Response(sseToTextStream(aiRes.body), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...(authToken && { 'X-Braggy-Token': authToken }),
      },
    });
  } catch (e) {
    console.error('handler error', e);
    return new Response(
      JSON.stringify({ error: "Something broke. Try again in a minute." }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
