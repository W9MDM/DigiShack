import { isValidElement, type ReactNode } from "react";

import type { FaqSection } from "@/components/help/faq";

/** The plain text of a JSX tree, so the search reads the answers rather than a copy of them. */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Lower case, accents off, dashes as spaces: "Re-arm" and "re arm" are the same search. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-–—/]/g, " ");
}

/** A search over a fixed FAQ: built once, then asked per keystroke. */
export function faqSearch(faq: FaqSection[]): (query: string) => FaqSection[] {
  const haystack = new Map<string, string>(
    faq.flatMap((s) =>
      s.items.map((i) => [i.id, normalize([s.title, i.q, i.keywords ?? "", textOf(i.a)].join(" "))]),
    ),
  );
  // Every word must appear, as a substring so "decod" finds "decodes".
  return (query) => {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return faq;
    return faq
      .map((s) => ({
        ...s,
        items: s.items.filter((i) => {
          const hay = haystack.get(i.id) ?? "";
          return words.every((w) => hay.includes(w));
        }),
      }))
      .filter((s) => s.items.length > 0);
  };
}
