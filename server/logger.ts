export interface Logger {
  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
  ): void;
  error(event: string, error: unknown, data?: Record<string, unknown>): void;
}

// Native payloads and error messages may contain credentials or prompts. Never log them.
export const logger: Logger = {
  log(level, event) {
    if (level !== "debug") console.error(`[zcode:${level}] ${event}`);
  },
  error(event, error) {
    console.error(`[zcode:error] ${event}\n${formatDiagnostic(error)}`);
  },
};
import { formatDiagnostic } from "./diagnostics.js";
