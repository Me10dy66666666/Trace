export type SecretFinding = Readonly<{
  path: string;
  rule: string;
}>;

export interface SecretScanner {
  scan(repositoryPath: string, changedPaths: readonly string[]): Promise<readonly SecretFinding[]>;
}
