/**
 * RTL Fix — Background service worker v4.2
 *
 * Handles the global keyboard shortcut (default Alt+Shift+R) that toggles
 * the master switch without opening the popup. The content script picks up
 * the change via chrome.storage.onChanged; we additionally message the
 * active tab so it can show a short on-page toast confirming the new state.
 */
"use strict";

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-rtl") return;

  const { masterEnabled = true } = await chrome.storage.sync.get({ masterEnabled: true });
  const next = !masterEnabled;
  await chrome.storage.sync.set({ masterEnabled: next });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      await chrome.tabs.sendMessage(tab.id, { type: "rtl-toast", enabled: next }, { frameId: 0 });
    }
  } catch {
    /* No content script on this tab (e.g. chrome:// pages) — nothing to show. */
  }
});
