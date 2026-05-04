import { useMarkdown } from "./use-markdown";
import { cn } from "../utils/cn";

export function MarkdownRenderer({ content, className }: { content: string; className?: string }) {
  const { renderedParts } = useMarkdown(content);

  return <div className={cn("markdown-renderer", className)}>{renderedParts}</div>;
}
