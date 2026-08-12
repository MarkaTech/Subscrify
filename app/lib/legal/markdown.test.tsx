import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderMarkdown } from "./markdown";

/** Flatten the rendered tree into plain text, so a test can assert nothing was dropped. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    return textOf((node.props as { children?: unknown }).children);
  }
  return "";
}

function typesOf(nodes: unknown[]): string[] {
  return nodes.filter(isValidElement).map((n) => String((n as ReactElement).type));
}

describe("renderMarkdown", () => {
  it("renders headings at the right level", () => {
    const nodes = renderMarkdown("# Title\n\n## Section\n\n### Sub");
    expect(typesOf(nodes)).toEqual(["h1", "h2", "h3"]);
    expect(textOf(nodes)).toBe("TitleSectionSub");
  });

  it("joins wrapped lines into one paragraph and splits on blank lines", () => {
    const nodes = renderMarkdown("one\ntwo\n\nthree");
    expect(typesOf(nodes)).toEqual(["p", "p"]);
    expect(textOf(nodes[0])).toBe("one two");
    expect(textOf(nodes[1])).toBe("three");
  });

  it("renders bold and links inline", () => {
    const nodes = renderMarkdown("a **bold** word and [a link](https://example.com).");
    expect(textOf(nodes)).toBe("a bold word and a link.");
    const para = nodes[0] as ReactElement;
    const children = (para.props as { children: unknown[] }).children;
    const link = children.find(
      (c) => isValidElement(c) && c.type === "a",
    ) as ReactElement;
    expect((link.props as { href: string }).href).toBe("https://example.com");
  });

  it("allows mailto links", () => {
    const nodes = renderMarkdown("[write to us](mailto:hello@example.com)");
    const children = ((nodes[0] as ReactElement).props as { children: unknown[] }).children;
    const link = children.find((c) => isValidElement(c) && c.type === "a") as ReactElement;
    expect((link.props as { href: string }).href).toBe("mailto:hello@example.com");
  });

  /**
   * The documents are ours, so this is defence in depth rather than a live
   * threat — but a renderer that can emit a javascript: href is a renderer
   * that will eventually be pointed at someone else's text.
   */
  it("refuses to emit a link for a non-http scheme", () => {
    const nodes = renderMarkdown("[click](javascript:alert(1))");
    expect(typesOf([nodes[0]])).toEqual(["p"]);
    const children = ((nodes[0] as ReactElement).props as { children: unknown[] }).children;
    expect(children.some((c) => isValidElement(c) && c.type === "a")).toBe(false);
    // Still visible, not silently dropped.
    expect(textOf(nodes[0])).toContain("click");
  });

  it("renders a pipe table with its header and rows", () => {
    const nodes = renderMarkdown(
      ["| What | Why |", "|---|---|", "| Session | Auth |", "| Billing | Charges |", "", "after"].join(
        "\n",
      ),
    );
    expect(typesOf(nodes)).toEqual(["table", "p"]);
    const table = nodes[0] as ReactElement;
    const [thead, tbody] = (table.props as { children: ReactElement[] }).children;
    expect(textOf(thead)).toBe("WhatWhy");
    const bodyRows = (tbody.props as { children: ReactElement[] }).children;
    expect(bodyRows).toHaveLength(2);
    expect(textOf(bodyRows[0])).toBe("SessionAuth");
    // Content after the table is not swallowed by it.
    expect(textOf(nodes[1])).toBe("after");
  });

  it("groups consecutive bullets into one list", () => {
    const nodes = renderMarkdown("intro\n\n- one\n- two\n\nafter");
    expect(typesOf(nodes)).toEqual(["p", "ul", "p"]);
    const items = ((nodes[1] as ReactElement).props as { children: ReactElement[] }).children;
    expect(items).toHaveLength(2);
  });

  it("renders a horizontal rule", () => {
    expect(typesOf(renderMarkdown("a\n\n---\n\nb"))).toEqual(["p", "hr", "p"]);
  });

  /**
   * The guarantee that matters for a legal page: every word of the source
   * reaches the page. A parser that drops a clause it doesn't understand
   * would publish an altered document without anyone noticing.
   */
  it("keeps every word of the real documents", async () => {
    const [{ default: privacy }, { default: terms }] = await Promise.all([
      import("../../legal/privacy.md?raw"),
      import("../../legal/terms.md?raw"),
    ]);

    for (const source of [privacy, terms]) {
      const rendered = textOf(renderMarkdown(source));
      const words = source
        .replace(/[#*|_>-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && /[a-z]/i.test(w));
      expect(words.length).toBeGreaterThan(200);
      for (const word of words) {
        expect(rendered).toContain(word.replace(/^\(|\)$/g, ""));
      }
    }
  });
});
