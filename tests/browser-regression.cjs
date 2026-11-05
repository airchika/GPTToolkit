// Optional synthetic browser checks. Install Playwright outside the extension.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const server = http.createServer((req, res) => {
  const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
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
    console.log("PASS synthetic conversation history: nested deduplication, safe labels, jump, edits, attachments, streaming, theme, mobile, route, disable/re-enable");

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
