"use client";

import { parseMarkdown, type Block, type Inline } from "@/lib/updates";

// Renders the block structure from src/lib/updates.ts.
//
// Every leaf is a React text node, so React escapes it. There is no
// dangerouslySetInnerHTML in this file and there should never be one: an
// update body is typed by a person and shown to every caller, and the whole
// point of parsing to a structure was to make injection impossible rather than
// merely unlikely.

function renderInlines(inlines: Inline[]) {
  return inlines.map((piece, i) => {
    switch (piece.kind) {
      case "strong":
        return <strong key={i}>{piece.text}</strong>;
      case "em":
        return <em key={i}>{piece.text}</em>;
      case "code":
        return (
          <code
            key={i}
            style={{
              background: "var(--bg-inset)",
              padding: "1px 5px",
              borderRadius: 3,
              fontSize: "0.9em",
            }}
          >
            {piece.text}
          </code>
        );
      default:
        return <span key={i}>{piece.text}</span>;
    }
  });
}

function renderBlock(block: Block, key: number) {
  if (block.kind === "heading") {
    const size = block.level === 1 ? "1.15rem" : block.level === 2 ? "1.02rem" : "0.92rem";
    return (
      <div
        key={key}
        style={{
          fontWeight: 700,
          fontSize: size,
          marginTop: key === 0 ? 0 : 16,
          marginBottom: 6,
          color: "var(--amber)",
        }}
      >
        {renderInlines(block.inlines)}
      </div>
    );
  }

  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag key={key} style={{ margin: "8px 0 8px 20px", padding: 0, lineHeight: 1.6 }}>
        {block.items.map((item, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            {renderInlines(item)}
          </li>
        ))}
      </Tag>
    );
  }

  return (
    <p key={key} style={{ margin: "0 0 10px", lineHeight: 1.65 }}>
      {renderInlines(block.inlines)}
    </p>
  );
}

export default function Markdown({ body }: { body: string }) {
  const blocks = parseMarkdown(body);
  return <div>{blocks.map(renderBlock)}</div>;
}
