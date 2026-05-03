chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CAPTURE') return;

  chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ error: chrome.runtime.lastError.message });
      return;
    }
    // Strip the data URL prefix to get raw base64
    const base64 = dataUrl.split(',')[1];
    sendResponse({ screenshot: base64 });
  });

  return true; // keep message channel open for async sendResponse
});
