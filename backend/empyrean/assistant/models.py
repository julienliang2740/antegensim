"""
Pydantic models of the built-in assistant (rev 4): API bodies, stored records and the shapes
the model is asked to produce.  OWNER: WP2 (all assistant models live here, never in
schemas.py; schemas.py keeps only the shared additions ModelRequest.response_format,
ModelResult.error_code, ModelInfo.assistant_only, InterventionOrigin 'assistant',
TranscriptionResult / WhisperStatus and the ApiErrorCode additions).

Conventions
-----------
* Model OUTPUT (what ``call_profile`` parses) is ``StrictModel``: ``AssistantStep``,
  ``StoryBriefDraft``.  Unknown keys are a validation error the engine repairs once.
* STORED records (conversations, briefs, ledger lines, storybook entries, story sessions) are
  ``LooseModel`` so old files keep loading after a field is added.
* API request bodies are ``StrictModel``; API responses are whatever the store holds.
* Brief actions are typed here (``BriefAction``) and validated with ``brief_action_adapter``;
  the JSON schema handed to the model carries only ``{type: enum, args: object}``
  (``BriefActionEnvelope``), A-AST-4.
* Scopes: ``run_id`` or ``None`` (global).  ``scope_key(run_id)`` gives the ledger / storage key
  ``"global"`` or the run id.
"""
# DOCS: every assistant request/response/storage shape is defined in this file; the frontend
# mirrors live in frontend/src/api/assistantTypes.ts (WP5) and storyTypes.ts (WP6).

from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Union

from pydantic import Field, TypeAdapter, model_validator

from ..schemas import (
    AgentCard,
    ApiProblem,
    EditKnowledgeIntervention,
    LooseModel,
    ModelUsage,
    PlaceEntityIntervention,
    RemoveEntityIntervention,
    RunCommand,
    RunStatus,
    RunSummary,
    SetStatIntervention,
    StrictModel,
    TranscriptionResult,
    UpdateContextSettingsIntervention,
    UpdateModelAssignmentIntervention,
    UpdatePlantRulesIntervention,
    UpdatePricesIntervention,
    UpdateRunSettingsIntervention,
    VoiceIntervention,
    WhisperStatus,
    utc_now_iso,
)

# ---------------------------------------------------------------------------
# Profiles and scopes
# ---------------------------------------------------------------------------

Profile = Literal["chat", "narrator", "author", "summarizer"]
PROFILES: tuple[str, ...] = ("chat", "narrator", "author", "summarizer")
GLOBAL_SCOPE = "global"


def scope_key(run_id: Optional[str]) -> str:
    """Ledger / storage key of a conversation scope: the run id, or ``"global"`` for None."""
    return run_id or GLOBAL_SCOPE


# ---------------------------------------------------------------------------
# References and chat steps (MODEL OUTPUT, strict)
# ---------------------------------------------------------------------------

RefKind = Literal["turn", "entity", "point", "run", "doc", "control"]


class AnswerRef(StrictModel):
    """A linkable reference in an answer: turn id, entity id, ``x,y`` point, run id, doc section
    (``SYSTEM.md#economy``) or control label (``data-control`` attribute)."""

    kind: RefKind
    id: str
    label: str = ""


class ToolCall(StrictModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class AnswerStep(StrictModel):
    kind: Literal["answer"]
    text: str
    refs: list[AnswerRef] = Field(default_factory=list)


class ToolStep(StrictModel):
    """Up to ``config.ASSISTANT_TOOLS_PER_STEP`` read tools; results come back nonce-fenced."""

    kind: Literal["tool"]
    calls: list[ToolCall] = Field(min_length=1, max_length=3)
    note: str = ""  # one line shown as progress ("Reading round 12")


class AskStep(StrictModel):
    kind: Literal["ask"]
    text: str
    options: list[str] = Field(default_factory=list, max_length=6)


BriefActionType = Literal[
    "create_run",
    "run_command",
    "stage_interventions",
    "create_continuation",
    "open_run",
    "update_assistant_settings",
]
BRIEF_ACTION_TYPES: tuple[str, ...] = (
    "create_run",
    "run_command",
    "stage_interventions",
    "create_continuation",
    "open_run",
    "update_assistant_settings",
)


class BriefActionEnvelope(StrictModel):
    """What the MODEL emits: ``args`` is untyped in the JSON schema (A-AST-4) and validated
    server-side with ``brief_action_adapter`` against ``{"type": type, **args}``."""

    type: BriefActionType
    args: dict[str, Any] = Field(default_factory=dict)


class BriefDraft(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    summary: str = Field(max_length=2000)
    steps: list[str] = Field(default_factory=list, max_length=12)
    warnings: list[str] = Field(default_factory=list, max_length=12)
    action: BriefActionEnvelope


class BriefStep(StrictModel):
    kind: Literal["brief"]
    brief: BriefDraft


AssistantStep = Annotated[Union[AnswerStep, ToolStep, AskStep, BriefStep], Field(discriminator="kind")]
RestrictedStep = Annotated[Union[AnswerStep, AskStep], Field(discriminator="kind")]
assistant_step_adapter: TypeAdapter[Any] = TypeAdapter(AssistantStep)
restricted_step_adapter: TypeAdapter[Any] = TypeAdapter(RestrictedStep)

# ---------------------------------------------------------------------------
# Brief actions (typed, validated server-side)
# ---------------------------------------------------------------------------

# The Intervention union minus apply_working_files (the model must never emit snapshot refs).
AssistantIntervention = Annotated[
    Union[
        SetStatIntervention,
        PlaceEntityIntervention,
        RemoveEntityIntervention,
        EditKnowledgeIntervention,
        VoiceIntervention,
        UpdateContextSettingsIntervention,
        UpdatePlantRulesIntervention,
        UpdatePricesIntervention,
        UpdateModelAssignmentIntervention,
        UpdateRunSettingsIntervention,
    ],
    Field(discriminator="type"),
]
assistant_intervention_adapter: TypeAdapter[Any] = TypeAdapter(AssistantIntervention)


class CreateRunAction(StrictModel):
    """``overlay`` is a partial RunCreateRequest deep-merged onto
    ``config.default_run_request(model_key, agent_count)`` (dicts merge recursively, everything
    else replaces; agent cards merge by index, cards beyond ``agent_count`` are dropped)."""

    type: Literal["create_run"]
    name: str = Field(min_length=1, max_length=80)
    agent_count: int = Field(ge=6, le=12)
    overlay: dict[str, Any] = Field(default_factory=dict)


class RunCommandAction(StrictModel):
    """``rounds`` (1-50) only with ``step_round``: approval runs a backend sequencer job."""

    type: Literal["run_command"]
    run_id: str
    command: RunCommand
    rounds: Optional[int] = Field(default=None, ge=1, le=50)

    @model_validator(mode="after")
    def _rounds_only_with_step_round(self) -> "RunCommandAction":
        if self.rounds is not None and self.command != "step_round":
            raise ValueError("rounds is only allowed with command step_round")
        return self


class StageInterventionsAction(StrictModel):
    """Executor sets ``origin='assistant'`` and ``note='assistant: <summary>'``, strips ids."""

    type: Literal["stage_interventions"]
    run_id: str
    interventions: list[AssistantIntervention] = Field(min_length=1, max_length=20)


class CreateContinuationAction(StrictModel):
    type: Literal["create_continuation"]
    run_id: str
    from_turn_id: str
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)


class OpenRunAction(StrictModel):
    """UI-only: the drawer navigates; nothing executes server-side."""

    type: Literal["open_run"]
    run_id: str


class UpdateAssistantSettingsAction(StrictModel):
    type: Literal["update_assistant_settings"]
    run_id: str
    storybook_auto: Optional[bool] = None
    chat_budget_usd: Optional[float] = Field(default=None, ge=0)
    storybook_budget_usd: Optional[float] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _something_to_change(self) -> "UpdateAssistantSettingsAction":
        if self.storybook_auto is None and self.chat_budget_usd is None and self.storybook_budget_usd is None:
            raise ValueError("nothing to change")
        return self


BriefAction = Annotated[
    Union[
        CreateRunAction,
        RunCommandAction,
        StageInterventionsAction,
        CreateContinuationAction,
        OpenRunAction,
        UpdateAssistantSettingsAction,
    ],
    Field(discriminator="type"),
]
brief_action_adapter: TypeAdapter[Any] = TypeAdapter(BriefAction)


def action_from_envelope(envelope: BriefActionEnvelope) -> Any:
    """``{type, args}`` (model output) -> typed ``BriefAction`` (raises ``ValidationError``)."""
    return brief_action_adapter.validate_python({"type": envelope.type, **envelope.args})


# ---------------------------------------------------------------------------
# Brief lifecycle (STORED)
# ---------------------------------------------------------------------------

BriefStatus = Literal["pending", "executing", "executed", "failed", "rejected", "superseded", "invalid"]


class SetupDiffEntry(LooseModel):
    """A non-default field of a create_run request (computed in Python from
    ``config.default_run_request``)."""

    path: str
    default: Any = None
    value: Any = None


class BriefValidation(LooseModel):
    ok: bool = True
    problems: list[ApiProblem] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)  # budget clear, paid model, spend so far ...
    setup_diff: list[SetupDiffEntry] = Field(default_factory=list)
    validated_against_turn_id: Optional[str] = None
    validated_at: Optional[str] = None


class BriefEffect(LooseModel):
    """What an approved brief did (stored on the brief; returned by approve, idempotent)."""

    run_id: Optional[str] = None
    run_summary: Optional[RunSummary] = None
    status: Optional[RunStatus] = None
    staged_ids: list[str] = Field(default_factory=list)
    rounds_done: Optional[int] = None
    rounds_requested: Optional[int] = None
    message: str = ""
    executed_at: Optional[str] = None


class Brief(LooseModel):
    brief_id: str
    conversation_id: str
    message_id: str  # the assistant message carrying the card
    in_reply_to: str = ""  # the user's message text ("Proposed in reply to")
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)
    status: BriefStatus = "pending"
    title: str = ""
    summary: str = ""
    steps: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    action: Any = None  # typed BriefAction (normalised) as a dict; None when invalid
    action_raw: dict[str, Any] = Field(default_factory=dict)  # the model's envelope as emitted
    validation: BriefValidation = Field(default_factory=BriefValidation)
    effect: Optional[BriefEffect] = None
    error: Optional[str] = None
    superseded_by: Optional[str] = None
    reject_reason: str = ""


class BriefApproveRequest(StrictModel):
    validated_against_turn_id: Optional[str] = None


class BriefRejectRequest(StrictModel):
    reason: str = Field(default="", max_length=500)


class BriefResponse(StrictModel):
    brief: Brief


# ---------------------------------------------------------------------------
# Conversations, messages, jobs (STORED + API)
# ---------------------------------------------------------------------------


class ContextChip(StrictModel):
    """What the user is looking at (published by the frontend context store)."""

    page: str = "entry"  # entry | new | resume | run | story | instructions
    run_id: Optional[str] = None
    run_name: Optional[str] = None
    shown_turn_id: Optional[str] = None
    live_turn_id: Optional[str] = None
    tab: Optional[str] = None
    selected_entity_id: Optional[str] = None
    selected_entity_kind: Optional[str] = None
    selected_point: Optional[str] = None  # "x,y"
    run_state: Optional[str] = None
    last_error: Optional[str] = None
    story_id: Optional[str] = None


MessageRole = Literal["user", "assistant"]
MessageStatus = Literal["pending", "running", "done", "error", "cancelled", "interrupted"]


class ToolCallRecord(LooseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    ok: bool = True
    summary: str = ""  # one line for the UI ("12 events in round 3")
    truncated: bool = False
    error: Optional[str] = None


class StepRecord(LooseModel):
    """One model call of a chat message (UI progress: 'step 2/4 · 18 s · $0.03')."""

    index: int
    kind: str = ""  # answer | tool | ask | brief | repair
    model_key: str = ""
    status: str = "pending"  # pending | ok | error | cancelled
    started_at: str = Field(default_factory=utc_now_iso)
    finished_at: Optional[str] = None
    elapsed_ms: float = 0.0
    cost_usd: float = 0.0
    cache_read_tokens: int = 0
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    error: Optional[str] = None
    error_code: Optional[str] = None


class Message(LooseModel):
    message_id: str
    role: MessageRole
    text: str = ""
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)
    status: MessageStatus = "done"
    context: Optional[ContextChip] = None  # user messages: the chip sent along
    steps: list[StepRecord] = Field(default_factory=list)  # assistant messages
    refs: list[AnswerRef] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)  # "turns r00003_t02_a05", "docs SYSTEM.md#economy"
    as_of_turn_id: Optional[str] = None
    brief_id: Optional[str] = None
    ask_options: list[str] = Field(default_factory=list)
    job_id: Optional[str] = None
    progress: Optional[str] = None  # live progress line while running
    cost_usd: float = 0.0
    error: Optional[str] = None
    error_code: Optional[str] = None
    offline: bool = False  # answered from docs search because no model was available


class ProfileSpend(LooseModel):
    calls: int = 0
    cost_usd: float = 0.0


class LedgerAggregate(LooseModel):
    """Computed on read from ``usage.jsonl`` (cached by file size)."""

    calls: int = 0
    ok_calls: int = 0
    failed_calls: int = 0
    input_tokens: int = 0  # billed input (uncached + cache read + cache write)
    cache_read_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    estimated_cost_usd: float = 0.0  # part of cost_usd that is a list-price estimate
    by_profile: dict[str, ProfileSpend] = Field(default_factory=dict)


class ConversationMeta(LooseModel):
    conversation_id: str
    run_id: Optional[str] = None  # mutable: rebound after create_run / open_run (None = global)
    title: str = "New conversation"
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)
    summary: str = ""  # rolling memory summary (summarizer profile)
    summary_through_message_id: Optional[str] = None
    message_count: int = 0
    usage: LedgerAggregate = Field(default_factory=LedgerAggregate)
    active_job_id: Optional[str] = None
    last_brief_id: Optional[str] = None


class ConversationView(StrictModel):
    meta: ConversationMeta
    messages: list[Message] = Field(default_factory=list)
    briefs: list[Brief] = Field(default_factory=list)
    job: Optional["JobView"] = None


class ConversationCreateRequest(StrictModel):
    run_id: Optional[str] = None
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)


class ConversationPatchRequest(StrictModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    run_id: Optional[str] = None  # rebind (explicit); "" is not allowed, use null for global
    rebind_to_global: bool = False


class MessageCreateRequest(StrictModel):
    text: str = Field(min_length=1, max_length=4000)
    context: Optional[ContextChip] = None
    include_context: bool = True
    in_reply_to_brief_id: Optional[str] = None  # "Ask for changes" on a brief (it gets superseded)


class MessageAccepted(StrictModel):
    """202 body of POST .../messages."""

    job_id: str
    message_id: str  # the pending assistant message
    user_message_id: str
    conversation_id: str
    queue_position: int = 0


JobKind = Literal["chat", "story", "storybook", "speech", "sequencer"]
JobStatus = Literal["queued", "running", "done", "error", "cancelled", "interrupted"]


class JobView(StrictModel):
    job_id: str
    kind: JobKind
    status: JobStatus = "queued"
    conversation_id: Optional[str] = None
    run_id: Optional[str] = None
    story_id: Optional[str] = None
    queue_position: int = 0
    queued_behind: Optional[str] = None  # 'Queued behind "The Arena" (ch 40/285)'
    step: int = 0
    max_steps: int = 0
    elapsed_s: float = 0.0
    cost_usd: float = 0.0
    progress: str = ""
    cancel_requested: bool = False
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[str] = None
    error_code: Optional[str] = None


ConversationView.model_rebuild()

# ---------------------------------------------------------------------------
# Per-run assistant settings (<run>/assistant/settings.json)
# ---------------------------------------------------------------------------


class AssistantRunSettings(LooseModel):
    storybook_auto: bool = False
    auto_since_turn_id: Optional[str] = None  # auto covers commits after this turn
    storybook_budget_usd: float = 2.0
    chat_budget_usd: float = 5.0
    updated_at: str = Field(default_factory=utc_now_iso)


class AssistantRunSettingsUpdate(StrictModel):
    storybook_auto: Optional[bool] = None
    storybook_budget_usd: Optional[float] = Field(default=None, ge=0)
    chat_budget_usd: Optional[float] = Field(default=None, ge=0)


class BudgetView(StrictModel):
    scope: str  # run id | "global" | "story:<id>" | "message"
    kind: str  # chat | storybook | story | message | global
    limit_usd: float
    spent_usd: float
    remaining_usd: float
    exhausted: bool


class SpendView(StrictModel):
    chat: BudgetView
    storybook: Optional[BudgetView] = None
    overall: BudgetView
    by_profile: dict[str, ProfileSpend] = Field(default_factory=dict)


class AssistantRunSettingsView(StrictModel):
    run_id: str
    exists: bool  # False: no settings.json yet (existing run; auto is off)
    settings: AssistantRunSettings
    spend: SpendView


# ---------------------------------------------------------------------------
# Ledger lines (<scope>/assistant/usage.jsonl)
# ---------------------------------------------------------------------------


class LedgerLine(LooseModel):
    ts: str = Field(default_factory=utc_now_iso)
    request_id: str
    scope: str  # run id | "global"
    profile: str
    purpose: str = "assistant"
    model_key: str
    response_model: Optional[str] = None
    status: str
    error_code: Optional[str] = None
    usage: ModelUsage = Field(default_factory=ModelUsage)
    cost_usd: float = 0.0
    cost_estimated: bool = False  # True when priced from tokens (provider_cost_usd was None)
    latency_ms: float = 0.0
    attempts: int = 0
    job_id: Optional[str] = None
    conversation_id: Optional[str] = None
    story_id: Optional[str] = None
    step: Optional[int] = None
    batch_size: Optional[int] = None  # narrator: turns in this call


# ---------------------------------------------------------------------------
# Storybook (<run>/assistant/storybook/entries/<turn_id>.json, opening.json)
# ---------------------------------------------------------------------------

StorybookEntryKind = Literal["opening", "turn", "round_end"]
StorybookAutoState = Literal["on", "off", "paused_budget", "paused_error"]


class StorybookEntry(LooseModel):
    turn_id: str  # "opening" for the opening entry
    kind: StorybookEntryKind
    round: int = 0
    text: str
    model_key: str = ""
    response_model: Optional[str] = None
    usage: ModelUsage = Field(default_factory=ModelUsage)
    cost_usd: float = 0.0
    created_at: str = Field(default_factory=utc_now_iso)
    digest_sha: str = ""  # sha of the digest the entry was written from
    batch_id: Optional[str] = None
    regenerated: int = 0
    entities: list[str] = Field(default_factory=list)  # ids mentioned (for "Following <name>")


class StorybookEstimate(StrictModel):
    entries: int = 0
    calls: int = 0
    cost_usd: float = 0.0
    seconds: float = 0.0
    model_key: str = ""


class StorybookStatus(StrictModel):
    run_id: str
    auto: bool
    auto_state: StorybookAutoState
    auto_since_turn_id: Optional[str] = None
    pending_count: int = 0  # queued for the job (eligible, not yet written)
    in_flight: bool = False
    missing_count: int = 0  # committed turns without an entry (history not covered by auto)
    estimate: StorybookEstimate = Field(default_factory=StorybookEstimate)
    spend: BudgetView
    notice: Optional[str] = None  # visible pause notice
    last_error: Optional[str] = None
    entry_count: int = 0
    has_opening: bool = False


class StorybookView(StrictModel):
    status: StorybookStatus
    opening: Optional[StorybookEntry] = None
    entries: list[StorybookEntry] = Field(default_factory=list)  # commit order


class StorybookGenerateRequest(StrictModel):
    turn_ids: Optional[list[str]] = None  # None = every missing entry (+ opening)
    include_opening: bool = True


class StorybookGenerateResponse(StrictModel):
    job_id: Optional[str]
    queued: int
    status: StorybookStatus


# ---------------------------------------------------------------------------
# Story Mode (<run>/assistant/stories/<story_id>/{story.json, chapters/<n>.json})
# ---------------------------------------------------------------------------

StoryStatus = Literal[
    "interviewing", "brief_pending", "generating", "paused", "complete", "cancelled", "error", "interrupted"
]
ChapterUnit = Literal["turn", "round"]
StoryPov = Literal["chronicler", "follow"]


class StoryQuickPicks(StrictModel):
    genre: str = "chronicle"
    tone: str = "measured"
    vividness: int = Field(default=3, ge=1, le=5)
    pov: StoryPov = "chronicler"
    follow_agent_id: Optional[str] = None
    from_turn_id: Optional[str] = None  # None = first
    to_turn_id: Optional[str] = None  # None = last committed
    unit: ChapterUnit = "turn"
    language: str = "en"


class CastMember(StrictModel):
    agent_id: str
    name: str
    persona: str = ""
    alive: bool = True
    model_key: Optional[str] = None
    kills: int = 0
    died_turn_id: Optional[str] = None


class StoryRunCard(StrictModel):
    """Deterministic step 0 of the interview (no model call)."""

    run_id: str
    name: str
    world_id: str
    cast: list[CastMember]
    rounds: int
    turns: int
    deaths: int
    kills: int
    highlights: list[str] = Field(default_factory=list)
    first_turn_id: str
    last_turn_id: str
    parent: Optional[dict[str, Any]] = None  # {world_id, run_id, turn_id} for continuations
    suggested: StoryQuickPicks = Field(default_factory=StoryQuickPicks)


class CastMapping(StrictModel):
    agent_id: str
    story_name: str
    role: str = ""


class ChapterPlanEntry(StrictModel):
    number: int
    kind: Literal["chapter", "interlude", "opening", "epilogue"] = "chapter"
    turn_ids: list[str] = Field(default_factory=list)
    title: str = ""


class StoryEstimate(StrictModel):
    unit: ChapterUnit
    chapters: int
    cost_usd: float
    seconds: float


class StoryBriefDraft(StrictModel):
    """MODEL OUTPUT of the author profile's brief step (lean; the plan and estimates are computed
    deterministically by story.py)."""

    title: str = Field(min_length=1, max_length=120)
    premise: str = Field(max_length=2000)
    style_guide: str = Field(max_length=2000)
    cast_map: list[CastMapping] = Field(default_factory=list)
    faithful: list[str] = Field(default_factory=list, max_length=10)
    embellished: list[str] = Field(default_factory=list, max_length=10)


class StoryBrief(LooseModel):
    brief_id: str
    status: BriefStatus = "pending"
    created_at: str = Field(default_factory=utc_now_iso)
    title: str = ""
    premise: str = ""
    style_guide: str = ""
    cast_map: list[CastMapping] = Field(default_factory=list)
    faithful: list[str] = Field(default_factory=list)
    embellished: list[str] = Field(default_factory=list)
    picks: StoryQuickPicks = Field(default_factory=StoryQuickPicks)
    chapter_plan: list[ChapterPlanEntry] = Field(default_factory=list)  # for the chosen unit
    estimate_turn: Optional[StoryEstimate] = None
    estimate_round: Optional[StoryEstimate] = None
    job_budget_usd: float = 5.0
    in_reply_to: str = ""


class StoryChapter(LooseModel):
    number: int
    kind: Literal["chapter", "interlude", "opening", "epilogue"] = "chapter"
    title: str = ""
    text: str = ""
    turn_ids: list[str] = Field(default_factory=list)
    status: Literal["pending", "running", "done", "error"] = "pending"
    model_key: str = ""
    response_model: Optional[str] = None
    usage: ModelUsage = Field(default_factory=ModelUsage)
    cost_usd: float = 0.0
    created_at: str = Field(default_factory=utc_now_iso)
    error: Optional[str] = None


class StorySession(LooseModel):
    story_id: str
    run_id: str
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)
    status: StoryStatus = "interviewing"
    title: str = ""
    picks: StoryQuickPicks = Field(default_factory=StoryQuickPicks)
    messages: list[Message] = Field(default_factory=list)  # the interview
    brief: Optional[StoryBrief] = None
    superseded_briefs: list[StoryBrief] = Field(default_factory=list)
    unit: ChapterUnit = "turn"
    chapters_total: int = 0
    chapters_done: int = 0
    reader_position: int = 0  # chapters are generated 3 ahead of this
    generate_all: bool = False
    end_turn_id: Optional[str] = None  # pinned end for a story over a running run
    cast_sheet: str = ""  # summarizer output, refreshed every 5 chapters
    story_so_far: str = ""
    job_budget_usd: float = 5.0
    spent_usd: float = 0.0
    job_id: Optional[str] = None
    error: Optional[str] = None


class StorySessionSummary(StrictModel):
    story_id: str
    run_id: str
    title: str
    status: StoryStatus
    unit: ChapterUnit
    chapters_done: int
    chapters_total: int
    spent_usd: float
    created_at: str
    updated_at: str


class StoryView(StrictModel):
    session: StorySession
    chapters: list[StoryChapter] = Field(default_factory=list)  # done ones, in order
    job: Optional[JobView] = None
    run_card: Optional[StoryRunCard] = None


class StoryCreateRequest(StrictModel):
    picks: Optional[StoryQuickPicks] = None
    text: str = Field(default="", max_length=4000)  # free text of step 0; "" = just the picks


class StoryMessageRequest(StrictModel):
    text: str = Field(min_length=1, max_length=4000)
    picks: Optional[StoryQuickPicks] = None  # changed chips


class StoryApproveRequest(StrictModel):
    brief_id: str
    unit: ChapterUnit = "turn"
    generate_all: bool = False
    job_budget_usd: Optional[float] = Field(default=None, ge=0)


class StoryRejectRequest(StrictModel):
    reason: str = Field(default="", max_length=500)


class StoryContinueRequest(StrictModel):
    to_turn_id: Optional[str] = None  # None = last committed


class StoryChapterRequest(StrictModel):
    """GET .../chapters/{n} also moves the reader position (lazy generation 3 ahead)."""

    mark_read: bool = True


class StoryExport(StrictModel):
    title: str
    markdown: str


# ---------------------------------------------------------------------------
# Capabilities and speech
# ---------------------------------------------------------------------------


class ProfileCapability(StrictModel):
    profile: str
    model_key: str
    available: bool
    fake: bool
    reason: Optional[str] = None  # why unavailable ("claude (executable on PATH)")


class SpeechCapability(StrictModel):
    status: Literal["ready", "loading", "unavailable", "disabled"]
    model: str = ""
    reason: Optional[str] = None
    max_seconds: int = 60
    max_bytes: int = 10_000_000
    language_default: str = "en"


class AssistantCapabilities(StrictModel):
    available: bool  # at least the chat profile can be called
    auto_live_allowed: bool
    models: list[ProfileCapability]
    speech: SpeechCapability
    budgets: SpendView
    max_steps: int
    message_timeout_seconds: float
    version: str


class TranscribeParams(StrictModel):
    """Query parameters of POST /api/assistant/transcribe (the body is the raw audio)."""

    language: Optional[str] = "en"
    run_id: Optional[str] = None  # builds initial_prompt from the run's names
    initial_prompt: Optional[str] = None


def whisper_to_capability(status: WhisperStatus, *, max_seconds: int, max_bytes: int, language_default: str) -> SpeechCapability:
    """``model.whisper_status()`` -> the capability the drawer gates the Dictate button on."""
    return SpeechCapability(
        status=status.status,
        model=status.model,
        reason=status.reason,
        max_seconds=max_seconds,
        max_bytes=max_bytes,
        language_default=language_default,
    )


# TranscriptionResult / WhisperStatus / AgentCard are imported above so route modules can take
# them from here (AgentCard: partial cards inside CreateRunAction.overlay["agents"]).
