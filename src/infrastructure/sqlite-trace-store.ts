import { DatabaseSync } from "node:sqlite";

import type { OperationIntent, OperationRecord, OperationRecovery, OperationResult, TraceNode } from "../domain/checkpoint.js";
import type { ConversationAttachment } from "../domain/conversation.js";
import type { TraceSession } from "../domain/resume.js";
import type { TraceNodeList, TraceStore } from "../domain/trace-store.js";
import type { RegisteredRepository } from "../domain/types.js";
import type { WorkTraceSummaryRecord } from "../domain/work-trace-summary.js";

type RepositoryRow = Readonly<{
  id: string;
  repository_path: string;
  common_directory: string;
  fingerprint: string;
  default_branch: string | null;
  created_at: string;
}>;

type OperationRow = Readonly<{
  id: string;
  repository_id: string;
  operation_type: OperationRecord["operationType"];
  state: OperationRecord["state"];
  result_json: string | null;
  intent_json: string | null;
  recovery_json: string | null;
  created_at: string;
}>;

type TraceNodeRow = Readonly<{
  id: string;
  repository_id: string;
  commit_oid: string;
  node_type: "checkpoint" | "commit";
  title: string;
  created_at: string;
  git_parent_node_id: string | null;
  chronological_parent_node_id: string | null;
  chronology_position: number | null;
}>;

type TraceSessionRow = Readonly<{
  id: string;
  repository_id: string;
  base_node_id: string;
  source_node_id: string;
  branch: string;
  worktree_path: string;
  started_at: string;
  status: TraceSession["status"];
}>;

type ConversationAttachmentRow = Readonly<{
  id: string;
  session_id: string;
  provider: string;
  conversation_id: string;
  retention: ConversationAttachment["retention"];
  attached_at: string;
}>;

type WorkTraceSummaryRow = Readonly<{
  node_id: string;
  repository_id: string;
  session_id: string | null;
  commit_oid: string;
  conversation_mode: WorkTraceSummaryRecord["conversationMode"];
  operation_id: string | null;
  summary_json: string;
  created_at: string;
  updated_at: string;
}>;

type NextChronologyPositionRow = Readonly<{
  chronology_position: number;
}>;

type SchemaRow = Readonly<{
  sql: string | null;
}>;

export class SqliteTraceStore implements TraceStore {
  private readonly database: DatabaseSync;

  public constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        repository_path TEXT NOT NULL UNIQUE,
        common_directory TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        default_branch TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trace_nodes (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        commit_oid TEXT NOT NULL,
        node_type TEXT NOT NULL CHECK(node_type IN ('commit', 'checkpoint')),
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(repository_id, commit_oid, node_type)
      );
      CREATE TABLE IF NOT EXISTS trace_node_relations (
        node_id TEXT PRIMARY KEY REFERENCES trace_nodes(id),
        git_parent_node_id TEXT REFERENCES trace_nodes(id),
        chronological_parent_node_id TEXT REFERENCES trace_nodes(id),
        chronology_position INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trace_node_relations_chronology_idx
        ON trace_node_relations(chronology_position DESC);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        operation_type TEXT NOT NULL CHECK(operation_type IN ('checkpoint', 'resume', 'attach_conversation')),
        intent_json TEXT,
        state TEXT NOT NULL,
        recovery_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trace_sessions (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        base_node_id TEXT NOT NULL REFERENCES trace_nodes(id),
        source_node_id TEXT NOT NULL REFERENCES trace_nodes(id),
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'orphaned')),
        UNIQUE(repository_id, worktree_path)
      );
      CREATE TABLE IF NOT EXISTS conversation_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES trace_sessions(id),
        provider TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        retention TEXT NOT NULL CHECK(retention IN ('summary')),
        attached_at TEXT NOT NULL,
        UNIQUE(session_id, provider, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS work_trace_summaries (
        node_id TEXT PRIMARY KEY REFERENCES trace_nodes(id),
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        session_id TEXT REFERENCES trace_sessions(id),
        commit_oid TEXT NOT NULL,
        conversation_mode TEXT NOT NULL CHECK(conversation_mode IN ('summary-only', 'summary+refs', 'full')),
        operation_id TEXT UNIQUE,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateOperationColumns();
    this.migrateTraceSessionsTable();
    this.migrateOperationsTable();
    this.migrateExistingNodesToRelations();
  }

  public findRepositoryByPath(repositoryPath: string): RegisteredRepository | null {
    const row = this.database
      .prepare("SELECT * FROM repositories WHERE repository_path = ?")
      .get(repositoryPath) as RepositoryRow | undefined;
    return row === undefined ? null : this.toRepository(row);
  }

  public getRepository(repositoryId: string): RegisteredRepository | null {
    const row = this.database
      .prepare("SELECT * FROM repositories WHERE id = ?")
      .get(repositoryId) as RepositoryRow | undefined;
    return row === undefined ? null : this.toRepository(row);
  }

  public saveRepository(repository: RegisteredRepository): void {
    this.database
      .prepare(`
        INSERT INTO repositories (
          id, repository_path, common_directory, fingerprint, default_branch, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        repository.id,
        repository.repositoryPath,
        repository.commonDirectory,
        repository.fingerprint,
        repository.defaultBranch,
        repository.createdAt
      );
  }

  public getOperation(operationId: string): OperationRecord | null {
    const row = this.database
      .prepare("SELECT * FROM operations WHERE id = ?")
      .get(operationId) as OperationRow | undefined;
    return row === undefined ? null : this.toOperation(row);
  }

  public listUnfinishedOperations(): readonly OperationRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM operations WHERE state IN ('PENDING', 'PREPARED', 'GIT_APPLIED', 'DB_APPLIED', 'VERIFIED') ORDER BY created_at ASC")
      .all() as OperationRow[];
    return rows.map((row) => this.toOperation(row));
  }

  public createOperation(operation: OperationRecord): void {
    this.database
      .prepare(`
        INSERT INTO operations (id, repository_id, operation_type, state, intent_json, result_json, recovery_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        operation.id,
        operation.repositoryId,
        operation.operationType,
        operation.state,
        operation.intent === null ? null : JSON.stringify(operation.intent),
        operation.result === null ? null : JSON.stringify(operation.result),
        operation.recovery === null ? null : JSON.stringify(operation.recovery),
        operation.createdAt
      );
  }

  public markOperationPrepared(operationId: string): void {
    this.database.prepare("UPDATE operations SET state = 'PREPARED' WHERE id = ? AND state = 'PENDING'").run(operationId);
  }

  public markOperationGitApplied(operationId: string): void {
    this.database
      .prepare("UPDATE operations SET state = 'GIT_APPLIED' WHERE id = ? AND state IN ('PENDING', 'PREPARED', 'GIT_APPLIED')")
      .run(operationId);
  }

  public markOperationDatabaseApplied(operationId: string): void {
    this.database
      .prepare("UPDATE operations SET state = 'DB_APPLIED' WHERE id = ? AND state IN ('PENDING', 'PREPARED', 'GIT_APPLIED', 'DB_APPLIED')")
      .run(operationId);
  }

  public markOperationVerified(operationId: string): void {
    this.database
      .prepare("UPDATE operations SET state = 'VERIFIED' WHERE id = ? AND state IN ('PENDING', 'PREPARED', 'GIT_APPLIED', 'DB_APPLIED', 'VERIFIED')")
      .run(operationId);
  }

  public markOperationRecoveryRequired(operationId: string, recovery: OperationRecovery): void {
    this.database
      .prepare("UPDATE operations SET state = 'RECOVERY_REQUIRED', recovery_json = ? WHERE id = ? AND state IN ('PENDING', 'PREPARED', 'GIT_APPLIED', 'DB_APPLIED', 'VERIFIED')")
      .run(recovery === null ? null : JSON.stringify(recovery), operationId);
  }

  public completeOperation(operationId: string, result: OperationResult): void {
    this.database
      .prepare("UPDATE operations SET state = 'COMPLETED', result_json = ? WHERE id = ?")
      .run(JSON.stringify(result), operationId);
  }

  public failOperation(operationId: string): void {
    this.database.prepare("UPDATE operations SET state = 'FAILED' WHERE id = ?").run(operationId);
  }

  public createNode(node: TraceNode): void {
    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      this.database
        .prepare(`
          INSERT INTO trace_nodes (id, repository_id, commit_oid, node_type, title, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(node.id, node.repositoryId, node.commit, node.nodeType, node.title, node.createdAt);
      const nextPosition = this.database
        .prepare(`
          SELECT COALESCE(MAX(relations.chronology_position), 0) + 1 AS chronology_position
          FROM trace_node_relations AS relations
          INNER JOIN trace_nodes AS existing_node ON existing_node.id = relations.node_id
          WHERE existing_node.repository_id = ?
        `)
        .get(node.repositoryId) as NextChronologyPositionRow;
      this.database
        .prepare(`
          INSERT INTO trace_node_relations (
            node_id, git_parent_node_id, chronological_parent_node_id, chronology_position
          ) VALUES (?, ?, ?, ?)
        `)
        .run(
          node.id,
          node.gitParentNodeId,
          node.chronologicalParentNodeId,
          nextPosition.chronology_position
        );
      this.database.exec("COMMIT;");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  public getNode(nodeId: string): TraceNode | null {
    const row = this.database
      .prepare(this.traceNodeSelect("WHERE nodes.id = ?"))
      .get(nodeId) as TraceNodeRow | undefined;
    return row === undefined ? null : this.toNode(row);
  }

  public findNodeByCommit(repositoryId: string, commit: string): TraceNode | null {
    const row = this.database
      .prepare(`${this.traceNodeSelect("WHERE nodes.repository_id = ? AND nodes.commit_oid = ?")} ORDER BY relations.chronology_position DESC LIMIT 1`)
      .get(repositoryId, commit) as TraceNodeRow | undefined;
    return row === undefined ? null : this.toNode(row);
  }

  public findLatestNode(repositoryId: string): TraceNode | null {
    const row = this.database
      .prepare(`${this.traceNodeSelect("WHERE nodes.repository_id = ?")} ORDER BY relations.chronology_position DESC LIMIT 1`)
      .get(repositoryId) as TraceNodeRow | undefined;
    return row === undefined ? null : this.toNode(row);
  }

  public listNodes(
    repositoryId: string,
    limit: number,
    beforeChronologyPosition: number | null
  ): TraceNodeList {
    const rows = this.database
      .prepare(`
        ${this.traceNodeSelect("WHERE nodes.repository_id = ? AND (? IS NULL OR relations.chronology_position < ?)")}
        ORDER BY relations.chronology_position DESC
        LIMIT ?
      `)
      .all(repositoryId, beforeChronologyPosition, beforeChronologyPosition, limit + 1) as TraceNodeRow[];
    const visibleRows = rows.slice(0, limit);
    const nextCursorPosition = rows.length > limit
      ? visibleRows[visibleRows.length - 1]?.chronology_position ?? null
      : null;

    return {
      nodes: visibleRows.map((row) => this.toNode(row)),
      nextCursorPosition
    };
  }

  public createSession(session: TraceSession): void {
    this.database
      .prepare(`
        INSERT INTO trace_sessions (
          id, repository_id, base_node_id, source_node_id, branch, worktree_path, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.repositoryId,
        session.baseNodeId,
        session.sourceNodeId,
        session.branch,
        session.worktreePath,
        session.startedAt,
        session.status
      );
  }

  public getSession(sessionId: string): TraceSession | null {
    const row = this.database
      .prepare("SELECT * FROM trace_sessions WHERE id = ?")
      .get(sessionId) as TraceSessionRow | undefined;
    return row === undefined ? null : this.toSession(row);
  }

  public findSessionByWorktree(repositoryId: string, worktreePath: string): TraceSession | null {
    const row = this.database
      .prepare("SELECT * FROM trace_sessions WHERE repository_id = ? AND worktree_path = ?")
      .get(repositoryId, worktreePath) as TraceSessionRow | undefined;
    return row === undefined ? null : this.toSession(row);
  }

  public findConversationAttachment(
    sessionId: string,
    provider: string,
    conversationId: string
  ): ConversationAttachment | null {
    const row = this.database
      .prepare(`
        SELECT * FROM conversation_attachments
        WHERE session_id = ? AND provider = ? AND conversation_id = ?
      `)
      .get(sessionId, provider, conversationId) as ConversationAttachmentRow | undefined;
    return row === undefined ? null : this.toConversationAttachment(row);
  }

  public createConversationAttachment(attachment: ConversationAttachment): void {
    this.database
      .prepare(`
        INSERT INTO conversation_attachments (
          id, session_id, provider, conversation_id, retention, attached_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.id,
        attachment.sessionId,
        attachment.provider,
        attachment.conversationId,
        attachment.retention,
        attachment.attachedAt
      );
  }

  public getWorkTraceSummary(nodeId: string): WorkTraceSummaryRecord | null {
    const row = this.database
      .prepare("SELECT * FROM work_trace_summaries WHERE node_id = ?")
      .get(nodeId) as WorkTraceSummaryRow | undefined;
    return row === undefined ? null : this.toWorkTraceSummary(row);
  }

  public findWorkTraceSummaryByOperationId(operationId: string): WorkTraceSummaryRecord | null {
    const row = this.database
      .prepare("SELECT * FROM work_trace_summaries WHERE operation_id = ?")
      .get(operationId) as WorkTraceSummaryRow | undefined;
    return row === undefined ? null : this.toWorkTraceSummary(row);
  }

  public saveWorkTraceSummary(summary: WorkTraceSummaryRecord): void {
    this.database
      .prepare(`
        INSERT INTO work_trace_summaries (
          node_id, repository_id, session_id, commit_oid, conversation_mode,
          operation_id, summary_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          repository_id = excluded.repository_id,
          session_id = excluded.session_id,
          commit_oid = excluded.commit_oid,
          conversation_mode = excluded.conversation_mode,
          operation_id = excluded.operation_id,
          summary_json = excluded.summary_json,
          updated_at = excluded.updated_at
      `)
      .run(
        summary.nodeId,
        summary.repositoryId,
        summary.sessionId,
        summary.commitOid,
        summary.conversationMode,
        summary.operationId,
        JSON.stringify(summary.summary),
        summary.createdAt,
        summary.updatedAt
      );
  }

  public hasConversationForNode(nodeId: string): boolean {
    const row = this.database
      .prepare(`
        SELECT 1
        FROM conversation_attachments AS attachments
        INNER JOIN trace_sessions AS sessions ON sessions.id = attachments.session_id
        WHERE sessions.base_node_id = ?
        LIMIT 1
      `)
      .get(nodeId);
    return row !== undefined;
  }

  public close(): void {
    this.database.close();
  }

  private migrateOperationsTable(): void {
    const schema = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'")
      .get() as SchemaRow | undefined;
    if (schema?.sql?.includes("'attach_conversation'") ?? true) {
      return;
    }

    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      this.database.exec(`
        ALTER TABLE operations RENAME TO operations_legacy;
        CREATE TABLE operations (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL REFERENCES repositories(id),
          operation_type TEXT NOT NULL CHECK(operation_type IN ('checkpoint', 'resume', 'attach_conversation')),
          state TEXT NOT NULL,
          intent_json TEXT,
          result_json TEXT,
          recovery_json TEXT,
          created_at TEXT NOT NULL
        );
         INSERT INTO operations (id, repository_id, operation_type, state, intent_json, result_json, recovery_json, created_at)
           SELECT id, repository_id, operation_type, state, NULL, result_json, NULL, created_at FROM operations_legacy;
        DROP TABLE operations_legacy;
      `);
      this.database.exec("COMMIT;");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  private migrateOperationColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(operations)").all() as unknown as readonly Readonly<{ name: string }>[];
    if (!columns.some((column) => column.name === "intent_json")) {
      this.database.exec("ALTER TABLE operations ADD COLUMN intent_json TEXT;");
    }
    if (!columns.some((column) => column.name === "recovery_json")) {
      this.database.exec("ALTER TABLE operations ADD COLUMN recovery_json TEXT;");
    }
  }

  private migrateTraceSessionsTable(): void {
    const schema = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trace_sessions'")
      .get() as SchemaRow | undefined;
    if (schema?.sql?.includes("'orphaned'") ?? true) {
      return;
    }

    let transactionStarted = false;
    try {
      this.database.exec("PRAGMA foreign_keys = OFF;");
      this.database.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      this.database.exec(`
        ALTER TABLE conversation_attachments RENAME TO conversation_attachments_legacy;
        ALTER TABLE trace_sessions RENAME TO trace_sessions_legacy;
        CREATE TABLE trace_sessions (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL REFERENCES repositories(id),
          base_node_id TEXT NOT NULL REFERENCES trace_nodes(id),
          source_node_id TEXT NOT NULL REFERENCES trace_nodes(id),
          branch TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          started_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'orphaned')),
          UNIQUE(repository_id, worktree_path)
        );
        INSERT INTO trace_sessions (
          id, repository_id, base_node_id, source_node_id, branch, worktree_path, started_at, status
        ) SELECT
          id, repository_id, base_node_id, source_node_id, branch, worktree_path, started_at, status
        FROM trace_sessions_legacy;
        CREATE TABLE conversation_attachments (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES trace_sessions(id),
          provider TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          retention TEXT NOT NULL CHECK(retention IN ('summary')),
          attached_at TEXT NOT NULL,
          UNIQUE(session_id, provider, conversation_id)
        );
        INSERT INTO conversation_attachments (
          id, session_id, provider, conversation_id, retention, attached_at
        ) SELECT
          id, session_id, provider, conversation_id, retention, attached_at
        FROM conversation_attachments_legacy;
        DROP TABLE conversation_attachments_legacy;
        DROP TABLE trace_sessions_legacy;
      `);
      this.database.exec("COMMIT;");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        this.database.exec("ROLLBACK;");
      }
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON;");
    }
  }


  private migrateExistingNodesToRelations(): void {
    this.database.exec(`
      INSERT OR IGNORE INTO trace_node_relations (
        node_id, git_parent_node_id, chronological_parent_node_id, chronology_position
      )
      SELECT
        node.id,
        NULL,
        NULL,
        (
          SELECT COUNT(*)
          FROM trace_nodes AS earlier
          WHERE earlier.repository_id = node.repository_id
            AND (
              earlier.created_at < node.created_at
              OR (earlier.created_at = node.created_at AND earlier.rowid <= node.rowid)
            )
        )
      FROM trace_nodes AS node;
    `);
  }

  private traceNodeSelect(whereClause: string): string {
    return `
      SELECT
        nodes.id,
        nodes.repository_id,
        nodes.commit_oid,
        nodes.node_type,
        nodes.title,
        nodes.created_at,
        relations.git_parent_node_id,
        relations.chronological_parent_node_id,
        relations.chronology_position
      FROM trace_nodes AS nodes
      INNER JOIN trace_node_relations AS relations ON relations.node_id = nodes.id
      ${whereClause}
    `;
  }

  private toRepository(row: RepositoryRow): RegisteredRepository {
    return {
      id: row.id,
      repositoryPath: row.repository_path,
      commonDirectory: row.common_directory,
      fingerprint: row.fingerprint,
      defaultBranch: row.default_branch,
      createdAt: row.created_at
    };
  }

  private toOperation(row: OperationRow): OperationRecord {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      intent: row.intent_json === null ? null : (JSON.parse(row.intent_json) as OperationIntent),
      operationType: row.operation_type,
      state: row.state,
      result: row.result_json === null ? null : (JSON.parse(row.result_json) as OperationResult),
      recovery: row.recovery_json === null ? null : (JSON.parse(row.recovery_json) as OperationRecovery),
      createdAt: row.created_at
    };
  }

  private toNode(row: TraceNodeRow): TraceNode {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      commit: row.commit_oid,
      nodeType: row.node_type,
      title: row.title,
      gitParentNodeId: row.git_parent_node_id,
      chronologicalParentNodeId: row.chronological_parent_node_id,
      createdAt: row.created_at
    };
  }

  private toSession(row: TraceSessionRow): TraceSession {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      baseNodeId: row.base_node_id,
      sourceNodeId: row.source_node_id,
      branch: row.branch,
      worktreePath: row.worktree_path,
      startedAt: row.started_at,
      status: row.status
    };
  }

  private toConversationAttachment(row: ConversationAttachmentRow): ConversationAttachment {
    return {
      id: row.id,
      sessionId: row.session_id,
      provider: row.provider,
      conversationId: row.conversation_id,
      retention: row.retention,
      attachedAt: row.attached_at
    };
  }

  private toWorkTraceSummary(row: WorkTraceSummaryRow): WorkTraceSummaryRecord {
    return {
      nodeId: row.node_id,
      repositoryId: row.repository_id,
      sessionId: row.session_id,
      commitOid: row.commit_oid,
      conversationMode: row.conversation_mode,
      operationId: row.operation_id,
      summary: JSON.parse(row.summary_json) as WorkTraceSummaryRecord["summary"],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
