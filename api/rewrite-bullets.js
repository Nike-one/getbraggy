// /api/rewrite-bullets.js — Vercel serverless Edge Function
// Called by editor.html's fixAll() to rewrite flagged resume bullets using Claude.
// Accepts: POST { bullets: [{id, original_text, issue_type, user_answer, context,
//                             rewritten_template, suggested_rewrite, ...}], dev_key? }
// Returns: { bullets: [{id, rewritten}] }

export const config = {
  runtime: 'edge',
};

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

  const isDev =
    body.dev_key &&
    process.env.DEV_KEY &&
    body.dev_key === process.env.DEV_KEY;

  if (!isDev && process.env.BRAGGY_ACTIVE === 'false') {
    return new Response(
      JSON.stringify({ error: 'capacity', message: "We're at capacity right now. Try again soon." }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { bullets } = body;
  if (!Array.isArray(bullets) || bullets.length === 0) {
    return new Response(JSON.stringify({ error: 'bullets array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (bullets.length > 10) {
    return new Response(JSON.stringify({ error: 'Too many bullets (max 10)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bulletDescriptions = bullets.map((b, i) => {
    const lines = [
      `${i + 1}. id: "${b.id}"`,
      `   original: "${b.original_text}"`,
      `   issue_type: ${b.issue_type}`,
      `   user_answer: "${b.user_answer}"`,
    ];
    if (b.rewritten_template) lines.push(`   template: "${b.rewritten_template}"`);
    if (b.suggested_rewrite) lines.push(`   suggested_rewrite: "${b.suggested_rewrite}"`);
    if (b.context) lines.push(`   context: "${b.context}"`);
    return lines.join('\n');
  }).join('\n\n');

  const prompt = `You are a resume bullet rewriter. Rewrite each bullet below using the user's answer.

Rules:
- Under 20 words per bullet
- Start with a strong action verb
- Use ONLY information from the original bullet or the user_answer — do not invent facts, companies, or activities
- For "estimate_needed": take the template, replace the {placeholder} token with the user_answer naturally (e.g. if user said "12", write "~12" if it's a count)
- For "weak_rewrite": use the user_answer as the new bullet text; polish grammar and punch only — do not add new facts
- Numbers: use tilde prefix ~N for approximations the user provided (e.g. ~12, ~500K)
- No adjectives without proof, no fluff

Return ONLY valid JSON with this exact shape — no markdown, no preamble:
{"bullets":[{"id":"<id>","rewritten":"<final bullet text>"}]}

Bullets to rewrite:
${bulletDescriptions}`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic error', anthropicRes.status, errText);
      return new Response(JSON.stringify({ error: 'AI service error. Try again.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const anthropicData = await anthropicRes.json();
    const rawText = anthropicData?.content?.[0]?.text || '';

    let parsed;
    try {
      // Strip any accidental markdown fences
      const cleaned = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('JSON parse failed:', rawText);
      return new Response(JSON.stringify({ error: 'AI returned invalid response. Try again.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!Array.isArray(parsed.bullets)) {
      return new Response(JSON.stringify({ error: 'AI returned unexpected shape. Try again.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ bullets: parsed.bullets }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('rewrite-bullets threw', e);
    return new Response(JSON.stringify({ error: 'Network error. Try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
