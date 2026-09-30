# Ask Page AI — Chrome Side Panel Extension

A Manifest V3 browser extension inspired by Ask Gemini. It reads the current webpage or Google Doc, lets the user ask grounded follow-up questions, and can analyze a screenshot of the visible tab with Gemini.

## Features

- Chrome side-panel interface
- Read current webpage
- Google Docs reading support
- Selected-text detection
- Follow-up conversation history
- Quick prompt chips
- Visible-tab screenshot analysis
- Gemini 3.8 Flash integration
- API key stored in `chrome.storage.local` for local/demo use

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Pin the extension if desired.
6. Open a normal webpage or Google Doc and click the extension icon.

## Configure Gemini

1. Open the extension side panel.
2. Click the **⚙** button.
3. Paste your Gemini API key.
4. Click **Save**.

The key is not hard-coded in the source. For a production extension distributed to other users, do not ship a shared Gemini key in the extension. Route Gemini requests through a secure backend and keep the production secret there.

## Important limitation

Browser extensions cannot inject scripts into protected Chrome pages such as `chrome://extensions` or the Chrome Web Store. Open a regular website when testing page reading.
