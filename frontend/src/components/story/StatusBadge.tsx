/** A small badge for a story's status (colour by outcome; the words come from storyStatusText); it pulses while a model works for the story.  OWNER: WP6. */

import type { StoryStatus } from "../../api/storyTypes";

const LABEL: Record<StoryStatus, string> = {
  interviewing: "choosing",
  brief_pending: "brief ready",
  generating: "writing",
  paused: "paused",
  complete: "complete",
  cancelled: "cancelled",
  error: "error",
  interrupted: "interrupted",
};

function tone(status: StoryStatus): string {
  switch (status) {
    case "generating":
      return " is-live";
    case "complete":
      return " is-done";
    case "error":
    case "cancelled":
      return " is-bad";
    case "brief_pending":
    case "paused":
    case "interrupted":
      return " is-wait";
    case "interviewing":
      return "";
  }
}

export function StatusBadge(props: { status: StoryStatus; working?: boolean }) {
  return <span className={`storymode-badge${props.working ? " is-live working-pulse" : tone(props.status)}`}>{LABEL[props.status] ?? props.status}</span>;
}
