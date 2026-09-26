/**
 * Small confirmation modal (the Resume page's delete dialog), built on the same pattern as
 * components/setup/AgentCardDialog.tsx: Escape, the backdrop and Cancel close it (not while
 * `busy`); focus moves into the dialog on open and back to the opener on close; page scrolling
 * is locked while it is open.  Styles: the shared .modal-* classes in setup.css.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import "../../setup.css";

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  /** The confirm button's label; omit to show only the close button (a finished dialog). */
  confirmLabel?: string;
  onConfirm?(): void;
  onClose(): void;
  /** Label of the close button ("Cancel" by default). */
  closeLabel?: string;
  /** True while the confirmed action runs: every button is disabled and closing is blocked. */
  busy?: boolean;
  /** Style the confirm button as destructive. */
  danger?: boolean;
  /** Extra class on the panel (width). */
  className?: string;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  const busy = useRef(Boolean(props.busy));
  useLayoutEffect(() => {
    onClose.current = props.onClose;
    busy.current = Boolean(props.busy);
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy.current) onClose.current();
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
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <div className={`modal-panel confirm-dialog ${props.className ?? ""}`} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" tabIndex={-1} ref={panel}>
        <header className="modal-head">
          <h2 id="confirm-dialog-title">{props.title}</h2>
        </header>
        <div className="modal-body">{props.children}</div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={props.onClose} disabled={props.busy}>
            {props.closeLabel ?? "Cancel"}
          </button>
          {props.confirmLabel ? (
            <button type="button" className={`btn confirm-dialog-confirm ${props.danger ? "btn-danger" : "btn-primary"}`} onClick={props.onConfirm} disabled={props.busy}>
              {props.confirmLabel}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
