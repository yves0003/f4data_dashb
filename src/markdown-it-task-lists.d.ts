declare module "markdown-it-task-lists" {
  import MarkdownIt = require("markdown-it");

  function taskLists(markdownIt: ReturnType<typeof MarkdownIt>): void;
  export = taskLists;
}
