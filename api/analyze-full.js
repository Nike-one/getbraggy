// /api/analyze-full.js — Vercel Edge Function
// Heavy-fields companion to /api/analyze. Called in parallel from the client.
// Returns: rewritten_resume, bullet_issues, rewrites, market_reality_full,
//          one_big_fix, salary_positioning, skill_gaps, recruiter_verdict.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT_FULL = `You are Braggy's deep-analysis pass. The user pasted a résumé and a parallel call has already scored it and called out red flags. Your job is the long-form rewrite and the structured output a recruiter would actually skim. Return JSON only, no preamble, no markdown.

1. MARKET REALITY FULL: 2-3 sentences. Specific to detected role, seniority, and city if mentioned. Include: what market pays for this profile, what the résumé signals to hiring managers, the gap between the two. Use rupees.

2. REWRITES: 3-6 weakest bullets. For each:
   - "before": original line exactly as written
   - "after": sharper version with concrete scope and outcome.
   - Keep under 25 words. No jargon: "leveraged", "spearheaded", "synergized".

   THREE RULES for the "after" text:
   Rule 1 — Source-grounded only. Every concrete claim must trace to text the user wrote. Do not invent methodologies, datasets, frameworks, or activities.
   Rule 2 — Estimate the count, never the thing. Tilde-prefix approximations for activities the user mentioned (e.g. \`~12\`). Never invent activities.
   Rule 3 — Qualitative fallback. No basis for a number? Use strong action verbs + qualitative outcomes. Zero fabricated numbers.

3. ONE BIG FIX: Single sentence — the #1 change to make today.

4. SALARY POSITIONING: One sentence. Format: "Résumé currently reads [range]. Market for your profile: [range]. Gap is [reason]."

5. SKILL GAPS: 3-5 skills missing for their next role, ranked by salary impact for their role and seniority in the Indian market. For each: {"skill": name, "salary_lift": rupee range like "₹2-4L"}. No advice. No roadmaps.

6. RECRUITER VERDICT: One honest closing paragraph. What happens to this résumé in a real hiring pipeline. What needs to change to break into the next tier. No motivation. No generic praise. No skill suggestions — presentation only.

7. REWRITTEN_RESUME: Extract the user's résumé into the fixed slots below. Rendered to PDF for recruiters — must be usable as-is.

    HARD RULES:
    - Preserve EXACTLY (never invent or change): name, email, phone, LinkedIn URL, GitHub URL, institution names, degree names, dates, GPAs/percentages, certification names, company names, role titles, project names, club/organization names.
    - Rewrite EVERY bullet to lead with an action verb and state an outcome. Under 25 words each. Apply the SAME THREE RULES as REWRITES.
    - If a role has a thin/empty description, infer 2-3 plausible bullets within the role's actual scope using the three rules — qualitative by default, tilde-prefixed numbers only for activities the user mentioned. Do NOT invent jobs, companies, projects, methodologies, or datasets that aren't on the original résumé.
    - For Skills, regroup into Jake's-Resume-style categories: Languages, Frameworks, Developer Tools, Libraries, Databases, Cloud. Use only categories that apply. Keep the user's actual skills — don't add new ones.
    - Plain ASCII throughout. "Resume" not "Résumé". No ₹ symbol. No em-dashes (use hyphens).
    - Each slot is OPTIONAL — leave as empty array if no data. Do not invent a section just to fill it.

8. BULLET ISSUES: Identify 3-5 bullets in rewritten_resume still weak after your rewrite. Each entry tells the editor which bullet to flag. NEVER more than 5. Rank worst-first. Empty array if fewer than 3 weak bullets.

    Two issue types — pick exactly one per entry:

    A) "estimate_needed" — bullet is qualitative but would land harder with a real number the user can recall (team size, count of events, dataset size). Activity must be real in original résumé.
       Required: "question" (one short sentence asking for the number), "context" (one short sentence on why it matters), "rewritten_template" (final bullet with one {placeholder} token).

    B) "weak_rewrite" — no number to add but rewrite is still task-y/vague. Provide a sharper rewrite.
       Required: "context" (one short sentence on what's wrong), "suggested_rewrite" (improved bullet, same THREE RULES).

    Common fields: "id" (\`exp-0-1\` format), "section" (experience|projects|extracurricular), "entry_index" (int), "bullet_index" (int), "original_text" (exact current bullet), "issue_type".

    Hard limits: 3-5 items. Only experience/projects/extracurricular sections. Indexes MUST be valid against rewritten_resume.

Return strictly this JSON and nothing else:

{
  "market_reality_full": "<2-3 sentences>",
  "rewrites": [{"before": "...", "after": "..."}],
  "one_big_fix": "<one sentence>",
  "salary_positioning": "<one sentence>",
  "skill_gaps": [{"skill": "...", "salary_lift": "..."}],
  "recruiter_verdict": "<paragraph>",
  "rewritten_resume": {
    "name": "<full name exactly as written>",
    "contact": {"email": "", "phone": "", "linkedin": "", "github": "", "location": ""},
    "summary": "<empty OR 1-2 lines IF original had one — never invent>",
    "education": [{"institution": "", "location": "", "degree": "", "dates": "", "details": ""}],
    "skills": [{"category": "", "items": ""}],
    "projects": [{"name": "", "tech": "", "link": "", "bullets": []}],
    "experience": [{"role": "", "company": "", "location": "", "dates": "", "bullets": []}],
    "certifications": [{"name": "", "issuer": "", "date": ""}],
    "extracurricular": [{"role": "", "organization": "", "dates": "", "bullets": []}],
    "awards": [{"name": "", "issuer": "", "date": ""}],
    "interests": []
  },
  "bullet_issues": [
    {"id": "", "section": "", "entry_index": 0, "bullet_index": 0, "original_text": "", "issue_type": "", "question": "", "context": "", "rewritten_template": "", "suggested_rewrite": ""}
  ]
}

Rules:
- Output JSON only. No \`\`\`json fences. No commentary before or after.
- Never invent jobs, companies, methodologies, datasets, evaluation frameworks, or any activity the user didn't mention. Numbers may be approximated only for activities the user mentioned — \`~N\` (tilde prefix). Never use [estimate] text anywhere.
- All field values must be plain text strings — no markdown inside values.`;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await req.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const isDev =
    body.dev_key &&
    process.env.DEV_KEY &&
    body.dev_key === process.env.DEV_KEY;

  if (!isDev && process.env.BRAGGY_ACTIVE === 'false') {
    return new Response(
      JSON.stringify({ error: 'capacity', message: "We're at capacity right now." }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { resume } = body;
  if (!resume || resume.length < 100) {
    return new Response(JSON.stringify({ error: 'Résumé required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (resume.length > 15000) {
    return new Response(JSON.stringify({ error: 'Résumé too long' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

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
        max_tokens: 5000,
        stream: true,
        system: [
          { type: 'text', text: SYSTEM_PROMPT_FULL, cache_control: { type: 'ephemeral' } }
        ],
        messages: [
          { role: 'user', content: `Here is my résumé:\n\n${resume}` },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('analyze-full anthropic error', aiRes.status, errText);
      return new Response(
        JSON.stringify({ error: 'AI service error. Try again.' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Stream SSE → text deltas (same pattern as analyze.js)
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const { readable, writable } = new TransformStream({
      transform(chunk, controller) {
        sseBuffer += decoder.decode(chunk, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';
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
    console.error('analyze-full handler error', e);
    return new Response(
      JSON.stringify({ error: 'Something broke. Try again.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
