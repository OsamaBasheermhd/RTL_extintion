/**
 * RTL Fix — Content Script v4.2
 *
 * Automatically applies right-to-left direction to Arabic text on AI chatbot
 * pages while preserving code blocks, math, and neutral symbols.
 *
 * Built as a clean rewrite addressing all accumulated bugs from v1–v3:
 *   - Mutation batch loss (debounce was discarding earlier batches)
 *   - Hash poisoning (fixNeutrals changed text → invalidated stored hash)
 *   - Missing LTR reset (blocks set to RTL could never revert)
 *   - Infinite observer loops (own DOM writes triggered re-processing)
 *   - TreeWalker root-skipping (added elements never processed by observer)
 *
 * Architecture (4 modules):
 *   1. CONFIG   — defaults, storage, hot-reload
 *   2. DETECT   — pure functions: language detection, element classification
 *   3. FIX      — DOM writes: direction, code protection, neutral wrapping
 *   4. OBSERVE  — MutationObserver with correct batch accumulation
 */
(() => {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════
   * 1. CONFIG — settings & defaults
   * ═══════════════════════════════════════════════════════════════ */

  const DEFAULTS = Object.freeze({
    masterEnabled: true,
    allSites:      false,
    codeBlockFix:  true,
    tableFix:      true,
    inputFix:      true,
    sites: Object.freeze({
      "claude.ai":         true,
      "chatgpt.com":       true,
      "chat.openai.com":   true,
      "gemini.google.com": true,
    }),
  });

  let cfg = clone(DEFAULTS);

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function loadConfig() {
    return new Promise(resolve => {
      if (chrome?.storage?.sync) {
        chrome.storage.sync.get(DEFAULTS, stored => {
          resolve({
            ...DEFAULTS,
            ...stored,
            sites: { ...DEFAULTS.sites, ...(stored.sites || {}) },
          });
        });
      } else {
        resolve(clone(DEFAULTS));
      }
    });
  }

  function isSiteEnabled(settings) {
    if (!settings.masterEnabled) return false;
    if (settings.allSites) return true;
    const host = location.hostname.replace(/^www\./, "");
    return Object.entries(settings.sites || {}).some(
      ([domain, on]) => on && (host === domain || host.endsWith("." + domain))
    );
  }

  /* ═══════════════════════════════════════════════════════════════
   * 2. DETECT — pure functions, zero side effects
   * ═══════════════════════════════════════════════════════════════ */

  /** Matches any Arabic/Farsi/Urdu character. */
  const RE_RTL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

  /** Matches neutral math/logic symbols that need directional anchoring. */
  const RE_NEUTRAL = /([←→↔⇐⇒⇔≥≤≠±∓≈≡∼∝∞∨∧∪∩⊂⊃⊆⊇∈∉⊕⊗√∑∏∫∂∀∃∄∅✓✗✘⟵⟶⟷•·°¹²³⁴⁵⁶⁷⁸⁹⁰₀₁₂₃₄₅₆₇₈₉])/g;

  /** Matches BIDI control characters we insert, for stable hashing. */
  const RE_BIDI = /[\u200F\u2067\u2069]/g;

  /** Matches inline code in backticks (excluded from RTL detection). */
  const RE_INLINE_CODE = /`[^`]*`/g;

  /** Matches Arabic text segments inside code blocks for bidi wrapping. */
  const RE_ARABIC_SEG =
    /([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF][\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\s,\u060C.!\u061F:;'"\\-\u066A\u066B\u066C]+)/g;

  const RLM = "\u200F";  // Right-to-Left Mark
  const RLI = "\u2067";  // Right-to-Left Isolate
  const PDI = "\u2069";  // Pop Directional Isolate

  /** Selectors for math rendering engines. */
  const SEL_MATH = [
    ".katex", ".katex-display", ".katex-html", ".katex-mathml",
    "mjx-container", "mjx-math", ".MathJax", ".MathJax_Display",
    ".MathJax_Preview", ".MJXc-display", "math",
    'annotation[encoding*="tex"]',
  ].join(",");

  /** Elements that should never be processed. */
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SVG", "CANVAS",
    "VIDEO", "AUDIO", "IFRAME", "NOSCRIPT", "TEMPLATE",
  ]);

  /** Inline elements (not block-level containers). */
  const INLINE_TAGS = new Set([
    "STRONG", "B", "EM", "I", "U", "S", "STRIKE", "DEL", "INS",
    "MARK", "SPAN", "A", "SUB", "SUP", "SMALL", "ABBR",
    "CITE", "DFN", "KBD", "SAMP", "VAR", "TIME", "LABEL", "BDI", "BDO",
  ]);

  /** Block selectors used to find the nearest block ancestor. */
  const BLOCK_SELECTOR =
    "p,li,div,td,th,h1,h2,h3,h4,h5,h6,blockquote,figcaption,summary,dt,dd";

  /**
   * Strip BIDI control characters before hashing.
   * This is the KEY fix for hash poisoning: the hash is always computed
   * on the "clean" text, so fixNeutrals adding RLM chars never
   * invalidates a stored hash.
   */
  function stripBidi(str) {
    return str.replace(RE_BIDI, "");
  }

  /** djb2 hash of clean (BIDI-stripped) text content. */
  function computeHash(text) {
    const clean = stripBidi(text);
    let h = 5381;
    for (let i = 0, len = clean.length; i < len; i++) {
      h = ((h << 5) + h + clean.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  /** Hash of an element's visible text, BIDI-stripped for stability. */
  function elementHash(el) {
    return computeHash((el.innerText || el.textContent || "").trimEnd());
  }

  /** True if text contains Arabic characters (ignoring inline code). */
  function hasRTL(text) {
    return RE_RTL.test(text.replace(RE_INLINE_CODE, ""));
  }

  /** True if element is inside a math rendering container. */
  function isMath(el) {
    return !!(el.closest && el.closest(SEL_MATH)) ||
           !!(el.matches && el.matches(SEL_MATH));
  }

  /** True if the node is inside a PRE or CODE element. */
  function isInsideCode(node) {
    for (let p = node.parentElement; p; p = p.parentElement) {
      if (p.tagName === "PRE" || p.tagName === "CODE") return true;
    }
    return false;
  }

  /** True if element renders as a block (not inline). */
  function isBlock(el) {
    if (INLINE_TAGS.has(el.tagName)) return false;
    try { return getComputedStyle(el).display !== "inline"; }
    catch { return true; }
  }

  /** Collect all text nodes under an element (snapshot). */
  function getTextNodes(el) {
    const walker = (el.ownerDocument || document).createTreeWalker(
      el, NodeFilter.SHOW_TEXT, null
    );
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  /** Read text content excluding code/pre descendants. */
  function readableText(el) {
    let result = "";
    for (const node of getTextNodes(el)) {
      if (!isInsideCode(node)) result += node.textContent;
    }
    return result;
  }

  /**
   * Check if element (or its inline children) contain real text.
   * Recurses into INLINE_TAGS only — blocks are visited separately
   * by the TreeWalker in scanRoot().
   */
  function hasMeaningfulText(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE &&
          child.textContent.trim().length > 1) return true;
      if (child.nodeType === Node.ELEMENT_NODE &&
          INLINE_TAGS.has(child.tagName) &&
          hasMeaningfulText(child)) return true;
    }
    return false;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 3. FIX — DOM write operations
   * ═══════════════════════════════════════════════════════════════ */

  /**
   * Wrap neutral symbols in RLM so they don't flip direction.
   * Operates on text nodes, skips code and math descendants.
   */
  function fixNeutrals(el) {
    for (const node of getTextNodes(el)) {
      if (isInsideCode(node)) continue;
      if (node.parentElement && isMath(node.parentElement)) continue;
      const clean = stripBidi(node.textContent);
      if (!RE_NEUTRAL.test(clean)) continue;
      const wrapped = clean.replace(RE_NEUTRAL, RLM + "$1" + RLM);
      if (wrapped !== node.textContent) node.textContent = wrapped;
    }
  }

  /**
   * Set text direction on a single block element.
   *
   * Key design decisions:
   *   - Hash is computed on BIDI-stripped text (stable across fixNeutrals calls)
   *   - If hash matches stored hash, skip entirely (no work needed)
   *   - If text is NOT Arabic, reset direction to default (LTR reset fix)
   *   - If text IS Arabic, set RTL and protect inline code/math
   */
  function fixBlock(el) {
    if (!el || SKIP_TAGS.has(el.tagName) || isMath(el)) return;
    if (el.tagName === "PRE" || el.tagName === "CODE") return;
    if (!isBlock(el)) return;

    const text = readableText(el);
    if (text.trim().length < 2) return;

    const hash = elementHash(el);
    if (el.dataset.rtlH === hash) return;
    el.dataset.rtlH = hash;

    if (!hasRTL(text)) {
      /* LTR RESET: If this block was previously set to RTL, clear it. */
      if (el.style.direction === "rtl") {
        el.style.direction = "";
        el.style.textAlign = "";
      }
      return;
    }

    /* Apply RTL direction. */
    el.style.direction = "rtl";
    el.style.textAlign = "right";

    /* Protect inline <code> elements from RTL. */
    for (const code of el.querySelectorAll(":scope > code, :scope code")) {
      code.style.direction   = "ltr";
      code.style.unicodeBidi = "embed";
    }

    /* Protect math elements from RTL. */
    for (const math of el.querySelectorAll(SEL_MATH)) {
      math.style.direction   = "ltr";
      math.style.textAlign   = "left";
      math.style.unicodeBidi = "isolate";
    }

    fixNeutrals(el);
  }

  /** Wrap Arabic text segments inside <pre> blocks with BIDI isolates. */
  function fixCodeBlocks(root) {
    if (!cfg.codeBlockFix) return;
    const pres = root.querySelectorAll ? root.querySelectorAll("pre") : [];
    for (const pre of pres) {
      const hash = elementHash(pre);
      if (pre.dataset.rtlC === hash) continue;
      pre.dataset.rtlC = hash;

      for (const node of getTextNodes(pre)) {
        const clean = stripBidi(node.textContent);
        if (!RE_RTL.test(clean)) continue;
        const wrapped = clean.replace(RE_ARABIC_SEG, RLI + "$1" + PDI);
        if (wrapped !== node.textContent) node.textContent = wrapped;
      }
    }
  }

  /** Set direction on table cells containing Arabic text. */
  function fixTables(root) {
    if (!cfg.tableFix) return;
    const cells = root.querySelectorAll ? root.querySelectorAll("td,th") : [];
    for (const cell of cells) {
      const text = cell.textContent.trim();
      if (text.length < 2) continue;
      const hash = computeHash(text);
      if (cell.dataset.rtlH === hash) continue;
      cell.dataset.rtlH = hash;
      if (hasRTL(text)) {
        cell.style.direction = "rtl";
        cell.style.textAlign = "right";
      } else if (cell.style.direction === "rtl") {
        cell.style.direction = "";
        cell.style.textAlign = "";
      }
    }
  }

  /** Bind input listener on contenteditable elements for live RTL. */
  function bindEditables(root) {
    if (!cfg.inputFix) return;
    const editables = root.querySelectorAll
      ? root.querySelectorAll("[contenteditable='true']") : [];
    for (const el of editables) {
      if (el.dataset.rtlBound) continue;
      el.dataset.rtlBound = "1";
      el.addEventListener("input", () => {
        const rtl = hasRTL(el.textContent || "");
        el.style.direction = rtl ? "rtl" : "";
        el.style.textAlign = rtl ? "right" : "";
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════
   * CSS — injected stylesheet for code/math/list protection
   * ═══════════════════════════════════════════════════════════════ */

  const STYLE_ID = "rtl-fix-v4";

  const CSS = `
/* ── Code blocks: always LTR ── */
pre, .hljs, [class*="code-block"] {
  direction: ltr !important;
  text-align: left !important;
}
pre code, pre * {
  direction: ltr !important;
  text-align: left !important;
  unicode-bidi: plaintext !important;
}
:not(pre) > code {
  direction: ltr !important;
  unicode-bidi: embed !important;
}

/* ── Lists: proper inline padding ── */
ol, ul {
  padding-inline-start: 2em;
}

/* ── KaTeX ── */
.katex, .katex-display, .katex-html, .katex-mathml,
.katex .base, .katex .strut, .katex .mord, .katex .mbin,
.katex .mrel, .katex .mopen, .katex .mclose, .katex .mfrac,
.katex .msqrt, .katex .msupsub {
  direction: ltr !important;
  text-align: left !important;
  unicode-bidi: isolate !important;
}

/* ── MathJax ── */
mjx-container, mjx-math, mjx-mrow, mjx-mi, mjx-mo, mjx-mn,
mjx-mfrac, mjx-msqrt, mjx-msup, mjx-msub,
.MathJax, .MathJax_Display, .MathJax_Preview, .MJXc-display {
  direction: ltr !important;
  text-align: left !important;
  unicode-bidi: isolate !important;
}
math {
  direction: ltr !important;
  text-align: left !important;
  unicode-bidi: isolate !important;
}`;

  function injectCSS(doc) {
    if (!doc?.head || doc.getElementById(STYLE_ID)) return;
    const style    = doc.createElement("style");
    style.id       = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function removeCSS(doc) {
    doc?.getElementById?.(STYLE_ID)?.remove();
  }

  /* ═══════════════════════════════════════════════════════════════
   * 4. OBSERVE — MutationObserver with correct batch handling
   * ═══════════════════════════════════════════════════════════════ */

  let observer    = null;
  let debounceId  = null;
  let active      = false;
  let isApplying  = false;          // Guard: true while WE are writing to DOM
  let pendingMuts = [];             // Accumulated mutation batches
  const iframeSet = new WeakSet();

  /**
   * Scan a root element: walk all block elements and apply fixes.
   * Uses TreeWalker for efficient traversal, skipping code/math subtrees.
   *
   * CRITICAL: TreeWalker.nextNode() never visits the root itself — only
   * descendants. We must process the root element separately, otherwise
   * added leaf blocks (e.g. a <p> with only text) are never fixed.
   */
  function scanRoot(root) {
    if (!root) return;

    /* Process the root element itself (TreeWalker skips it). */
    if (root.nodeType === Node.ELEMENT_NODE &&
        !SKIP_TAGS.has(root.tagName) &&
        root.tagName !== "PRE" &&
        !isMath(root) &&
        hasMeaningfulText(root)) {
      fixBlock(root);
    }

    /* Then walk all descendant block elements. */
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (SKIP_TAGS.has(node.tagName) || node.tagName === "PRE") {
          return NodeFilter.FILTER_REJECT;
        }
        if (isMath(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (hasMeaningfulText(el)) fixBlock(el);
    }

    /* Protect top-level math elements. */
    for (const m of (root.querySelectorAll?.(SEL_MATH) ?? [])) {
      m.style.direction   = "ltr";
      m.style.textAlign   = "left";
      m.style.unicodeBidi = "isolate";
    }

    fixCodeBlocks(root);
    fixTables(root);
    bindEditables(root);
  }

  /** Scan shadow DOMs attached to elements within root. */
  function scanShadows(root) {
    if (!root?.querySelectorAll) return;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        scanRoot(el.shadowRoot);
        scanShadows(el.shadowRoot);
      }
    }
  }

  /* ─── Iframe handling ─── */

  function setupIframe(iframe) {
    if (iframeSet.has(iframe)) return;
    let doc;
    try { doc = iframe.contentDocument; } catch { return; }
    if (!doc?.body) return;
    iframeSet.add(iframe);

    injectCSS(doc);
    scanRoot(doc.body);

    /* Iframe gets its own observer with the same batch-accumulation pattern. */
    let iframePending = [];
    let iframeTid = null;
    new MutationObserver(muts => {
      iframePending.push(...muts);
      clearTimeout(iframeTid);
      iframeTid = setTimeout(() => {
        const batch = iframePending;
        iframePending = [];
        processMutations(batch);
      }, 200);
    }).observe(doc.body, { childList: true, subtree: true, characterData: true });
  }

  function scanIframes() {
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument?.body) setupIframe(frame);
        else frame.addEventListener("load", () => setupIframe(frame), { once: true });
      } catch { /* cross-origin — ignore */ }
    }
  }

  /* ─── Mutation processing ─── */

  /**
   * Process a batch of MutationRecords.
   *
   * The `isApplying` flag prevents infinite loops:
   * when we write to the DOM (setting style, changing textContent),
   * the observer fires again. With the flag set, the observer callback
   * just accumulates mutations but the processing function skips them.
   */
  function processMutations(mutations) {
    if (isApplying) return;
    isApplying = true;

    try {
      const seen = new Set();
      let needIframeScan = false;

      for (const m of mutations) {
        /* ── Added elements: scan them for RTL text ── */
        for (const node of m.addedNodes) {
          if (seen.has(node)) continue;

          /* Handle text nodes: find parent block and re-process it. */
          if (node.nodeType === Node.TEXT_NODE) {
            const block = node.parentElement?.closest(BLOCK_SELECTOR);
            if (block && !seen.has(block)) {
              seen.add(block);
              delete block.dataset.rtlH;
              fixBlock(block);
            }
            continue;
          }

          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          seen.add(node);
          scanRoot(node);
          if (node.shadowRoot) scanShadows(node);
          if (node.tagName === "IFRAME" || node.querySelector?.("iframe")) {
            needIframeScan = true;
          }
        }

        /* ── Character data: streaming text changes ── */
        if (m.type === "characterData" && m.target.parentElement) {
          const block = m.target.parentElement.closest(BLOCK_SELECTOR);
          if (block && !seen.has(block)) {
            seen.add(block);
            /*
             * Recompute hash on clean (BIDI-stripped) text.
             * If hash differs from stored, the text truly changed
             * (streaming, not our own fixNeutrals edit).
             * Clear the old hash and re-process.
             */
            const current = elementHash(block);
            if (block.dataset.rtlH !== current) {
              delete block.dataset.rtlH;
              fixBlock(block);
            }
          }
        }
      }

      if (needIframeScan) scanIframes();
    } finally {
      isApplying = false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════
   * LIFECYCLE — activate, deactivate, bootstrap
   * ═══════════════════════════════════════════════════════════════ */

  function activate() {
    if (active) return;
    active = true;

    injectCSS(document);
    isApplying = true;
    try {
      scanRoot(document.body);
      scanShadows(document.body);
      scanIframes();
    } finally {
      isApplying = false;
    }

    /*
     * CRITICAL FIX: Accumulate ALL mutation batches in pendingMuts[].
     *
     * In v3.0, each observer callback captured its own `muts` array
     * and clearTimeout killed the previous one — losing all earlier
     * batches. Now we push into a shared array and drain it on tick.
     */
    observer = new MutationObserver(muts => {
      if (isApplying) return;       // Skip mutations caused by our own writes
      pendingMuts.push(...muts);
      clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        const batch = pendingMuts;
        pendingMuts = [];
        processMutations(batch);
      }, 150);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function deactivate() {
    if (!active) return;
    active = false;
    clearTimeout(debounceId);
    pendingMuts = [];
    observer?.disconnect();
    observer = null;

    removeCSS(document);

    /* Clean up all applied styles and data attributes. */
    for (const el of document.querySelectorAll("[data-rtl-h]")) {
      el.style.direction = "";
      el.style.textAlign = "";
      el.style.unicodeBidi = "";
      delete el.dataset.rtlH;
    }
    for (const el of document.querySelectorAll("[data-rtl-c]")) {
      delete el.dataset.rtlC;
    }
  }

  /* ─── Settings hot-reload ─── */

  chrome?.storage?.onChanged?.addListener(() => {
    loadConfig().then(settings => {
      cfg = settings;
      if (isSiteEnabled(cfg)) {
        if (!active) activate();
        else {
          /* Re-scan with new feature flags (e.g., user toggled tableFix). */
          isApplying = true;
          try { scanRoot(document.body); }
          finally { isApplying = false; }
        }
      } else {
        deactivate();
      }
    });
  });

  /* ─── Keyboard-shortcut toast ─── */

  /**
   * Short on-page confirmation shown when the master switch is toggled via
   * the keyboard shortcut (see background.js). Rendered inside a closed
   * shadow root so page styles can't affect it and our own scanner never
   * touches it. Top frame only.
   */
  const TOAST_ID = "rtl-fix-toast";
  let toastTimer = null;

  function showToast(enabled) {
    if (window !== window.top || !document.documentElement) return;

    document.getElementById(TOAST_ID)?.remove();
    clearTimeout(toastTimer);

    const host = document.createElement("div");
    host.id = TOAST_ID;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .t {
          position: fixed; top: 18px; left: 50%; z-index: 2147483647;
          transform: translate(-50%, -12px); opacity: 0;
          transition: opacity .2s ease, transform .2s ease;
          display: flex; align-items: center; gap: 8px;
          padding: 10px 18px; border-radius: 10px;
          background: #12121f; color: #e0e0e0;
          border: 1px solid rgba(139,92,246,.35);
          box-shadow: 0 8px 24px rgba(0,0,0,.35);
          font: 600 13px/1.4 "Noto Kufi Arabic","Segoe UI",Tahoma,system-ui,sans-serif;
          direction: rtl; pointer-events: none;
        }
        .t.show { opacity: 1; transform: translate(-50%, 0); }
        .d { width: 8px; height: 8px; border-radius: 50%; }
        .on  { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
        .off { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
      </style>
      <div class="t" role="status">
        <span class="d ${enabled ? "on" : "off"}"></span>
        <span>RTL Fix ${enabled ? "مفعّلة" : "متوقفة"}</span>
      </div>`;
    document.documentElement.appendChild(host);

    const box = shadow.querySelector(".t");
    requestAnimationFrame(() => box.classList.add("show"));
    toastTimer = setTimeout(() => {
      box.classList.remove("show");
      setTimeout(() => host.remove(), 250);
    }, 1600);
  }

  chrome?.runtime?.onMessage?.addListener(msg => {
    if (msg?.type === "rtl-toast") showToast(!!msg.enabled);
  });

  /* ─── Bootstrap ─── */

  loadConfig().then(settings => {
    cfg = settings;
    if (!isSiteEnabled(cfg)) return;
    if (document.body) activate();
    else document.addEventListener("DOMContentLoaded", activate, { once: true });
  });
})();
