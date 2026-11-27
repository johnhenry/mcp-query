// Run a tool CLI's `run()` in-process, capturing stderr/stdout and the exit code (the CLIs call process.exit).
import { vi } from "vitest";

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export async function runCli(run: (argv: string[]) => Promise<void>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" "))),
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" "))),
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => (out.push(String(s)), true)) as never),
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Exit(c ?? 0);
    }) as never),
  ];
  try {
    await run(argv);
    return { code: 0, out: out.join("\n"), err: err.join("\n") };
  } catch (e) {
    if (e instanceof Exit) return { code: e.code, out: out.join("\n"), err: err.join("\n") };
    throw e;
  } finally {
    for (const s of spies) s.mockRestore();
  }
}
