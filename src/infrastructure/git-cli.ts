import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { TraceError } from "../domain/errors.js";
import type {
  CreateGitBranchInput,
  CreateGitCheckpointInput,
  CreateGitWorktreeInput,
  FindGitBranchForResumeInput,
  LocatedGitCheckpoint,
  FindGitWorktreeForResumeInput,
  GitCommitSummary,
  GitAdapter,
  WorktreeEnvironment
} from "../domain/git-adapter.js";
import type { ChangedFile } from "../domain/node-detail.js";
import type { GitOperationState, RepositoryInspection } from "../domain/types.js";

const execFile = promisify(execFileCallback);

type GitCommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

type GitOperationPaths = Readonly<{
  mergeHead: string;
  rebaseApply: string;
  rebaseMerge: string;
  cherryPickHead: string;
  bisectLog: string;
}>;

export class GitCli implements GitAdapter {
  public async inspectRepository(repositoryPath: string): Promise<RepositoryInspection> {
    const canonicalPath = await this.resolveRepositoryPath(repositoryPath);
    const insideWorkTree = (await this.run(canonicalPath, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();

    if (insideWorkTree !== "true") {
      throw new TraceError(
        "NOT_A_GIT_REPOSITORY",
        `Path is not a Git work tree: ${canonicalPath}`,
        false,
        { repositoryPath: canonicalPath }
      );
    }

    const [commonDirectory, head, branch, statusOutput, operationPaths] = await Promise.all([
      this.absoluteGitPath(canonicalPath, "--git-common-dir"),
      this.optionalRun(canonicalPath, ["rev-parse", "--verify", "HEAD"]),
      this.currentBranch(canonicalPath),
      this.run(canonicalPath, ["status", "--porcelain=v2", "-z", "--branch", "--ignored=matching"]),
      this.gitOperationPaths(canonicalPath)
    ]);
    const status = this.parseStatus(statusOutput.stdout);
    const operationState = await this.detectOperationState(operationPaths, branch?.trim() || null);
    const fingerprint = createHash("sha256")
      .update(commonDirectory)
      .digest("hex");

    return {
      repositoryPath: canonicalPath,
      commonDirectory,
      fingerprint,
      head: head?.trim() || null,
      branch,
      dirty: status.dirty,
      untrackedCount: status.untrackedCount,
      operationState
    };
  }

  public async listVisibleChanges(repositoryPath: string): Promise<readonly string[]> {
    const [unstaged, staged, untracked] = await Promise.all([
      this.run(repositoryPath, ["diff", "--name-only", "-z"]),
      this.run(repositoryPath, ["diff", "--cached", "--name-only", "-z"]),
      this.run(repositoryPath, ["ls-files", "--others", "--exclude-standard", "-z"])
    ]);
    const paths = new Set<string>();

    for (const output of [unstaged.stdout, staged.stdout, untracked.stdout]) {
      for (const path of output.split("\u0000")) {
        if (path !== "") {
          paths.add(path);
        }
      }
    }
    return [...paths];
  }

  public async listCommits(repositoryPath: string, limit: number): Promise<readonly GitCommitSummary[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result = await this.run(repositoryPath, [
      "log",
      "--first-parent",
      `--max-count=${safeLimit}`,
      "--format=%H%x00%P%x00%cI%x00%s%x1e"
    ]);

    return result.stdout
      .split("\x1e")
      .map((record) => record.trim())
      .filter((record) => record !== "")
      .map((record) => {
        const [commit, parents, createdAt, title] = record.split("\x00");
        if (commit === undefined || parents === undefined || createdAt === undefined || title === undefined) {
          throw new Error("Git returned malformed commit history output.");
        }
        return {
          commit,
          parentCommit: parents.split(" ")[0] || null,
          title,
          createdAt
        };
      });
  }

  public async getPublishedCommit(repositoryPath: string): Promise<string | null> {
    const branch = await this.optionalRun(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const upstream = branch?.trim()
      ? await this.optionalRun(repositoryPath, ["rev-parse", "--abbrev-ref", `${branch.trim()}@{upstream}`])
      : null;

    if (upstream?.trim()) {
      const upstreamRef = upstream.trim();
      const separator = upstreamRef.indexOf("/");
      const remote = separator > 0 ? upstreamRef.slice(0, separator) : null;
      const remoteBranch = remote ? upstreamRef.slice(separator + 1) : null;
      if (remote && remoteBranch) {
        const remoteRef = `refs/heads/${remoteBranch}`;
        const result = await this.optionalRun(repositoryPath, ["ls-remote", remote, remoteRef]);
        const commit = (result ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .find(([objectId, ref]) => ref === remoteRef && /^[0-9a-f]{40,64}$/i.test(objectId ?? ""))?.[0];
        if (commit !== undefined) return commit;

        const localUpstream = await this.optionalRun(repositoryPath, ["rev-parse", "--verify", upstreamRef]);
        if (localUpstream?.trim()) return localUpstream.trim();
      }
    }

    const remoteOutput = await this.optionalRun(repositoryPath, ["remote"]);
    const remotes = (remoteOutput ?? "")
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter((remote) => remote !== "")
      .sort((left, right) => (left === "origin" ? -1 : right === "origin" ? 1 : 0));
    for (const remote of remotes) {
      const result = await this.optionalRun(repositoryPath, ["ls-remote", "--symref", remote, "HEAD"]);
      const commit = (result ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .find(([objectId, ref]) => ref === "HEAD" && /^[0-9a-f]{40,64}$/i.test(objectId ?? ""))?.[0];
      if (commit !== undefined) return commit;
    }

    const localHeadRef = await this.optionalRun(repositoryPath, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD"
    ]);
    if (localHeadRef?.trim()) {
      const localHead = await this.optionalRun(repositoryPath, ["rev-parse", "--verify", localHeadRef.trim()]);
      if (localHead?.trim()) return localHead.trim();
    }

    if (branch?.trim()) {
      if (upstream?.trim() && upstream.trim() !== "HEAD") {
        const upstreamCommit = await this.optionalRun(repositoryPath, ["rev-parse", "--verify", upstream.trim()]);
        if (upstreamCommit?.trim()) return upstreamCommit.trim();
      }
    }

    return null;
  }

  public async createCheckpoint(input: CreateGitCheckpointInput): Promise<string> {
    const message = [
      `trace: checkpoint ${input.reason}`,
      "",
      `TraceAndBack-Operation: ${input.operationId}`
    ].join("\n");

    try {
      await this.run(input.repositoryPath, ["add", "-A"]);
      await this.run(input.repositoryPath, ["commit", "-m", message]);
      const commit = await this.run(input.repositoryPath, ["rev-parse", "--verify", "HEAD"]);
      return commit.stdout.trim();
    } catch (error) {
      throw new TraceError(
        "CHECKPOINT_FAILED",
        "Git could not create a checkpoint commit.",
        true,
        {
          cause: error instanceof Error ? error.message : String(error),
          operationId: input.operationId,
          repositoryPath: input.repositoryPath
        }
      );
    }
  }

  public async findCheckpointByOperationId(
    repositoryPath: string,
    operationId: string
  ): Promise<LocatedGitCheckpoint | null> {
    const candidates = await this.run(repositoryPath, [
      "log",
      "--all",
      "HEAD",
      "--format=%H",
      "--fixed-strings",
      `--grep=TraceAndBack-Operation: ${operationId}`
    ]);

    for (const candidate of candidates.stdout.split(/\r?\n/)) {
      if (candidate === "") {
        continue;
      }
      const message = await this.run(repositoryPath, ["show", "-s", "--format=%B", candidate]);
      const trailers = message.stdout.replace(/\r\n/g, "\n").split("\n");
      if (!trailers.includes(`TraceAndBack-Operation: ${operationId}`)) {
        continue;
      }
      const ancestry = await this.run(repositoryPath, ["rev-list", "--parents", "-n", "1", candidate]);
      const [, parentCommit = null] = ancestry.stdout.trim().split(/\s+/);
      return { commit: candidate, parentCommit };
    }

    return null;
  }

  public async verifyCommit(repositoryPath: string, commit: string): Promise<void> {
    try {
      await this.run(repositoryPath, ["cat-file", "-e", `${commit}^{commit}`]);
    } catch (error) {
      throw new TraceError(
        "VERIFY_FAILED",
        "Git did not verify the requested commit.",
        true,
        {
          cause: error instanceof Error ? error.message : String(error),
          commit,
          repositoryPath
        }
      );
    }
  }

  public async getCommitChangedFiles(repositoryPath: string, commit: string): Promise<readonly ChangedFile[]> {
    try {
      const output = await this.run(repositoryPath, [
        "diff-tree",
        "--no-commit-id",
        "--numstat",
        "-r",
        "--root",
        "--no-renames",
        commit
      ]);
      return this.parseNumstat(output.stdout);
    } catch (error) {
      throw new TraceError(
        "VERIFY_FAILED",
        "Git could not read the requested commit's changed-file statistics.",
        true,
        {
          cause: error instanceof Error ? error.message : String(error),
          commit,
          repositoryPath
        }
      );
    }
  }

  public async compareCommits(
    repositoryPath: string,
    fromCommit: string,
    toCommit: string
  ): Promise<readonly ChangedFile[]> {
    try {
      const output = await this.run(repositoryPath, [
        "diff",
        "--numstat",
        "--no-renames",
        fromCommit,
        toCommit
      ]);
      return this.parseNumstat(output.stdout);
    } catch (error) {
      throw new TraceError(
        "VERIFY_FAILED",
        "Git could not compare the requested commits.",
        true,
        {
          cause: error instanceof Error ? error.message : String(error),
          fromCommit,
          repositoryPath,
          toCommit
        }
      );
    }
  }

  public async createWorktree(input: CreateGitWorktreeInput): Promise<WorktreeEnvironment> {
    const worktreePath = this.resolveWorktreePath(input.repositoryPath, input.worktreeName);

    try {
      await mkdir(resolve(input.repositoryPath, "..", ".traceandback-worktrees"), { recursive: true });
      await this.run(input.repositoryPath, ["check-ref-format", "--branch", input.branchName]);
      await this.run(input.repositoryPath, ["worktree", "add", "-b", input.branchName, worktreePath, input.targetCommit]);
      return { branch: input.branchName, worktreePath };
    } catch (error) {
      if (error instanceof TraceError && error.code === "WORKTREE_CREATE_FAILED") {
        throw error;
      }
      throw new TraceError(
        "WORKTREE_CREATE_FAILED",
        "Git could not create the requested worktree.",
        true,
        {
          branchName: input.branchName,
          cause: error instanceof Error ? error.message : String(error),
          repositoryPath: input.repositoryPath,
          targetCommit: input.targetCommit,
          worktreePath
        }
      );
    }
  }

  public async createBranchAndCheckout(input: CreateGitBranchInput): Promise<WorktreeEnvironment> {
    try {
      await this.run(input.repositoryPath, ["check-ref-format", "--branch", input.branchName]);
      await this.run(input.repositoryPath, ["switch", "--create", input.branchName, input.targetCommit]);
      return { branch: input.branchName, worktreePath: input.repositoryPath };
    } catch (error) {
      throw new TraceError(
        "BRANCH_CREATE_FAILED",
        "Git could not create and checkout the requested branch in the current worktree.",
        true,
        {
          branchName: input.branchName,
          cause: error instanceof Error ? error.message : String(error),
          repositoryPath: input.repositoryPath,
          targetCommit: input.targetCommit
        }
      );
    }
  }

  public async findBranchCheckoutForResume(
    input: FindGitBranchForResumeInput
  ): Promise<WorktreeEnvironment | null> {
    const inspection = await this.inspectRepository(input.repositoryPath);
    return inspection.branch === input.branchName
      ? { branch: input.branchName, worktreePath: inspection.repositoryPath }
      : null;
  }

  public async findWorktreeForResume(
    input: FindGitWorktreeForResumeInput
  ): Promise<WorktreeEnvironment | null> {
    const expectedWorktreePath = this.resolveWorktreePath(input.repositoryPath, input.worktreeName);
    const expectedBranch = `refs/heads/${input.branchName}`;
    const listed = await this.run(input.repositoryPath, ["worktree", "list", "--porcelain"]);

    for (const record of listed.stdout.split(/\r?\n\r?\n/)) {
      const lines = record.split(/\r?\n/);
      const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      if (
        worktreePath !== undefined &&
        branch === expectedBranch &&
        this.pathsMatch(worktreePath, expectedWorktreePath)
      ) {
        return { branch: input.branchName, worktreePath: expectedWorktreePath };
      }
    }

    return null;
  }

  public async verifyWorktreeHead(worktreePath: string, targetCommit: string): Promise<void> {
    try {
      const head = (await this.run(worktreePath, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
      if (head !== targetCommit) {
        throw new TraceError(
          "VERIFY_FAILED",
          "The new worktree does not point to the requested commit.",
          true,
          { actualHead: head, targetCommit, worktreePath }
        );
      }
    } catch (error) {
      if (error instanceof TraceError && error.code === "VERIFY_FAILED") {
        throw error;
      }
      throw new TraceError(
        "VERIFY_FAILED",
        "Git did not verify the new worktree HEAD.",
        true,
        {
          cause: error instanceof Error ? error.message : String(error),
          targetCommit,
          worktreePath
        }
      );
    }
  }

  private pathsMatch(left: string, right: string): boolean {
    const normalizePath = (value: string): string => {
      const resolved = resolve(value).replaceAll("\\", "/");
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return normalizePath(left) === normalizePath(right);
  }


  private resolveWorktreePath(repositoryPath: string, worktreeName: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(worktreeName)) {
      throw new TraceError(
        "WORKTREE_CREATE_FAILED",
        "The generated worktree name is not safe.",
        false,
        { worktreeName }
      );
    }

    const worktreeRoot = resolve(repositoryPath, "..", ".traceandback-worktrees");
    const worktreePath = resolve(worktreeRoot, worktreeName);
    const childPath = relative(worktreeRoot, worktreePath);
    if (childPath === "" || childPath === ".." || childPath.startsWith("..\\") || childPath.startsWith("../") || isAbsolute(childPath)) {
      throw new TraceError(
        "WORKTREE_CREATE_FAILED",
        "The generated worktree path must remain inside the TraceAndBack worktree directory.",
        false,
        { worktreeName, worktreeRoot }
      );
    }
    return worktreePath;
  }

  private async resolveRepositoryPath(repositoryPath: string): Promise<string> {
    try {
      return await realpath(repositoryPath);
    } catch (error) {
      throw new TraceError(
        "REPOSITORY_NOT_FOUND",
        `Repository path does not exist: ${repositoryPath}`,
        false,
        { cause: error instanceof Error ? error.message : String(error), repositoryPath }
      );
    }
  }

  private async currentBranch(repositoryPath: string): Promise<string | null> {
    const branch = await this.optionalRun(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return branch?.trim() || null;
  }

  private async detectOperationState(paths: GitOperationPaths, branch: string | null): Promise<GitOperationState> {
    const [mergeHead, rebaseApply, rebaseMerge, cherryPickHead, bisectLog] = await Promise.all([
      this.pathExists(paths.mergeHead),
      this.pathExists(paths.rebaseApply),
      this.pathExists(paths.rebaseMerge),
      this.pathExists(paths.cherryPickHead),
      this.pathExists(paths.bisectLog)
    ]);
    if (mergeHead) {
      return "merge";
    }
    if (rebaseApply || rebaseMerge) {
      return "rebase";
    }
    if (cherryPickHead) {
      return "cherry_pick";
    }
    if (bisectLog) {
      return "bisect";
    }
    return branch === null ? "detached" : "normal";
  }

  private async gitOperationPaths(repositoryPath: string): Promise<GitOperationPaths> {
    const result = await this.run(repositoryPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "MERGE_HEAD",
      "--git-path",
      "rebase-apply",
      "--git-path",
      "rebase-merge",
      "--git-path",
      "CHERRY_PICK_HEAD",
      "--git-path",
      "BISECT_LOG"
    ]);
    const paths = result.stdout.trim().split(/\r?\n/);
    if (paths.length !== 5 || paths.some((path) => path.length === 0)) {
      throw new Error("Git returned malformed operation paths.");
    }
    return {
      mergeHead: paths[0] as string,
      rebaseApply: paths[1] as string,
      rebaseMerge: paths[2] as string,
      cherryPickHead: paths[3] as string,
      bisectLog: paths[4] as string
    };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async absoluteGitPath(repositoryPath: string, ...args: string[]): Promise<string> {
    const result = await this.run(repositoryPath, ["rev-parse", "--path-format=absolute", ...args]);
    return resolve(repositoryPath, result.stdout.trim());
  }

  private parseNumstat(output: string): readonly ChangedFile[] {
    const changedFiles: ChangedFile[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (line === "") {
        continue;
      }
      const [additionsText, deletionsText, ...pathParts] = line.split("\t");
      if (additionsText === undefined || deletionsText === undefined || pathParts.length === 0) {
        throw new Error("Git returned malformed numstat output.");
      }
      changedFiles.push({
        path: pathParts.join("\t"),
        additions: this.parseNumstatCount(additionsText),
        deletions: this.parseNumstatCount(deletionsText)
      });
    }
    return changedFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  private parseNumstatCount(value: string): number {
    if (value === "-") {
      return 0;
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Git returned an invalid numstat count.");
    }
    return count;
  }

  private parseStatus(output: string): Readonly<{ dirty: boolean; untrackedCount: number }> {
    let dirty = false;
    let untrackedCount = 0;

    for (const record of output.split("\u0000")) {
      if (record === "" || record.startsWith("# ") || record.startsWith("! ")) {
        continue;
      }
      if (record.startsWith("? ")) {
        dirty = true;
        untrackedCount += 1;
        continue;
      }
      dirty = true;
    }

    return { dirty, untrackedCount };
  }

  private async optionalRun(repositoryPath: string, args: readonly string[]): Promise<string | null> {
    try {
      return (await this.run(repositoryPath, args)).stdout;
    } catch (error) {
      if (error instanceof TraceError && (error.details.exitCode === 1 || error.details.exitCode === 128)) {
        return null;
      }
      throw error;
    }
  }

  private async run(repositoryPath: string, args: readonly string[]): Promise<GitCommandResult> {
    try {
      const result = await execFile("git", ["-C", repositoryPath, ...args], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      });
      return { stderr: result.stderr, stdout: result.stdout };
    } catch (error) {
      const commandError = error as NodeJS.ErrnoException & {
        code?: string | number;
        stderr?: string;
        stdout?: string;
      };
      throw new TraceError(
        "NOT_A_GIT_REPOSITORY",
        commandError.stderr?.trim() || commandError.message,
        false,
        {
          args,
          exitCode: commandError.code,
          repositoryPath,
          stdout: commandError.stdout?.trim()
        }
      );
    }
  }
}
