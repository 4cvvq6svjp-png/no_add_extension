const STORAGE_KEY = "no_add_extension_runtime_stats";

function updateRuntimeStats(partialStats) {
  chrome.storage.session
    .get(STORAGE_KEY)
    .then((result) => {
      const previous = result?.[STORAGE_KEY] ?? {};
      const next = { ...previous, ...partialStats, updatedAt: Date.now() };
      return chrome.storage.session.set({ [STORAGE_KEY]: next });
    })
    .catch(() => {
      // Le service worker doit rester silencieux en cas d'échec de stockage.
    });
}

chrome.runtime.onInstalled.addListener(() => {
  updateRuntimeStats({ installed: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "runtime:ping") {
    updateRuntimeStats({
      lastPingFromTabId: sender?.tab?.id ?? null,
      lastPingAt: Date.now()
    });
    sendResponse({ ok: true, from: "service-worker" });
    return true;
  }

  if (message?.type === "runtime:get-stats") {
    chrome.storage.session
      .get(STORAGE_KEY)
      .then((result) => sendResponse(result?.[STORAGE_KEY] ?? {}))
      .catch(() => sendResponse({}));
    return true;
  }

  return false;
});
