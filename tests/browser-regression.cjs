// Optional synthetic browser checks. Install Playwright outside the extension.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = path.resolve(root, "." + (/^\/c\/fixture-/.test(pathname) ? "/tests/fixtures/tools-browser.html" : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", ({".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".png":"image/png"})[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? {channel: process.env.BROWSER_CHANNEL} : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    // Persisted bookmarks: long-answer offsets, nested/page return, reload and route isolation.
    await page.goto(base + "/c/fixture-bookmarks");
    const bookmarks = page.locator("#gpttoolkit-conversation-bookmarks");
    const bookmarkToggle = bookmarks.locator(":scope > button");
    const bookmarkPanel = page.locator("#gpttoolkit-bookmarks-panel");
    const savedBookmarks = bookmarkPanel.locator("[data-gpttoolkit-bookmark-jump]");
    const bookmarkBack = bookmarkPanel.locator("[data-gpttoolkit-bookmark-back]");
    const bookmarkScroll = () => page.evaluate(() => ({top:document.getElementById("thread-scroll").scrollTop, page:document.scrollingElement.scrollTop}));
    const setupBookmarkThread = () => page.evaluate(() => {
      document.body.style.minHeight = "2400px";
      Object.assign(document.querySelector("header").style, {position:"fixed", top:"0", right:"0", zIndex:"100"});
      document.querySelector("main").innerHTML = Array.from({length:4}, (_, i) =>
        `<section data-chatgpt-search-unit-key="message-${i}:${i % 2 ? 'user' : 'assistant'}" style="height:900px"><div data-message-author-role="${i % 2 ? 'user' : 'assistant'}" style="height:100%">Saved message ${i} &lt;script&gt;safe&lt;/script&gt;</div></section>`).join("");
    });
    await setupBookmarkThread();
    await bookmarks.waitFor();
    await page.waitForFunction(() => document.getElementById("gpttoolkit-conversation-bookmarks")?.nextElementSibling?.id === "gpttoolkit-conversation-history");
    await page.evaluate(() => { document.getElementById("thread-scroll").scrollTop = 1250; window.scrollTo(0, 40); });
    const savedPosition = await bookmarkScroll();
    await bookmarkToggle.click();
    await bookmarkPanel.locator("[data-gpttoolkit-bookmark-add]").click();
    assert.equal(await savedBookmarks.count(), 1);
    assert.match(await savedBookmarks.first().textContent(), /Saved message 1 <script>safe<\/script>/);
    assert.equal(await bookmarkPanel.locator("script").count(), 0);
    await bookmarkPanel.locator("[data-gpttoolkit-bookmark-add]").click();
    assert.equal(await savedBookmarks.count(), 1, "same position is deduplicated");
    await page.evaluate(() => { document.getElementById("thread-scroll").scrollTop = 100; window.scrollTo(0, 0); });
    const beforeFirstJump = await bookmarkScroll();
    await savedBookmarks.first().click();
    assert.equal((await bookmarkScroll()).top, savedPosition.top, "restore offset inside long message");
    const beforeSecondJump = await bookmarkScroll();
    await savedBookmarks.first().click();
    await bookmarkBack.click();
    assert.deepEqual(await bookmarkScroll(), beforeSecondJump);
    await bookmarkBack.click();
    assert.deepEqual(await bookmarkScroll(), beforeFirstJump);
    assert.equal(await bookmarkBack.isVisible(), false);
    const bookmarkLight = await bookmarkPanel.evaluate(el => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    assert.notEqual(await bookmarkPanel.evaluate(el => getComputedStyle(el).backgroundColor), bookmarkLight);
    await page.reload();
    await setupBookmarkThread();
    await bookmarkToggle.click();
    assert.equal(await savedBookmarks.count(), 1, "bookmark survives a full content-script reload");
    await savedBookmarks.first().click();
    assert.equal((await bookmarkScroll()).top, savedPosition.top);
    await page.evaluate(() => {
      history.pushState({}, "", "/c/fixture-other");
      window.dispatchEvent(new Event("gpttoolkit:routechange"));
    });
    await bookmarkToggle.click();
    assert.equal(await savedBookmarks.count(), 0);
    assert.equal(await bookmarkBack.isVisible(), false);
    await page.evaluate(() => {
      history.pushState({}, "", "/c/fixture-bookmarks");
      window.dispatchEvent(new Event("gpttoolkit:routechange"));
    });
    await bookmarkToggle.click();
    assert.equal(await savedBookmarks.count(), 1);
    await page.evaluate(() => document.querySelector('[data-chatgpt-search-unit-key="message-1:user"]').remove());
    const beforeMissingJump = await bookmarkScroll();
    await savedBookmarks.first().click();
    assert.deepEqual(await bookmarkScroll(), beforeMissingJump);
    assert.match(await bookmarkPanel.locator('[role="status"]').textContent(), /尚未加载/);
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.bookmarks.enabled":{newValue:false}}, "sync")));
    assert.equal(await bookmarks.count(), 0);
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.bookmarks.enabled":{newValue:true}}, "sync")));
    await bookmarkToggle.click();
    assert.equal(await savedBookmarks.count(), 1, "disable keeps persistent records");
    await page.evaluate(() => {
      globalThis.fixtureOriginalSet = chrome.storage.local.set;
      chrome.storage.local.set = (_values, callback) => {
        chrome.runtime.lastError = {message:"fixture quota failure"};
        callback();
        delete chrome.runtime.lastError;
      };
    });
    await bookmarkPanel.locator("[data-gpttoolkit-bookmark-remove]").click();
    assert.equal(await savedBookmarks.count(), 1, "failed deletion keeps the persisted record");
    assert.match(await bookmarkPanel.locator('[role="status"]').textContent(), /保存失败/);
    await page.evaluate(() => { chrome.storage.local.set = fixtureOriginalSet; });
    // A delayed read from the old conversation must not replace the new list.
    await page.evaluate(() => {
      globalThis.fixtureOriginalGet = chrome.storage.local.get;
      globalThis.fixturePendingReads = [];
      chrome.storage.local.get = (key, callback) => fixturePendingReads.push(() => fixtureOriginalGet(key, callback));
      history.pushState({}, "", "/c/fixture-delayed");
      window.dispatchEvent(new Event("gpttoolkit:routechange"));
      history.pushState({}, "", "/c/fixture-bookmarks");
      window.dispatchEvent(new Event("gpttoolkit:routechange"));
      chrome.storage.local.get = fixtureOriginalGet;
      fixturePendingReads.reverse().forEach(read => read());
    });
    await bookmarkToggle.click();
    assert.equal(await savedBookmarks.count(), 1, "stale async reads cannot leak across routes");
    await bookmarkPanel.locator("[data-gpttoolkit-bookmark-remove]").click();
    assert.equal(await savedBookmarks.count(), 0);
    await page.reload();
    await bookmarkToggle.click();
    assert.equal(await savedBookmarks.count(), 0, "deletion persists");
    await page.evaluate(() => {
      history.pushState({}, "", "/");
      window.dispatchEvent(new Event("gpttoolkit:routechange"));
    });
    assert.equal(await bookmarks.count(), 0, "unsaved conversations have no bookmark entry");
    console.log("PASS persistent bookmarks: icon order, deduplication, long-answer offset, return stack, safe labels, theme, reload, route isolation, missing targets, disable/re-enable and deletion");
    // Current ChatGPT moved its title menu left and left only Share on the right.
    await page.goto(base + "/c/fixture-titlebar");
    await bookmarks.waitFor();
    await page.evaluate(() => {
      document.querySelector("header").innerHTML = '<div id="hidden-old-header" hidden><button type="button" aria-label="Chat actions" aria-haspopup="menu">…</button></div><div data-app-shell-main-titlebar="true" style="display:flex;width:100%;align-items:center;justify-content:space-between"><div id="title-wrapper"><button id="chat-title" type="button" aria-haspopup="menu">Conversation title</button></div><div id="trailing-actions" style="display:flex;align-items:center"><button id="header-share" type="button" aria-label="Share">Share</button></div></div>';
    });
    const assertTrailingOrder = () => page.waitForFunction(() => {
      const history = document.getElementById("gpttoolkit-conversation-history");
      const bookmarks = document.getElementById("gpttoolkit-conversation-bookmarks");
      return history?.parentElement?.id === "trailing-actions" && history.nextElementSibling?.id === "header-share" &&
        bookmarks?.nextElementSibling === history;
    });
    await assertTrailingOrder();
    assert.equal(await page.locator("#title-wrapper aside").count(), 0);
    const trailingMetrics = await bookmarks.locator(":scope > button").evaluate(el => {
      const icon = el.getBoundingClientRect();
      const title = document.getElementById("chat-title").getBoundingClientRect();
      const share = document.getElementById("header-share").getBoundingClientRect();
      return {display:getComputedStyle(el.parentElement).display, iconLeft:icon.left, iconRight:icon.right, titleRight:title.right, shareLeft:share.left, hidden:el.parentElement.hidden};
    });
    assert.ok(["inline-flex", "flex"].includes(trailingMetrics.display) && trailingMetrics.iconLeft > trailingMetrics.titleRight && trailingMetrics.iconRight <= trailingMetrics.shareLeft, JSON.stringify(trailingMetrics));
    await bookmarkToggle.click();
    assert.equal(await bookmarkPanel.isVisible(), true);
    await page.keyboard.press("Escape");
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.conversationHistory.enabled":{newValue:false}}, "sync")));
    await page.waitForFunction(() => document.getElementById("gpttoolkit-conversation-bookmarks")?.nextElementSibling?.id === "header-share");
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.conversationHistory.enabled":{newValue:true}}, "sync")));
    await assertTrailingOrder();
    await page.evaluate(() => {
      const old = document.querySelector("header");
      const replacement = old.cloneNode(true);
      replacement.querySelectorAll('aside, #hidden-old-header').forEach(el => el.remove());
      replacement.id = "replacement-titlebar";
      old.setAttribute("aria-hidden", "true");
      old.style.display = "none";
      // The hidden cached header has earlier native anchors in document order.
      document.body.append(replacement);
    });
    await page.waitForFunction(() => document.getElementById("gpttoolkit-conversation-history")?.closest("header")?.id === "replacement-titlebar");
    assert.equal(await bookmarks.count(), 1);
    await page.locator("#replacement-titlebar").evaluate(el => { el.hidden = true; });
    await page.waitForFunction(() => document.getElementById("gpttoolkit-conversation-history")?.hidden && document.getElementById("gpttoolkit-conversation-bookmarks")?.hidden);
    assert.equal(await page.evaluate(async () => {
      const original = window.requestAnimationFrame;
      let count = 0;
      window.requestAnimationFrame = callback => { count++; return original(callback); };
      await new Promise(resolve => original(() => original(() => original(resolve))));
      window.requestAnimationFrame = original;
      return count;
    }), 0, "hiding tools must not sustain an observer/animation-frame loop");
    await page.locator("#replacement-titlebar").evaluate(el => { el.hidden = false; });
    await bookmarks.waitFor();
    assert.equal(await page.locator("#gpttoolkit-conversation-history").isVisible(), true);
    console.log("PASS redesigned titlebar: left title menu excluded, Share fallback, rendered trailing order, independent tools, cached hidden headers, replacement and visibility recovery");
    // Native menu buttons can reappear, be wrapped in fixed-size slots, and
    // toggle visibility through CSS without replacing their surrounding toolbar.
    await page.goto(base + "/c/fixture-dynamic-toolbar");
    await bookmarks.waitFor();
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = '.fixture-native-slot {position:relative;width:36px;height:36px;flex:none} .fixture-native-menu {position:absolute;inset:0;width:36px;height:36px;margin:0;transform:translateX(0)} .fixture-hide-menu {display:none}';
      document.head.append(style);
      document.querySelector("header").innerHTML = '<div data-app-shell-main-titlebar style="display:flex;width:100%;justify-content:space-between"><button type="button" aria-haspopup="menu" id="dynamic-title">Title</button><div data-app-shell-header-obstacle style="display:flex;align-items:center;gap:4px" id="dynamic-actions"><div class="fixture-native-slot fixture-hide-menu" id="native-menu-slot"><button type="button" aria-haspopup="menu" class="fixture-native-menu" id="dynamic-menu">…</button></div><button type="button" aria-label="Share" id="dynamic-share">Share</button></div></div>';
    });
    const expectDynamicOrder = slot => page.waitForFunction(slot => {
      const history = document.getElementById("gpttoolkit-conversation-history");
      const bookmark = document.getElementById("gpttoolkit-conversation-bookmarks");
      return history?.nextElementSibling?.id === slot && bookmark?.nextElementSibling === history;
    }, slot);
    await expectDynamicOrder("dynamic-share");
    await page.locator("#native-menu-slot").evaluate(el => el.classList.remove("fixture-hide-menu"));
    await expectDynamicOrder("native-menu-slot");
    const assertNoToolbarOverlap = async () => {
      const result = await page.evaluate(() => {
        const buttons = ['#gpttoolkit-conversation-bookmarks > button', '#gpttoolkit-conversation-history > button', '#dynamic-menu', '#dynamic-share']
          .map(selector => document.querySelector(selector)).filter(element => element && element.checkVisibility());
        return buttons.every((button, index) => {
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.width > 0 && (center === button || button.contains(center)) &&
            buttons.slice(index + 1).every(other => {
              const next = other.getBoundingClientRect();
              return rect.right <= next.left || next.right <= rect.left || rect.bottom <= next.top || next.bottom <= rect.top;
            }) && (!button.parentElement.id.startsWith('gpttoolkit-') || style.position === 'static');
        });
      });
      assert.equal(result, true, "tool and native hit targets must remain separate");
    };
    await assertNoToolbarOverlap();
    await bookmarkToggle.click();
    assert.equal(await bookmarkPanel.isVisible(), true);
    await page.keyboard.press("Escape");
    await page.locator("#dynamic-menu").evaluate(el => { el.dataset.clicked = "false"; el.addEventListener("click", () => { el.dataset.clicked = "true"; }); });
    await page.locator("#dynamic-menu").click();
    assert.equal(await page.locator("#dynamic-menu").getAttribute("data-clicked"), "true");
    await page.locator("#native-menu-slot").evaluate(el => { el.style.display = "none"; });
    await expectDynamicOrder("dynamic-share");
    await page.locator("#native-menu-slot").evaluate(el => { el.style.display = ""; });
    await expectDynamicOrder("native-menu-slot");
    await page.locator("#dynamic-share").evaluate(el => { el.hidden = true; });
    await expectDynamicOrder("native-menu-slot");
    await assertNoToolbarOverlap();
    await page.locator("#dynamic-share").evaluate(el => { el.hidden = false; });
    await page.locator("#native-menu-slot").evaluate(el => el.remove());
    await expectDynamicOrder("dynamic-share");
    await page.locator("#dynamic-actions").evaluate(el => {
      const slot = document.createElement("div");
      slot.id = "native-menu-slot"; slot.className = "fixture-native-slot";
      slot.innerHTML = '<button type="button" id="dynamic-menu" class="fixture-native-menu" aria-haspopup="menu">…</button>';
      el.prepend(slot);
    });
    await expectDynamicOrder("native-menu-slot");
    await page.setViewportSize({width:390, height:700});
    await assertNoToolbarOverlap();
    await page.setViewportSize({width:1280, height:720});
    await assertNoToolbarOverlap();
    assert.equal(await bookmarks.count(), 1);
    assert.equal(await page.locator("#gpttoolkit-conversation-history").count(), 1);
    console.log("PASS dynamic native menus: unlabeled menu reappearance, fixed slots, class/style visibility, removal/reinsertion, Share hiding, responsive resize, separate hit targets and native clicks");
    await page.goto(base + "/tests/fixtures/content-css-browser.html");
    const probe = () => page.evaluate(() => Object.fromEntries(
      ["ui", "prompt-textarea", "message-text", "explicit-span", "code", "inline-code", "cm-token", "formula", "role-formula", "mathml"]
        .map(id => [id, getComputedStyle(document.getElementById(id)).fontFamily])));
    const original = await probe();
    await page.evaluate(() => {
      const listeners = [], messages = [];
      const settings = {"gptskins.font.text":"noto-serif-sc", "gpttoolkit.font.interface":"sarasa-ui-sc", "gptskins.font.code1":"jetbrains-mono", "gptskins.font.code2":"sarasa-mono-sc"};
      window.fixture = {listeners, messages, settings};
      window.chrome = {
        runtime: { onMessage: { addListener(fn) { messages.push(fn); } } },
        storage: {
          sync: {
            get(keys, callback) { callback(Object.fromEntries(keys.filter(key => key in settings).map(key => [key, settings[key]]))); },
            set(values, callback) {
              const changes = Object.fromEntries(Object.entries(values).map(([key,newValue]) => [key,{newValue}]));
              Object.assign(settings, values);
              listeners.forEach(fn => fn(changes, "sync")); callback?.();
            }
          },
          onChanged: { addListener(fn) { listeners.push(fn); } }
        }
      };
    });
    await page.addScriptTag({url:base + "/shared/fonts.js"});
    await page.addScriptTag({url:base + "/content/content.js"});
    let fonts = await probe();
    assert.match(fonts.ui, /Sarasa UI SC/);
    assert.match(fonts["prompt-textarea"], /Sarasa UI SC/);
    assert.match(fonts["message-text"], /Noto Serif SC/);
    assert.match(fonts["explicit-span"], /Noto Serif SC/);
    for (const id of ["code", "inline-code", "cm-token"]) assert.match(fonts[id], /JetBrains Mono.*Sarasa Mono SC/);
    for (const id of ["formula", "role-formula", "mathml"]) assert.equal(fonts[id], original[id]);
    await page.evaluate(() => {
      const p = document.createElement("p"); p.id = "streamed"; p.textContent = "New streamed text";
      document.getElementById("markdown").append(p);
      window.fixture.routes = 0;
      window.addEventListener("gpttoolkit:routechange", () => window.fixture.routes++);
      history.pushState({}, "", "?conversation=next");
      document.documentElement.classList.add("dark");
    });
    assert.match(await page.locator("#streamed").evaluate(el=>getComputedStyle(el).fontFamily), /Noto Serif SC/);
    assert.equal(await page.evaluate(()=>fixture.routes), 1);
    assert.equal(await page.locator("body").evaluate(el=>getComputedStyle(el).backgroundColor), "rgb(20, 20, 20)");
    assert.deepEqual(await probe(), fonts);
    // Default body must leave independently enabled code and interface fonts intact.
    await page.evaluate(()=>chrome.storage.sync.set({"gpttoolkit.font.text":"default"}));
    fonts = await probe();
    assert.equal(fonts["explicit-span"], original["explicit-span"]);
    assert.match(fonts.code, /JetBrains Mono/);
    await page.evaluate(() => {
      const defaults = GPTToolkitFonts.resolveFontSelections();
      fixture.messages.forEach(fn=>fn({type:"GPTTOOLKIT_APPLY_FONTS",fonts:defaults},{},()=>{}));
    });
    assert.deepEqual(await probe(), original);
    assert.equal(await page.evaluate(()=>document.documentElement.style.length), 0);
    console.log("PASS synthetic font cascade, migration, math exclusions, defaults, streaming, route and native colors");

    await page.goto(base + "/tests/fixtures/popup-fonts-browser.html");
    assert.equal(await page.locator(".font-select").count(), 4);
    assert.equal(await page.locator("[data-style-mode]").count(), 2);
    assert.equal(await page.locator("#font-panel").isVisible(), true);
    await page.selectOption('[data-font-role="text"]', "noto-serif-sc");
    assert.equal(await page.evaluate(()=>fixtureSettings["gpttoolkit.font.text"]), "noto-serif-sc");
    await page.click('[data-style-mode="tools"]');
    assert.equal(await page.locator("#tools-panel").isVisible(), true);
    await page.uncheck("[data-gpttoolkit-latex-copy-enabled]");
    assert.equal(await page.evaluate(()=>fixtureSettings["gpttoolkit.latexCopy.enabled"]), false);
    await page.uncheck("[data-gpttoolkit-conversation-history-enabled]");
    assert.equal(await page.evaluate(()=>fixtureSettings["gpttoolkit.conversationHistory.enabled"]), false);
    await page.uncheck("[data-gpttoolkit-bookmarks-enabled]");
    assert.equal(await page.evaluate(()=>fixtureSettings["gpttoolkit.bookmarks.enabled"]), false);
    console.log("PASS synthetic popup defaults, font selection and tool toggles");

    await page.goto(base + "/tests/fixtures/tools-browser.html");
    await page.click("#run-mixed-copy");
    const mixed = await page.evaluate(()=>JSON.parse(document.documentElement.dataset.mixedCopy));
    assert.equal(mixed.defaultPrevented, true);
    assert.match(mixed.data["text/plain"], /Before[\s\S]*\$x\^2 \+ y\^2\$[\s\S]*after/);
    for (const [button, key] of [["#run-ordinary-copy","ordinaryCopy"],["#run-native-copy","nativeCopy"]]) {
      await page.click(button);
      assert.equal(await page.evaluate(key=>JSON.parse(document.documentElement.dataset[key]).defaultPrevented,key), false);
    }
    await page.click("#inline-formula");
    for (const [format, expected] of [["tex","x^2 + y^2"],["inline","$x^2 + y^2$"],["display","$$x^2 + y^2$$"],["inline-unboxed","$x^2 + y^2$"],["display-unboxed","$$x^2 + y^2$$"]]) {
      await page.click("#inline-formula");
      await page.click(`[data-gpttoolkit-latex-format="${format}"]`);
      assert.equal(await page.evaluate(()=>__gpttoolkitFixtureClipboard),expected);
    }
    await page.click("#inline-formula");
    assert.equal(await page.locator("#gpttoolkit-latex-toolbar").evaluate(el=>getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
    await page.evaluate(()=>document.documentElement.classList.add("dark"));
    assert.equal(await page.locator("#gpttoolkit-latex-toolbar").evaluate(el=>getComputedStyle(el).backgroundColor), "rgb(47, 47, 47)");
    await page.evaluate(()=>fixtureStorageListeners.forEach(fn=>fn({"gpttoolkit.latexCopy.tex.enabled":{newValue:false}},"sync")));
    assert.equal(await page.locator('[data-gpttoolkit-latex-format="tex"]').isVisible(),false);
    assert.equal(await page.locator('[data-gpttoolkit-latex-format="inline"]').isVisible(),true);
    await page.evaluate(()=>window.dispatchEvent(new Event("gpttoolkit:routechange")));
    assert.equal(await page.locator("#gpttoolkit-latex-toolbar").isVisible(),false);
    await page.evaluate(()=>fixtureStorageListeners.forEach(fn=>fn({"gpttoolkit.latexCopy.enabled":{newValue:false}},"sync")));
    await page.click("#inline-formula");
    assert.equal(await page.locator("#gpttoolkit-latex-toolbar").count(),0);
    await page.click("#run-scroll-tests");
    await page.waitForFunction(()=>document.documentElement.dataset.scrollTests);
    const scroll = await page.evaluate(()=>JSON.parse(document.documentElement.dataset.scrollTests));
    assert.equal(scroll.guardedTop,120);
    assert.equal(scroll.afterStableTop,260);
    assert.equal(scroll.bottomNativeTop,210);
    assert.equal(scroll.wheelCanceledTop,scroll.maxScrollTop);
    assert.equal(scroll.globalApisUnchanged,true);
    await page.evaluate(()=>fixtureStorageListeners.forEach(fn=>fn({"gpttoolkit.scrollGuard.enabled":{newValue:false}},"sync")));
    assert.equal(await page.evaluate(()=>{
      const scroller=document.getElementById("thread-scroll");
      scroller.scrollTop=120;
      document.getElementById("composer-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
      scroller.scrollTop=300;
      scroller.dispatchEvent(new Event("scroll"));
      return scroller.scrollTop;
    }),300);

    // User-message navigation: real scrolling in a nested transcript scroller.
    await page.goto(base + "/tests/fixtures/tools-browser.html");
    const history = page.locator("#gpttoolkit-conversation-history");
    const entries = page.locator("#gpttoolkit-history-panel li button");
    await history.waitFor();
    assert.equal(await history.evaluate(el => el.nextElementSibling?.getAttribute("aria-label")), "Chat actions");
    const toggle = history.locator(":scope > button");
    const idleWidth = await toggle.evaluate(el => el.getBoundingClientRect().width);
    await toggle.hover();
    assert.equal(await toggle.evaluate(el => el.getBoundingClientRect().width), idleWidth);
    assert.equal(await toggle.textContent(), "");
    assert.equal(await history.locator("nav").isVisible(), false);
    // A header with paint containment must not clip the top-layer directory.
    await page.locator('[data-testid="app-shell-header-context-menu-surface"]').evaluate(el => {
      el.style.contain = "layout paint";
      el.style.overflow = "hidden";
    });
    await toggle.click();
    assert.equal(await history.locator("nav").evaluate(el => {
      const rect = el.getBoundingClientRect();
      return el.matches(":popover-open") && el.contains(document.elementFromPoint(rect.left + 20, rect.bottom - 10));
    }), true);
    assert.equal(await entries.count(), 1);
    await page.evaluate(() => {
      const turn = document.createElement("section");
      turn.dataset.chatgptSearchUnitKey = "new:user";
      turn.innerHTML = '<div data-message-author-role="user" id="history-user">第二个问题 &lt;script&gt;安全文本&lt;/script&gt;</div>';
      document.querySelector("main").append(turn);
    });
    await page.waitForFunction(() => document.querySelectorAll("#gpttoolkit-history-panel li").length === 2);
    assert.match(await entries.nth(1).textContent(), /第二个问题 <script>安全文本<\/script>/);
    assert.equal(await history.locator("script").count(), 0);
    await entries.nth(1).click();
    assert.equal(await entries.nth(1).getAttribute("aria-current"), "true");
    assert.equal(await page.locator("#history-user").evaluate(el => {
      const rect = el.getBoundingClientRect();
      const scroller = document.getElementById("thread-scroll").getBoundingClientRect();
      return rect.top >= scroller.top && rect.bottom <= scroller.bottom;
    }), true);
    await page.evaluate(() => { document.getElementById("history-user").textContent = "编辑后的问题"; });
    await page.waitForFunction(() => document.querySelectorAll("#gpttoolkit-history-panel li")[1].textContent.includes("编辑后的问题"));
    await page.evaluate(() => { document.getElementById("history-user").textContent = ""; });
    await page.waitForFunction(() => document.querySelectorAll("#gpttoolkit-history-panel li")[1].textContent.includes("图片或附件"));
    // Assistant streaming must not rebuild or disturb the focused directory item.
    await entries.first().focus();
    await page.evaluate(() => { document.getElementById("ordinary-text").textContent += " streamed"; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await entries.first().evaluate(el => el === document.activeElement), true);
    const light = await history.locator("nav").evaluate(el => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    assert.notEqual(await history.locator("nav").evaluate(el => getComputedStyle(el).backgroundColor), light);
    await page.setViewportSize({width: 390, height: 700});
    assert.equal(await history.evaluate(el => el.getBoundingClientRect().left >= 0), true);
    await page.keyboard.press("Escape");
    assert.equal(await history.locator("nav").isVisible(), false);
    assert.equal(await history.locator(":scope > button").evaluate(el => el === document.activeElement), true);
    await page.setViewportSize({width: 1280, height: 720});
    await page.evaluate(() => {
      document.querySelector("main").replaceChildren();
      window.dispatchEvent(new Event("gpttoolkit:routechange"));
    });
    await page.waitForFunction(() => document.getElementById("gpttoolkit-conversation-history")?.hidden);
    await page.evaluate(() => {
      const turn = document.createElement("div");
      turn.dataset.messageAuthorRole = "user";
      turn.textContent = "新聊天";
      document.querySelector("main").append(turn);
    });
    await history.waitFor();
    assert.equal(await entries.count(), 1);
    assert.match(await entries.first().textContent(), /新聊天/);
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.conversationHistory.enabled":{newValue:false}}, "sync")));
    assert.equal(await history.count(), 0);
    await page.evaluate(() => { document.querySelector('[data-message-author-role="user"]').textContent = "关闭后编辑"; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await history.count(), 0);
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.conversationHistory.enabled":{newValue:true}}, "sync")));
    await history.waitFor();
    assert.equal(await entries.count(), 1);
    assert.match(await entries.first().textContent(), /关闭后编辑/);
    // Replacing the native toolbar must remount exactly one entry.
    await page.locator('[data-testid="app-shell-header-context-menu-surface"]').evaluate(el => {
      const replacement = el.cloneNode(true);
      replacement.querySelector("#gpttoolkit-conversation-history").remove();
      el.replaceWith(replacement);
    });
    await history.waitFor();
    assert.equal(await history.count(), 1);
    assert.equal(await history.evaluate(el => el.nextElementSibling?.getAttribute("aria-label")), "Chat actions");
    // SPA navigation can fire before the old transcript is hidden, and keep it cached.
    await page.evaluate(() => window.dispatchEvent(new Event("gpttoolkit:routechange")));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      const previous = document.querySelector("main");
      previous.setAttribute("aria-hidden", "true");
      previous.style.display = "none";
      const current = document.createElement("main");
      current.id = "active-conversation";
      current.innerHTML = '<div data-chatgpt-search-unit-key="active:user"><div data-message-author-role="user">当前对话的问题</div></div>';
      document.getElementById("thread-scroll").append(current);
    });
    await history.locator(":scope > button").click();
    assert.equal(await entries.count(), 1, "cached previous transcripts must not leak into the current directory");
    assert.match(await entries.first().textContent(), /当前对话的问题/);
    // Switching back can reuse existing nodes and only change CSS visibility.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("gpttoolkit:routechange"));
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      document.getElementById("active-conversation").style.display = "none";
      const previous = document.querySelector("main");
      previous.removeAttribute("aria-hidden");
      previous.style.display = "";
    });
    await history.locator(":scope > button").click();
    assert.equal(await entries.count(), 1);
    assert.match(await entries.first().textContent(), /关闭后编辑/);
    console.log("PASS cached SPA conversations: early route event, hidden transcript exclusion and reused nodes on return");
    console.log("PASS synthetic conversation history: nested deduplication, safe labels, jump, edits, attachments, streaming, theme, mobile, route, disable/re-enable");

    // Back bookmarks are consumed in LIFO order, preserving nested and page scroll.
    await page.goto(base + "/tests/fixtures/tools-browser.html");
    await page.evaluate(() => {
      document.body.style.minHeight = "2600px";
      const header = document.querySelector("header");
      Object.assign(header.style, {position:"fixed", top:"0", right:"0", zIndex:"100"});
      document.querySelector("main").innerHTML = Array.from({length:5}, (_, i) =>
        `<section data-testid="conversation-turn-${i}" style="height:600px"><div data-message-author-role="user">书签测试 ${i}</div></section>`).join("");
      document.getElementById("thread-scroll").scrollTop = 850;
      window.scrollTo(0, 100);
    });
    await page.waitForFunction(() => document.querySelectorAll("#gpttoolkit-history-panel li").length === 5);
    const back = page.locator("[data-gpttoolkit-history-back]");
    const readScroll = () => page.evaluate(() => ({top:document.getElementById("thread-scroll").scrollTop, page:document.scrollingElement.scrollTop}));
    const firstPosition = await readScroll();
    await history.locator(":scope > button").click();
    assert.equal(await back.isVisible(), false);
    await entries.nth(4).click();
    assert.equal(await back.isVisible(), true);
    const secondPosition = await readScroll();
    assert.notEqual(secondPosition.top, firstPosition.top);
    await entries.first().click();
    assert.notDeepEqual(await readScroll(), secondPosition);
    await back.click();
    assert.deepEqual(await readScroll(), secondPosition);
    assert.equal(await back.isVisible(), true, "one earlier bookmark must remain");
    assert.equal(await entries.nth(4).getAttribute("aria-current"), "true");
    await back.click();
    assert.deepEqual(await readScroll(), firstPosition);
    assert.equal(await back.isVisible(), false, "consuming the last bookmark hides the button");
    // Hiding/reopening the panel must not discard bookmarks.
    await entries.nth(3).click();
    await history.locator(":scope > button").click();
    await history.locator(":scope > button").click();
    assert.equal(await back.isVisible(), true);
    // Navigation clears bookmarks so positions cannot leak into another chat.
    await page.evaluate(() => window.dispatchEvent(new Event("gpttoolkit:routechange")));
    await history.waitFor();
    await history.locator(":scope > button").click();
    assert.equal(await back.isVisible(), false);
    await entries.nth(2).click();
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.conversationHistory.enabled":{newValue:false}}, "sync")));
    await page.evaluate(() => fixtureStorageListeners.forEach(fn => fn({"gpttoolkit.conversationHistory.enabled":{newValue:true}}, "sync")));
    await history.waitFor();
    await history.locator(":scope > button").click();
    assert.equal(await back.isVisible(), false);
    console.log("PASS stacked directory bookmarks: LIFO, exact nested/page scroll, active item, exhaustion, reopen, route and disable cleanup");

    // Replay the semantic structure supplied by the user, without private IDs.
    await page.goto(base + "/tests/fixtures/tools-browser.html");
    await page.locator("#thread-scroll").evaluate((el, html) => { el.innerHTML = html; },
      fs.readFileSync(path.join(__dirname, "fixtures/current-message-dom.html"), "utf8"));
    await page.addStyleTag({content: '.Paragraph-kKnbIo {font-family: Arial;} .katex-html {font-family: "Times New Roman";} pre, code {font-family: Consolas;}'});
    await page.addStyleTag({url:base + "/content/content.css"});
    const bodyFont = () => page.locator("#ordinary-text").evaluate(el=>getComputedStyle(el).fontFamily);
    const nativeBodyFont = await bodyFont();
    const nativeMathFont = await page.locator("#current-math-glyph").evaluate(el=>getComputedStyle(el).fontFamily);
    await page.evaluate(()=>{
      document.documentElement.setAttribute("data-gpttoolkit-font-text", "");
      document.documentElement.style.setProperty("--gpttoolkit-text-font-family", '"Noto Serif SC", serif');
    });
    assert.match(await bodyFont(), /Noto Serif SC/);
    assert.match(await page.locator("#current-user").evaluate(el=>getComputedStyle(el).fontFamily), /Noto Serif SC/);
    assert.equal(await page.locator("#current-math-glyph").evaluate(el=>getComputedStyle(el).fontFamily), nativeMathFont);
    assert.equal(await page.locator("#current-code").evaluate(el=>getComputedStyle(el).fontFamily), "Consolas");
    await page.evaluate(()=>document.documentElement.removeAttribute("data-gpttoolkit-font-text"));
    assert.equal(await bodyFont(),nativeBodyFont);
    for (const [formula, format, expected] of [
      ["#inline-formula", "inline", "$\\theta$"],
      ["#display-formula", "display", "$$\\boxed{x^2}$$"],
      ["#display-formula", "inline-unboxed", "$x^2$"],
      ["#display-formula", "display-unboxed", "$$x^2$$"]
    ]) {
      await page.click(formula);
      await page.click(`[data-gpttoolkit-latex-format="${format}"]`);
      assert.equal(await page.evaluate(()=>__gpttoolkitFixtureClipboard), expected);
    }
    await page.click("#run-mixed-copy");
    assert.match(await page.evaluate(()=>JSON.parse(document.documentElement.dataset.mixedCopy).data["text/plain"]), /Before[\s\S]*\$\\theta\$[\s\S]*after/);
    // Check unrelated math before the native-copy suppression window starts.
    await page.click("#outside-formula");
    assert.equal(await page.locator("#gpttoolkit-latex-toolbar").isVisible(),false);
    await page.click("#run-native-copy");
    assert.equal(await page.evaluate(()=>JSON.parse(document.documentElement.dataset.nativeCopy).defaultPrevented),false);
    console.log("PASS supplied current DOM: body/default/math/code, inline/display/unboxed copy, mixed selection and native Copy");
    assert.deepEqual(errors,[]);
    console.log("PASS synthetic mixed/native copy, all formula formats, disable/route cleanup, reading protection and wheel cancellation");
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{ console.error(error); process.exitCode=1; });
