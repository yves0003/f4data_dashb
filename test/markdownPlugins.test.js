const assert = require("node:assert/strict");
const test = require("node:test");
const MarkdownIt = require("markdown-it");
const { extendMarkdownIt } = require("../out/markdownPlugins");

test("extends the VS Code Markdown parser with collapsible sections and task lists", () => {
  const markdown = extendMarkdownIt(new MarkdownIt());
  const html = markdown.render("+++ Details\nHidden content\n+++\n\n- [ ] Todo\n- [x] Done");

  assert.match(html, /<details>/);
  assert.match(html, /<summary>.*Details/);
  assert.match(html, /class="task-list-item"/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked=""/);
});
