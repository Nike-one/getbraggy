// share-roast.js — Braggy share module
// Self-contained: injects its own CSS, builds the DOM, wires up handlers.
// Drop into the repo root. Load with: <script src="/share-roast.js" defer></script>
// Then call BraggyShare.render(score) when the unlocked results are revealed.
//
// Safe to call multiple times — re-renders preview text in place without dupes.

(function () {
  'use strict';

  const SHARE_URL = 'https://getbraggy.in';
  const TRACK_ENDPOINT = '/api/track-share'; // optional; fire-and-forget

  let stylesInjected = false;

  // ===== styles — scoped under .share-roast so nothing leaks =====
  const CSS = `
    .share-roast {
      background: var(--ink, #161413);
      color: var(--cream, #F2EDE4);
      border-radius: 20px;
      padding: 2rem;
      margin: 2.5rem 0 2rem;
      position: relative;
      overflow: hidden;
      box-shadow: 6px 6px 0 var(--orange, #E8541C);
    }
    .share-roast::before {
      content: '';
      position: absolute;
      top: -50%; right: -10%;
      width: 50%; height: 160%;
      background: radial-gradient(circle, rgba(232,84,28,0.22), transparent 60%);
      pointer-events: none;
    }
    .share-roast .share-eyebrow {
      font-family: 'Geist Mono', monospace;
      font-size: 0.72rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--orange, #E8541C);
      margin-bottom: 0.85rem;
      position: relative; z-index: 2;
    }
    .share-roast .share-headline {
      font-family: 'Instrument Serif', serif;
      font-weight: 400;
      font-size: clamp(1.6rem, 3.5vw, 2.2rem);
      line-height: 1.15;
      letter-spacing: -0.015em;
      margin: 0 0 0.55rem;
      position: relative; z-index: 2;
    }
    .share-roast .share-sub {
      font-size: 0.96rem;
      line-height: 1.5;
      color: rgba(242,237,228,0.72);
      margin: 0 0 1.35rem;
      max-width: 42ch;
      position: relative; z-index: 2;
    }
    .share-roast .share-preview {
      background: rgba(242,237,228,0.07);
      border: 1px solid rgba(242,237,228,0.15);
      border-radius: 12px;
      padding: 1rem 1.1rem;
      font-family: 'Instrument Serif', serif;
      font-style: italic;
      font-size: 1.02rem;
      line-height: 1.45;
      color: rgba(242,237,228,0.92);
      margin: 0 0 1.35rem;
      position: relative; z-index: 2;
    }
    .share-roast .share-buttons {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
      position: relative; z-index: 2;
    }
    .share-roast .share-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      background: var(--cream, #F2EDE4);
      color: var(--ink, #161413);
      border: none;
      font-family: 'Geist', system-ui, sans-serif;
      font-weight: 500;
      font-size: 0.92rem;
      padding: 0.78rem 1.25rem;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.15s, background 0.15s, color 0.15s;
    }
    .share-roast .share-btn:hover {
      transform: translateY(-2px);
      background: var(--orange, #E8541C);
      color: var(--cream, #F2EDE4);
    }
    .share-roast .share-btn.copied {
      background: var(--green, #2D7A3E);
      color: white;
    }
    @media (max-width: 480px) {
      .share-roast .share-buttons { flex-direction: column; }
      .share-roast .share-btn { width: 100%; justify-content: center; }
    }
  `;

  function injectStyles() {
    if (stylesInjected) return;
    const style = document.createElement('style');
    style.id = 'braggy-share-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
    stylesInjected = true;
  }

  // Score-aware copy — keeps the brutal tone but doesn't lie when the score is high
  function buildShareText(score) {
    let verdict;
    if (score >= 75) verdict = "and grudgingly admitted I know what I'm doing.";
    else if (score >= 55) verdict = "and told me I'm leaving money on the table.";
    else if (score >= 35) verdict = "and told me I sound like a junior. Brutal.";
    else verdict = "and basically said my résumé is doing me dirty.";
    return `Braggy just gave my résumé a ${score}/100 ${verdict} Get yours roasted: ${SHARE_URL}`;
  }

  // Fire-and-forget tracking. Never blocks the user. Safe if endpoint is missing.
  function trackShare(channel, score) {
    if (window.console && console.debug) console.debug('[braggy] share', { channel, score });
    try {
      fetch(TRACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, score, at: Date.now() }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  function buildDom(score) {
    const text = buildShareText(score);
    const section = document.createElement('div');
    section.className = 'share-roast';
    section.id = 'share-roast';
    section.innerHTML = `
      <div class="share-eyebrow">Share the pain</div>
      <h3 class="share-headline">Brutal feedback is better with friends.</h3>
      <p class="share-sub">Drag yours in. Roast their résumé together.</p>
      <div class="share-preview" id="share-preview"></div>
      <div class="share-buttons">
        <button class="share-btn" id="share-native" type="button" hidden>📲 Share</button>
        <button class="share-btn" id="share-x" type="button">𝕏 Share on X</button>
        <button class="share-btn" id="share-linkedin" type="button">in Share on LinkedIn</button>
        <button class="share-btn" id="share-copy" type="button">📋 Copy text</button>
      </div>
    `;
    // textContent so quotes/emojis in the message never break HTML
    section.querySelector('#share-preview').textContent = `"${text}"`;
    return { section, text };
  }

  function wireUp(section, text, score) {
    // Native Web Share API — only show when supported (most mobile + Safari + recent Chrome)
    if (navigator.share) {
      const native = section.querySelector('#share-native');
      native.hidden = false;
      native.addEventListener('click', async () => {
        try {
          await navigator.share({
            title: 'Braggy roasted my résumé',
            text,
            url: SHARE_URL,
          });
          trackShare('native', score);
        } catch {} // user cancelled — silent
      });
    }

    // X / Twitter intent — still supports prefilled text via ?text=
    section.querySelector('#share-x').addEventListener('click', () => {
      const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank', 'noopener,noreferrer,width=600,height=500');
      trackShare('x', score);
    });

    // LinkedIn — share URL no longer prefills text (only the URL).
    // Workaround: copy snarky text to clipboard so user can paste into LinkedIn composer.
    section.querySelector('#share-linkedin').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); } catch {}
      const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_URL)}`;
      window.open(url, '_blank', 'noopener,noreferrer,width=600,height=600');
      trackShare('linkedin', score);
    });

    // Plain copy with success state
    const copyBtn = section.querySelector('#share-copy');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        const orig = copyBtn.innerHTML;
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '✓ Copied';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = orig;
        }, 1800);
        trackShare('copy', score);
      } catch (e) {
        console.error('[braggy] clipboard failed', e);
      }
    });
  }

  function render(score, mountSelector) {
    const n = Number(score);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      console.warn('[braggy] share: invalid score', score);
      return;
    }

    injectStyles();

    // Idempotent: if already rendered, just refresh the preview text
    const existing = document.getElementById('share-roast');
    if (existing) {
      const text = buildShareText(n);
      const preview = existing.querySelector('#share-preview');
      if (preview) preview.textContent = `"${text}"`;
      return;
    }

    // Find mount point — explicit selector wins, otherwise auto-detect
    const mount = mountSelector
      ? document.querySelector(mountSelector)
      : document.querySelector('.locked-section') ||
        document.querySelector('.results');

    if (!mount) {
      console.warn('[braggy] share: no mount point found');
      return;
    }

    const { section, text } = buildDom(n);

    // Insert before feedback card if present, else append at the end
    const feedback = mount.querySelector('.feedback-card');
    if (feedback) {
      mount.insertBefore(section, feedback);
    } else {
      mount.appendChild(section);
    }

    wireUp(section, text, n);
  }

  window.BraggyShare = { render };
})();
