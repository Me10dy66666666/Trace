import { z } from "zod";

import { TraceError } from "./errors.js";

const boundedString = (maxLength: number) => z.string().max(maxLength);
const sourceRefs = z.array(boundedString(200)).max(20).optional();

export const workTraceSummarySchema = z.object({
  schema_version: z.literal("0.1"),
  summary_mode: z.enum(["conversation-first", "partial", "code-only"]),
  title: boundedString(160).optional(),
  user_requests: z.array(z.object({
    request: boundedString(1000),
    constraints: z.array(boundedString(500)).max(20).optional(),
    source_refs: sourceRefs
  }).strict()).max(20),
  ai_actions: z.array(z.object({
    action: boundedString(1000),
    result: boundedString(1000).optional(),
    tool_refs: z.array(boundedString(200)).max(30).optional(),
    source_refs: sourceRefs
  }).strict()).max(50),
  decisions: z.array(z.object({
    statement: boundedString(1000),
    made_by: z.enum(["user", "ai", "joint"]),
    status: z.enum(["accepted", "rejected", "superseded", "deferred"]),
    rationale: boundedString(1000).optional(),
    source_refs: sourceRefs
  }).strict()).max(30),
  direction_changes: z.array(z.object({
    from: boundedString(1000),
    to: boundedString(1000),
    reason: boundedString(1000).optional(),
    source_refs: sourceRefs
  }).strict()).max(20),
  outcomes: z.array(boundedString(1000)).max(30),
  unresolved: z.array(boundedString(1000)).max(30),
  tests: z.array(z.object({
    name: boundedString(500),
    status: z.enum(["passed", "failed", "partial", "not-run", "unknown"]),
    details: boundedString(1000).optional()
  }).strict()).max(30).optional(),
  affected_areas: z.array(boundedString(300)).max(50).optional(),
  verification_notes: z.array(boundedString(1000)).max(20).optional(),
  source_session_ref: boundedString(300).optional(),
  confidence: z.number().min(0).max(1)
}).strict();

export type WorkTraceSummary = z.infer<typeof workTraceSummarySchema>;

export type SummaryConversationMode = "summary-only" | "summary+refs" | "full";

export type WorkTraceSummaryRecord = Readonly<{
  nodeId: string;
  repositoryId: string;
  sessionId: string | null;
  commitOid: string;
  conversationMode: SummaryConversationMode;
  operationId: string | null;
  summary: WorkTraceSummary;
  createdAt: string;
  updatedAt: string;
}>;

export type FinalizeSummaryResult = Readonly<{
  node_id: string;
  session_id: string | null;
  generation_status: "completed";
  stored: true;
}>;

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*(["']?)[^\s,"'}`]+/gi
];

function redactText(value: string): string {
  return secretPatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value
  );
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item)])
    );
  }
  return value;
}

export function parseWorkTraceSummary(value: unknown): WorkTraceSummary {
  const parsed = workTraceSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw new TraceError(
      "INVALID_WORK_SUMMARY",
      "The WorkTraceSummary does not conform to the required schema.",
      false,
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message
        }))
      }
    );
  }
  return redactValue(parsed.data) as WorkTraceSummary;
}
