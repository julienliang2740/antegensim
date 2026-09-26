/**
 * Modal holding one full agent card on the New session page.  Escape, the
 * backdrop and the Done buttons close it; focus moves into the dialog on
 * open and back to the element that opened it on close; page scrolling is
 * locked while it is open.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export interface AgentCardDialogProps {
  title: string;
  subtitle?: ReactNode;
  onClose(): void;
  /** Extra controls in the footer, left of Done. */
  footer?: ReactNode;
  children: ReactNode;
}

export function AgentCardDialog(props: AgentCardDialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  useLayoutEffect(() => {
    onClose.current = props.onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title" tabIndex={-1} ref={panel}>
        <header className="modal-head">
          <div>
            <h2 id="agent-dialog-title">{props.title}</h2>
            {props.subtitle ? <div className="hint">{props.subtitle}</div> : null}
          </div>
          <button type="button" className="btn" onClick={props.onClose}>
            Close
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        <footer className="modal-foot">
          {props.footer}
          <button type="button" className="btn btn-primary modal-done" onClick={props.onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
