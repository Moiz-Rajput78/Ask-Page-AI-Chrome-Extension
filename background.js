chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Also set it immediately in case the service worker is already active.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
