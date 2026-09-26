/**
 * Rendering of assistant text: state/assistantFormat.ts blocks (paragraphs,
 * lists, headings, code) whose id-shaped tokens (turn ids, call ids, agent
 * ids, "(x, y)" points) become buttons that act through the run page's
 * registered handlers, plus the answer's structured refs as chips.
 *
 * DOCS: links never leave the app: a turn ref views that turn, an entity ref
 * selects it, a point ref finds it, a run ref opens the run page, a doc ref
 * opens the matching "How the world works" section, a control ref flashes the
 * element carrying data-control="<id>".  When the run is not on screen the
 * drawer navigates to it instead (turn/run) or explains (entity/point).
 */

import type { AnswerRef } from "../../api/assistantTypes";
import type { Block, Inline, Segment } from "../../state/assistantFormat";
import { formatAnswer, refChipText } from "../../state/assistantFormat";

/** What a click on a link asks the drawer to do (the drawer resolves handlers and navigation). */
export type RefAction =
  | { kind: "turn"; turnId: string }
  | { kind: "call"; turnId: string; callId: string }
  | { kind: "entity"; entityId: string }
  | { kind: "point"; x: number; y: number }
  | { kind: "run"; runId: string }
  | { kind: "doc"; ref: string }
  | { kind: "control"; id: string };

export interface AnswerBlocksProps {
  text: string;
  /** Agent ids of the run, when known (otherwise "aNN" ids are linked). */
  agentIds?: Iterable<string> | null;
  onAction(action: RefAction): void;
}

function segmentAction(segment: Segment): RefAction | null {
  switch (segment.kind) {
    case "turn":
      return { kind: "turn", turnId: segment.turnId };
    case "call":
      return { kind: "call", turnId: segment.turnId, callId: segment.callId };
    case "entity":
      return { kind: "entity", entityId: segment.entityId };
    case "point":
      return { kind: "point", x: segment.x, y: segment.y };
    default:
      return null;
  }
}

function Segments(props: { parts: Segment[]; onAction(action: RefAction): void }) {
  return (
    <>
      {props.parts.map((part, i) => {
        const action = segmentAction(part);
        if (!action) return <span key={i}>{part.text}</span>;
        return (
          <button key={i} type="button" className={`assistant-link assistant-link-${part.kind}`} onClick={() => props.onAction(action)}>
            {part.text}
          </button>
        );
      })}
    </>
  );
}

function Inlines(props: { inlines: Inline[]; onAction(action: RefAction): void }) {
  return (
    <>
      {props.inlines.map((part, i) => {
        if (part.kind === "code") return <code key={i}>{part.text}</code>;
        if (part.kind === "strong")
          return (
            <strong key={i}>
              <Segments parts={part.parts} onAction={props.onAction} />
            </strong>
          );
        return <Segments key={i} parts={[part]} onAction={props.onAction} />;
      })}
    </>
  );
}

function BlockView(props: { block: Block; onAction(action: RefAction): void }) {
  const { block } = props;
  switch (block.kind) {
    case "paragraph":
      return (
        <p>
          <Inlines inlines={block.inlines} onAction={props.onAction} />
        </p>
      );
    case "heading": {
      const content = <Inlines inlines={block.inlines} onAction={props.onAction} />;
      if (block.level === 1) return <h3 className="assistant-h">{content}</h3>;
      if (block.level === 2) return <h4 className="assistant-h">{content}</h4>;
      return <h5 className="assistant-h">{content}</h5>;
    }
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <Inlines inlines={item} onAction={props.onAction} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return <pre className="assistant-code">{block.text}</pre>;
  }
}

/** The formatted text of an answer (or of a brief's description). */
export function AnswerBlocks(props: AnswerBlocksProps) {
  const blocks = formatAnswer(props.text, { agentIds: props.agentIds ?? undefined });
  return (
    <div className="assistant-blocks">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} onAction={props.onAction} />
      ))}
    </div>
  );
}

function refAction(ref: AnswerRef): RefAction | null {
  switch (ref.kind) {
    case "turn":
      return { kind: "turn", turnId: ref.id };
    case "entity":
      return { kind: "entity", entityId: ref.id };
    case "point": {
      const match = /^\s*\(?\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*\)?\s*$/.exec(ref.id);
      return match ? { kind: "point", x: parseInt(match[1], 10), y: parseInt(match[2], 10) } : null;
    }
    case "run":
      return { kind: "run", runId: ref.id };
    case "doc":
      return { kind: "doc", ref: ref.id };
    case "control":
      return { kind: "control", id: ref.id };
  }
}

const REF_KIND_LABEL: Record<AnswerRef["kind"], string> = {
  turn: "turn",
  entity: "entity",
  point: "point",
  run: "run",
  doc: "docs",
  control: "control",
};

/** The answer's structured refs as chips ("turn r00003_end", "docs SYSTEM.md#economy"). */
export function RefChips(props: { refs: AnswerRef[]; onAction(action: RefAction): void }) {
  if (props.refs.length === 0) return null;
  return (
    <div className="assistant-refs" aria-label="References">
      {props.refs.map((ref, i) => {
        const action = refAction(ref);
        const text = refChipText([REF_KIND_LABEL[ref.kind], ref.kind], ref.label, ref.id);
        return action ? (
          <button key={i} type="button" className={`assistant-ref assistant-ref-${ref.kind}`} title={`${REF_KIND_LABEL[ref.kind]} ${ref.id}`} onClick={() => props.onAction(action)}>
            <span className="assistant-ref-kind">{REF_KIND_LABEL[ref.kind]}</span> {text}
          </button>
        ) : (
          <span key={i} className={`assistant-ref assistant-ref-${ref.kind} assistant-ref-static`}>
            <span className="assistant-ref-kind">{REF_KIND_LABEL[ref.kind]}</span> {text}
          </span>
        );
      })}
    </div>
  );
}
