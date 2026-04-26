import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { policyFileSchema } from "./schema";
import type { PolicyFile, PolicyRule } from "./types";

export type PolicyEngine = {
  rules: PolicyRule[];
  sourceFiles: string[];
};

export function loadPolicyEngine(rulesDir: string): PolicyEngine {
  if (!fs.existsSync(rulesDir)) {
    return { rules: [], sourceFiles: [] };
  }

  const candidates = fs
    .readdirSync(rulesDir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .sort();

  const rules: PolicyRule[] = [];
  const sourceFiles: string[] = [];

  for (const fileName of candidates) {
    const fullPath = path.join(rulesDir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const parsedYaml = yaml.load(raw);

    const parsedPolicy = policyFileSchema.safeParse(parsedYaml);
    if (!parsedPolicy.success) {
      throw new Error(
        `Invalid policy file ${fileName}: ${JSON.stringify(parsedPolicy.error.flatten().fieldErrors)}`
      );
    }

    const policyFile = parsedPolicy.data as PolicyFile;
    rules.push(...policyFile.rules);
    sourceFiles.push(fileName);
  }

  return { rules, sourceFiles };
}
