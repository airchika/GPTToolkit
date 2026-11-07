(function () {
  "use strict";

  const api = globalThis.GPTToolkitTools;
  if (!api) return;
  const routeEvent = "gpttoolkit:routechange";
  const prefix = "gpttoolkit.bookmarks.";
  const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]';
  const anchorSelector = api.toolbarAnchorSelector;
  let enabled = false;
  let ui = null;
  let observer = null;
  let frame = 0;
  let generation = 0;
  let storageKey = null;
  let records = [];
  let loaded = false;
  let saving = false;
  let backStack = [];

  function conversationKey() {
    const id = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)(?:\/|$)/)?.[1];
    return id ? prefix + id : null;
  }

  function messages() {
    return Array.from(document.querySelectorAll(messageSelector)).filter(element =>
      !element.parentElement?.closest(messageSelector) &&
      !element.closest('[hidden], [aria-hidden="true"], [inert]') &&
      element.checkVisibility({ visibilityProperty: true }));
  }

  function identity(element) {
    const owner = element.closest("[data-message-id], [data-chatgpt-search-unit-key]") ||
      element.querySelector("[data-message-id]");
    return owner?.getAttribute("data-message-id") || owner?.getAttribute("data-chatgpt-search-unit-key") || "";
  }

  function text(element) {
    const content = element.querySelector("[data-message-author-role]") || element;
    return (content.innerText || content.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
  }

  function role(element) {
    return element.getAttribute("data-message-author-role") ||
      element.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role") ||
      element.getAttribute("data-chatgpt-search-unit-key")?.split(":").pop();
  }

  function containers(element) {
    const result = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node === document.scrollingElement ||
          (node.scrollHeight > node.clientHeight && /auto|scroll|overlay|hidden/.test(getComputedStyle(node).overflowY))) {
        result.push(node);
      }
    }
    return result;
  }

  function viewport(container) {
    if (container === document.scrollingElement) return { top: 0, bottom: window.innerHeight };
    const rect = container.getBoundingClientRect();
    return { top: rect.top + container.clientTop, bottom: Math.min(window.innerHeight, rect.top + container.clientTop + container.clientHeight) };
  }

  function notify(value) {
    if (ui) ui.querySelector('[role="status"]').textContent = value;
  }

  function render() {
    if (!ui) return;
    const focused = ui.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.dataset.gpttoolkitBookmarkJump || focused?.dataset.gpttoolkitBookmarkRemove;
    ui.querySelector("[data-gpttoolkit-bookmark-add]").disabled = !loaded || saving;
    ui.querySelector("[data-gpttoolkit-bookmark-back]").hidden = backStack.length === 0;
    ui.querySelector("ol").replaceChildren(...records.map(record => {
      const li = document.createElement("li");
      const jump = document.createElement("button");
      jump.type = "button";
      jump.dataset.gpttoolkitBookmarkJump = record.id;
      jump.textContent = record.label;
      jump.disabled = saving;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.gpttoolkitBookmarkRemove = record.id;
      remove.textContent = "×";
      remove.setAttribute("aria-label", `删除书签：${record.label}`);
      remove.disabled = saving;
      li.append(jump, remove);
      return li;
    }));
    ui.querySelector("[data-gpttoolkit-bookmark-empty]").hidden = !loaded || records.length > 0;
    if (focusedId && !saving) {
      const attribute = focused.hasAttribute("data-gpttoolkit-bookmark-jump") ? "data-gpttoolkit-bookmark-jump" : "data-gpttoolkit-bookmark-remove";
      const replacement = Array.from(ui.querySelectorAll(`[${attribute}]`)).find(item => item.getAttribute(attribute) === focusedId);
      (replacement || ui.querySelector("[data-gpttoolkit-bookmark-add]")).focus({ preventScroll: true });
    }
  }

  function load() {
    const key = storageKey;
    const token = ++generation;
    loaded = false;
    render();
    if (!key) return;
    chrome.storage.local.get(key, result => {
      if (!enabled || token !== generation || key !== conversationKey()) return;
      if (chrome.runtime.lastError) {
        notify("无法读取书签，请重新打开书签面板重试。");
        return;
      }
      records = Array.isArray(result[key]) ? result[key].filter(record =>
        record && typeof record.id === "string" && typeof record.label === "string" &&
        typeof record.text === "string" && typeof record.role === "string" &&
        typeof record.messageId === "string" && Number.isInteger(record.occurrence) && record.occurrence >= 0 &&
        Number.isFinite(record.offset)) : [];
      loaded = true;
      notify("");
      render();
    });
  }

  function save(next) {
    const key = storageKey;
    const token = generation;
    saving = true;
    render();
    chrome.storage.local.set({ [key]: next }, () => {
      if (!enabled || token !== generation || key !== conversationKey()) return;
      saving = false;
      if (chrome.runtime.lastError) {
        notify("保存失败，请重试。书签尚未更改。");
      } else {
        records = next;
        notify("已保存到此浏览器。");
      }
      render();
    });
  }

  function add() {
    const all = messages();
    // Choose the message spanning the reading edge, even in a very long answer.
    const element = all.find(element => {
      const rect = element.getBoundingClientRect();
      const view = viewport(containers(element)[0] || document.scrollingElement);
      return rect.bottom > Math.max(0, view.top) + 64 && rect.top < view.bottom;
    });
    if (!element) { notify("当前视口没有可保存的消息，请滚动到消息后重试。"); return; }
    const container = containers(element)[0] || document.scrollingElement;
    const offset = element.getBoundingClientRect().top - viewport(container).top;
    const messageId = identity(element);
    const content = text(element);
    const author = role(element);
    const occurrence = all.filter(item => role(item) === author && text(item) === content).indexOf(element);
    if (records.some(record => record.messageId === messageId && record.text === content &&
        record.role === author && record.occurrence === occurrence && Math.abs(record.offset - offset) < 24)) {
      notify("此阅读位置已有书签。"); return;
    }
    save([...records, { id: crypto.randomUUID(), messageId, text: content, role: author, occurrence, offset,
      label: `${author === "user" ? "提问" : "回答"} · ${content.slice(0, 80) || "图片或附件"}` }]);
  }

  function jump(record) {
    const all = messages();
    // A stable ID must never fall through to a different branch with similar text.
    const element = record.messageId ? all.find(item => identity(item) === record.messageId) :
      all.filter(item => role(item) === record.role && text(item) === record.text)[record.occurrence];
    if (!element) { notify("这条消息尚未加载或已不在当前分支，请加载对应消息后重试。"); return; }
    const positions = containers(element).map(container => ({ container, top: container.scrollTop, left: container.scrollLeft }));
    backStack.push(positions);
    // Cancel the optional submit guard before intentionally moving the transcript.
    window.dispatchEvent(new Event("gpttoolkit:readingjump"));
    element.scrollIntoView({ block: "start", behavior: "instant" });
    const container = positions[0]?.container || document.scrollingElement;
    container.scrollBy({ top: element.getBoundingClientRect().top - viewport(container).top - record.offset, behavior: "instant" });
    notify("");
    render();
  }

  function close() {
    if (!ui) return;
    const panel = ui.querySelector("nav");
    panel.hidePopover();
    panel.hidden = true;
    ui.querySelector("button").setAttribute("aria-expanded", "false");
  }

  function position() {
    const panel = ui?.querySelector("nav");
    if (!panel || panel.hidden) return;
    const rect = ui.querySelector("button").getBoundingClientRect();
    const width = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    panel.style.top = `${rect.bottom + 8}px`;
  }

  function click(event) {
    const button = event.target.closest("button");
    if (!button || !ui?.contains(button) || storageKey !== conversationKey()) return;
    if (button === ui.querySelector("button")) {
      const panel = ui.querySelector("nav");
      if (!panel.hidden) { close(); return; }
      if (!loaded && !saving) load();
      document.getElementById("gpttoolkit-conversation-history")?.querySelector('button[aria-expanded="true"]')?.click();
      panel.hidden = false;
      panel.showPopover();
      button.setAttribute("aria-expanded", "true");
      position();
    } else if (button.hasAttribute("data-gpttoolkit-bookmark-back")) {
      window.dispatchEvent(new Event("gpttoolkit:readingjump"));
      for (const item of (backStack.pop() || []).slice().reverse()) {
        if (item.container.isConnected) item.container.scrollTo({ top: item.top, left: item.left, behavior: "instant" });
      }
      if (!backStack.length) ui.querySelector("button").focus({ preventScroll: true });
      render();
    } else if (loaded && !saving) {
      if (button.hasAttribute("data-gpttoolkit-bookmark-add")) add();
      const record = records.find(item => item.id === (button.dataset.gpttoolkitBookmarkJump || button.dataset.gpttoolkitBookmarkRemove));
      if (record && button.hasAttribute("data-gpttoolkit-bookmark-remove")) save(records.filter(item => item !== record));
      else if (record) jump(record);
    }
  }

  function outside(event) { if (ui && !ui.contains(event.target)) close(); }
  function keydown(event) {
    if (event.key !== "Escape" || !ui || ui.querySelector("nav").hidden) return;
    const focusInside = ui.contains(document.activeElement);
    close();
    if (focusInside) ui.querySelector("button").focus({ preventScroll: true });
  }

  function mount() {
    frame = 0;
    if (!enabled) return;
    const native = api.findToolbarAnchor();
    const history = document.getElementById("gpttoolkit-conversation-history");
    const anchor = history?.nextElementSibling === native ? history : native;
    if (!native || !anchor || !storageKey) { if (ui) ui.hidden = true; close(); return; }
    if (!ui) {
      ui = document.createElement("aside");
      ui.id = "gpttoolkit-conversation-bookmarks";
      ui.setAttribute("aria-label", "GPT Toolkit 书签");
      ui.innerHTML = '<button type="button" aria-expanded="false" aria-controls="gpttoolkit-bookmarks-panel" aria-label="对话书签"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z"/></svg></button><nav id="gpttoolkit-bookmarks-panel" aria-label="对话书签" popover="manual" hidden><div data-gpttoolkit-bookmark-heading><strong>书签</strong><button type="button" data-gpttoolkit-bookmark-back hidden>↶ 回退</button></div><button type="button" data-gpttoolkit-bookmark-add>＋ 添加当前阅读位置</button><p data-gpttoolkit-bookmark-empty hidden>暂无书签。在要保存的位置添加书签，下次打开此对话仍可跳转。</p><ol></ol><p role="status" aria-live="polite"></p></nav>';
      ui.addEventListener("click", click);
      render();
    }
    const button = ui.querySelector("button");
    button.className = native.className;
    for (const name of ["data-color", "data-variant", "data-uniform", "data-size", "data-icon-size"]) {
      if (native.hasAttribute(name)) button.setAttribute(name, native.getAttribute(name));
      else button.removeAttribute(name);
    }
    ui.hidden = false;
    if (ui.nextElementSibling !== anchor) anchor.before(ui);
  }

  function schedule() { if (enabled && !frame) frame = requestAnimationFrame(mount); }
  function reset() {
    generation++;
    close();
    ui?.removeEventListener("click", click);
    ui?.remove();
    ui = null;
    storageKey = conversationKey();
    records = [];
    backStack = [];
    saving = false;
    loaded = false;
    if (storageKey) load();
    schedule();
  }

  function syncFeature(value) {
    if (enabled === value) return;
    enabled = value;
    const method = enabled ? "addEventListener" : "removeEventListener";
    document[method]("click", outside, true);
    document[method]("keydown", keydown);
    document[method]("scroll", position, true);
    window[method]("resize", position);
    window[method](routeEvent, reset);
    observer?.disconnect();
    observer = null;
    if (enabled) {
      observer = new MutationObserver(batch => {
        const relevant = node => node instanceof Element && (node.matches(anchorSelector) ||
          node.querySelector(anchorSelector) || node.id === "gpttoolkit-conversation-history" || node === ui);
        if (batch.some(record => record.type === "attributes" ?
          !record.target.closest("#gpttoolkit-conversation-history, #gpttoolkit-conversation-bookmarks") && relevant(record.target) :
          [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true,
        attributes: true, attributeFilter: ["hidden", "aria-hidden", "inert"] });
    } else {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    reset();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[api.bookmarksEnabledStorageKey]) syncFeature(changes[api.bookmarksEnabledStorageKey].newValue !== false);
    if (area === "local" && enabled && storageKey && changes[storageKey] && !saving) load();
  });
  api.loadToolSettings(settings => syncFeature(settings[api.bookmarksEnabledStorageKey] !== false));
})();
