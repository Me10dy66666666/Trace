import type { ChangedFile } from "./node-detail.js";

export type TraceComparison = Readonly<{
  filesChanged: number;
  additions: number;
  deletions: number;
  summary: string;
  files: readonly ChangedFile[];
}>;
