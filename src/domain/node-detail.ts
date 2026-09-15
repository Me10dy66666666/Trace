import type { WorkTraceSummary } from "./work-trace-summary.js";

export type ChangedFile = Readonly<{
  path: string;
  additions: number;
  deletions: number;
}>;

export type TraceDecision = Readonly<{
  title: string;
  reason: string;
}>;

export type TraceNodeDetail = Readonly<{
  id: string;
  commit: string;
  summary: string;
  goal: string;
  decisions: readonly TraceDecision[];
  changedFiles: readonly ChangedFile[];
  gitParent: string | null;
  chronologicalParent: string | null;
  conversationStatus: "available" | "unavailable";
  workSummary?: WorkTraceSummary;
}>;
