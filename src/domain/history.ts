export type TraceHistoryNode = Readonly<{
  id: string;
  commit: string;
  title: string;
  createdAt: string;
  gitParent: string | null;
  chronologicalParent: string | null;
}>;

export type TraceHistoryPage = Readonly<{
  nodes: readonly TraceHistoryNode[];
  nextCursor: string | null;
}>;
