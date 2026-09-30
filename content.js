(async () => {
  const MAX_CHARS = 250000;

  const sendStatus = (message) => {
    try {
      chrome.runtime.sendMessage({ type: "STATUS", msg: message });
    } catch (_) {
      // Side panel may have closed while the page was being read.
    }
  };

  const normalizeText = (text) =>
    String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const getSelectionText = () => {
    const selection = window.getSelection?.();
    return normalizeText(selection ? selection.toString() : "");
  };

  const createTextCollector = () => {
    const seen = new Set();
    const chunks = [];
    let totalChars = 0;

    return {
      add(text) {
        if (totalChars >= MAX_CHARS) return false;

        const normalized = normalizeText(text);
        if (!normalized || normalized.length < 2) return true;

        const key =
          normalized.length > 1200
            ? `${normalized.slice(0, 600)}\n…\n${normalized.slice(-500)}`
            : normalized;

        if (seen.has(key)) return true;
        seen.add(key);

        const remaining = MAX_CHARS - totalChars;
        const value = normalized.slice(0, remaining);
        chunks.push(value);
        totalChars += value.length + 2;

        return totalChars < MAX_CHARS;
      },

      getText() {
        return normalizeText(chunks.join("\n\n"));
      },

      get count() {
        return chunks.length;
      },

      get full() {
        return totalChars >= MAX_CHARS;
      }
    };
  };

  const isHiddenByStyle = (element) => {
    if (!(element instanceof Element)) return true;

    const style = window.getComputedStyle(element);
    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    );
  };

  const getTextFromElement = (element) => {
    if (!element || isHiddenByStyle(element)) return "";

    const tag = element.tagName?.toLowerCase();
    if (["script", "style", "noscript", "svg", "canvas", "template"].includes(tag)) {
      return "";
    }

    return normalizeText(element.innerText || element.textContent || "");
  };

  const collectSemanticPageText = (collector) => {
    const selectors = [
      "main",
      "article",
      '[role="main"]',
      "section",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "li",
      "blockquote",
      "pre",
      "table",
      "dl",
      "figcaption",
      '[role="article"]',
      '[role="listitem"]',
      '[role="row"]',
      '[aria-label]'
    ];

    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (collector.full) break;

      const text = getTextFromElement(element);
      if (text.length >= 2) collector.add(text);
    }
  };

  const collectOpenShadowRoots = (root, collector) => {
    const elements = root.querySelectorAll?.("*") || [];

    for (const element of elements) {
      if (collector.full) return;

      if (element.shadowRoot) {
        const text = normalizeText(element.shadowRoot.textContent || "");
        if (text) collector.add(text);
        collectOpenShadowRoots(element.shadowRoot, collector);
      }
    }
  };

  const readWebPageWithoutScrolling = async () => {
    sendStatus("Reading webpage without scrolling…");

    const collector = createTextCollector();

    // Prefer semantic content first so navigation and repeated chrome do not
    // dominate the context.
    collectSemanticPageText(collector);

    if (!collector.full) {
      const preferred =
        document.querySelector("main") ||
        document.querySelector("article") ||
        document.querySelector('[role="main"]');

      const preferredText = getTextFromElement(preferred);
      if (preferredText) collector.add(preferredText);
    }

    // Capture text already present in open shadow DOM trees used by many SPAs.
    if (!collector.full) {
      collectOpenShadowRoots(document, collector);
    }

    // Final fallback: body.innerText contains text currently present in the DOM,
    // even when it is below the current viewport, without changing scroll position.
    if (!collector.full) {
      const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
      if (bodyText) collector.add(bodyText);
    }

    const text = collector.getText();

    return {
      text: text.slice(0, MAX_CHARS),
      sections: collector.count,
      truncated: collector.full || text.length > MAX_CHARS
    };
  };

  const readGoogleDocWithoutScrolling = async () => {
    sendStatus("Reading Google Doc without scrolling…");

    const collector = createTextCollector();

    // Google Docs can virtualize long documents, so this captures every part
    // that is already rendered in the DOM without moving the user's document.
    const selectors = [
      ".kix-paragraphrenderer",
      ".kix-lineview-text-block",
      ".kix-lineview-content",
      '[role="textbox"]',
      '[aria-label]'
    ];

    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (collector.full) break;
      const text = normalizeText(element.innerText || element.textContent || "");
      if (text) collector.add(text);
    }

    if (!collector.full) {
      const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
      if (bodyText) collector.add(bodyText);
    }

    const text = collector.getText();

    return {
      text: text.slice(0, MAX_CHARS),
      sections: collector.count,
      truncated: collector.full || text.length > MAX_CHARS
    };
  };

  try {
    const title = document.title || "Untitled page";
    const url = location.href;
    const selectedText = getSelectionText();
    const isGoogleDoc =
      /(^|\.)docs\.google\.com$/.test(location.hostname) &&
      location.pathname.startsWith("/document/");

    const result = isGoogleDoc
      ? await readGoogleDocWithoutScrolling()
      : await readWebPageWithoutScrolling();

    if (!result.text) {
      throw new Error("No readable text was found on this page.");
    }

    chrome.runtime.sendMessage({
      type: "PAGE_CONTENT",
      data: result.text,
      title,
      url,
      selectedText,
      totalParagraphs: result.sections,
      truncated: result.truncated,
      sourceType: isGoogleDoc ? "Google Doc" : "Web page"
    });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: "PAGE_READ_ERROR",
      message: error?.message || "Could not read this page."
    });
  }
})();
