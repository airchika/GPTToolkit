"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../tools/shared.js");

const toolsApi = globalThis.GPTToolkitTools;
assert.ok(toolsApi, "tools API must be exposed");
assert.equal(toolsApi.scrollGuardEnabledStorageKey, "gpttoolkit.scrollGuard.enabled");
assert.equal(toolsApi.latexCopyEnabledStorageKey, "gpttoolkit.latexCopy.enabled");
assert.equal(toolsApi.latexTexEnabledStorageKey, "gpttoolkit.latexCopy.tex.enabled");
assert.equal(toolsApi.defaultScrollGuardEnabled, true);
assert.equal(toolsApi.defaultLatexCopyEnabled, true);
assert.equal(toolsApi.defaultLatexTexEnabled, true);

const boxedSource = String.raw`\boxed{ \bar\alpha_t = \prod_{s=1}^{t}\alpha_s }`;
assert.equal(toolsApi.formatLatex(boxedSource, toolsApi.latexFormats.inlineUnboxed), String.raw`$\bar\alpha_t = \prod_{s=1}^{t}\alpha_s$`);
for (const [source, expected] of [
  ["$\\boxed{ \n x + y \t }$", "$x + y$"],
  ["\\boxed{ \\boxed{ x, } }。", "$x$"],
  ["\\boxed{ \\frac{a_{1}}{b^{2}} }", "$\\frac{a_{1}}{b^{2}}$"],
  ["\\boxed{ \\{x\\} }", "$\\{x\\}$"],
  ["\\boxed { x }", "$x$"],
  ["\\boxed{ }", ""],
  [" x + y ", "$x + y$"],
  ["\\boxed{x} + {y}", "$\\boxed{x} + {y}$"],
  ["\\boxed{x", "$\\boxed{x$"],
  ["\\boxedextra{x}", "$\\boxedextra{x}$"]
]) {
  assert.equal(toolsApi.formatLatex(source, toolsApi.latexFormats.inlineUnboxed), expected);
  assert.equal(toolsApi.formatLatex(source, toolsApi.latexFormats.displayUnboxed), expected ? `$${expected}$` : "");
}
assert.equal(toolsApi.formatLatex(boxedSource, toolsApi.latexFormats.inline), `$${boxedSource}$`);
assert.equal(toolsApi.formatLatex(boxedSource, toolsApi.latexFormats.display), `$$${boxedSource}$$`);
assert.equal(toolsApi.formatLatex(boxedSource, toolsApi.latexFormats.tex), boxedSource);

assert.equal(toolsApi.formatLatex("  x^2 + y^2  ", toolsApi.latexFormats.tex), "x^2 + y^2");
assert.equal(toolsApi.formatLatex("$x$", toolsApi.latexFormats.inline), "$x$");
assert.equal(toolsApi.formatLatex("\\[x + y\\]", toolsApi.latexFormats.display), "$$x + y$$");
for (const format of Object.values(toolsApi.latexFormats)) {
  const wrap = (source) => format === "inline" || format === "inline-unboxed" ? `$${source}$` : format === "display" || format === "display-unboxed" ? `$$${source}$$` : source;
  for (const punctuation of [",", ".", "，", "。", "， 。"]) {
    assert.equal(toolsApi.formatLatex(` x + y${punctuation} \n`, format), wrap("x + y"));
    assert.equal(toolsApi.formatLatex(`$$x + y${punctuation}$$`, format), wrap("x + y"));
  }
  for (const source of ["f(x,y) = 1.5", "x\\,", "x\\.", "\\left|x\\right.", "\\left. x \\right|", "x\\middle."]) {
    assert.equal(toolsApi.formatLatex(source, format), wrap(source), "mathematical punctuation must survive copying");
  }
  assert.equal(toolsApi.formatLatex("\\left|x\\right..", format), wrap("\\left|x\\right."));
  assert.equal(toolsApi.formatLatex("，。", format), "");
}
const multilineLatex = "\\begin{aligned}\r\n  x &= 1 \\\\\r\n  y &= 2\n\\end{aligned}";
assert.equal(
  toolsApi.formatLatex(multilineLatex, toolsApi.latexFormats.inline),
  "$\\begin{aligned} x &= 1 \\\\ y &= 2 \\end{aligned}$",
  "single-dollar formulas must flatten source whitespace without removing TeX line-break commands"
);
assert.equal(
  toolsApi.formatLatex(multilineLatex, toolsApi.latexFormats.tex),
  multilineLatex,
  "raw tex copies must preserve source line breaks"
);
assert.equal(
  toolsApi.formatLatex(multilineLatex, toolsApi.latexFormats.display),
  `$$${multilineLatex}$$`,
  "display copies must preserve source line breaks"
);
assert.equal(
  toolsApi.formatLatex(`$$\\boxed{ \n${multilineLatex}\n }。$$`, toolsApi.latexFormats.displayUnboxed),
  `$$${multilineLatex}$$`,
  "unboxed display copies must trim the edges and punctuation while preserving internal line breaks"
);
assert.equal(
  toolsApi.resolveLatexSource("x_current", "x_legacy", "x_annotation"),
  "x_current",
  "current data-math-source metadata must win"
);
assert.equal(toolsApi.resolveLatexSource("", "x_legacy", "x_annotation"), "x_legacy", "legacy data-math must remain supported");
assert.equal(toolsApi.resolveLatexSource("", "", "x_annotation"), "x_annotation", "TeX annotation must be the fallback");
assert.equal(toolsApi.resolveLatexSource("", "", ""), "", "formulas without source metadata must stay native");

const outer = { id: "outer", parent: null, formula: true };
const inner = { id: "inner", parent: outer, formula: true };
const sibling = { id: "sibling", parent: null, formula: true };
assert.deepEqual(
  toolsApi.dedupeNestedFormulaCandidates(
    [outer, inner, sibling],
    (item) => item.parent,
    (item) => item.formula
  ).map((item) => item.id),
  ["outer", "sibling"],
  "nested KaTeX and MathML candidates must be replaced only once"
);

assert.equal(toolsApi.getBottomGap({ scrollHeight: 1000, clientHeight: 500, scrollTop: 350 }), 150);
assert.equal(
  toolsApi.shouldPreserveSubmitPosition({ scrollHeight: 1000, clientHeight: 500, scrollTop: 350 }),
  false,
  "the 150px boundary must keep ChatGPT's normal behavior"
);
assert.equal(toolsApi.shouldPreserveSubmitPosition({ scrollHeight: 1000, clientHeight: 500, scrollTop: 349 }), true);
assert.equal(toolsApi.shouldPreserveSubmitPosition({ scrollHeight: 1000, clientHeight: 500, scrollTop: 0 }, false), false);

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const toolsContentScript = manifest.content_scripts.find((entry) => entry.js && entry.js.includes("tools/content.js"));
assert.ok(toolsContentScript, "tools must be registered as a separate content-script module");
assert.deepEqual(toolsContentScript.js, ["tools/shared.js", "tools/content.js"]);
assert.deepEqual(toolsContentScript.css, ["tools/content.css"]);
assert.doesNotMatch(JSON.stringify(manifest.permissions), /clipboard|scripting/i, "tools must not add clipboard or scripting permissions");
assert.equal(toolsContentScript.world, undefined, "tools must stay in the normal isolated content-script world");

const contentSource = fs.readFileSync(path.join(__dirname, "..", "tools", "content.js"), "utf8");
assert.ok(contentSource.includes(`data-gpttoolkit-latex-format="${toolsApi.latexFormats.inlineUnboxed}"`), "the unboxed inline format must be available in the formula toolbar");
assert.ok(contentSource.includes(`data-gpttoolkit-latex-format="${toolsApi.latexFormats.displayUnboxed}"`), "the unboxed display format must be available in the formula toolbar");
assert.match(contentSource, /function syncFeatureEventListeners\(\)/, "tool listeners must follow their feature switches");
assert.match(contentSource, /document\[method\]\("submit", onComposerSubmit, true\)/);
assert.match(contentSource, /document\[method\]\("copy", onSelectionCopy, true\)/);
assert.match(contentSource, /removeEventListener/, "disabled tools must detach their event listeners");
assert.match(contentSource, /window\.addEventListener\(routeChangeEventName, cleanupTransientState\)/);
assert.doesNotMatch(contentSource, /setInterval\(/, "tools must consume the shared route signal instead of polling again");
assert.match(contentSource, /range\.cloneContents\(\)/, "mixed copy must inspect only the selected range clone");
assert.match(contentSource, /setData\("text\/plain"/);
assert.match(contentSource, /setData\("text\/html"/);
assert.match(contentSource, /isNativeResponseCopyControl/, "ChatGPT's response copy control must stay native");
assert.match(contentSource, /data-message-author-role=\\?"assistant\\?"/);
assert.match(contentSource, /data-math-source/, "current ChatGPT formula source metadata must be supported");
assert.match(contentSource, /\[role=\\?"math\\?"\]/, "current ChatGPT formula roots must be recognized");
assert.match(contentSource, /annotation\[encoding=\\?"application\/x-tex\\?"\]/);
assert.match(contentSource, /data-gpttoolkit-latex-format="tex">tex<\/button>/, "the raw formula choice must use lowercase tex");
assert.match(contentSource, /latexTexEnabledStorageKey/, "the raw tex choice must react to its independent setting");
assert.doesNotMatch(contentSource, /(?:Window|Element|HTMLElement)\.prototype/, "tools must not patch browser prototypes");
assert.doesNotMatch(contentSource, /scrollIntoView\s*=|scrollTo\s*=|scrollBy\s*=/, "scroll protection must not replace global scrolling APIs");
assert.doesNotMatch(contentSource, /clipboard\.read|readText\s*\(/, "tools must never read the clipboard");
assert.doesNotMatch(contentSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket/, "tools must not call network APIs");
const guardMutationStart = contentSource.indexOf("function mutationsAddUserTurn(");
const guardMutationEnd = contentSource.indexOf("function armScrollGuard(", guardMutationStart);
assert.notEqual(guardMutationStart, -1, "scroll protection must inspect mutation batches");
const guardMutationSource = contentSource.slice(guardMutationStart, guardMutationEnd);
assert.match(guardMutationSource, /record\.addedNodes/);
assert.doesNotMatch(guardMutationSource, /querySelectorAll/, "scroll protection must not recount a long conversation on every mutation");

const popupSource = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.html"), "utf8");
assert.match(popupSource, /data-style-mode="tools"/);
assert.doesNotMatch(popupSource, /queue/i, "the removed message queue must not remain in the popup");
assert.match(popupSource, /data-gpttoolkit-scroll-guard-enabled/);
assert.match(popupSource, /data-gpttoolkit-latex-copy-enabled/);
assert.match(popupSource, /data-gpttoolkit-latex-tex-enabled/);
assert.match(popupSource, /Formula Copy and Prevent Auto Scroll/);

const toolsCss = fs.readFileSync(path.join(__dirname, "..", "tools", "content.css"), "utf8");
assert.match(toolsCss, /html:is\(\.dark, \[data-theme="dark"\]\)/, "tool surfaces must follow ChatGPT's dark theme state");
assert.match(toolsCss, /#gpttoolkit-latex-toolbar button\[hidden\]/, "the raw tex choice must be removable from the toolbar");

console.log("Checked GPTToolkit tools contracts.");

const oldSettings = { "gptskins.scrollGuard.enabled": false, "gptskins.latexCopy.enabled": false, "gpttoolkit.latexCopy.enabled": true };
assert.deepEqual(toolsApi.resolveToolSettings(oldSettings), {
  "gpttoolkit.scrollGuard.enabled": false,
  "gpttoolkit.latexCopy.enabled": true,
  "gpttoolkit.latexCopy.tex.enabled": true,
  "gpttoolkit.conversationHistory.enabled": true
});
assert.deepEqual(toolsApi.getToolMigration(oldSettings), {
  "gpttoolkit.scrollGuard.enabled": false, "gpttoolkit.latexCopy.tex.enabled": true,
  "gpttoolkit.conversationHistory.enabled": true
});
assert.deepEqual(toolsApi.getToolMigration({...oldSettings, ...toolsApi.getToolMigration(oldSettings)}), {});

assert.equal(toolsApi.resolveToolSettings({ "gpttoolkit.conversationHistory.enabled": false })[toolsApi.conversationHistoryEnabledStorageKey], false);
assert.equal(toolsApi.getToolMigration({ "gpttoolkit.conversationHistory.enabled": false })[toolsApi.conversationHistoryEnabledStorageKey], undefined);
