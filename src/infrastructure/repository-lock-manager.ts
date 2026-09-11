import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { TraceError } from "../domain/errors.js";
import type { RegisteredRepository } from "../domain/types.js";

type RepositoryLockTarget = Pick<RegisteredRepository, "id" | "commonDirectory">;

type LockRecord = Readonly<{
  ownerId: string;
  repositoryId: string;
  pid: number;
  createdAt: string;
}>;

export type RepositoryLock = Readonly<{
  release(): Promise<void>;
}>;

export class RepositoryLockManager {
  private readonly heldRepositoryIds = new Set<string>();

  public async acquire(repository: RepositoryLockTarget): Promise<RepositoryLock> {
    if (this.heldRepositoryIds.has(repository.id)) {
      throw this.lockedError(repository.id);
    }

    const lockPath = join(repository.commonDirectory, "traceandback.lock");
    const ownerId = randomUUID();
    const record: LockRecord = {
      ownerId,
      repositoryId: repository.id,
      pid: process.pid,
      createdAt: new Date().toISOString()
    };
    let createdLockFile = false;
    let handle: Awaited<ReturnType<typeof open>> | null = null;

    try {
      handle = await open(lockPath, "wx");
      createdLockFile = true;
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      if (createdLockFile) {
        await unlink(lockPath).catch(() => undefined);
      }
      if (this.errorCode(error) === "EEXIST") {
        throw this.lockedError(repository.id);
      }
      throw new TraceError(
        "DATABASE_ERROR",
        "TraceAndBack could not acquire the repository lock.",
        true,
        { repositoryId: repository.id }
      );
    }

    this.heldRepositoryIds.add(repository.id);
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        this.heldRepositoryIds.delete(repository.id);
        await this.releaseOwnedLock(lockPath, ownerId, repository.id);
      }
    };
  }

  private async releaseOwnedLock(lockPath: string, ownerId: string, repositoryId: string): Promise<void> {
    try {
      const content = await readFile(lockPath, "utf8");
      const record = JSON.parse(content) as Partial<LockRecord>;
      if (record.ownerId !== ownerId) {
        return;
      }
      await unlink(lockPath);
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") {
        return;
      }
      throw new TraceError(
        "DATABASE_ERROR",
        "TraceAndBack could not release the repository lock.",
        true,
        { repositoryId }
      );
    }
  }

  private lockedError(repositoryId: string): TraceError {
    return new TraceError(
      "REPO_LOCKED",
      `A mutating operation is already running for repository ${repositoryId}.`,
      true,
      { repositoryId }
    );
  }

  private errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return undefined;
    }
    const code = (error as Readonly<{ code?: unknown }>).code;
    return typeof code === "string" ? code : undefined;
  }
}
