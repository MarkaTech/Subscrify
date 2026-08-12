import type { ReactNode } from "react";

/**
 * A deliberately tiny Markdown renderer for the legal pages.
 *
 * WHY NOT A LIBRARY: the privacy policy and the terms are the only Markdown
 * this app renders, they are written by us, they are bundled at build time,
 * and they change a few times a year. Pulling in a parser (plus a sanitiser,
 * because a parser that emits HTML needs one) to render two static documents
 * is a dependency and a supply-chain surface bought for nothing.
 *
 * WHY NOT JSX: the documents also ship to merchants and reviewers as .md
 * files. Keeping one source of truth in docs/ and rendering it means the
 * published page and the sent document cannot drift apart — which for a legal
 * document is the entire point.
 *
 * It returns React elements, never HTML strings, so there is no
 * dangerouslySetInnerHTML anywhere and nothing to sanitise.
 *
 * Supported, because that is what the documents use: ATX headings (# to ###),
 * paragraphs, `---` rules, pipe tables with a separator row, unordered lists,
 * **bold**, and [links](url). Anything else renders as literal text rather
 * than silently disappearing — a legal page that quietly drops a clause it
 * cannot parse would be far worse than one that shows stray asterisks.
 */

/** Split a line into text and inline markup. Bold and links only. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // One pass over both patterns so nesting order can't produce broken output.
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{match[1]}</strong>);
    } else {
      const href = match[3];
      // Only http(s) and mailto get to be links. A "javascript:" href in a
      // document is not something we ever write, and not something this
      // renderer should be capable of emitting.
      const safe = /^(https?:|mailto:)/i.test(href);
      nodes.push(
        safe ? (
          <a key={`${keyPrefix}-a${i}`} href={href}>
            {match[2]}
          </a>
        ) : (
          `${match[2]} (${href})`
        ),
      );
    }
    last = match.index + match[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isTableSeparator = (line: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    out.push(<p key={`p${key++}`}>{renderInline(text, `p${key}`)}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    out.push(
      <ul key={`ul${key++}`}>
        {listItems.map((item, n) => (
          <li key={n}>{renderInline(item, `li${key}-${n}`)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushAll();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const content = renderInline(heading[2], `h${key}`);
      out.push(
        level === 1 ? (
          <h1 key={`h${key++}`}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={`h${key++}`}>{content}</h2>
        ) : (
          <h3 key={`h${key++}`}>{content}</h3>
        ),
      );
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushAll();
      out.push(<hr key={`hr${key++}`} />);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      listItems.push(bullet[1]);
      continue;
    }

    // A table: a pipe row followed by a separator row.
    if (trimmed.startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      const header = splitRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i].trim()));
        i += 1;
      }
      i -= 1;
      const tableKey = key++;
      out.push(
        <table key={`t${tableKey}`}>
          <thead>
            <tr>
              {header.map((cell, n) => (
                <th key={n}>{renderInline(cell, `th${tableKey}-${n}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{renderInline(cell, `td${tableKey}-${r}-${c}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushAll();
  return out;
}
