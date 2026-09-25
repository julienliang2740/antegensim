/**
 * Saved skills and the resumable execution state of one agent (spec U2 and
 * "Display and historical inspection": saved skills, current block/action).
 * Shapes follow INTERFACES section 4.2 (SkillDefinition, SkillExecutionState,
 * compiled Instruction with its source line).
 */

import type { Agent, SkillDefinition, SkillExecutionState } from "../../api/types";
import { KeyValueTable } from "./common";
import { kv } from "./rows";
import type { KeyValueRow } from "./rows";
import { fmtNum, fmtValue } from "./format";

/** What a stored last_error means (schemas.SkillExecutionState docstring). */
const LAST_ERROR_MEANING: Record<string, string> = {
  op_budget_exhausted: "yielded: per-turn op budget used up; resumes next turn",
  interrupted: "stopped: an unread record interrupted it (A-SKILL-9)",
  skill_modified: "stopped: a skill in the call stack was saved or deleted",
  replaced: "stopped: replaced by a new decision",
  stopped: "stopped by STOP",
  operator: "stopped by the operator",
  death: "stopped: the agent died",
  insufficient_compute: "error: not enough compute for interpreter ops",
};

/** Source line of the instruction at `pc` in `skill`, or null. */
function lineAt(skill: SkillDefinition | undefined, pc: number): number | null {
  const instruction = skill?.compiled[pc];
  return instruction ? instruction.line : null;
}

/** Map skill name -> {line -> "current" | "caller"} for the frames of a live execution. */
function activeLines(agent: Agent): Map<string, Map<number, "current" | "caller">> {
  const result = new Map<string, Map<number, "current" | "caller">>();
  const state = agent.skill_execution;
  if (!state || state.frames.length === 0) return result;
  state.frames.forEach((frame, i) => {
    const line = lineAt(agent.skills[frame.skill], frame.pc);
    if (line === null) return;
    const lines = result.get(frame.skill) ?? new Map<number, "current" | "caller">();
    const role = i === state.frames.length - 1 ? "current" : "caller";
    if (lines.get(line) !== "current") lines.set(line, role);
    result.set(frame.skill, lines);
  });
  return result;
}

function statusClass(status: SkillExecutionState["status"]): string {
  if (status === "error") return "insp-badge insp-badge-bad";
  if (status === "running" || status === "awaiting_action_result") return "insp-badge insp-badge-info";
  if (status === "finished") return "insp-badge insp-badge-good";
  return "insp-badge";
}

export function ExecutionStateView(props: { agent: Agent; maxOpsPerTurn?: number | null }) {
  const { agent } = props;
  const state = agent.skill_execution;
  if (!state) return <p className="insp-muted">No skill is running (the last decision was a direct action or nothing ran yet).</p>;
  const top = state.frames.length > 0 ? state.frames[state.frames.length - 1] : null;
  const topSkill = top ? agent.skills[top.skill] : undefined;
  const topInstruction = top ? topSkill?.compiled[top.pc] : undefined;
  const rows: KeyValueRow[] = [
    kv("status", <span className={statusClass(state.status)}>{state.status}</span>),
    ["root skill", `${state.root_skill}(${state.arguments.map((a) => fmtValue(a, 30)).join(", ")})`],
    kv(
      "current position",
      top ? (
        <>
          <code>{top.skill}</code> pc {top.pc}
          {topInstruction ? `, line ${topInstruction.line}, op ${topInstruction.op}` : " (past the end)"}
        </>
      ) : (
        <span className="insp-muted">no frames (finished or stopped)</span>
      ),
    ),
    kv(
      "pending action",
      state.pending_action ? (
        <>
          <strong>{state.pending_action.name}</strong> {fmtValue(state.pending_action.args, 80)}
          {state.pending_result_var ? ` → ${state.pending_result_var}` : ""}
        </>
      ) : (
        <span className="insp-muted">none</span>
      ),
    ),
    ["ops this turn", `${state.ops_this_turn}${props.maxOpsPerTurn ? ` of ${props.maxOpsPerTurn} per turn` : ""}`],
    ["total ops / interpreter cost", `${state.total_ops} ops · ${fmtNum(state.total_interpreter_cost)} compute`],
    ["world actions executed", String(state.actions_executed)],
    ["started round", String(state.started_round)],
    kv(
      "last error",
      state.last_error ? (
        <span className={state.status === "error" ? "insp-bad" : undefined}>
          {state.last_error}
          {LAST_ERROR_MEANING[state.last_error] ? ` — ${LAST_ERROR_MEANING[state.last_error]}` : ""}
        </span>
      ) : (
        <span className="insp-muted">none</span>
      ),
    ),
  ];
  if (state.status === "finished") rows.push(["return value", fmtValue(state.return_value, 120)]);
  return (
    <div>
      <KeyValueTable rows={rows} />
      {state.frames.length > 0 ? (
        <div className="insp-frames">
          <div className="insp-subtitle">Call stack (top frame last)</div>
          {state.frames.map((frame, i) => {
            const top = i === state.frames.length - 1;
            const vars = Object.entries(frame.vars);
            return (
              <div key={i} className={`insp-frame${top ? " insp-frame-top" : ""}`}>
                <div className="insp-frame-head">
                  Frame {i}
                  {top ? " (top)" : ""}: <code>{frame.skill}</code> · pc {frame.pc} · line {lineAt(agent.skills[frame.skill], frame.pc) ?? "?"}
                  {frame.return_into ? ` · returns into ${frame.return_into}` : ""}
                </div>
                <div className="insp-frame-body">
                  <div>
                    <span className="insp-frame-label">variables:</span>
                    {vars.length === 0 ? <span className="insp-muted"> none</span> : null}
                  </div>
                  {vars.map(([k, v]) => (
                    <div key={k} className="insp-frame-var">
                      <code>{k}</code> = {fmtValue(v, 160)}
                    </div>
                  ))}
                  {frame.loops.length > 0 ? (
                    <div>
                      <span className="insp-frame-label">loops:</span>{" "}
                      {frame.loops
                        .map((loop) =>
                          loop.kind === "repeat" ? `REPEAT (${loop.remaining} left)` : `FOR_EACH ${loop.var ?? "?"} (item ${loop.index + 1} of ${loop.items.length})`,
                        )
                        .join("; ")}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function SkillList(props: { agent: Agent }) {
  const { agent } = props;
  const skills = Object.values(agent.skills).sort((a, b) => a.name.localeCompare(b.name));
  const lines = activeLines(agent);
  if (skills.length === 0) return <p className="insp-muted">No saved skills.</p>;
  return (
    <div className="insp-skills">
      {skills.map((skill) => {
        const active = lines.get(skill.name);
        return (
          <div key={skill.name} className={`insp-skill${active ? " insp-skill-active" : ""}`}>
            <div className="insp-skill-head">
              <code className="insp-skill-name">
                {skill.name}({skill.params.join(", ")})
              </code>
              <span>
                {skill.block_count} blocks (limit {agent.stats.skill_block_limit})
              </span>
              <span>saved round {skill.saved_round}</span>
              {skill.calls.length > 0 ? <span>calls {skill.calls.join(", ")}</span> : null}
              {active ? <span className="insp-badge insp-badge-info">in the running execution</span> : null}
            </div>
            <SourceWithLines source={skill.source} active={active} />
          </div>
        );
      })}
    </div>
  );
}

function SourceWithLines(props: { source: string; active?: Map<number, "current" | "caller"> }) {
  const lines = props.source.split("\n");
  return (
    <pre className="insp-pre insp-source">
      {lines.map((text, i) => {
        const role = props.active?.get(i + 1);
        return (
          <div key={i} className={role === "current" ? "insp-line-current" : role === "caller" ? "insp-line-caller" : undefined}>
            <span className="insp-lineno">{i + 1}</span>
            {text || " "}
            {role === "current" ? <span className="insp-line-marker"> ◀ current</span> : role === "caller" ? <span className="insp-line-marker"> ◀ caller</span> : null}
          </div>
        );
      })}
    </pre>
  );
}
