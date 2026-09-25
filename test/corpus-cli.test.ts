import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const { scripts } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8")
) as { scripts: Record<string, string> };

it.each(["verify:corpus", "ingest:corpus"])(
  "%s loads TypeScript on the current supported Node runtime",
  (command) => {
    const [executable, ...args] = scripts[command]!.split(" ");
    expect(executable).toBe("node");
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 5000
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    // No input means no corpus is opened. Reaching argument validation proves
    // the runtime loaded the actual script instead of rejecting its extension.
    expect(result.stderr).toContain('"code":"MISSING_ARGUMENT"');
    expect(result.stdout).toBe("");
  }
);
