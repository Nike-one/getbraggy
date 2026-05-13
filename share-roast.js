// share-roast.js — Braggy share module
// Self-contained: injects its own CSS, builds the DOM, wires up handlers.
// Drop into the repo root. Load with: <script src="/share-roast.js" defer></script>
// Then call BraggyShare.render(score) when the unlocked results are revealed.
//
// Safe to call multiple times — re-renders preview text in place without dupes.

(function () {
  'use strict';

  const SHARE_URL = 'https://getbraggy.in';
  const TRACK_ENDPOINT = '/api/track-share';

  let stylesInjected = false;

  const SVG = {
    share: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
    x: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.631zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
    linkedin: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
    copy: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  };

  const CSS = `
    .share-roast {
      background: var(--ink, #161413);
      color: var(--cream, #F2EDE4);
      border-radius: 20px;
      padding: 1.75rem 2rem;
      margin: 2.5rem 0 2rem;
      position: relative;
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
    .share-roast-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1.25rem;
      flex-wrap: wrap;
      position: relative;
      z-index: 2;
    }
    .share-roast .share-eyebrow {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--orange, #E8541C);
      margin-bottom: 0.35rem;
    }
    .share-roast .share-headline {
      font-family: 'Instrument Serif', serif;
      font-weight: 400;
      font-size: clamp(1.25rem, 2.5vw, 1.65rem);
      line-height: 1.2;
      letter-spacing: -0.012em;
      margin: 0;
      color: var(--cream, #F2EDE4);
    }
    .share-trigger-wrap {
      position: relative;
      flex-shrink: 0;
    }
    .share-trigger {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--orange, #E8541C);
      color: white;
      border: none;
      font-family: 'Geist', system-ui, sans-serif;
      font-weight: 600;
      font-size: 0.95rem;
      padding: 0.85rem 1.4rem;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.15s, background 0.15s;
      white-space: nowrap;
    }
    .share-trigger:hover {
      background: #c7430f;
      transform: translateY(-1px);
    }
    .share-popover {
      position: absolute;
      bottom: calc(100% + 10px);
      right: 0;
      background: white;
      border: 1px solid rgba(22,20,19,0.12);
      border-radius: 16px;
      padding: 0.5rem;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18), 4px 4px 0 var(--orange, #E8541C);
      min-width: 200px;
      display: none;
      z-index: 100;
      animation: popIn 0.18s ease;
    }
    .share-popover.open { display: block; }
    @keyframes popIn {
      from { opacity: 0; transform: translateY(6px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .share-popover-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      background: none;
      border: none;
      padding: 0.75rem 1rem;
      border-radius: 10px;
      cursor: pointer;
      font-family: 'Geist', system-ui, sans-serif;
      font-size: 0.95rem;
      font-weight: 500;
      color: #161413;
      text-align: left;
      transition: background 0.12s;
    }
    .share-popover-item:hover { background: rgba(22,20,19,0.06); }
    .share-popover-item .share-platform-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: white;
    }
    .share-platform-icon.icon-x        { background: #000; }
    .share-platform-icon.icon-linkedin  { background: #0A66C2; }
    .share-platform-icon.icon-copy      { background: #6B635C; color: white; }
    .share-popover-item.copied .share-platform-icon.icon-copy { background: #2D7A3E; }
    .share-popover-divider {
      height: 1px;
      background: rgba(22,20,19,0.08);
      margin: 0.3rem 0.5rem;
    }
    @media (max-width: 480px) {
      .share-roast-inner { flex-direction: column; align-items: flex-start; }
      .share-popover { right: auto; left: 0; }
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

  function buildShareText(score) {
    let verdict;
    if (score >= 75) verdict = "and said my résumé is solid — but I'm still underselling myself to recruiters.";
    else if (score >= 55) verdict = "and said I'm worth at least one job level more than my résumé implies.";
    else if (score >= 35) verdict = "and said I write like a fresher despite real experience. That stings.";
    else verdict = "and said my résumé is actively costing me interviews. Fixing it now.";
    return `Braggy just gave my résumé a ${score}/100 ${verdict} Get yours roasted: ${SHARE_URL}`;
  }

  function trackShare(channel, score) {
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
      <div class="share-roast-inner">
        <div>
          <div class="share-eyebrow">Share your roast</div>
          <h3 class="share-headline">Brutal feedback is better with friends.</h3>
        </div>
        <div class="share-trigger-wrap">
          <button class="share-trigger" id="share-trigger" type="button" aria-haspopup="true" aria-expanded="false">
            ${SVG.share} Share score
          </button>
          <div class="share-popover" id="share-popover" role="menu">
            <button class="share-popover-item" id="share-x" type="button" role="menuitem">
              <span class="share-platform-icon icon-x">${SVG.x}</span>
              Share on X
            </button>
            <button class="share-popover-item" id="share-linkedin" type="button" role="menuitem">
              <span class="share-platform-icon icon-linkedin">${SVG.linkedin}</span>
              Share on LinkedIn
            </button>
            <div class="share-popover-divider"></div>
            <button class="share-popover-item" id="share-copy" type="button" role="menuitem">
              <span class="share-platform-icon icon-copy" id="copy-icon">${SVG.copy}</span>
              <span id="copy-label">Copy text</span>
            </button>
          </div>
        </div>
      </div>
    `;
    return { section, text };
  }

  function wireUp(section, text, score) {
    const trigger = section.querySelector('#share-trigger');
    const popover = section.querySelector('#share-popover');

    // Toggle popover
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = popover.classList.toggle('open');
      trigger.setAttribute('aria-expanded', isOpen);
    });

    // Close on outside click
    document.addEventListener('click', () => {
      popover.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        popover.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    // X / Twitter
    section.querySelector('#share-x').addEventListener('click', () => {
      popover.classList.remove('open');
      const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank', 'noopener,noreferrer,width=600,height=500');
      trackShare('x', score);
    });

    // LinkedIn — copies text first (LinkedIn no longer prefills via URL)
    section.querySelector('#share-linkedin').addEventListener('click', async () => {
      popover.classList.remove('open');
      try { await navigator.clipboard.writeText(text); } catch {}
      const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_URL)}`;
      window.open(url, '_blank', 'noopener,noreferrer,width=600,height=600');
      trackShare('linkedin', score);
    });

    // Copy with success state
    section.querySelector('#share-copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        const item = section.querySelector('#share-copy');
        const iconEl = section.querySelector('#copy-icon');
        const labelEl = section.querySelector('#copy-label');
        item.classList.add('copied');
        iconEl.innerHTML = SVG.check;
        labelEl.textContent = 'Copied!';
        setTimeout(() => {
          item.classList.remove('copied');
          iconEl.innerHTML = SVG.copy;
          labelEl.textContent = 'Copy text';
        }, 1800);
        trackShare('copy', score);
      } catch (e) {
        console.error('[braggy] clipboard failed', e);
      }
    });

    // Native share (mobile) — insert at top of popover if supported
    if (navigator.share) {
      const nativeBtn = document.createElement('button');
      nativeBtn.className = 'share-popover-item';
      nativeBtn.type = 'button';
      nativeBtn.setAttribute('role', 'menuitem');
      nativeBtn.innerHTML = `<span class="share-platform-icon" style="background:#6B635C">${SVG.share}</span> More options`;
      nativeBtn.addEventListener('click', async () => {
        popover.classList.remove('open');
        try {
          await navigator.share({ title: 'Braggy roasted my résumé', text, url: SHARE_URL });
          trackShare('native', score);
        } catch {}
      });
      const divider = document.createElement('div');
      divider.className = 'share-popover-divider';
      popover.appendChild(divider);
      popover.appendChild(nativeBtn);
    }
  }

  function render(score, mountSelector) {
    const n = Number(score);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      console.warn('[braggy] share: invalid score', score);
      return;
    }

    injectStyles();

    // Idempotent: refresh text if already rendered
    const existing = document.getElementById('share-roast');
    if (existing) {
      return; // score doesn't change on re-render
    }

    const mount = mountSelector
      ? document.querySelector(mountSelector)
      : document.querySelector('.locked-section') ||
        document.querySelector('.results');

    if (!mount) {
      console.warn('[braggy] share: no mount point found');
      return;
    }

    const { section, text } = buildDom(n);

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
