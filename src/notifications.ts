import { routeToAgent } from "./ateam-conductor.js";
import type { ShepherdConfig } from "./types.js";

export async function sendToAgent(
  config: ShepherdConfig,
  targetAgent: string,
  message: string,
): Promise<void> {
  routeToAgent(config, message);
}

export async function postWebhook(
  url: string,
  text: string,
  channel?: string | null,
): Promise<void> {
  const payload: Record<string, string> = { text };
  if (channel) payload.channel = channel;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Webhook POST failed: ${response.status} ${response.statusText}`,
    );
  }
}

export function formatCIFailureMessage(
  prNumber: number,
  repo: string,
  failedChecks: string[],
): string {
  return [
    `[PR Shepherd] PR #${prNumber} (${repo}) — CI Failed`,
    "",
    "The following checks failed:",
    "",
    ...failedChecks.map((c) => `- ${c}`),
    "",
    "Please investigate and push a fix. I'll monitor CI on the next push.",
  ].join("\n");
}

export function formatReviewMessage(
  prNumber: number,
  repo: string,
  reviewer: string,
  state: string,
  body: string,
): string {
  const action =
    state === "CHANGES_REQUESTED" ? "Changes Requested" : "Review Comment";
  return [
    `[PR Shepherd] PR #${prNumber} (${repo}) — ${action}`,
    "",
    `Reviewer: ${reviewer}`,
    "",
    body,
    "",
    state === "CHANGES_REQUESTED"
      ? "Please address the feedback and push a fix."
      : "FYI — review comment posted.",
  ].join("\n");
}

export function formatMergeMessage(
  prNumber: number,
  repo: string,
): string {
  return [
    `[PR Shepherd] PR #${prNumber} (${repo}) — Merged.`,
    "",
    "This PR has merged. Close out this session: clean up the worktree/branch and mark the work complete.",
  ].join("\n");
}

export function formatMergeQueueEnteredMessage(
  prNumber: number,
  repo: string,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Entered merge queue. No action needed; I'll notify you when it merges.`;
}

export function formatMergeQueueLeftMessage(
  prNumber: number,
  repo: string,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Removed from merge queue without merging. This usually means the queue's CI check failed. Please investigate and push a fix if needed.`;
}

export function formatStaleMessage(
  prNumber: number,
  repo: string,
  hoursStale: number,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) has been awaiting review for ${hoursStale}h. Please follow up on reviews.`;
}

export function formatApprovalMessage(
  prNumber: number,
  repo: string,
  approvals: number,
  autoMerge: boolean,
): string {
  const head = `[PR Shepherd] PR #${prNumber} (${repo}) — Approved (${approvals} approval${approvals !== 1 ? "s" : ""}).`;
  return autoMerge
    ? `${head} Enabling auto-merge.`
    : `🚩 ${head} Ready to merge — auto-merge is disabled, so merge it yourself when you're ready.`;
}
