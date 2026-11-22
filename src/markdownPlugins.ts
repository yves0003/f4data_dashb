import MarkdownIt = require("markdown-it");
import collapsible from "markdown-it-collapsible";
import taskLists from "markdown-it-task-lists";

type MarkdownItInstance = ReturnType<typeof MarkdownIt>;

export function extendMarkdownIt(markdownIt: MarkdownItInstance): MarkdownItInstance {
  return markdownIt.use(collapsible).use(taskLists);
}
