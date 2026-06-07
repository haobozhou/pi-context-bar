/**
 * Context Status Bar Extension
 *
 * Replaces the footer with a visual bar showing how the context window is composed:
 *   - System (system prompt, agent.md, skills, tool descriptions)
 *   - User (user messages)
 *   - LLM (assistant responses)
 *   - Tools (tool call inputs + tool outputs)
 *   - Summary (compaction / branch summaries)
 *
 * Features:
 *   - Color-coded progress bar proportional to token usage
 *   - Token count and percentage per category
 *   - Context window utilization indicator
 *   - Model name display
 *   - History tracking with /context-bar history
 *
 * Toggle with /context-bar command.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Token estimation ───────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text: unknown): number {
  if (text === undefined || text === null) return 0;
  if (typeof text === "string") return Math.ceil(text.length / CHARS_PER_TOKEN);
  if (Array.isArray(text)) {
    return text.reduce((acc: number, block: unknown) => acc + estimateTokenBlock(block), 0);
  }
  return Math.ceil(JSON.stringify(text).length / CHARS_PER_TOKEN);
}

function estimateTokenBlock(block: unknown): number {
  if (block === null || block === undefined) return 0;
  if (typeof block === "string") return estimateTokens(block);
  if (typeof block !== "object") return 0;

  const obj = block as Record<string, unknown>;
  const type = obj.type;

  if (type === "text") {
    return estimateTokens((obj as TextContent).text);
  }
  if (type === "thinking") {
    return estimateTokens((obj as ThinkingContent).thinking);
  }
  if (type === "toolCall") {
    const tc = obj as ToolCall;
    // Count the tool call overhead + arguments
    const overhead = tc.name.length + tc.id.length + 20; // 20 for structural chars
    return overhead + estimateTokens(tc.arguments);
  }
  if (type === "image") {
    // Images are base64 — they're large but compressed in context
    return estimateTokens((obj as { data: string }).data);
  }

  // Fallback: stringify and estimate
  return estimateTokens(JSON.stringify(obj));
}

// ─── Context categories ─────────────────────────────────────────────

interface ContextSegment {
  label: string;
  tokens: number;
  color: string; // theme fg color name
}

interface ContextData {
  segments: ContextSegment[];
  totalTokens: number;
  modelId: string | undefined;
  contextWindow: number | undefined;
  realContextTokens: number | null; // real token count from session (null = unknown)
}

function computeContextSegments(
  entries: SessionEntry[],
  systemPrompt: string
): ContextSegment[] {
  const segments: ContextSegment[] = [];

  // 1. System prompt (agent.md, skills, tool descriptions, custom prompt)
  const systemTokens = estimateTokens(systemPrompt);
  if (systemTokens > 0) {
    segments.push({ label: "System", tokens: systemTokens, color: "dim" });
  }

  // 2. Assistant messages (LLM responses)
  let assistantTokens = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const m = entry.message as AssistantMessage;
      if (m.usage && m.usage.totalTokens > 0) {
        assistantTokens += m.usage.totalTokens;
      } else {
        const content = m.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            assistantTokens += estimateTokenBlock(block);
          }
        }
      }
    }
  }
  if (assistantTokens > 0) {
    segments.push({ label: "LLM", tokens: assistantTokens, color: "accent" });
  }

  // 3. User messages
  let userTokens = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      const m = entry.message as UserMessage;
      userTokens += estimateTokens(m.content);
    }
  }
  if (userTokens > 0) {
    segments.push({ label: "User", tokens: userTokens, color: "success" });
  }

  // 4. Tool outputs (toolResult + bashExecution)
  let toolTokens = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const m = entry.message as ToolResultMessage;
      toolTokens += estimateTokens(m.content);
      toolTokens += estimateTokens(m.details);
    }
    if (entry.type === "message" && entry.message.role === "bashExecution") {
      const m = entry.message as { output: string };
      toolTokens += estimateTokens(m.output);
    }
  }
  if (toolTokens > 0) {
    segments.push({ label: "Tools", tokens: toolTokens, color: "warning" });
  }

  // 5. Compaction / branch summaries
  let summaryTokens = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "compactionSummary") {
      const m = entry.message as { summary: string };
      summaryTokens += estimateTokens(m.summary);
    }
    if (entry.type === "message" && entry.message.role === "branchSummary") {
      const m = entry.message as { summary: string };
      summaryTokens += estimateTokens(m.summary);
    }
  }
  if (summaryTokens > 0) {
    segments.push({ label: "Summary", tokens: summaryTokens, color: "muted" });
  }

  // 6. Custom messages (extension-injected)
  let customTokens = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "custom") {
      const m = entry.message as { content: unknown };
      customTokens += estimateTokens(m.content);
    }
  }
  if (customTokens > 0) {
    segments.push({ label: "Custom", tokens: customTokens, color: "borderMuted" });
  }

  return segments;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// Icon mapping for segment labels
const segmentIcons: Record<string, string> = {
  System: "⚙",
  LLM: "🤖",
  User: "👤",
  Tools: "🔧",
  Summary: "◈",
  Custom: "⊕",
};

// ─── History tracking ───────────────────────────────────────────────

interface HistoryEntry {
  segments: ContextSegment[];
  totalTokens: number;
  realContextTokens: number | null;
  turnIndex: number;
}

let historyBuffer: HistoryEntry[] = [];
const MAX_HISTORY = 10;
let turnCounter = 0;

function addSnapshot(
  entries: SessionEntry[],
  systemPrompt: string,
  contextWindow: number | undefined,
  realContextTokens: number | null
): void {
  const segments = computeContextSegments(entries, systemPrompt);
  const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0);
  turnCounter++;
  historyBuffer.push({ segments, totalTokens, realContextTokens, turnIndex: turnCounter });
  if (historyBuffer.length > MAX_HISTORY) {
    historyBuffer.shift();
  }
}

function renderHistory(
  width: number,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }
): string[] {
  const lines: string[] = [];

  if (historyBuffer.length === 0) {
    return [theme.fg("dim", "No history yet — send a message to start tracking")];
  }

  // Find max tokens for scaling
  const maxTokens = Math.max(...historyBuffer.map(s => s.totalTokens), 1);
  const barWidth = Math.min(24, Math.floor((width - 14) / 2)); // leave room for label

  // Header
  lines.push(
    theme.bold(
      ` Context History  (${historyBuffer.length} snapshots, ${turnCounter} turns)`
    )
  );
  lines.push("");

  // Each row: turn │ mini-bar  segment labels
  for (const entry of historyBuffer) {
    // Build mini bar
    let bar = "";
    let filled = 0;
    for (const seg of entry.segments) {
      const segWidth = Math.max(1, Math.round((seg.tokens / maxTokens) * barWidth));
      const actualWidth = Math.min(segWidth, barWidth - filled);
      bar += theme.fg(seg.color, "█".repeat(actualWidth));
      filled += actualWidth;
      if (filled >= barWidth) break;
    }
    while (filled < barWidth) {
      bar += theme.fg("dim", "░");
      filled++;
    }

    // Build label: "System 1.2k(40%) LLM 3.5k(60%)"
    const labelParts = entry.segments.map(s => {
      const pct = ((s.tokens / entry.totalTokens) * 100).toFixed(0);
      return `${s.label} ${formatTokens(s.tokens)}(${pct}%)`;
    });
    const label = labelParts.join(" ");

    // Pad label if it's too long
    const labelWidth = Math.min(label.length, width - barWidth - 10);
    const paddedLabel = label.slice(0, labelWidth);

    lines.push(
      theme.fg("dim", `#${entry.turnIndex} │`) +
      " " +
      bar +
      " " +
      paddedLabel
    );
  }

  // Footer
  lines.push("");
  lines.push(theme.fg("dim", "─────────────────────────────────────────────────────►"));
  lines.push(theme.fg("dim", "  time →"));

  return lines;
}

// ─── Progress bar rendering ─────────────────────────────────────────

/**
 * Two-line status bar:
 *   Line 1 — proportion bar: colored blocks showing relative token share per segment
 *   Line 2 — labels with values: "System 0.5k (12%) LLM 2.0k (45%) User 1.2k (27%) Tools 0.8k (16%)"
 * Each segment on line 2 is rendered in its own color.
 */
function renderStatusBar(
  data: ContextData,
  entries: SessionEntry[],
  width: number,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }
): string[] {
  const { segments, totalTokens, modelId, contextWindow, realContextTokens } = data;

  if (totalTokens === 0 || segments.length === 0) {
    return [theme.fg("dim", "No context yet — send a message to see the breakdown")];
  }

  // ── Input / Output token delta (↑ = input, ↓ = output) ──
  let inputTokens = 0;
  let outputTokens = 0;
  for (const seg of segments) {
    if (seg.label === "LLM") {
      outputTokens += seg.tokens;
    } else {
      inputTokens += seg.tokens;
    }
  }

  // ── Cache read tokens (R) — cumulative from all entries ──
  let totalCacheRead = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const m = entry.message as AssistantMessage;
      if (m.usage && m.usage.cacheRead) {
        totalCacheRead += m.usage.cacheRead;
      }
    }
  }

  // ── Utilization percentage ──
  // Use real context token count from session (via getContextUsage) for accuracy.
  // The estimated totalTokens (sum of char-count segments) can far exceed actual
  // context tokens because: (a) character→token ratio over-counts, (b) it includes
  // messages that were compacted away.
  let utilPct = "";
  if (contextWindow && contextWindow > 0) {
    let fraction: number;
    if (realContextTokens !== null && realContextTokens > 0) {
      fraction = Math.min(realContextTokens / contextWindow, 1);
    } else {
      fraction = Math.min(totalTokens / contextWindow, 1);
    }
    const pct = (fraction * 100).toFixed(0);
    const color = fraction > 0.9 ? "error" : fraction > 0.7 ? "warning" : "success";
    const cacheStr = totalCacheRead > 0 ? ` R${formatTokens(totalCacheRead)}` : "";
    utilPct = theme.fg(color, `[${pct}%/${formatTokens(contextWindow)}${cacheStr}] `);
  } else {
    const displayTokens = realContextTokens !== null ? realContextTokens : totalTokens;
    utilPct = theme.fg("dim", `[${formatTokens(displayTokens)}] `);
  }

  // ── Line 1: Proportion bar (colored blocks) ──
  // Reserve space for utilPct + delta + modelId + padding; rest goes to bar
  const deltaText = (inputTokens > 0 || outputTokens > 0)
    ? ` ${theme.fg("success", `↑${formatTokens(inputTokens)}`)} ${theme.fg("warning", `↓${formatTokens(outputTokens)}`)}`
    : "";
  const modelOverhead = modelId ? modelId.length + 3 : 0; // (modelId)
  const availableForBar = Math.max(40, width - utilPct.length - deltaText.length - modelOverhead - 2);

  // Distribute availableForBar proportionally
  type SegWithWidth = { seg: ContextSegment; pct: number; rawWidth: number };
  const segProportions: SegWithWidth[] = segments.map(seg => ({
    seg,
    pct: seg.tokens / totalTokens,
    rawWidth: (seg.tokens / totalTokens) * availableForBar,
  }));

  const floorWidths = segProportions.map(s => Math.max(1, Math.floor(s.rawWidth)));
  const used = floorWidths.reduce((a, b) => a + b, 0);
  let remainder = availableForBar - used;
  // Give remainder to largest segments
  const indexed = segProportions.map((s, i) => ({ idx: i, excess: s.rawWidth - Math.floor(s.rawWidth) }));
  indexed.sort((a, b) => b.excess - a.excess);
  for (let r = 0; r < remainder && r < indexed.length; r++) {
    floorWidths[indexed[r].idx]++;
  }

  let line1 = "";
  for (let i = 0; i < segProportions.length; i++) {
    const { seg } = segProportions[i];
    const w = floorWidths[i];
    line1 += theme.fg(seg.color, "█".repeat(w));
  }
  // Pad remaining space with dim block
  const currentLine1Width = visibleWidth(line1);
  if (currentLine1Width < availableForBar) {
    line1 += theme.fg("dim", "░".repeat(availableForBar - currentLine1Width));
  }

  // ── Line 2: Labels with values & percentages ──
  // Layout: [⚙ 0.5k (12%)][✦ 2.0k (45%)][◉ 1.2k (27%)][⚡ 0.8k (16%)]
  let line2 = "";
  for (let seg of segments) {
    const pct = ((seg.tokens / totalTokens) * 100).toFixed(0);
    const icon = segmentIcons[seg.label] ?? "●";
    line2 += theme.fg(seg.color, `[${icon} ${formatTokens(seg.tokens)} (${pct}%)]`);
  }

  // ── Assemble ──
  let suffix = "";
  if (modelId) {
    suffix += theme.fg("dim", ` (${modelId})`);
  }

  const line1Full = `${utilPct}${deltaText}[${line1}]${suffix}`;
  return [
    truncateToWidth(line1Full, width),
    truncateToWidth(line2, width),
  ];
}

// ─── Extension ──────────────────────────────────────────────────────

let enabled = false;
let lastTotalTokens = -1; // Guard against capturing on every render

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context-bar", {
    description: "Toggle context composition status bar (use /context-bar history for history)",
    handler: async (args: string, ctx) => {
      const subcommand = (args || "").trim().toLowerCase();

      if (subcommand === "history") {
        // Show history chart
        const theme = ctx.ui.theme;
        const entries = ctx.sessionManager.getBranch();
        const segments = computeContextSegments(entries, ctx.getSystemPrompt());
        const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0);
        const model = ctx.model;
        const contextWindow = model?.contextWindow;
        const usage = ctx.getContextUsage();
        const realContextTokens = usage?.tokens ?? null;

        // Capture current state
        addSnapshot(entries, ctx.getSystemPrompt(), contextWindow, realContextTokens);

        const lines = renderHistory(200, theme);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Default: toggle enabled
      enabled = !enabled;

      if (enabled) {
        const theme = ctx.ui.theme;
        ctx.ui.setFooter((_tui, theme, _footerData) => {
          return {
            invalidate() {},
            render(width: number): string[] {
              const entries = ctx.sessionManager.getBranch();
              const segments = computeContextSegments(entries, ctx.getSystemPrompt());
              const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0);
              const model = ctx.model;
              const contextWindow = model?.contextWindow;
              const modelId = model?.id;

              // Real context token count from session (accurate, tokenizer-based)
              const usage = ctx.getContextUsage();
              const realContextTokens = usage?.tokens ?? null;

              // Capture snapshot for history — only when context actually changed
              if (totalTokens !== lastTotalTokens) {
                lastTotalTokens = totalTokens;
                addSnapshot(entries, ctx.getSystemPrompt(), contextWindow, realContextTokens);
              }

              const data: ContextData = {
                segments,
                totalTokens,
                modelId,
                contextWindow,
                realContextTokens,
              };
              return renderStatusBar(data, entries, width, theme);
            },
          };
        });
        ctx.ui.notify("Context status bar enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Context status bar disabled", "info");
      }
    },
  });

  // Update status when context changes
  pi.on("session_start", async (_event, ctx) => {
    if (!enabled) return;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus("context-bar", theme.fg("dim", "● Context bar on"));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!enabled) return;
    ctx.ui.setStatus("context-bar", undefined);
  });
}
