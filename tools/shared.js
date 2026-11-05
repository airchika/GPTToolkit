(function () {
  "use strict";

  const scrollGuardEnabledStorageKey = "gpttoolkit.scrollGuard.enabled";
  const latexCopyEnabledStorageKey = "gpttoolkit.latexCopy.enabled";
  const latexTexEnabledStorageKey = "gpttoolkit.latexCopy.tex.enabled";
  const defaultScrollGuardEnabled = true;
  const defaultLatexCopyEnabled = true;
  const defaultLatexTexEnabled = true;
  const scrollBottomGapThreshold = 150;
  const scrollGuardDuration = 2000;
  const latexFormats = Object.freeze({
    tex: "tex",
    inline: "inline",
    inlineUnboxed: "inline-unboxed",
    display: "display",
    displayUnboxed: "display-unboxed"
  });

  function stripMathDelimiters(value) {
    let source = typeof value === "string" ? value.trim() : "";
    const delimiterPairs = [
      ["$$", "$$"],
      ["\\[", "\\]"],
      ["\\(", "\\)"],
      ["$", "$"]
    ];

    for (const [opening, closing] of delimiterPairs) {
      if (source.startsWith(opening) && source.endsWith(closing) && source.length > opening.length + closing.length) {
        source = source.slice(opening.length, -closing.length).trim();
        break;
      }
    }
    return source;
  }

  function unwrapBoxedLatex(value) {
    let source = formatLatex(value, latexFormats.tex);
    for (let opening; (opening = /^\\boxed\s*\{/.exec(source));) {
      // Match the outer group without counting escaped braces such as \{.
      const tokens = /\\[a-zA-Z]+|\\[\s\S]|[{}]/g;
      tokens.lastIndex = opening[0].length;
      let depth = 1;
      let closing = -1;
      for (let token; (token = tokens.exec(source));) {
        if (token[0] === "{") depth += 1;
        if (token[0] === "}") depth -= 1;
        if (depth === 0) {
          closing = token.index;
          break;
        }
      }
      if (closing !== source.length - 1) break;
      source = formatLatex(source.slice(opening[0].length, closing), latexFormats.tex);
    }
    return source;
  }

  function formatLatex(value, format = latexFormats.tex) {
    if (format === latexFormats.inlineUnboxed) {
      return formatLatex(unwrapBoxedLatex(value), latexFormats.inline);
    }
    if (format === latexFormats.displayUnboxed) {
      return formatLatex(unwrapBoxedLatex(value), latexFormats.display);
    }
    let source = stripMathDelimiters(value);
    while (/[,，.。]$/.test(source)) {
      // Preserve escaped punctuation and TeX's invisible delimiters.
      const backslashes = source.slice(0, -1).match(/\\+$/);
      if ((backslashes && backslashes[0].length % 2 === 1) || /\\(?:left|right|middle)\s*\.$/.test(source)) {
        break;
      }
      source = source.slice(0, -1).trimEnd();
    }
    if (!source) {
      return "";
    }
    if (format === latexFormats.inline) {
      return `$${source.replace(/\s+/g, " ").trim()}$`;
    }
    if (format === latexFormats.display) {
      return `$$${source}$$`;
    }
    return source;
  }

  function resolveLatexSource(...sources) {
    for (const source of sources) {
      const resolved = stripMathDelimiters(source);
      if (resolved) {
        return resolved;
      }
    }
    return "";
  }

  function dedupeNestedFormulaCandidates(candidates, getParent, isFormula) {
    return Array.from(candidates || []).filter((candidate) => {
      for (let parent = getParent(candidate); parent; parent = getParent(parent)) {
        if (isFormula(parent)) {
          return false;
        }
      }
      return true;
    });
  }

  function getBottomGap(metrics) {
    if (!metrics) {
      return 0;
    }
    const scrollHeight = Number(metrics.scrollHeight) || 0;
    const clientHeight = Number(metrics.clientHeight) || 0;
    const scrollTop = Number(metrics.scrollTop) || 0;
    return Math.max(0, scrollHeight - clientHeight - scrollTop);
  }

  function shouldPreserveSubmitPosition(metrics, enabled = true) {
    return Boolean(enabled && getBottomGap(metrics) > scrollBottomGapThreshold);
  }

  const conversationHistoryEnabledStorageKey = "gpttoolkit.conversationHistory.enabled";
  const toolStorageKeys = [scrollGuardEnabledStorageKey, latexCopyEnabledStorageKey, latexTexEnabledStorageKey, conversationHistoryEnabledStorageKey];
  function resolveToolSettings(settings = {}) {
    return Object.fromEntries(toolStorageKeys.map((key) => {
      const oldKey = key.replace("gpttoolkit.", "gptskins.");
      const value = Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : settings[oldKey];
      return [key, value !== false];
    }));
  }
  function getToolMigration(settings = {}) {
    const resolved = resolveToolSettings(settings);
    return Object.fromEntries(toolStorageKeys.filter((key) =>
      !Object.prototype.hasOwnProperty.call(settings, key)).map((key) => [key, resolved[key]]));
  }
  function loadToolSettings(callback) {
    chrome.storage.sync.get([...toolStorageKeys, ...toolStorageKeys.map((key) => key.replace("gpttoolkit.", "gptskins."))], (settings) => {
      const error = chrome.runtime.lastError;
      if (error) { callback(resolveToolSettings(), error.message); return; }
      const resolved = resolveToolSettings(settings);
      const migration = getToolMigration(settings);
      if (Object.keys(migration).length) {
        chrome.storage.sync.set(migration, () => {
          const saveError = chrome.runtime.lastError;
          callback(resolved, saveError?.message);
        });
      } else { callback(resolved); }
    });
  }

  globalThis.GPTToolkitTools = {
    resolveToolSettings, getToolMigration, loadToolSettings,
    conversationHistoryEnabledStorageKey,
    scrollGuardEnabledStorageKey,
    latexCopyEnabledStorageKey,
    latexTexEnabledStorageKey,
    defaultScrollGuardEnabled,
    defaultLatexCopyEnabled,
    defaultLatexTexEnabled,
    scrollBottomGapThreshold,
    scrollGuardDuration,
    latexFormats,
    stripMathDelimiters,
    formatLatex,
    resolveLatexSource,
    dedupeNestedFormulaCandidates,
    getBottomGap,
    shouldPreserveSubmitPosition
  };
})();
