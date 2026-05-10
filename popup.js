/**
 * RTL Fix — Popup v4.0
 *
 * Reads/writes settings to chrome.storage.sync and keeps the UI in sync.
 * Settings object shape mirrors DEFAULTS in content.js.
 */
(() => {
  "use strict";

  /* ───────── defaults (must match content.js) ───────── */

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

  /* ───────── DOM refs ───────── */

  const $ = (id) => document.getElementById(id);

  const ui = {
    master:    $("master"),
    statusBar: $("statusBar"),
    dot:       $("dot"),
    label:     $("statusLabel"),
    host:      $("host"),
    allSites:  $("allSites"),
    code:      $("codeBlockFix"),
    table:     $("tableFix"),
    input:     $("inputFix"),
    secSites:  $("secSites"),
    secOpts:   $("secOpts"),
    siteRows:  document.querySelectorAll(".stoggle"),
  };

  let cfg = { ...DEFAULTS, sites: { ...DEFAULTS.sites } };

  /* ───────── storage helpers ───────── */

  const load = () =>
    new Promise((ok) =>
      chrome.storage.sync.get(DEFAULTS, (r) =>
        ok({ ...DEFAULTS, ...r, sites: { ...DEFAULTS.sites, ...(r.sites || {}) } })
      )
    );

  const save = (data) =>
    new Promise((ok) => chrome.storage.sync.set(data, ok));

  /* ───────── render UI from cfg ───────── */

  function render() {
    const on = cfg.masterEnabled;

    // master
    ui.master.checked = on;
    ui.statusBar.className = "status-bar " + (on ? "on" : "off");
    ui.dot.className       = "dot " + (on ? "on" : "off");
    ui.label.textContent   = on ? "مفعّلة" : "متوقفة";

    // lock sections when master is off
    ui.secSites.classList.toggle("locked", !on);
    ui.secOpts.classList.toggle("locked",  !on);

    // all-sites
    ui.allSites.checked = cfg.allSites;

    // per-site toggles
    ui.siteRows.forEach((inp) => {
      const key = inp.dataset.s;
      inp.checked = cfg.sites[key] ?? false;
      inp.closest(".row").classList.toggle("muted", cfg.allSites);
    });

    // feature toggles
    ui.code.checked  = cfg.codeBlockFix;
    ui.table.checked = cfg.tableFix;
    ui.input.checked = cfg.inputFix;
  }

  /* ───────── event wiring (single handler per toggle) ───────── */

  function bind(el, key, redraw) {
    el.addEventListener("change", async () => {
      cfg[key] = el.checked;
      await save(cfg);
      if (redraw) render();
    });
  }

  bind(ui.master,   "masterEnabled", true);
  bind(ui.allSites, "allSites",      true);
  bind(ui.code,     "codeBlockFix",  false);
  bind(ui.table,    "tableFix",      false);
  bind(ui.input,    "inputFix",      false);

  ui.siteRows.forEach((inp) => {
    inp.addEventListener("change", async () => {
      cfg.sites[inp.dataset.s] = inp.checked;
      await save(cfg);
    });
  });

  /* ───────── current-tab hostname ───────── */

  async function showHost() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      ui.host.textContent = tab?.url ? new URL(tab.url).hostname.replace(/^www\./, "") : "—";
    } catch {
      ui.host.textContent = "—";
    }
  }

  /* ───────── init ───────── */

  (async () => {
    cfg = await load();
    render();
    showHost();
  })();
})();
