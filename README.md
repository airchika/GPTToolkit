# GPT Toolkit

A dependency-free Manifest V3 extension with local font controls and practical tools for ChatGPT. ChatGPT owns its appearance: this extension does not change page colors, themes, borders, or layout.

## Fonts

The **Font** tab opens by default. Four independent controls use fonts installed on your computer:

- **Interface:** GPT Default or Sarasa UI SC.
- **Body:** GPT Default, Noto Sans SC, Noto Serif SC, or Sarasa Gothic SC.
- **Code font 1 and 2:** GPT Default, JetBrains Mono, Sarasa Mono SC, Fira Code, or Google Sans Code.

The two code slots form an ordered, deduplicated font stack followed by system monospace fallbacks. Missing local fonts fall back; fonts are never downloaded or bundled. Select **GPT Default** to remove a role's override. Both code slots must be Default to restore the native code stack. Mathematical typesetting keeps its own fonts.

## Bookmarks, Conversation History, Reading Position and LaTeX Copy

These tools are enabled by default and can be switched independently from the **Tools** tab.

The toolbar entries use the visible chat-actions button as their anchor, or the header's **Share** button on the newer title-dropdown layout. Title menus and hidden cached headers are excluded; replacing the header remounts the entries automatically.

- **Bookmarks / 书签** adds a bookmark icon to the left of the directory icon (or chat actions when the directory is disabled). Open it and choose **＋ 添加当前阅读位置** to save the message at the reading edge and the offset within it, including positions inside long answers. Click a saved bookmark to jump; **↶ 回退** restores the positions before your jumps, one at a time. **×** deletes a bookmark. Bookmarks are saved per conversation in `chrome.storage.local` on this browser installation and survive refreshes and reopening the conversation. They are not synced across devices. Disabling the tool keeps saved bookmarks but clears the temporary return stack. Only saved conversations with a `/c/…` URL support bookmarks. If a message is not loaded or belongs to another branch, the panel asks you to load it instead of jumping to a different message. No conversation is fetched; only message identifiers, short previews and offsets are saved.
- **Conversation history / 对话目录** adds a directory icon immediately before the chat actions button in the top toolbar. The icon uses the native button styling in light and dark mode and remains icon-only on hover and focus. Clicking opens the list of your messages. Click an entry to return to that message. Each jump saves the previous scroll position in memory; the **↶ 回退** button beside the directory title pops one position at a time and disappears when the stack is empty. Switching chats or disabling the tool clears the stack. New messages and edits update the list; switching chats resets it. Escape or clicking outside collapses it. Only messages currently loaded in the page can be indexed, including attachment-only messages. The directory itself does not fetch or store conversation data. Disable it independently in **Tools**.
- **Keep reading position** activates only when a real composer form submission happens while the thread is more than 150px from the bottom. It keeps the currently visible turn anchored for at most two seconds, but cancels immediately when you use the wheel, touch scrolling, paging keys, the scrollbar, or ChatGPT's scroll-to-bottom control. Sending at the bottom remains fully native.
- **LaTeX quick copy** shows one small reusable toolbar that follows the active light or dark theme when you click a formula in an assistant response without an active text selection. Choose raw `tex`, inline `$…$`, or display `$$…$$` without changing ChatGPT's formula DOM. Inline copies collapse source line breaks and adjacent whitespace to one space so the result stays on one Markdown line. The raw `tex` choice can be hidden independently; `$…$` and `$$…$$` always remain available.
- The **去框 $** and **去框 $$** options copy inline and display formulas after removing complete outer `\boxed{…}` wrappers, including nested wrappers. Both trim whitespace inside the dollar delimiters and remove trailing commas and periods. Inline copies flatten line breaks; display copies preserve internal line breaks. The original copy options retain boxes; incomplete or partial-formula boxes are preserved.
- Copying a mixed selection containing assistant formulas writes both plain text and HTML, replacing inline and display formulas with the corresponding delimiters while preserving the rest of the selection. Ordinary text selections and ChatGPT's own whole-response copy button remain native.
- Formula source metadata is read locally from `data-math-source`, legacy `data-math`, or the KaTeX `application/x-tex` annotation. GPT Toolkit does not read the clipboard, call a network service, import fonts, or patch global scrolling methods.

If GPT Voyager is installed, disable its **Formula Copy** and **Prevent Auto Scroll** features to avoid duplicate event handling.

## Install or update

1. Clone or download [this repository](https://github.com/airchika/GPTToolkit).
2. Open `chrome://extensions` or `edge://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open ChatGPT, click **GPT Toolkit**, and choose Font or Tools.

For an existing unpacked installation, keep the same folder, click **Reload** on the extension card, then refresh every open ChatGPT tab. Existing tabs can retain the previous content scripts and theme stylesheet until refreshed.

On the same extension installation, GPTskins font and tool settings migrate automatically. Existing GPT Toolkit values take precedence, including disabled switches and Default fonts. Old theme settings are ignored; old storage values are retained. A different extension ID has separate storage and does not automatically inherit settings.

## Development

No build step or runtime packages are required. Permissions remain `activeTab` and `storage`, with content scripts limited to `chatgpt.com` and `chat.openai.com`.

- `shared/fonts.js`: local font options and settings migration.
- `content/`: font-only CSS/runtime and the shared route notification.
- `tools/`: conversation navigation, reading-position protection, LaTeX copying, and tool settings migration.
- `popup/`: Font and Tools settings.
- `icons/toolkit.svg`: editable source for the toolbar PNG icons.
- `tests/`: Node contracts/runtime tests and synthetic browser fixtures.

Run the automated checks:

```sh
node --check content/content.js
node --test tests/*.test.js
git diff --check
```

Optional browser regression tests use an externally installed Playwright and Chromium (no production dependency):

```sh
node tests/browser-regression.cjs
```

Set `BROWSER_CHANNEL=chrome` (PowerShell: `$env:BROWSER_CHANNEL="chrome"`) to use installed Chrome in an isolated headless test profile instead of Playwright's bundled Chromium.

These fixtures test computed styles and tool behavior against synthetic markup; they do not prove compatibility with the current ChatGPT DOM. For live acceptance, reload the extension and ChatGPT, then inspect computed fonts on interface text, responses, code, CodeMirror and formulas. Also check native light/dark appearance, navigation, new messages, reading-position protection, and each LaTeX copy format.

## Origin

GPT Toolkit evolved from [dboyza/GPTskins](https://github.com/dboyza/GPTskins), with subsequent font and tool work in this repository. Version 2 removes the theme engine and adopts its own product name. GPT Toolkit is maintained independently. The original Git history and project attribution are preserved.
