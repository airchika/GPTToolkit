(function () {
  "use strict";

  const toolsApi = globalThis.GPTToolkitTools;
  if (!toolsApi) {
    return;
  }

  // Support both legacy turns and the current transcript/search-unit markup.
  const assistantSelector = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-markdown-text-style="assistant-message"]';
  const composerSelector = '#prompt-textarea, [data-testid="composer"] [contenteditable="true"], form[data-type="unified-composer"] [contenteditable="true"]';
  const formulaSelector = [
    "[data-math-source]",
    "[data-math]",
    '[role="math"]',
    ".math-inline",
    ".math-block",
    "ms-katex",
    ".katex-display",
    ".katex",
    "math"
  ].join(", ");
  const blockTextTags = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DIV",
    "DL",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TR",
    "UL"
  ]);
  const cancelKeys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);
  let scrollGuardEnabled = toolsApi.defaultScrollGuardEnabled;
  let latexCopyEnabled = toolsApi.defaultLatexCopyEnabled;
  let latexTexEnabled = toolsApi.defaultLatexTexEnabled;
  let activeGuard = null;
  let formulaMenu = null;
  let formulaContext = null;
  let formulaContextObserver = null;
  let toast = null;
  let toastTimer = 0;
  let suppressSelectionCopyUntil = 0;
  let scrollGuardListenersAttached = false;
  let latexCopyListenersAttached = false;
  let documentClickListenerAttached = false;
  const routeChangeEventName = "gpttoolkit:routechange";

  // User-message and toolbar changes refresh the directory; assistant streaming is ignored.
  const userMessageSelector = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"]';
  let historyEnabled = false;
  let historyUi = null;
  let historyObserver = null;
  let historyFrame = 0;
  let historyEntries = [];

  function closeHistory() {
    if (!historyUi) return;
    const panel = historyUi.querySelector("nav");
    panel.hidePopover();
    panel.hidden = true;
    historyUi.querySelector("button").setAttribute("aria-expanded", "false");
  }

  function onHistoryClick(event) {
    const button = event.target.closest("button");
    if (!button || !historyUi.contains(button)) return;
    if (button.hasAttribute("data-gpttoolkit-history-index")) {
      const entry = historyEntries[Number(button.dataset.gpttoolkitHistoryIndex)];
      if (!entry?.element.isConnected) { scheduleHistoryRefresh(); return; }
      disarmScrollGuard();
      entry.element.scrollIntoView({ block: "center", behavior: "instant" });
      historyUi.querySelectorAll("[aria-current]").forEach(item => item.removeAttribute("aria-current"));
      button.setAttribute("aria-current", "true");
      return;
    }
    const panel = historyUi.querySelector("nav");
    if (!panel.hidden) { closeHistory(); return; }
    // Route notifications may precede React hiding/reusing cached transcripts.
    // Refresh on demand, after navigation has settled, without another polling loop.
    refreshHistory();
    if (historyUi.hidden) return;
    panel.hidden = false;
    panel.showPopover();
    button.setAttribute("aria-expanded", "true");
    positionHistoryPanel();
  }

  function onHistoryOutsideClick(event) {
    if (historyUi && !historyUi.contains(event.target)) closeHistory();
  }

  function onHistoryKeydown(event) {
    if (event.key !== "Escape" || !historyUi || historyUi.querySelector("nav").hidden) return;
    const focusWasInside = historyUi.contains(document.activeElement);
    closeHistory();
    if (focusWasInside) historyUi.querySelector("button").focus({ preventScroll: true });
  }

  const historyAnchorSelector = '[data-testid="app-shell-header-context-menu-surface"] button[aria-haspopup="menu"], [data-app-shell-main-titlebar] button[aria-label="Chat actions"], [data-testid="conversation-options-button"]';

  function positionHistoryPanel() {
    const panel = historyUi?.querySelector("nav");
    if (!panel || panel.hidden) return;
    const rect = historyUi.querySelector("button").getBoundingClientRect();
    const width = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    panel.style.top = `${rect.bottom + 8}px`;
  }

  function mountHistoryEntry() {
    const anchor = document.querySelector(historyAnchorSelector);
    if (!anchor || !historyUi) return false;
    const button = historyUi.querySelector("button");
    // Borrow native presentation only, never IDs, menu wiring or event handlers.
    button.className = anchor.className;
    for (const name of ["data-color", "data-variant", "data-uniform", "data-size", "data-icon-size"]) {
      if (anchor.hasAttribute(name)) button.setAttribute(name, anchor.getAttribute(name));
      else button.removeAttribute(name);
    }
    if (historyUi.nextElementSibling !== anchor) anchor.before(historyUi);
    return true;
  }

  function refreshHistory() {
    cancelAnimationFrame(historyFrame);
    historyFrame = 0;
    if (!historyEnabled) return;
    const candidates = Array.from(document.querySelectorAll(userMessageSelector));
    const entries = candidates.filter(element =>
      !element.parentElement?.closest(userMessageSelector) &&
      !element.closest('[hidden], [aria-hidden="true"], [inert]') &&
      (element.checkVisibility ? element.checkVisibility({ visibilityProperty: true }) : element.getClientRects().length > 0))
      .map((element, index) => {
        // Inner content avoids edit/copy controls in a search-unit wrapper.
        const content = element.querySelector('[data-message-author-role="user"]') || element;
        const text = (content.innerText || content.textContent || "").replace(/\s+/g, " ").trim();
        return { element, label: text || `第 ${index + 1} 条消息（图片或附件）` };
      });
    if (!historyUi) {
      historyUi = document.createElement("aside");
      historyUi.id = "gpttoolkit-conversation-history";
      historyUi.setAttribute("aria-label", "GPT Toolkit 对话目录");
      historyUi.innerHTML = '<button type="button" aria-expanded="false" aria-controls="gpttoolkit-history-panel" aria-label="对话目录"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg></button><nav id="gpttoolkit-history-panel" aria-label="按用户消息跳转" popover="manual" hidden><strong>对话目录</strong><ol></ol></nav>';
      historyUi.addEventListener("click", onHistoryClick);
    }
    const mounted = mountHistoryEntry();
    historyUi.hidden = entries.length === 0 || !mounted;
    if (historyUi.hidden) closeHistory();
    if (entries.length === historyEntries.length && entries.every((entry, index) =>
      entry.element === historyEntries[index].element && entry.label === historyEntries[index].label)) return;
    historyEntries = entries;
    const list = historyUi.querySelector("ol");
    list.replaceChildren(...entries.map((entry, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.gpttoolkitHistoryIndex = String(index);
      button.textContent = `${index + 1}. ${entry.label.slice(0, 100)}`;
      button.title = entry.label;
      item.appendChild(button);
      return item;
    }));
  }

  function scheduleHistoryRefresh() {
    if (historyEnabled && !historyFrame) historyFrame = requestAnimationFrame(refreshHistory);
  }

  function resetHistoryRoute() {
    closeHistory();
    historyEntries = [];
    historyUi?.removeEventListener("click", onHistoryClick);
    historyUi?.remove();
    historyUi = null;
    scheduleHistoryRefresh();
  }

  function syncHistoryFeature(enabled) {
    if (enabled === historyEnabled) return;
    historyEnabled = enabled;
    const method = enabled ? "addEventListener" : "removeEventListener";
    document[method]("click", onHistoryOutsideClick);
    document[method]("keydown", onHistoryKeydown);
    window[method](routeChangeEventName, resetHistoryRoute);
    window[method]("resize", positionHistoryPanel);
    document[method]("scroll", positionHistoryPanel, true);
    if (enabled) {
      historyObserver = new MutationObserver(records => {
        const touchesHistoryNodes = node => node instanceof Element &&
          (node.matches(userMessageSelector + ", " + historyAnchorSelector) ||
            node.querySelector(userMessageSelector + ", " + historyAnchorSelector) || node === historyUi);
        if (records.some(record => {
          if (record.type === "attributes") return true;
          const target = record.target instanceof Element ? record.target : record.target.parentElement;
          if (target?.closest(userMessageSelector)) return true;
          return [...record.addedNodes, ...record.removedNodes].some(touchesHistoryNodes);
        })) scheduleHistoryRefresh();
      });
      historyObserver.observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["data-message-author-role", "data-chatgpt-search-unit-key"] });
      scheduleHistoryRefresh();
    } else {
      historyObserver?.disconnect();
      historyObserver = null;
      cancelAnimationFrame(historyFrame);
      historyFrame = 0;
      closeHistory();
      historyUi?.removeEventListener("click", onHistoryClick);
      historyUi?.remove();
      historyUi = null;
      historyEntries = [];
    }
  }

  function readFormulaSource(element) {
    if (!element) {
      return "";
    }
    const dataMathSourceOwner = element.matches?.("[data-math-source]") ? element : element.querySelector?.("[data-math-source]");
    const dataMathSource = dataMathSourceOwner?.getAttribute("data-math-source");
    const dataMathOwner = element.matches?.("[data-math]") ? element : element.querySelector?.("[data-math]");
    const dataMath = dataMathOwner?.getAttribute("data-math");
    const annotation = element.matches?.('annotation[encoding="application/x-tex"]')
      ? element
      : element.querySelector?.('annotation[encoding="application/x-tex"]');
    return toolsApi.resolveLatexSource(dataMathSource, dataMath, annotation?.textContent);
  }

  function isDisplayFormula(element) {
    return Boolean(
      element?.matches?.(".math-block, .katex-display, math[display='block']") ||
        element?.closest?.(".math-block, .katex-display, math[display='block']") ||
        element?.querySelector?.(".math-block, .katex-display, math[display='block']")
    );
  }

  function getClickedFormula(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    let formula = target.closest(formulaSelector);
    const assistant = formula?.closest(assistantSelector);
    if (!formula || !assistant) {
      return null;
    }
    const currentMathRoot = formula.closest('[data-math-source], [role="math"]');
    const displayRoot = formula.closest(".math-block, .katex-display");
    const dataMathRoot = formula.closest("[data-math]");
    if (currentMathRoot && assistant.contains(currentMathRoot)) {
      formula = currentMathRoot;
    } else if (displayRoot && assistant.contains(displayRoot)) {
      formula = displayRoot;
    } else if (dataMathRoot && assistant.contains(dataMathRoot)) {
      formula = dataMathRoot;
    } else {
      const katexRoot = formula.closest(".katex, ms-katex, [data-math], .math-inline");
      if (katexRoot && assistant.contains(katexRoot)) {
        formula = katexRoot;
      }
    }
    const source = readFormulaSource(formula);
    return source ? { element: formula, source, display: isDisplayFormula(formula) } : null;
  }

  function selectionIsActive() {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString());
  }

  function syncFormulaMenuOptions() {
    const texButton = formulaMenu?.querySelector('button[data-gpttoolkit-latex-format="tex"]');
    if (texButton) {
      texButton.hidden = !latexTexEnabled;
    }
  }

  function ensureFormulaMenu() {
    if (formulaMenu?.isConnected) {
      return formulaMenu;
    }
    formulaMenu = document.createElement("div");
    formulaMenu.id = "gpttoolkit-latex-toolbar";
    formulaMenu.hidden = true;
    formulaMenu.setAttribute("role", "toolbar");
    formulaMenu.setAttribute("aria-label", "Copy LaTeX formula");
    formulaMenu.innerHTML = `
      <button type="button" data-gpttoolkit-latex-format="tex">tex</button>
      <button type="button" data-gpttoolkit-latex-format="inline">$</button>
      <button type="button" data-gpttoolkit-latex-format="display">$$</button>
      <button type="button" data-gpttoolkit-latex-format="inline-unboxed" title="Copy inline LaTeX without the outer box">去框 $</button>
      <button type="button" data-gpttoolkit-latex-format="display-unboxed" title="Copy display LaTeX without the outer box">去框 $$</button>
    `;
    syncFormulaMenuOptions();
    formulaMenu.addEventListener("click", onFormulaMenuClick);
    document.body.appendChild(formulaMenu);
    return formulaMenu;
  }

  function positionFormulaMenu() {
    if (!formulaMenu || formulaMenu.hidden || !formulaContext?.element.isConnected) {
      closeFormulaMenu();
      return;
    }
    const anchorRect = formulaContext.element.getBoundingClientRect();
    const menuRect = formulaMenu.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchorRect.left + (anchorRect.width - menuRect.width) / 2), window.innerWidth - menuRect.width - 8);
    const preferredTop = anchorRect.bottom + 8;
    const top = preferredTop + menuRect.height <= window.innerHeight - 8 ? preferredTop : Math.max(8, anchorRect.top - menuRect.height - 8);
    formulaMenu.style.left = `${Math.round(left)}px`;
    formulaMenu.style.top = `${Math.round(top)}px`;
  }

  function openFormulaMenu(context) {
    closeFormulaMenu();
    formulaContext = context;
    const menu = ensureFormulaMenu();
    menu.hidden = false;
    requestAnimationFrame(positionFormulaMenu);
    formulaContextObserver = new MutationObserver(() => {
      if (!formulaContext?.element.isConnected) {
        closeFormulaMenu();
      }
    });
    formulaContextObserver.observe(document.body, { childList: true, subtree: true });
  }

  function closeFormulaMenu() {
    formulaContext = null;
    if (formulaContextObserver) {
      formulaContextObserver.disconnect();
      formulaContextObserver = null;
    }
    if (formulaMenu) {
      formulaMenu.hidden = true;
    }
  }

  function ensureToast() {
    if (toast?.isConnected) {
      return toast;
    }
    toast = document.createElement("div");
    toast.id = "gpttoolkit-tools-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
    return toast;
  }

  function showToast(message, tone = "success") {
    const item = ensureToast();
    clearTimeout(toastTimer);
    item.textContent = message;
    item.dataset.tone = tone;
    item.hidden = false;
    toastTimer = window.setTimeout(() => {
      item.hidden = true;
    }, 1800);
  }

  function destroyFormulaUi() {
    closeFormulaMenu();
    clearTimeout(toastTimer);
    formulaMenu?.remove();
    toast?.remove();
    formulaMenu = null;
    toast = null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.setAttribute("data-gpttoolkit-tools-transient", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      } finally {
        textarea.remove();
      }
    }
  }

  async function onFormulaMenuClick(event) {
    const button = event.target.closest("button[data-gpttoolkit-latex-format]");
    if (!button || !formulaContext?.element.isConnected) {
      closeFormulaMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const format = button.dataset.gpttoolkitLatexFormat;
    const text = toolsApi.formatLatex(formulaContext.source, format);
    const copied = Boolean(text) && (await copyText(text));
    closeFormulaMenu();
    showToast(copied ? "Formula copied." : "Couldn't copy the formula.", copied ? "success" : "error");
  }

  function onFormulaClick(event) {
    if (!latexCopyEnabled || formulaMenu?.contains(event.target)) {
      return;
    }
    if (selectionIsActive()) {
      closeFormulaMenu();
      return;
    }
    const context = getClickedFormula(event.target);
    if (context) {
      openFormulaMenu(context);
    } else if (formulaMenu && !formulaMenu.contains(event.target)) {
      closeFormulaMenu();
    }
  }

  function getTopLevelFormulaNodes(fragment) {
    return toolsApi.dedupeNestedFormulaCandidates(
      fragment.querySelectorAll(formulaSelector),
      (candidate) => candidate.parentElement,
      (candidate) => candidate.matches?.(formulaSelector)
    );
  }

  function rangeIsInsideAssistant(range) {
    const common = range.commonAncestorContainer;
    const element = common instanceof Element ? common : common.parentElement;
    return Boolean(element?.closest(assistantSelector));
  }

  function rangeTouchesAssistant(range) {
    const common = range.commonAncestorContainer;
    const element = common instanceof Element ? common : common.parentElement;
    if (!element) {
      return false;
    }
    if (element.closest(assistantSelector)) {
      return true;
    }
    return Array.from(element.querySelectorAll(assistantSelector)).some((assistant) => {
      try {
        return range.intersectsNode(assistant);
      } catch {
        return false;
      }
    });
  }

  function replaceSelectionFormulas(fragment, processAllFormulas) {
    let replacements = 0;
    getTopLevelFormulaNodes(fragment).forEach((formula) => {
      if (!formula.isConnected && !fragment.contains(formula)) {
        return;
      }
      if (!processAllFormulas && !formula.closest(assistantSelector)) {
        return;
      }
      const source = readFormulaSource(formula);
      if (!source) {
        return;
      }
      const display = isDisplayFormula(formula);
      const format = display ? toolsApi.latexFormats.display : toolsApi.latexFormats.inline;
      const formatted = toolsApi.formatLatex(source, format);
      if (display) {
        const block = document.createElement("div");
        block.textContent = formatted;
        formula.replaceWith(block);
      } else {
        formula.replaceWith(document.createTextNode(formatted));
      }
      replacements += 1;
    });
    return replacements;
  }

  function fragmentToPlainText(fragment) {
    let output = "";
    const appendBreak = () => {
      output = output.replace(/[ \t]+$/g, "");
      if (output && !output.endsWith("\n")) {
        output += "\n";
      }
    };
    const visit = (node, preserveWhitespace = false) => {
      if (node.nodeType === Node.TEXT_NODE) {
        let value = node.nodeValue || "";
        if (!preserveWhitespace) {
          value = value.replace(/\s+/g, " ");
          if ((!output || output.endsWith("\n") || output.endsWith(" ")) && value.startsWith(" ")) {
            value = value.slice(1);
          }
        }
        output += value;
        return;
      }
      if (!(node instanceof Element) && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
        return;
      }
      if (node instanceof Element && node.tagName === "BR") {
        appendBreak();
        return;
      }
      const block = node instanceof Element && blockTextTags.has(node.tagName);
      const preserveChildren = preserveWhitespace || (node instanceof Element && node.tagName === "PRE");
      if (block) {
        appendBreak();
      }
      node.childNodes.forEach((child) => visit(child, preserveChildren));
      if (block) {
        appendBreak();
      }
    };
    visit(fragment);
    return output.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function onSelectionCopy(event) {
    if (!latexCopyEnabled || !event.clipboardData || performance.now() < suppressSelectionCopyUntil) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let replacements = 0;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      const clonedRange = range.cloneContents();
      if (rangeTouchesAssistant(range)) {
        replacements += replaceSelectionFormulas(clonedRange, rangeIsInsideAssistant(range));
      }
      if (fragment.childNodes.length && clonedRange.childNodes.length) {
        fragment.appendChild(document.createElement("br"));
      }
      fragment.appendChild(clonedRange);
    }
    if (!replacements) {
      return;
    }

    const plainText = fragmentToPlainText(fragment);
    const htmlContainer = document.createElement("div");
    htmlContainer.appendChild(fragment);
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData("text/plain", plainText);
    event.clipboardData.setData("text/html", htmlContainer.innerHTML);
  }

  function getScrollViewportRect(container) {
    if (container === document.scrollingElement) {
      return { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };
    }
    return container.getBoundingClientRect();
  }

  function findThreadScrollContainer(form) {
    const main = form.closest("main") || document.querySelector("main");
    for (let item = main; item && item !== document.body; item = item.parentElement) {
      const styles = getComputedStyle(item);
      if (/(?:auto|scroll|overlay)/.test(styles.overflowY) && item.scrollHeight > item.clientHeight + 4) {
        return item;
      }
    }
    const scrollingElement = document.scrollingElement;
    return scrollingElement && scrollingElement.scrollHeight > scrollingElement.clientHeight + 4 ? scrollingElement : null;
  }

  function findVisibleTurn(container) {
    const viewport = getScrollViewportRect(container);
    return Array.from(container.querySelectorAll("section[data-testid^='conversation-turn-'], [data-message-author-role]")).find((turn) => {
      const rect = turn.getBoundingClientRect();
      return rect.bottom > viewport.top + 4 && rect.top < viewport.bottom - 4;
    });
  }

  function getAnchorOffset(guard) {
    if (!guard.anchor?.isConnected) {
      return null;
    }
    return guard.anchor.getBoundingClientRect().top - getScrollViewportRect(guard.container).top;
  }

  function performGuardRestore(guard) {
    if (activeGuard !== guard || Date.now() >= guard.expiresAt) {
      disarmScrollGuard(guard);
      return;
    }
    const offset = getAnchorOffset(guard);
    const targetScrollTop = offset === null ? guard.scrollTop : guard.container.scrollTop + offset - guard.anchorOffset;
    if (Math.abs(guard.container.scrollTop - targetScrollTop) <= 0.5) {
      return;
    }
    guard.restoring = true;
    guard.container.scrollTop = targetScrollTop;
    requestAnimationFrame(() => {
      if (activeGuard === guard) {
        guard.restoring = false;
      }
    });
  }

  function scheduleGuardRestore(guard) {
    if (activeGuard !== guard || guard.restoreFrame) {
      return;
    }
    guard.restoreFrame = requestAnimationFrame(() => {
      guard.restoreFrame = 0;
      performGuardRestore(guard);
    });
  }

  function scheduleGuardSettle(guard) {
    if (activeGuard !== guard || guard.settleTimer) {
      return;
    }
    guard.settleTimer = window.setTimeout(() => {
      guard.settleTimer = 0;
      scheduleGuardRestore(guard);
      guard.settleFrame = requestAnimationFrame(() => {
        const firstOffset = getAnchorOffset(guard);
        scheduleGuardRestore(guard);
        guard.settleFrame = requestAnimationFrame(() => {
          guard.settleFrame = 0;
          const secondOffset = getAnchorOffset(guard);
          const stable =
            firstOffset !== null &&
            secondOffset !== null &&
            Math.abs(secondOffset - guard.anchorOffset) <= 1 &&
            Math.abs(secondOffset - firstOffset) <= 1;
          if (stable) {
            disarmScrollGuard(guard);
          } else if (activeGuard === guard) {
            scheduleGuardSettle(guard);
          }
        });
      });
    }, 180);
  }

  function disarmScrollGuard(guard = activeGuard) {
    if (!guard || activeGuard !== guard) {
      return;
    }
    activeGuard = null;
    clearTimeout(guard.expiryTimer);
    clearTimeout(guard.settleTimer);
    if (guard.restoreFrame) {
      cancelAnimationFrame(guard.restoreFrame);
    }
    if (guard.settleFrame) {
      cancelAnimationFrame(guard.settleFrame);
    }
    guard.observer.disconnect();
    guard.scrollEventTarget.removeEventListener("scroll", guard.onScroll);
  }

  function mutationsAddUserTurn(records) {
    return records.some((record) =>
      Array.from(record.addedNodes).some(
        (node) =>
          node instanceof Element &&
          (node.matches('[data-message-author-role="user"]') || node.querySelector('[data-message-author-role="user"]'))
      )
    );
  }

  function onGuardMutations(guard, records) {
    if (activeGuard !== guard) {
      return;
    }
    scheduleGuardRestore(guard);
    if (mutationsAddUserTurn(records)) {
      scheduleGuardSettle(guard);
    }
  }

  function armScrollGuard(container) {
    disarmScrollGuard();
    const anchor = findVisibleTurn(container);
    if (!anchor) {
      return;
    }
    const guard = {
      container,
      anchor,
      anchorOffset: anchor.getBoundingClientRect().top - getScrollViewportRect(container).top,
      scrollTop: container.scrollTop,
      expiresAt: Date.now() + toolsApi.scrollGuardDuration,
      restoring: false,
      restoreFrame: 0,
      settleFrame: 0,
      settleTimer: 0,
      expiryTimer: 0,
      observer: null,
      onScroll: null,
      scrollEventTarget: container === document.scrollingElement ? document : container
    };
    guard.onScroll = () => {
      if (guard.restoring) {
        requestAnimationFrame(() => scheduleGuardRestore(guard));
      } else {
        scheduleGuardRestore(guard);
      }
    };
    guard.observer = new MutationObserver((records) => onGuardMutations(guard, records));
    guard.observer.observe(container, { childList: true, subtree: true });
    guard.scrollEventTarget.addEventListener("scroll", guard.onScroll, { passive: true });
    guard.expiryTimer = window.setTimeout(() => disarmScrollGuard(guard), toolsApi.scrollGuardDuration);
    activeGuard = guard;
  }

  function onComposerSubmit(event) {
    if (!scrollGuardEnabled || !(event.target instanceof HTMLFormElement) || !event.target.querySelector(composerSelector)) {
      return;
    }
    const container = findThreadScrollContainer(event.target);
    if (!container || !toolsApi.shouldPreserveSubmitPosition(container, scrollGuardEnabled)) {
      disarmScrollGuard();
      return;
    }
    armScrollGuard(container);
  }

  function isEditableTarget(target) {
    return Boolean(target instanceof Element && target.closest("input, textarea, [contenteditable='true']"));
  }

  function onUserKeydown(event) {
    if (!activeGuard) {
      return;
    }
    const pagingKey = cancelKeys.has(event.key) || (event.key === " " && !isEditableTarget(event.target));
    if (pagingKey && (!isEditableTarget(event.target) || event.key === "PageUp" || event.key === "PageDown")) {
      disarmScrollGuard();
    }
  }

  function onPointerDown(event) {
    if (!activeGuard || !Number.isFinite(event.clientX)) {
      return;
    }
    const rect = getScrollViewportRect(activeGuard.container);
    if (event.clientX >= rect.right - 18) {
      disarmScrollGuard();
    }
  }

  function isScrollToBottomControl(target) {
    return Boolean(
      target instanceof Element &&
        target.closest(
          "[data-gpttoolkit-scroll-button], button[aria-label*='scroll' i], button[aria-label*='bottom' i], button[data-testid*='scroll' i], [role='button'][aria-label*='bottom' i]"
        )
    );
  }

  function isNativeResponseCopyControl(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    const control = target.closest("button, [role='button']");
    const turn = control?.closest("section[data-testid^='conversation-turn-'], [data-content-search-turn-key]");
    if (!control || (!control.closest(assistantSelector) && !turn?.querySelector(assistantSelector))) {
      return false;
    }
    const signal = [
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.getAttribute("data-testid"),
      control.textContent
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return /(?:^|\b)copy(?: response| message| answer)?(?:\b|$)|复制(?:回答|响应|消息)?|コピー/i.test(signal);
  }

  function onDocumentClick(event) {
    if (latexCopyEnabled && isNativeResponseCopyControl(event.target)) {
      suppressSelectionCopyUntil = performance.now() + 750;
    }
    if (scrollGuardEnabled && activeGuard && isScrollToBottomControl(event.target)) {
      disarmScrollGuard();
    }
    if (latexCopyEnabled) {
      onFormulaClick(event);
    }
  }

  function cleanupTransientState() {
    disarmScrollGuard();
    destroyFormulaUi();
  }

  function onScrollGuardUserIntent() {
    disarmScrollGuard();
  }

  function syncDocumentClickListener() {
    const shouldAttach = scrollGuardEnabled || latexCopyEnabled;
    if (shouldAttach === documentClickListenerAttached) {
      return;
    }

    documentClickListenerAttached = shouldAttach;
    document[shouldAttach ? "addEventListener" : "removeEventListener"]("click", onDocumentClick, true);
  }

  function syncScrollGuardListeners() {
    if (scrollGuardEnabled === scrollGuardListenersAttached) {
      return;
    }

    scrollGuardListenersAttached = scrollGuardEnabled;
    const method = scrollGuardEnabled ? "addEventListener" : "removeEventListener";
    document[method]("submit", onComposerSubmit, true);
    document[method]("wheel", onScrollGuardUserIntent, { passive: true, capture: true });
    document[method]("touchstart", onScrollGuardUserIntent, { passive: true, capture: true });
    document[method]("keydown", onUserKeydown, true);
    document[method]("pointerdown", onPointerDown, true);
  }

  function syncLatexCopyListeners() {
    if (latexCopyEnabled === latexCopyListenersAttached) {
      return;
    }

    latexCopyListenersAttached = latexCopyEnabled;
    const method = latexCopyEnabled ? "addEventListener" : "removeEventListener";
    document[method]("copy", onSelectionCopy, true);
    document[method]("scroll", closeFormulaMenu, { passive: true, capture: true });
    window[method]("resize", closeFormulaMenu, { passive: true });
  }

  function syncFeatureEventListeners() {
    syncScrollGuardListeners();
    syncLatexCopyListeners();
    syncDocumentClickListener();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }
    if (changes[toolsApi.conversationHistoryEnabledStorageKey]) {
      syncHistoryFeature(changes[toolsApi.conversationHistoryEnabledStorageKey].newValue !== false);
    }
    let featureListenersChanged = false;
    if (changes[toolsApi.scrollGuardEnabledStorageKey]) {
      scrollGuardEnabled = changes[toolsApi.scrollGuardEnabledStorageKey].newValue !== false;
      featureListenersChanged = true;
      if (!scrollGuardEnabled) {
        disarmScrollGuard();
      }
    }
    if (changes[toolsApi.latexCopyEnabledStorageKey]) {
      latexCopyEnabled = changes[toolsApi.latexCopyEnabledStorageKey].newValue !== false;
      featureListenersChanged = true;
      if (!latexCopyEnabled) {
        destroyFormulaUi();
      }
    }
    if (changes[toolsApi.latexTexEnabledStorageKey]) {
      latexTexEnabled = changes[toolsApi.latexTexEnabledStorageKey].newValue !== false;
      syncFormulaMenuOptions();
      if (formulaMenu && !formulaMenu.hidden) {
        requestAnimationFrame(positionFormulaMenu);
      }
    }
    if (featureListenersChanged) {
      syncFeatureEventListeners();
    }
  });

  toolsApi.loadToolSettings(
    (result) => {
      scrollGuardEnabled = result[toolsApi.scrollGuardEnabledStorageKey] !== false;
      latexCopyEnabled = result[toolsApi.latexCopyEnabledStorageKey] !== false;
      latexTexEnabled = result[toolsApi.latexTexEnabledStorageKey] !== false;
      syncHistoryFeature(result[toolsApi.conversationHistoryEnabledStorageKey] !== false);
      syncFormulaMenuOptions();
      syncFeatureEventListeners();
    }
  );

  syncFeatureEventListeners();
  window.addEventListener(routeChangeEventName, cleanupTransientState);
})();
