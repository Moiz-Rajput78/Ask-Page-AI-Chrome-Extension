const MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }
];

const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_CONTEXT_CHARS = 250000;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 12000;
const MAX_SUMMARY_MEMORY_CHARS = 12000;
const MAX_RETRIEVED_CONTEXT_CHARS = 14000;
const RETRIEVAL_CHUNK_CHARS = 2600;
const RETRIEVAL_CHUNK_OVERLAP = 300;
const SUMMARY_CACHE_STORAGE_KEY = "pageSummaryCacheV1";
const MODEL_STATE_STORAGE_KEY = "geminiModelStateV1";
const SELECTED_MODEL_STORAGE_KEY = "selectedGeminiModelV1";
const MAX_CACHED_SUMMARIES = 20;
const QUOTA_STATE_TTL_MS = 26 * 60 * 60 * 1000;

let activeModel = MODELS[0].id;
let modelStates = {};

let pageContext = "";
let pageTitle = "";
let pageUrl = "";
let selectedText = "";
let sourceType = "Web page";
let pageSummaryMemory = "";
let conversationHistory = [];
let busy = false;
let autoSummaryPending = false;
let autoSummaryCompleted = false;
let currentTabId = null;
let currentTabUrl = "";
let tabRefreshTimer = null;
let pageEpoch = 0;
let activeRequestController = null;

const chatEl = document.getElementById("chat");
const statusEl = document.getElementById("status");
const promptEl = document.getElementById("prompt");
const askButton = document.getElementById("btn-ask");
const settingsButton = document.getElementById("btn-settings");
const settingsDialog = document.getElementById("settingsDialog");
const settingsForm = document.getElementById("settingsForm");
const cancelSettingsButton = document.getElementById("cancelSettings");
const apiKeyInput = document.getElementById("apiKey");
const modelSelector = document.getElementById("modelSelector");
const modelMenu = document.getElementById("modelMenu");
const modelOptionsEl = document.getElementById("modelOptions");
const modelLabelEl = document.getElementById("modelLabel");

window.addEventListener("DOMContentLoaded", async () => {
  await loadSavedKeyIntoSettings();
  await loadModelPreferences();
  renderModelMenu();
  updateModelSelector();

  await refreshActiveTab("Opening extension");
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const senderTabId = sender?.tab?.id ?? null;

  // Ignore late messages from a tab that is no longer active in this side panel.
  if (senderTabId !== null && currentTabId !== null && senderTabId !== currentTabId) {
    return;
  }

  if (message.type === "STATUS") {
    setStatus(message.msg);
    return;
  }

  if (message.type === "PAGE_READ_ERROR") {
    autoSummaryPending = false;
    setBusy(false);
    setStatus(message.message || "Could not read this page.");
    addBubble(message.message || "I could not read this page.", "error");
    return;
  }

  if (message.type === "PAGE_CONTENT") {
    pageContext = message.data || "";
    pageTitle = message.title || "Untitled page";
    pageUrl = message.url || "";
    currentTabUrl = pageUrl || currentTabUrl;
    selectedText = message.selectedText || "";
    sourceType = message.sourceType || "Web page";
    pageSummaryMemory = "";
    conversationHistory = [];

    updateContextCard(message);
    document.getElementById("welcome")?.remove();
    setBusy(false);

    if (!pageContext.trim()) {
      autoSummaryPending = false;
      setStatus("No readable page text found");
      addBubble("I could not find readable text on this page.", "error");
      return;
    }

    setStatus("Page read successfully");

    if (autoSummaryPending && !autoSummaryCompleted) {
      autoSummaryPending = false;
      autoSummaryCompleted = true;
      generateAutomaticSummary();
    }
  }
});

// Keep the already-open side panel synchronized with Chrome tab changes.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleTabRefresh(tabId, "Tab switched");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== currentTabId) return;

  // A URL change means navigation started. Wait for the completed page before scanning.
  if (changeInfo.url) {
    scheduleTabRefresh(tabId, "Page changed");
    return;
  }

  if (changeInfo.status === "complete") {
    scheduleTabRefresh(tabId, "Page loaded");
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  scheduleActiveTabRefresh("Window changed");
});

askButton.addEventListener("click", askManual);

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    askManual();
  }
});

promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 110)}px`;
});

settingsButton.addEventListener("click", async () => {
  await loadSavedKeyIntoSettings();
  settingsDialog.showModal();
});

cancelSettingsButton.addEventListener("click", () => settingsDialog.close());

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = apiKeyInput.value.trim();

  if (!value) {
    await chrome.storage.local.remove("geminiApiKey");
    setStatus("API key removed");
  } else {
    await chrome.storage.local.set({ geminiApiKey: value });
    setStatus("API key saved locally");
  }

  settingsDialog.close();
});

modelSelector.addEventListener("click", (event) => {
  event.stopPropagation();
  const willOpen = modelMenu.hidden;
  modelMenu.hidden = !willOpen;
  modelSelector.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".model-picker")) {
    modelMenu.hidden = true;
    modelSelector.setAttribute("aria-expanded", "false");
  }
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    promptEl.value = chip.dataset.q || "";
    askManual();
  });
});

async function loadModelPreferences() {
  const stored = await chrome.storage.local.get([
    SELECTED_MODEL_STORAGE_KEY,
    MODEL_STATE_STORAGE_KEY
  ]);

  const savedModel = stored[SELECTED_MODEL_STORAGE_KEY];
  if (MODELS.some((model) => model.id === savedModel)) {
    activeModel = savedModel;
  }

  modelStates = pruneModelStates(stored[MODEL_STATE_STORAGE_KEY] || {});
  await chrome.storage.local.set({ [MODEL_STATE_STORAGE_KEY]: modelStates });
}

function pruneModelStates(states) {
  const now = Date.now();
  const next = {};

  for (const [modelId, state] of Object.entries(states || {})) {
    if (
      state?.status === "quota" &&
      Number(state.updatedAt || 0) > 0 &&
      now - Number(state.updatedAt) < QUOTA_STATE_TTL_MS
    ) {
      next[modelId] = state;
    }
  }

  return next;
}

function renderModelMenu() {
  modelOptionsEl.innerHTML = "";

  for (const model of MODELS) {
    const quota = isModelQuotaLimited(model.id);
    const active = model.id === activeModel;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `model-option${active ? " active" : ""}${quota ? " quota" : ""}`;
    button.dataset.model = model.id;

    const dot = document.createElement("span");
    dot.className = "option-dot";

    const copy = document.createElement("span");
    copy.className = "option-copy";

    const name = document.createElement("div");
    name.className = "option-name";
    name.textContent = model.label;

    const status = document.createElement("div");
    status.className = "option-status";
    status.textContent = quota
      ? "Quota/rate limit reached"
      : active
        ? "Currently selected"
        : "Available to select";

    copy.append(name, status);
    button.append(dot, copy);

    if (active) {
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";
      button.appendChild(check);
    }

    button.addEventListener("click", async () => {
      await selectModel(model.id, { userInitiated: true });
      modelMenu.hidden = true;
      modelSelector.setAttribute("aria-expanded", "false");
    });

    modelOptionsEl.appendChild(button);
  }
}

async function selectModel(modelId, { userInitiated = false } = {}) {
  if (!MODELS.some((model) => model.id === modelId)) return;

  const previousModel = activeModel;
  activeModel = modelId;
  await chrome.storage.local.set({ [SELECTED_MODEL_STORAGE_KEY]: modelId });

  updateModelSelector();
  renderModelMenu();

  if (userInitiated && previousModel !== modelId) {
    const quotaText = isModelQuotaLimited(modelId)
      ? " This model was previously marked quota-limited, so the next request will test it again."
      : "";

    addBubble(
      `Switched to ${friendlyModelName(modelId)}. Previous chat memory is preserved.${quotaText}`,
      "system-note"
    );
    setStatus(`Using ${friendlyModelName(modelId)} • chat memory preserved`);
  }
}

function updateModelSelector() {
  modelLabelEl.textContent = friendlyModelName(activeModel);
  const quota = isModelQuotaLimited(activeModel);
  modelSelector.classList.toggle("quota", quota);
  modelSelector.title = quota
    ? `${friendlyModelName(activeModel)} was marked quota-limited. Click to switch models.`
    : `Using ${friendlyModelName(activeModel)}. Click to switch models.`;
}

function isModelQuotaLimited(modelId) {
  return modelStates?.[modelId]?.status === "quota";
}

async function markModelQuotaLimited(modelId) {
  modelStates[modelId] = {
    status: "quota",
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({ [MODEL_STATE_STORAGE_KEY]: modelStates });
  updateModelSelector();
  renderModelMenu();
}

async function markModelHealthy(modelId) {
  if (!modelStates[modelId]) return;
  delete modelStates[modelId];
  await chrome.storage.local.set({ [MODEL_STATE_STORAGE_KEY]: modelStates });
  updateModelSelector();
  renderModelMenu();
}

function scheduleTabRefresh(tabId, reason) {
  clearTimeout(tabRefreshTimer);
  tabRefreshTimer = setTimeout(() => {
    refreshTab(tabId, reason).catch((error) => {
      console.error("Tab refresh failed:", error);
    });
  }, 220);
}

function scheduleActiveTabRefresh(reason) {
  clearTimeout(tabRefreshTimer);
  tabRefreshTimer = setTimeout(() => {
    refreshActiveTab(reason).catch((error) => {
      console.error("Active-tab refresh failed:", error);
    });
  }, 220);
}

async function refreshActiveTab(reason = "Active tab detected") {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    showTabReadError("No active browser tab was found.");
    return;
  }

  await refreshTab(tab.id, reason, tab);
}

async function refreshTab(tabId, reason = "Tab changed", knownTab = null) {
  let tab = knownTab;

  try {
    tab = tab || await chrome.tabs.get(tabId);
  } catch (_) {
    return;
  }

  // Ignore events for a tab that stopped being the active tab before our debounce fired.
  if (!tab?.active) return;

  const tabUrl = tab.url || "";
  const isSamePage = tabId === currentTabId && tabUrl === currentTabUrl;

  // A duplicate completed event for the exact page does not need another scan.
  if (isSamePage && reason === "Page loaded" && pageContext) return;

  prepareForTab(tab, reason);

  if (isRestrictedUrl(tabUrl)) {
    showTabReadError(
      "Chrome does not allow extensions to read this browser page. Open a normal website or Google Doc."
    );
    return;
  }

  if (tab.status === "loading") {
    setStatus(`${reason} — waiting for the page to finish loading…`);
    return;
  }

  await readCurrentPage(tab);
}

function prepareForTab(tab, reason) {
  activeRequestController?.abort();
  activeRequestController = null;
  pageEpoch += 1;

  currentTabId = tab.id;
  currentTabUrl = tab.url || "";

  pageContext = "";
  pageTitle = tab.title || "Untitled page";
  pageUrl = tab.url || "";
  selectedText = "";
  sourceType = "Web page";
  pageSummaryMemory = "";
  conversationHistory = [];
  autoSummaryPending = true;
  autoSummaryCompleted = false;

  removeTyping();
  clearConversationBubbles();
  hideContextCard();
  setBusy(false);
  setStatus(`${reason} — detecting current page…`);
}

function clearConversationBubbles() {
  chatEl.querySelectorAll(".bubble").forEach((bubble) => bubble.remove());
}

function hideContextCard() {
  const card = document.getElementById("contextCard");
  card?.classList.remove("show");
}

function showTabReadError(message) {
  autoSummaryPending = false;
  autoSummaryCompleted = false;
  setBusy(false);
  setStatus("Unable to read page");
  clearConversationBubbles();
  addBubble(message, "error");
}

async function readCurrentPage(tabOverride = null) {
  const requestEpoch = pageEpoch;

  setBusy(true);
  setStatus("Reading the complete current page…");

  try {
    const tab = tabOverride || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    if (currentTabId !== null && tab.id !== currentTabId) {
      return;
    }

    if (isRestrictedUrl(tab.url)) {
      throw new Error(
        "Chrome does not allow extensions to read this browser page. Open a normal website or Google Doc."
      );
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (error) {
    if (requestEpoch !== pageEpoch) return;

    autoSummaryPending = false;
    setBusy(false);
    setStatus("Unable to read page");
    addBubble(error.message || "Unable to read this page.", "error");
  }
}

async function generateAutomaticSummary() {
  if (!pageContext || busy) return;

  const summaryPrompt = `Create a complete, well-structured summary of the entire page/document that was provided as context.

Include all important information that is actually present on the page. Organize the summary with useful headings and bullet points where appropriate.

Cover, when applicable:
- Overall purpose or topic
- Main objective
- Important sections and their key details
- Requirements, features, facts, or concepts
- Technologies, tools, people, products, or entities mentioned
- Important decisions, instructions, action items, or next steps
- Any constraints, warnings, dates, numbers, or other significant details
- A short conclusion

Do not invent information. Do not intentionally skip important sections just to make the answer short. The goal is a complete summary of the page, not a brief overview.`;

  const cacheKey = buildSummaryCacheKey();
  const cached = await getCachedSummary(cacheKey);

  if (cached?.summary) {
    document.getElementById("welcome")?.remove();
    addBubble(cached.summary, "ai");
    pageSummaryMemory = cached.summary;

    if (cached.model && MODELS.some((model) => model.id === cached.model)) {
      activeModel = cached.model;
      await chrome.storage.local.set({ [SELECTED_MODEL_STORAGE_KEY]: activeModel });
      updateModelSelector();
      renderModelMenu();
    }

    setStatus(`Loaded saved summary • ${friendlyModelName(activeModel)}`);
    return;
  }

  setStatus("Page read — generating complete summary…");
  const result = await askQuestion(summaryPrompt, {
    showUserBubble: false,
    addToHistory: false,
    summaryMode: true
  });

  if (result?.text) {
    pageSummaryMemory = result.text;

    await saveCachedSummary(cacheKey, {
      summary: result.text,
      model: result.model,
      url: pageUrl,
      title: pageTitle,
      savedAt: Date.now()
    });
  }
}

async function askManual() {
  const question = promptEl.value.trim();
  if (!question || busy) return;

  if (!pageContext) {
    addBubble("I am still reading the current page. Please wait a moment.", "error");
    return;
  }

  promptEl.value = "";
  promptEl.style.height = "auto";
  await askQuestion(question);
}

async function askQuestion(
  question,
  { showUserBubble = true, addToHistory = true, summaryMode = false } = {}
) {
  const requestEpoch = pageEpoch;
  const controller = new AbortController();
  activeRequestController?.abort();
  activeRequestController = controller;

  if (showUserBubble) {
    addBubble(question, "user");
  }

  setBusy(true);
  addBubble(summaryMode ? "Creating complete summary…" : "Thinking…", "ai", true);

  try {
    const result = await callGemini(question, {
      summaryMode,
      signal: controller.signal
    });

    if (requestEpoch !== pageEpoch) return null;

    const answer = result.text;
    activeModel = result.model;
    await chrome.storage.local.set({ [SELECTED_MODEL_STORAGE_KEY]: activeModel });

    removeTyping();
    addBubble(answer, "ai");

    if (summaryMode) {
      pageSummaryMemory = answer;
    }

    if (addToHistory) {
      conversationHistory.push(
        { role: "user", text: question },
        { role: "model", text: answer }
      );
      trimConversationHistory();
    }

    updateModelSelector();
    renderModelMenu();

    setStatus(
      summaryMode
        ? `Complete page summary ready • ${friendlyModelName(result.model)}`
        : `Answered with ${friendlyModelName(result.model)} • compact memory used`
    );

    return result;
  } catch (error) {
    if (requestEpoch !== pageEpoch || error?.name === "AbortError") {
      return null;
    }

    removeTyping();
    addBubble(error.message || "Gemini request failed.", "error");
    setStatus("Request failed");
  } finally {
    if (activeRequestController === controller) {
      activeRequestController = null;
    }

    if (requestEpoch === pageEpoch) {
      setBusy(false);
    }
  }

  return null;
}

async function callGemini(question, { summaryMode = false, signal = null } = {}) {
  const apiKey = await requireApiKey();
  const history = buildCompactHistory();
  const pageBlock = buildPageBlock(question, { summaryMode });

  const contents = [
    {
      role: "user",
      parts: [
        {
          text: summaryMode
            ? `Use this current-page context as the source for the complete summary.\n\n${pageBlock}`
            : `Use this compact current-page memory and retrieved page sections as the primary source for the conversation.\n\n${pageBlock}`
        }
      ]
    },
    {
      role: "model",
      parts: [
        {
          text: summaryMode
            ? "I will summarize the supplied page context accurately."
            : "I have the compact page memory and relevant page sections. I will keep the conversation grounded in them."
        }
      ]
    },
    ...history,
    {
      role: "user",
      parts: [{ text: question }]
    }
  ];

  const body = {
    systemInstruction: {
      parts: [
        {
          text: summaryMode
            ? "You are an Ask Gemini-style browser assistant. Create a comprehensive and accurate summary of the supplied current-page content. Cover all important sections and details in the available page context. Use clear headings and bullet points. Do not invent facts and do not claim to have read content that is absent from the supplied context."
            : "You are an Ask Gemini-style browser side-panel assistant. Answer using the supplied page summary, retrieved page sections, and recent conversation. Preserve conversational continuity even if the underlying Gemini model changes. Be factual and grounded in the page. If the supplied evidence is insufficient, say so clearly. Use clean Markdown when useful."
        }
      ]
    },
    contents,
    generationConfig: {
      temperature: summaryMode ? 0.15 : 0.25,
      maxOutputTokens: summaryMode ? 4096 : 2200
    }
  };

  return geminiFetch(body, apiKey, signal);
}

function buildPageBlock(question, { summaryMode = false } = {}) {
  if (summaryMode) {
    const fullContext = pageContext.slice(0, MAX_CONTEXT_CHARS);

    return [
      `PAGE TITLE: ${pageTitle}`,
      `PAGE URL: ${pageUrl}`,
      `SOURCE TYPE: ${sourceType}`,
      selectedText ? `SELECTED TEXT:\n${selectedText}` : "",
      `PAGE CONTENT:\n${fullContext}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const retrieved = retrieveRelevantPageSections(question);
  const summaryMemory = pageSummaryMemory
    ? pageSummaryMemory.slice(0, MAX_SUMMARY_MEMORY_CHARS)
    : "No automatic summary memory is available yet.";

  return [
    `PAGE TITLE: ${pageTitle}`,
    `PAGE URL: ${pageUrl}`,
    `SOURCE TYPE: ${sourceType}`,
    selectedText ? `CURRENT SELECTED TEXT:\n${selectedText.slice(0, 5000)}` : "",
    `PAGE SUMMARY MEMORY:\n${summaryMemory}`,
    retrieved ? `RELEVANT PAGE SECTIONS:\n${retrieved}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function retrieveRelevantPageSections(question) {
  const chunks = chunkText(pageContext, RETRIEVAL_CHUNK_CHARS, RETRIEVAL_CHUNK_OVERLAP);
  if (!chunks.length) return "";

  const queryTerms = tokenize(question);

  const scored = chunks.map((text, index) => ({
    text,
    index,
    score: scoreChunk(text, queryTerms)
  }));

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = [];
  let totalChars = 0;

  for (const item of scored) {
    if (chosen.length >= 6) break;
    if (totalChars + item.text.length > MAX_RETRIEVED_CONTEXT_CHARS && chosen.length >= 2) break;

    chosen.push(item);
    totalChars += item.text.length;
  }

  chosen.sort((a, b) => a.index - b.index);

  return chosen
    .map((item, index) => `--- Relevant section ${index + 1} ---\n${item.text}`)
    .join("\n\n")
    .slice(0, MAX_RETRIEVED_CONTEXT_CHARS);
}

function chunkText(text, chunkSize, overlap) {
  const clean = String(text || "").trim();
  if (!clean) return [];

  const chunks = [];
  const step = Math.max(1, chunkSize - overlap);

  for (let start = 0; start < clean.length; start += step) {
    const chunk = clean.slice(start, start + chunkSize).trim();
    if (chunk) chunks.push(chunk);
    if (start + chunkSize >= clean.length) break;
  }

  return chunks;
}

function tokenize(text) {
  const stopWords = new Set([
    "the","and","for","that","this","with","from","what","when","where","which","who","how","are","was","were","have","has","had","can","could","would","should","about","into","your","you","page","please","tell","give","show","does","did","its","their","there","then","than"
  ]);

  return [...new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 2 && !stopWords.has(term))
  )];
}

function scoreChunk(text, queryTerms) {
  if (!queryTerms.length) return 0;

  const haystack = text.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    let fromIndex = 0;
    let count = 0;

    while (count < 8) {
      const found = haystack.indexOf(term, fromIndex);
      if (found === -1) break;
      count += 1;
      fromIndex = found + term.length;
    }

    score += count * (term.length >= 7 ? 2 : 1);
  }

  return score;
}

function buildCompactHistory() {
  const selected = [];
  let chars = 0;

  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    const item = conversationHistory[index];
    const text = String(item?.text || "");

    if (selected.length >= MAX_HISTORY_MESSAGES) break;
    if (chars + text.length > MAX_HISTORY_CHARS && selected.length >= 2) break;

    selected.push({
      role: item.role,
      parts: [{ text: text.slice(0, 5000) }]
    });
    chars += Math.min(text.length, 5000);
  }

  return selected.reverse();
}

function trimConversationHistory() {
  conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);

  let total = conversationHistory.reduce(
    (sum, item) => sum + String(item?.text || "").length,
    0
  );

  while (conversationHistory.length > 2 && total > MAX_HISTORY_CHARS) {
    const removed = conversationHistory.splice(0, 2);
    total -= removed.reduce((sum, item) => sum + String(item?.text || "").length, 0);
  }
}

async function geminiFetch(body, apiKey, signal = null) {
  let lastError = null;
  const orderedModels = getModelAttemptOrder();

  for (let modelIndex = 0; modelIndex < orderedModels.length; modelIndex += 1) {
    const model = orderedModels[modelIndex];
    const apiUrl = `${API_BASE_URL}/${model}:generateContent`;
    const maxServerAttempts = 2;

    for (let attempt = 1; attempt <= maxServerAttempts; attempt += 1) {
      const switched = model !== activeModel;
      setStatus(
        attempt === 1
          ? `Thinking with ${friendlyModelName(model)}${switched ? " (switching)" : ""}…`
          : `${friendlyModelName(model)} is busy — retrying…`
      );

      let response;

      try {
        response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(body),
          signal
        });
      } catch (error) {
        if (error?.name === "AbortError") throw error;

        lastError = new Error(
          "Could not connect to Gemini. Check your internet connection and try again."
        );

        if (attempt < maxServerAttempts) {
          await sleep(1500 * 2 ** (attempt - 1));
          continue;
        }

        break;
      }

      let data;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }

      if (response.ok && !data?.error) {
        const text = (data?.candidates || [])
          .flatMap((candidate) => candidate?.content?.parts || [])
          .map((part) => part?.text || "")
          .join("\n")
          .trim();

        if (!text) {
          const reason = data?.candidates?.[0]?.finishReason;
          throw new Error(
            reason ? `Gemini returned no text (${reason}).` : "Gemini returned no text."
          );
        }

        await markModelHealthy(model);

        if (activeModel !== model) {
          const previous = activeModel;
          activeModel = model;
          await chrome.storage.local.set({ [SELECTED_MODEL_STORAGE_KEY]: model });
          updateModelSelector();
          renderModelMenu();
          addBubble(
            `Switched from ${friendlyModelName(previous)} to ${friendlyModelName(model)}. Previous chat memory was preserved.`,
            "system-note"
          );
        }

        return { text, model };
      }

      const status = response.status;
      const message = data?.error?.message || `Gemini request failed (${status}).`;

      if (status === 401 || status === 403) {
        throw new Error(
          `Gemini authentication failed. Open ⚙ and check your API key. ${message}`
        );
      }

      if (status === 429) {
        lastError = new Error(message);
        await markModelQuotaLimited(model);

        const nextModel = orderedModels.slice(modelIndex + 1).find(
          (candidate) => !isModelQuotaLimited(candidate)
        );

        if (nextModel) {
          if (activeModel === model) {
            modelSelector.classList.add("quota");
          }

          setStatus(
            `${friendlyModelName(model)} quota reached — switching to ${friendlyModelName(nextModel)}…`
          );
          await sleep(450);
          break;
        }

        throw new Error(
          "All configured Gemini models are currently marked as quota/rate limited. Open the model selector to retry a model after its quota resets."
        );
      }

      if (status === 503 || status >= 500) {
        lastError = new Error(message);

        if (attempt < maxServerAttempts) {
          await sleep(1500 * 2 ** (attempt - 1));
          continue;
        }

        break;
      }

      throw new Error(message);
    }
  }

  throw lastError || new Error("Gemini request failed on all configured models.");
}

function getModelAttemptOrder() {
  const ids = MODELS.map((model) => model.id);
  const startIndex = Math.max(0, ids.indexOf(activeModel));
  const rotated = [...ids.slice(startIndex), ...ids.slice(0, startIndex)];

  const healthy = rotated.filter((model) => !isModelQuotaLimited(model));
  const limited = rotated.filter((model) => isModelQuotaLimited(model));

  if (healthy.length) return [...healthy, ...limited];
  return rotated;
}

function friendlyModelName(model) {
  return MODELS.find((entry) => entry.id === model)?.label || String(model || "Gemini");
}

function buildSummaryCacheKey() {
  return `${pageUrl}::${hashString(pageContext)}`;
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

async function getCachedSummary(cacheKey) {
  const stored = await chrome.storage.local.get(SUMMARY_CACHE_STORAGE_KEY);
  const cache = stored[SUMMARY_CACHE_STORAGE_KEY] || {};
  return cache[cacheKey] || null;
}

async function saveCachedSummary(cacheKey, entry) {
  const stored = await chrome.storage.local.get(SUMMARY_CACHE_STORAGE_KEY);
  const cache = stored[SUMMARY_CACHE_STORAGE_KEY] || {};

  cache[cacheKey] = entry;

  const trimmedEntries = Object.entries(cache)
    .sort(([, a], [, b]) => Number(b?.savedAt || 0) - Number(a?.savedAt || 0))
    .slice(0, MAX_CACHED_SUMMARIES);

  await chrome.storage.local.set({
    [SUMMARY_CACHE_STORAGE_KEY]: Object.fromEntries(trimmedEntries)
  });
}

async function requireApiKey() {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (geminiApiKey) return geminiApiKey;

  await loadSavedKeyIntoSettings();
  settingsDialog.showModal();
  throw new Error(
    "Add your Gemini API key using the ⚙ settings button. After saving it, close and reopen the extension to generate the automatic summary."
  );
}

async function loadSavedKeyIntoSettings() {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  apiKeyInput.value = geminiApiKey || "";
}

function updateContextCard(message) {
  document.getElementById("contextCard").classList.add("show");
  document.getElementById("ctxTitle").textContent = pageTitle;
  document.getElementById("ctxUrl").textContent = pageUrl;

  const details = [
    sourceType,
    `${pageContext.length.toLocaleString()} chars`,
    `${Number(message.totalParagraphs || 0).toLocaleString()} sections`,
    selectedText ? "selection detected" : "",
    message.truncated ? "content capped" : ""
  ].filter(Boolean);

  document.getElementById("ctxMeta").textContent = details.join(" • ");
}

function addBubble(text, type, isTyping = false) {
  if (isTyping) removeTyping();

  const bubble = document.createElement("div");
  bubble.className = `bubble ${type}${isTyping ? " typing" : ""}`;

  if (isTyping) {
    bubble.id = "typing";
  }

  if (type === "ai" && !isTyping) {
    bubble.innerHTML = renderSafeMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  chatEl.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderSafeMarkdown(text) {
  const escaped = escapeHtml(text);

  return escaped
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^###\s+(.+)$/gm, "<strong>$1</strong>")
    .replace(/^##\s+(.+)$/gm, "<strong>$1</strong>")
    .replace(/^#\s+(.+)$/gm, "<strong>$1</strong>")
    .replace(/^[-*]\s+(.+)$/gm, "• $1")
    .replace(/\n/g, "<br>");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function removeTyping() {
  document.getElementById("typing")?.remove();
}

function setBusy(value) {
  busy = value;
  askButton.disabled = value;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function isRestrictedUrl(url = "") {
  return (
    /^(chrome|edge|brave|about|view-source|chrome-extension):/i.test(url) ||
    url.startsWith("https://chromewebstore.google.com/")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
