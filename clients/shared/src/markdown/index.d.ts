import type { ReactNode } from "react";

export function useMarkdown(content: string): { renderedParts: ReactNode };
export function MarkdownRenderer(props: { content: string; className?: string }): ReactNode;
