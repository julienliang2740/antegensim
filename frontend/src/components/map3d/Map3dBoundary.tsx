/**
 * Error boundary around the lazily loaded 3D view: when the chunk fails to
 * load (offline, a stale deployment) or the view throws while rendering, the
 * centre column shows "The 3D view could not load." with a way back to the 2D
 * map instead of a blank page.  The error itself goes to the console only (a
 * loader error carries internal URLs); the page shows a short hint.  A class
 * component because React has no hook for getDerivedStateFromError; no
 * parameter properties (erasableSyntaxOnly).
 */

// DOCS: div.map3d-fallback[data-webgl="failed"][role=alert] "The 3D view could not load." with **Back to 2D map** when the chunk fails to load or the view throws; the error goes to the console only.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  onBackTo2d(): void;
  /** The view switch, kept visible in the fallback. */
  legendExtra?: ReactNode;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class Map3dBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("3D view failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="map3d-fallback insp" role="alert" data-webgl="failed">
        {this.props.legendExtra}
        <p>The 3D view could not load.</p>
        <p className="insp-muted map3d-fallback-detail">Reload the page to try again, or go back to the 2D map.</p>
        <button type="button" className="insp-btn" onClick={this.props.onBackTo2d}>
          Back to 2D map
        </button>
      </div>
    );
  }
}
