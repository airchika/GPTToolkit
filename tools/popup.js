(function () {
  "use strict";

  const toolsApi = globalThis.GPTToolkitTools;
  const scrollGuardToggle = document.querySelector("[data-gpttoolkit-scroll-guard-enabled]");
  const latexCopyToggle = document.querySelector("[data-gpttoolkit-latex-copy-enabled]");
  const latexTexToggle = document.querySelector("[data-gpttoolkit-latex-tex-enabled]");
  const historyToggle = document.querySelector("[data-gpttoolkit-conversation-history-enabled]");
  const toolsTab = document.querySelector('[data-style-mode="tools"]');
  const status = document.getElementById("status");
  if (!toolsApi || !scrollGuardToggle || !latexCopyToggle || !latexTexToggle || !historyToggle) {
    return;
  }

  const toolSettings = [
    {
      toggle: historyToggle,
      storageKey: toolsApi.conversationHistoryEnabledStorageKey,
      enabledText: "Conversation history enabled.",
      disabledText: "Conversation history disabled."
    },
    {
      toggle: scrollGuardToggle,
      storageKey: toolsApi.scrollGuardEnabledStorageKey,
      enabledText: "Reading-position protection enabled.",
      disabledText: "Reading-position protection disabled."
    },
    {
      toggle: latexCopyToggle,
      storageKey: toolsApi.latexCopyEnabledStorageKey,
      enabledText: "LaTeX quick copy enabled.",
      disabledText: "LaTeX quick copy disabled."
    },
    {
      toggle: latexTexToggle,
      storageKey: toolsApi.latexTexEnabledStorageKey,
      enabledText: "The tex choice is shown.",
      disabledText: "The tex choice is hidden."
    }
  ];

  toolSettings.forEach(({ toggle }) => { toggle.disabled = true; });
  toolsApi.loadToolSettings(
    (result, error) => {
      if (error) status.textContent = "Couldn't load or migrate tool settings. Refresh and try again.";
      toolSettings.forEach(({ toggle, storageKey }) => {
        toggle.checked = result[storageKey] !== false;
        toggle.disabled = false;
      });
    }
  );

  toolsTab?.addEventListener("click", () => {
    status.textContent = "Conversation history, reading-position protection and LaTeX quick copy are enabled by default.";
  });

  toolSettings.forEach(({ toggle, storageKey, enabledText, disabledText }) => {
    toggle.addEventListener("change", () => {
      const enabled = toggle.checked;
      chrome.storage.sync.set({ [storageKey]: enabled }, () => {
        if (chrome.runtime.lastError) {
          toggle.checked = !enabled;
          status.textContent = "Couldn't save the tool setting. Try again.";
          return;
        }
        status.textContent = enabled ? enabledText : disabledText;
      });
    });
  });
})();
