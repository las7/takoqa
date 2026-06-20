/**
 * The decision layer: given the current observation and mission context, ask
 * the model for the next action. Kept behind an LLMClient interface so the
 * engine can run against a real model or a scripted mock (for dry-runs/CI).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Action } from "./act.js";
import { ACTION_TOOL_SCHEMA } from "./act.js";
import type { Observation } from "./observe.js";
import { renderObservation } from "./observe.js";
import { renderKnowledge } from "./knowledge.js";
import type { Knowledge, Mission, Persona } from "./types.js";

export interface Decision {
  action: Action;
  rationale: string;
}

export interface AgentContext {
  persona: Persona;
  mission: Mission;
  /** Summaries of prior actions this mission, oldest first. */
  history: string[];
  /** Optional structural context about the app under test. */
  knowledge?: Knowledge;
  /** Known routes not yet visited this mission — to bias exploration. */
  frontier?: string[];
}

export interface LLMClient {
  decide(obs: Observation, ctx: AgentContext): Promise<Decision>;
  /** Free-form JSON judgement used by the LLM-judge oracle. */
  judge(prompt: string, screenshotBase64: string): Promise<string>;
  /**
   * Free-form JSON used by the exploration loop's mission *proposer* — given an
   * app map + what's been explored/found so far, the model invents the next
   * batch of missions to try. Returns raw text (the planner parses/validates).
   */
  propose(prompt: string): Promise<string>;
}

export function systemPrompt(ctx: AgentContext): string {
  const knowledgeBlock = ctx.knowledge
    ? renderKnowledge(ctx.knowledge, { forJudge: false })
    : ``;
  return [
    `You are simulating a real user testing a web application. Behave like the persona, not like an automated script.`,
    ``,
    knowledgeBlock,
    ``,
    `PERSONA: ${ctx.persona.name}`,
    ctx.persona.description,
    ctx.persona.traits.length
      ? `Traits: ${ctx.persona.traits.join(", ")}.`
      : ``,
    ``,
    `YOUR GOAL: ${ctx.mission.goal}`,
    ctx.mission.successCriteria.length
      ? `Success looks like:\n- ${ctx.mission.successCriteria.join("\n- ")}`
      : ``,
    ctx.mission.hints.length
      ? `SUGGESTED STEPS (a playbook for this task — follow it, but adapt to what you actually see on the page):\n- ${ctx.mission.hints.join("\n- ")}`
      : ``,
    ctx.frontier && ctx.frontier.length
      ? `AREAS NOT YET VISITED this run (prefer these if you are exploring): ${ctx.frontier.join(", ")}`
      : ``,
    ``,
    `Each turn you receive the page state and a screenshot. Call the "act" tool with exactly one action.`,
    `Address elements by their [ref] number whenever one exists — prefer that over coordinates.`,
    `Some areas are drawn on a <canvas> (e.g. a diagram or drawing editor) and have NO refs. To interact with those, read pixel coordinates from the screenshot and use click_at/double_click/drag (e.g. drag to draw a box around a symbol; double_click a node to open its menu). Coordinates are viewport pixels from the top-left; see VIEWPORT for the range.`,
    `Prefer the most natural next step a real user would take. Explore when the path is unclear.`,
    `If you accomplish the goal, or you are truly blocked, call act with type="finish".`,
    `Do not loop on the same failing action — if something does not work, try a different path or finish with success=false.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function userMessage(obs: Observation, ctx: AgentContext): string {
  const history = ctx.history.length
    ? `ACTIONS SO FAR:\n${ctx.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
    : `This is your first action.`;
  return `${history}\n\nCURRENT PAGE:\n${renderObservation(obs)}`;
}

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  constructor(
    apiKey: string | undefined,
    private readonly model: string = "claude-sonnet-4-6",
  ) {
    // With an explicit key, use it. Without one, construct a bare client and let
    // the SDK resolve credentials itself — ANTHROPIC_AUTH_TOKEN, or an
    // `ant auth login` OAuth profile that it auto-refreshes. That's the same
    // mechanism Claude Code uses, so a long unattended run won't die when a
    // short-lived OAuth token expires mid-run (a static key never expires).
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async decide(obs: Observation, ctx: AgentContext): Promise<Decision> {
    // The system prompt (persona + goal + hints + knowledge) and the tool
    // schema are identical on every step of a mission, so cache that prefix —
    // each step after the first reuses it (5-min TTL) instead of reprocessing
    // the tokens. Only the per-step user message (history + observation +
    // screenshot) changes.
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: systemPrompt(ctx),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [{ ...ACTION_TOOL_SCHEMA, cache_control: { type: "ephemeral" } }],
      tool_choice: { type: "tool", name: "act" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userMessage(obs, ctx) },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: obs.screenshotBase64,
              },
            },
          ],
        },
      ],
    });

    const toolUse = res.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return {
        action: {
          type: "finish",
          success: false,
          summary: "Model returned no action.",
        },
        rationale: "No tool_use block in response.",
      };
    }
    const input = toolUse.input as Record<string, unknown>;
    const rationale = String(input.rationale ?? "");
    return { action: coerceAction(input), rationale };
  }

  async judge(prompt: string, screenshotBase64: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshotBase64,
              },
            },
          ],
        },
      ],
    });
    const text = res.content.find((c) => c.type === "text");
    return text && text.type === "text" ? text.text : "{}";
  }

  async propose(prompt: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.find((c) => c.type === "text");
    return text && text.type === "text" ? text.text : "[]";
  }
}

/** Turns loosely-typed tool input into a well-formed Action. */
function coerceAction(input: Record<string, unknown>): Action {
  const type = String(input.type);
  switch (type) {
    case "click":
      return { type: "click", ref: Number(input.ref) };
    case "type":
      return {
        type: "type",
        ref: Number(input.ref),
        text: String(input.text ?? ""),
        submit: Boolean(input.submit),
      };
    case "upload":
      return {
        type: "upload",
        ref: Number(input.ref),
        fixture: String(input.fixture ?? ""),
      };
    case "navigate":
      return { type: "navigate", path: String(input.path ?? "/") };
    case "scroll":
      return {
        type: "scroll",
        direction: input.direction === "up" ? "up" : "down",
      };
    case "wait":
      return { type: "wait", ms: Number(input.ms ?? 1000) };
    case "click_at":
      return { type: "click_at", x: Number(input.x), y: Number(input.y) };
    case "double_click":
      return { type: "double_click", x: Number(input.x), y: Number(input.y) };
    case "drag":
      return {
        type: "drag",
        x: Number(input.x),
        y: Number(input.y),
        x2: Number(input.x2),
        y2: Number(input.y2),
      };
    default:
      return {
        type: "finish",
        success: Boolean(input.success),
        summary: String(input.summary ?? ""),
      };
  }
}

/**
 * Scripted client for dry-runs and CI smoke tests. Walks a fixed action list,
 * then finishes. Lets the whole pipeline run with no API key or model cost.
 */
export class MockClient implements LLMClient {
  private i = 0;
  constructor(private readonly script: Action[] = []) {}

  async decide(): Promise<Decision> {
    const action = this.script[this.i] ?? {
      type: "finish" as const,
      success: true,
      summary: "Mock script complete.",
    };
    this.i++;
    return { action, rationale: "mock" };
  }

  async judge(): Promise<string> {
    return JSON.stringify({ goalMet: true, severity: "low", issues: [] });
  }

  async propose(): Promise<string> {
    return "[]";
  }
}
