// /api/analyze.js — Vercel serverless function
// Proxies Anthropic API and records user activity in Supabase.
// API key is read from process.env.ANTHROPIC_API_KEY (set in Vercel dashboard).

export const config = {
  runtime: 'edge',
};

const SYSTEM_PROMPT = `You are Braggy — an honest, sharp, plain-English résumé coach for Indian professionals. The user will paste their résumé. You return JSON only, no preamble, no markdown.

Your job, in order:

1. SCORE the résumé out of 100 based on:
   - Specificity (does it use real numbers, percentages, scope?)
   - Action-orientation (does it lead with verbs, not "responsible for")
   - Outcome-orientation (does it state results, not just tasks?)
   - Density (no filler words, no fluff)
   Be honest. A typical untouched Indian fresher résumé is 35–55. A polished senior résumé is 75–90. Reserve 90+ for genuinely excellent ones.

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

  // Kill switch — flip BRAGGY_ACTIVE to "false" in Vercel env vars to put site in waitlist mode
  if (process.env.BRAGGY_ACTIVE === 'false') {
    return new Response(
      JSON.stringify({ error: 'capacity', message: "We're at capacity right now. Drop your email — you'll be first when we top up." }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
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

  const { email, resume } = body;

  if (!email || !resume) {
    return new Response(JSON.stringify({ error: 'Email and résumé required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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

  // CHECK USAGE LIMIT — before spending Anthropic credits
  // Free tier: 1 analysis per email
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
        return new Response(
          JSON.stringify({
            error: 'limit_reached',
            message: "You've already used your free analysis. We'll let you know when more credits open up.",
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  } catch (e) {
    console.error('usage check failed', e);
    // If check fails, allow request — don't block the user
  }

  // Save user to Supabase via RPC — atomically inserts or increments uses_count
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
      console.error('supabase rpc failed', supaRes.status, errBody);
    }
  } catch (e) {
    console.error('supabase rpc threw', e);
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
        model: 'claude-sonnet-4-5-20250929',
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
        // Save this email to the waitlist so they're queued when we top up
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
