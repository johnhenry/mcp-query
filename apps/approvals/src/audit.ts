// Audit helpers — formatting + NDJSON export for the audit timeline.

import type { AuditEntry } from "mcp-query";

/** Serialize audit entries as newline-delimited JSON (one object per line). */
export function toNDJSON(entries: readonly AuditEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

/** Color token (CSS class suffix) for an audit outcome — used for the timeline. */
export function outcomeClass(outcome: AuditEntry["outcome"]): string {
  switch (outcome) {
    case "approved":
    case "auto-allow":
      return "ok";
    case "denied":
    case "auto-deny":
      return "deny";
    case "error":
      return "error";
    default:
      return "";
  }
}

/** Human-friendly label for an outcome. */
export function outcomeLabel(outcome: AuditEntry["outcome"]): string {
  switch (outcome) {
    case "auto-allow":
      return "Auto-allowed";
    case "auto-deny":
      return "Auto-denied";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "error":
      return "Error";
    default:
      return outcome;
  }
}
