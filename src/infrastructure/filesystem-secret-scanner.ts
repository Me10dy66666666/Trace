import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { SecretFinding, SecretScanner } from "../domain/secret-scanner.js";

const HIGH_RISK_FILE_NAME = /(^|\/)(?:\.env|id_rsa|credentials(?:\.json)?|.*\.pem)$/i;
const CONTENT_RULES: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  { name: "private_key", pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/ },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "generic_secret_assignment", pattern: /(?:api[_-]?key|access[_-]?token|secret)\s*=\s*[^\s]+/i }
];

export class FilesystemSecretScanner implements SecretScanner {
  public async scan(repositoryPath: string, changedPaths: readonly string[]): Promise<readonly SecretFinding[]> {
    const findings: SecretFinding[] = [];

    for (const changedPath of changedPaths) {
      const normalizedPath = changedPath.replaceAll("\\", "/");
      if (HIGH_RISK_FILE_NAME.test(normalizedPath)) {
        findings.push({ path: changedPath, rule: "high_risk_file_name" });
        continue;
      }

      const absolutePath = resolve(repositoryPath, changedPath);
      const relativePath = relative(repositoryPath, absolutePath);
      if (relativePath.startsWith("..") || relativePath === "") {
        findings.push({ path: changedPath, rule: "path_outside_repository" });
        continue;
      }

      try {
        const content = await readFile(absolutePath, "utf8");
        for (const rule of CONTENT_RULES) {
          if (rule.pattern.test(content)) {
            findings.push({ path: changedPath, rule: rule.name });
          }
        }
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== "ENOENT") {
          findings.push({ path: changedPath, rule: "unreadable_file" });
        }
      }
    }

    return findings;
  }
}
