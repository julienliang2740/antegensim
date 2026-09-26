/**
 * Pure text helpers for assistant answers (no React; unit-tested in state.test.mjs).
 *
 * DOCS: linkify() splits text into plain runs and id-shaped links (turn ids in
 * the schemas.TurnId formats, model call ids, agent ids, "(x, y)" points);
 * formatAnswer() turns the answer's light markdown (paragraphs, "-"/"*"/"1."
 * bullets, `inline code`, **bold**, ``` fences, "#" headings) into a block
 * structure the drawer renders.  Links go to RunPage-registered handlers
 * (state/assistantContext.ts), never to arbitrary URLs: raw HTML and URLs stay text.
 */

/** A run of answer text: plain, or an id the UI can act on. */
export type Segment =
  | { kind: "text"; text: string }
  /** schemas.TurnId: "r00000_init", "r00012_end", "r00012_t03_a04". */
  | { kind: "turn"; text: string; turnId: string }
  /** A model call id "mc_<turn_id>_<nn>" (opens the Record viewer on that call). */
  | { kind: "call"; text: string; callId: string; turnId: string }
  /** An agent id (selects the entity). */
  | { kind: "entity"; text: string; entityId: string }
  /** "(x, y)" (finds the point on the map). */
  | { kind: "point"; text: string; x: number; y: number };

/** Inline pieces of a block: linkified text, inline code, bold. */
export type Inline = Segment | { kind: "code"; text: string } | { kind: "strong"; parts: Segment[] };

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string };

export interface LinkifyOptions {
  /**
   * Agent ids of the run.  When given, exactly these ids (case-sensitive) are
   * linked; when omitted, ids shaped like the default "aNN" are linked.
   */
  agentIds?: Iterable<string> | null;
}

/** Agent id segment of a turn id (schemas.AgentCard.id: 1-16 letters or digits). */
const AGENT_PART = "[A-Za-z0-9]{1,16}";
const TURN = `r\\d{5}_(?:init|end|t\\d{2}_${AGENT_PART})`;
const CALL = `mc_(${TURN})_\\d{2,}`;
const POINT = "\\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\)";
const DEFAULT_AGENT = "a\\d{2}";
/** Not inside a longer identifier. */
const BEFORE = "(?<![A-Za-z0-9_])";
const AFTER = "(?![A-Za-z0-9_])";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linkPattern(agentIds: Iterable<string> | null | undefined): RegExp {
  let agents = DEFAULT_AGENT;
  if (agentIds) {
    const ids = [...new Set(agentIds)].filter((id) => /^[A-Za-z0-9]{1,16}$/.test(id));
    // Longest first so "a1" never shadows "a12".
    ids.sort((a, b) => b.length - a.length);
    agents = ids.length ? ids.map(escapeRegExp).join("|") : "(?!)";
  }
  // Group 1: call (2: its turn); 3: turn; 4: agent; 5/6: point.
  return new RegExp(`${BEFORE}(${CALL})${AFTER}|${BEFORE}(${TURN})${AFTER}|${BEFORE}(${agents})${AFTER}|${POINT}`, "g");
}

/** Split `text` into plain runs and id links (see Segment). */
export function linkify(text: string, options: LinkifyOptions = {}): Segment[] {
  const pattern = linkPattern(options.agentIds);
  const out: Segment[] = [];
  let last = 0;
  const pushText = (chunk: string) => {
    if (!chunk) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === "text") prev.text += chunk;
    else out.push({ kind: "text", text: chunk });
  };
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushText(text.slice(last, index));
    const token = match[0];
    if (match[1]) out.push({ kind: "call", text: token, callId: match[1], turnId: match[2] });
    else if (match[3]) out.push({ kind: "turn", text: token, turnId: match[3] });
    else if (match[4]) out.push({ kind: "entity", text: token, entityId: match[4] });
    else out.push({ kind: "point", text: token, x: parseInt(match[5], 10), y: parseInt(match[6], 10) });
    last = index + token.length;
  }
  pushText(text.slice(last));
  return out;
}

/** Inline formatting of one line or paragraph: `code` spans stay literal, **bold** and plain text are linkified. */
export function formatInline(text: string, options: LinkifyOptions = {}): Inline[] {
  const out: Inline[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    out.push(...linkify(text.slice(last, index), options));
    if (match[1] !== undefined) out.push({ kind: "code", text: match[1] });
    else out.push({ kind: "strong", parts: linkify(match[2], options) });
    last = index + match[0].length;
  }
  out.push(...linkify(text.slice(last), options));
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,3})\s+(.*)$/;
const FENCE = /^\s*```/;

interface ListAcc {
  ordered: boolean;
  items: string[];
}

/**
 * Parse an answer into blocks: blank lines separate paragraphs, consecutive
 * bullet lines form one list (an indented line continues the previous item),
 * ``` fences keep their text verbatim, "#".."###" are headings.
 */
export function formatAnswer(text: string, options: LinkifyOptions = {}): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const acc: { paragraph: string[]; list: ListAcc | null } = { paragraph: [], list: null };

  const flushParagraph = () => {
    const joined = acc.paragraph.map((l) => l.trim()).join(" ").trim();
    if (joined) blocks.push({ kind: "paragraph", inlines: formatInline(joined, options) });
    acc.paragraph = [];
  };
  const flushList = () => {
    if (acc.list) blocks.push({ kind: "list", ordered: acc.list.ordered, items: acc.list.items.map((item) => formatInline(item.trim(), options)) });
    acc.list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flushAll();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, inlines: formatInline(heading[2].trim(), options) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = numbered !== null;
      if (!acc.list || acc.list.ordered !== ordered) {
        flushList();
        acc.list = { ordered, items: [] };
      }
      acc.list.items.push(item[1]);
      continue;
    }
    if (acc.list && acc.list.items.length > 0 && /^\s/.test(line)) {
      acc.list.items[acc.list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    acc.paragraph.push(line);
  }
  flushAll();
  return blocks;
}

/** The plain text of inlines (for aria labels, copy, tests). */
export function inlineText(inlines: Inline[]): string {
  return inlines.map((part) => (part.kind === "strong" ? part.parts.map((p) => p.text).join("") : part.text)).join("");
}
