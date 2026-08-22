import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const virtualEnvironment = path.join(repositoryRoot, ".venv");
export const virtualEnvironmentPython = path.join(
  virtualEnvironment,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

export function runPython(args, options = {}) {
  if (!existsSync(virtualEnvironmentPython)) {
    console.error("Python environment is missing. Run `npm run setup` first.");
    process.exitCode = 1;
    return undefined;
  }

  return spawn(virtualEnvironmentPython, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    ...options,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = runPython(process.argv.slice(2));
  child?.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
