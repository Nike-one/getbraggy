// /api/analyze.js — Vercel serverless function
// Proxies Anthropic API and records user activity in Supabase.
// API key is read from process.env.ANTHROPIC_API_KEY (set in Vercel dashboard).

import { isDisposableEmail } from './_disposable-domains.js';

// Daily platform-wide cap — protects against viral spikes
const DAILY_CAP = 30;

export const config = {
  runtime: 'edge',
};

const SYSTEM_PROMPT = `You are Braggy — an honest, sharp, plain-English résumé coach for Indian professionals. The user will paste their résumé. You return JSON only, no preamble, no markdown.

Your job, in order:

1. SCORE the résumé out of 100 by computing a weighted sum of four sub-scores, each out of 25:

   A. SPECIFICITY (0-25): How many bullets contain concrete numbers, percentages, scope, or named tools/technologies?
      - 0-5: Almost no specifics. Vague claims everywhere.
      - 6-12: Some specifics but mostly generic.
      - 13-19: Most bullets have at least one concrete detail.
      - 20-25: Nearly every bullet has multiple specifics.

   B. ACTION-ORIENTATION (0-25): How many bullets lead with strong action verbs (vs. "responsible for", "worked on", passive voice)?
      - 0-5: Almost no action verbs. Reads like a job description.
      - 6-12: Mix of action verbs and passive constructions.
      - 13-19: Most bullets lead with action verbs.
      - 20-25: Nearly every bullet leads with a strong, varied action verb.

   C. OUTCOME-ORIENTATION (0-25): How many bullets state a measurable result or impact (vs. just listing tasks)?
      - 0-5: Pure task lists. No outcomes.
      - 6-12: Occasional outcomes mentioned.
      - 13-19: Most bullets pair tasks with outcomes.
      - 20-25: Every bullet shows clear impact.

   D. DENSITY (0-25): How free is the résumé from filler words, buzzwords, and redundancy?
      - 0-5: Heavy with "results-driven", "team player", "passionate", etc.
      - 6-12: Some filler but mostly substantive.
      - 13-19: Tight writing with minimal filler.
      - 20-25: Every word earns its place.

   Compute each sub-score independently, then sum to get total. Do NOT anchor to a "typical" range — let the math drive the score. A genuinely weak résumé should score 20-40. A genuinely good one should score 70-95. Reserve 95+ for exceptional.

   In score_reason, briefly cite the sub-scores: "Specificity 8/25, Action 12/25, Outcome 6/25, Density 14/25 → 40/100".

2. REWRITE the 3–6 weakest bullets. For each:
   - "before": the original line, exactly as written
   - "after": a sharper version with concrete numbers, scope, and outcome
   - If the user did not give numbers, INVENT plausible ones and mark them with [estimate] so they know to verify
   - Keep the new bullet under 25 words
   - Use simple English. No jargon like "leveraged", "spearheaded", "synergized"

3. SKILL GAPS: Identify 3–5 skills the user should learn next, ranked by salary impact for THEIR role and seniority in the Indian market. For each:
   - "skill": name
   - "why": one sentence in plain English explaining why it matters for their next role
   - "salary_lift": rough rupee range like "₹2-4L" or "₹5-8L" — be conservative

4. ONE_BIG_FIX: A single sentence telling them the #1 thing to change on their résumé today.

Return strictly this JSON shape and nothing else:

{
  "score": <number 0-100>,
  "score_reason": "<one short sentence on what dragged the score>",
  "rewrites": [
    {"before": "...", "after": "..."}
  ],
  "skill_gaps": [
    {"skill": "...", "why": "...", "salary_lift": "..."}
  ],
  "one_big_fix": "<one sentence>"
}

Rules:
- Output JSON only. No \`\`\`json fences. No commentary before or after.
- Be honest, not flattering. If the résumé is weak, say so in score_reason.
- Plain English. An average graduate should understand every word.
- Never invent the user's job title or company; only invent numbers when rewriting bullets, and mark them [estimate].`;

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

        // Daily cap — auto-pause if platform hits limit
        if (stats.total_today >= DAILY_CAP) {
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
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
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

    const data = await aiRes.json();
    const text = data?.content?.[0]?.text || '';

    let parsed;
    try {
      // Defensive: strip any accidental code fences
      const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return new Response(
        JSON.stringify({ error: "We had trouble reading the result. Try again — usually works on second go." }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('handler error', e);
    return new Response(
      JSON.stringify({ error: "Something broke. Try again in a minute." }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
