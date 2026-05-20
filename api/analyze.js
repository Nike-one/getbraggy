// /api/analyze.js — Vercel serverless function
// Proxies Anthropic API and records user activity in Supabase.
// API key is read from process.env.ANTHROPIC_API_KEY (set in Vercel dashboard).

import { isDisposableEmail } from './_disposable-domains.js';

// Daily platform-wide cap — protects against viral spikes
const DAILY_CAP = 30;

export const config = {
  runtime: 'edge',
};

const SYSTEM_PROMPT = `You are Braggy — a brutally honest recruiter-perception engine for Indian professionals. The user will paste their résumé. Return JSON only, no preamble, no markdown.

Your job:

1. SCORE the résumé 0-100 using four sub-scores (each 0-25):

   A. SPECIFICITY (0-25): How many bullets contain concrete numbers, percentages, scope, or named tools?
      0-5: Almost none. 6-12: Some. 13-19: Most have at least one concrete detail. 20-25: Nearly all have multiple specifics.

   B. ACTION-ORIENTATION (0-25): How many bullets lead with strong action verbs vs "responsible for", "worked on", passive voice?
      0-5: Almost no action verbs. 6-12: Mix. 13-19: Most lead with action verbs. 20-25: Nearly all, varied.

   C. OUTCOME-ORIENTATION (0-25): How many bullets state a measurable result vs just listing tasks?
      0-5: Pure task lists. 6-12: Occasional outcomes. 13-19: Most pair task + outcome. 20-25: Every bullet shows impact.

   D. DENSITY (0-25): How free from filler, buzzwords, redundancy?
      0-5: Heavy filler. 6-12: Some. 13-19: Tight. 20-25: Every word earns its place.

   Compute each independently. Sum = total. Do NOT anchor to a typical range — weak résumé should score 20-40, good résumé 70-95, reserve 95+ for exceptional.

   score_reason format: cite sub-scores, then one-sentence recruiter implication. Example: "Specificity 8/25, Action 12/25, Outcome 6/25, Density 14/25 → 40. Reads like a task list with no proof of impact."

2. PROFILE CHIPS: Detect 3-4 short tags from the résumé content. Examples: "Senior Backend", "7+ yrs", "Fintech", "Bangalore", "Team Lead", "IC Track", "MNC". If uncertain about a tag, omit it rather than guess.

3. RECRUITER REACTION: One paragraph simulating what a recruiter thinks in the first 6 seconds. Human voice, blunt, honest. Not a score breakdown — a gut-reaction read. Example: "Reads like someone who shows up and does the work but can't prove it. Zero numbers, owns nothing — every bullet is 'we' or 'team'. I'd need to interview to know if this person is actually strong, which means most recruiters won't bother."

4. RED FLAGS: Exactly 2-3 specific issues that hurt candidacy. Be concrete — not "lacks metrics" but "6 of 8 experience bullets contain zero numbers". Each is one plain-English sentence.

5. MARKET REALITY PARTIAL: One sentence teasing their market positioning. Must include a ₹ range. Example: "At current presentation, you're pricing yourself ₹4-6L below your actual market."

6. MARKET REALITY FULL: 2-3 sentences. Specific to detected role, seniority, and city if mentioned. Include: what market pays for this profile, what the résumé signals to hiring managers, the gap between the two. Use rupees.

7. REWRITES: 3-6 weakest bullets. For each:
   - "before": original line exactly as written
   - "after": sharper version with concrete numbers, scope, outcome. If user gave no numbers, INVENT plausible ones and mark with [estimate].
   - Keep under 25 words. No jargon: "leveraged", "spearheaded", "synergized".

8. ONE BIG FIX: Single sentence — the #1 change to make today.

9. SALARY POSITIONING: One sentence. Format: "Résumé currently reads [range]. Market for your profile: [range]. Gap is [reason]."

10. SKILL GAPS: 3-5 skills missing for their next role, ranked by salary impact for their role and seniority in the Indian market. For each:
    - "skill": name
    - "salary_lift": rough rupee range like "₹2-4L" or "₹5-8L"
    No learning advice. No roadmaps. Just what's missing and what it's worth.

11. RECRUITER VERDICT: One honest closing paragraph. What happens to this résumé in a real hiring pipeline. What needs to change to break into the next tier. No motivation. No generic praise.
No skill suggestions — focus on presentation and positioning changes only.

12. REWRITTEN_RESUME: Extract the user's résumé into the fixed slots below. This will be rendered into a downloadable PDF the user sends to recruiters — it must be usable as-is.

    HARD RULES:
    - Preserve EXACTLY (never invent or change): name, email, phone, LinkedIn URL, GitHub URL, institution names, degree names, dates, GPAs/percentages, certification names, company names, role titles, project names, club/organization names.
    - Rewrite EVERY bullet to lead with an action verb, include concrete numbers, state an outcome. Use the same [estimate] convention as the rewrites field — invent plausible numbers and tag with [estimate]. Keep each bullet under 25 words.
    - If the user has a thin/empty role description ("internship will provide me experience"), infer 2-3 plausible bullets within the role's actual scope and tag numbers with [estimate]. Do NOT invent jobs, companies, or projects that aren't on the original résumé.
    - For Skills, regroup the user's skills into Jake's-Resume-style categories: Languages, Frameworks, Developer Tools, Libraries, Databases, Cloud. Use only categories that apply. Keep the user's actual skills — don't add new ones.
    - Use plain ASCII throughout this object. Use "Resume" not "Résumé". No ₹ symbol (the résumé doesn't need it). No em-dashes (use hyphens).
    - Each slot is OPTIONAL — leave as an empty array if the user has no data for it. Do not invent a section just to fill it.

Return strictly this JSON and nothing else:

{
  "score": <number 0-100>,
  "score_reason": "<sub-scores then recruiter implication>",
  "profile_chips": ["<tag>", "<tag>", "<tag>"],
  "recruiter_reaction": "<paragraph>",
  "red_flags": ["<specific flag>", "<specific flag>"],
  "market_reality_partial": "<one sentence with ₹ range>",
  "market_reality_full": "<2-3 sentences>",
  "rewrites": [
    {"before": "...", "after": "..."}
  ],
  "one_big_fix": "<one sentence>",
  "salary_positioning": "<one sentence>",
  "skill_gaps": [
    {"skill": "...", "salary_lift": "..."}
  ],
  "recruiter_verdict": "<paragraph>",
  "rewritten_resume": {
    "name": "<full name exactly as written>",
    "contact": {
      "email": "<email or empty string>",
      "phone": "<phone or empty string>",
      "linkedin": "<linkedin URL/handle or empty string>",
      "github": "<github URL/handle or empty string>",
      "location": "<city, country if present, else empty>"
    },
    "summary": "<empty string OR a 1-2 line professional summary IF the original résumé had one — never invent one>",
    "education": [
      {
        "institution": "<school name>",
        "location": "<city, state/country or empty>",
        "degree": "<degree + field, e.g. 'Bachelors in Computer Science and Engineering'>",
        "dates": "<e.g. 'Nov 2020 - Jun 2024'>",
        "details": "<GPA, percentage, honors, relevant coursework — one short line, or empty>"
      }
    ],
    "skills": [
      {"category": "<e.g. Languages>", "items": "<comma-separated skills>"}
    ],
    "projects": [
      {
        "name": "<project name>",
        "tech": "<tech stack one-line or empty>",
        "link": "<github/demo URL or empty>",
        "bullets": ["<rewritten bullet>", "<rewritten bullet>"]
      }
    ],
    "experience": [
      {
        "role": "<job title>",
        "company": "<company name>",
        "location": "<city or empty>",
        "dates": "<e.g. 'Sep 2022 - Nov 2022'>",
        "bullets": ["<rewritten bullet>", "<rewritten bullet>"]
      }
    ],
    "certifications": [
      {"name": "<cert name>", "issuer": "<issuer or empty>", "date": "<year or empty>"}
    ],
    "extracurricular": [
      {
        "role": "<position title>",
        "organization": "<club/org name>",
        "dates": "<dates or empty>",
        "bullets": ["<rewritten bullet>"]
      }
    ],
    "awards": [
      {"name": "<award name>", "issuer": "<or empty>", "date": "<or empty>"}
    ],
    "interests": ["<interest>", "<interest>"]
  }
}

Rules:
- Output JSON only. No \`\`\`json fences. No commentary before or after.
- Honest, not flattering. Weak résumé should score 20-40.
- Plain English. An average graduate should understand every word.
- Never invent the user's job title or company. Only invent numbers in rewrites, marked [estimate].
- score_reason: cite sub-scores (e.g. "Specificity 8/25, Action 12/25, Outcome 6/25, Density 14/25 -> 40") then one recruiter implication sentence.
- red_flags: exactly 2-3. Specific. Not "lacks metrics" — give the actual count or pattern.
- profile_chips: 3-4 max. Omit uncertain ones.
- All field values must be plain text strings — no markdown formatting inside values.`;

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
        max_tokens: 6000,
        stream: true,
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

    // Stream Anthropic SSE → extract text deltas → pipe to client as plain text.
    // Client accumulates the full JSON string, then parses it when the stream ends.
    // Buffer across chunks so SSE lines split at chunk boundaries are not dropped.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const { readable, writable } = new TransformStream({
      transform(chunk, controller) {
        sseBuffer += decoder.decode(chunk, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? ''; // keep incomplete last line in buffer
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          } catch {}
        }
      },
      flush(controller) {
        // process any remaining buffered line
        if (sseBuffer.startsWith('data: ')) {
          const jsonStr = sseBuffer.slice(6).trim();
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          } catch {}
        }
      },
    });

    aiRes.body.pipeTo(writable).catch(() => {});

    return new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (e) {
    console.error('handler error', e);
    return new Response(
      JSON.stringify({ error: "Something broke. Try again in a minute." }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
