import { describe, it, expect } from "vitest";
import { transition, isTerminal, validEvents } from "../src/state-machine.js";
import type { PRState, PREvent } from "../src/types.js";

describe("state-machine", () => {
  describe("transition", () => {
    it("moves OPENED → CI_PENDING on poll_started", () => {
      expect(transition("OPENED", "poll_started")).toBe("CI_PENDING");
    });

    it("moves CI_PENDING → CI_PASSED on ci_passed", () => {
      expect(transition("CI_PENDING", "ci_passed")).toBe("CI_PASSED");
    });

    it("moves CI_PENDING → CI_FAILED on ci_failed", () => {
      expect(transition("CI_PENDING", "ci_failed")).toBe("CI_FAILED");
    });

    it("stays CI_PENDING on ci_pending (checks still running)", () => {
      expect(transition("CI_PENDING", "ci_pending")).toBe("CI_PENDING");
    });

    it("moves CI_PASSED → AWAITING_REVIEW on review_posted", () => {
      expect(transition("CI_PASSED", "review_posted")).toBe("AWAITING_REVIEW");
    });

    it("moves CI_PASSED → APPROVED when all approved before review phase", () => {
      expect(transition("CI_PASSED", "all_approved")).toBe("APPROVED");
    });

    it("moves CI_PASSED → CHANGES_REQUESTED on changes_requested", () => {
      expect(transition("CI_PASSED", "changes_requested")).toBe("CHANGES_REQUESTED");
    });

    it("moves AWAITING_REVIEW → CHANGES_REQUESTED on changes_requested", () => {
      expect(transition("AWAITING_REVIEW", "changes_requested")).toBe(
        "CHANGES_REQUESTED",
      );
    });

    it("moves AWAITING_REVIEW → APPROVED on all_approved", () => {
      expect(transition("AWAITING_REVIEW", "all_approved")).toBe("APPROVED");
    });

    it("stays AWAITING_REVIEW on review_posted (partial review)", () => {
      expect(transition("AWAITING_REVIEW", "review_posted")).toBe(
        "AWAITING_REVIEW",
      );
    });

    it("moves AWAITING_REVIEW → STALE on stale_detected", () => {
      expect(transition("AWAITING_REVIEW", "stale_detected")).toBe("STALE");
    });

    it("moves STALE → AWAITING_REVIEW on review_requested", () => {
      expect(transition("STALE", "review_requested")).toBe("AWAITING_REVIEW");
    });

    it("moves STALE → AWAITING_REVIEW on review_posted", () => {
      expect(transition("STALE", "review_posted")).toBe("AWAITING_REVIEW");
    });

    it("moves STALE → APPROVED on all_approved", () => {
      expect(transition("STALE", "all_approved")).toBe("APPROVED");
    });

    it("moves CHANGES_REQUESTED → CI_PENDING on new_commit", () => {
      expect(transition("CHANGES_REQUESTED", "new_commit")).toBe("CI_PENDING");
    });

    it("moves CI_FAILED → CI_PENDING on new_commit", () => {
      expect(transition("CI_FAILED", "new_commit")).toBe("CI_PENDING");
    });

    it("moves APPROVED → AUTO_MERGE_ENABLED on auto_merge_enabled", () => {
      expect(transition("APPROVED", "auto_merge_enabled")).toBe(
        "AUTO_MERGE_ENABLED",
      );
    });

    it("moves APPROVED → MERGED on merged (fast merge without auto-merge)", () => {
      expect(transition("APPROVED", "merged")).toBe("MERGED");
    });

    it("moves APPROVED → CI_PENDING on new_commit (late push)", () => {
      expect(transition("APPROVED", "new_commit")).toBe("CI_PENDING");
    });

    it("moves AUTO_MERGE_ENABLED → MERGED on merged", () => {
      expect(transition("AUTO_MERGE_ENABLED", "merged")).toBe("MERGED");
    });

    it("moves AUTO_MERGE_ENABLED → CI_PENDING on new_commit", () => {
      expect(transition("AUTO_MERGE_ENABLED", "new_commit")).toBe("CI_PENDING");
    });

    it("moves AUTO_MERGE_ENABLED → CI_FAILED on ci_failed", () => {
      expect(transition("AUTO_MERGE_ENABLED", "ci_failed")).toBe("CI_FAILED");
    });

    it("moves AUTO_MERGE_ENABLED → IN_MERGE_QUEUE on entered_merge_queue", () => {
      expect(transition("AUTO_MERGE_ENABLED", "entered_merge_queue")).toBe(
        "IN_MERGE_QUEUE",
      );
    });

    it("moves IN_MERGE_QUEUE → MERGED on merged", () => {
      expect(transition("IN_MERGE_QUEUE", "merged")).toBe("MERGED");
    });

    it("moves IN_MERGE_QUEUE → AUTO_MERGE_ENABLED on left_queue", () => {
      expect(transition("IN_MERGE_QUEUE", "left_queue")).toBe(
        "AUTO_MERGE_ENABLED",
      );
    });

    it("moves IN_MERGE_QUEUE → CI_PENDING on new_commit", () => {
      expect(transition("IN_MERGE_QUEUE", "new_commit")).toBe("CI_PENDING");
    });
  });

  describe("closed from any non-terminal state", () => {
    const nonTerminalStates: PRState[] = [
      "OPENED",
      "CI_PENDING",
      "CI_PASSED",
      "CI_FAILED",
      "AWAITING_REVIEW",
      "CHANGES_REQUESTED",
      "APPROVED",
      "AUTO_MERGE_ENABLED",
      "IN_MERGE_QUEUE",
      "STALE",
    ];

    for (const state of nonTerminalStates) {
      it(`moves ${state} → CLOSED on closed`, () => {
        expect(transition(state, "closed")).toBe("CLOSED");
      });
    }
  });

  describe("terminal states reject all events", () => {
    const allEvents: PREvent[] = [
      "poll_started",
      "ci_passed",
      "ci_failed",
      "ci_pending",
      "review_posted",
      "changes_requested",
      "all_approved",
      "auto_merge_enabled",
      "entered_merge_queue",
      "left_queue",
      "merged",
      "closed",
      "new_commit",
      "stale_detected",
      "review_requested",
    ];

    for (const event of allEvents) {
      it(`MERGED + ${event} → null`, () => {
        expect(transition("MERGED", event)).toBeNull();
      });
      it(`CLOSED + ${event} → null`, () => {
        expect(transition("CLOSED", event)).toBeNull();
      });
    }
  });

  describe("invalid transitions return null", () => {
    it("OPENED + ci_passed → null", () => {
      expect(transition("OPENED", "ci_passed")).toBeNull();
    });

    it("CI_PENDING + all_approved → null", () => {
      expect(transition("CI_PENDING", "all_approved")).toBeNull();
    });

    it("CI_FAILED + all_approved → null", () => {
      expect(transition("CI_FAILED", "all_approved")).toBeNull();
    });

    it("AWAITING_REVIEW + ci_failed → CI_FAILED (late CI regression)", () => {
      expect(transition("AWAITING_REVIEW", "ci_failed")).toBe("CI_FAILED");
    });
  });

  describe("isTerminal", () => {
    it("MERGED is terminal", () => {
      expect(isTerminal("MERGED")).toBe(true);
    });

    it("CLOSED is terminal", () => {
      expect(isTerminal("CLOSED")).toBe(true);
    });

    it("OPENED is not terminal", () => {
      expect(isTerminal("OPENED")).toBe(false);
    });

    it("CI_PENDING is not terminal", () => {
      expect(isTerminal("CI_PENDING")).toBe(false);
    });
  });

  describe("validEvents", () => {
    it("returns events for OPENED", () => {
      const events = validEvents("OPENED");
      expect(events).toContain("poll_started");
      expect(events).toContain("closed");
    });

    it("returns empty array for terminal states", () => {
      expect(validEvents("MERGED")).toEqual([]);
      expect(validEvents("CLOSED")).toEqual([]);
    });
  });

  describe("full lifecycle — happy path", () => {
    it("OPENED → ... → MERGED", () => {
      let state: PRState = "OPENED";
      const steps: Array<{ event: PREvent; expected: PRState }> = [
        { event: "poll_started", expected: "CI_PENDING" },
        { event: "ci_passed", expected: "CI_PASSED" },
        { event: "review_posted", expected: "AWAITING_REVIEW" },
        { event: "all_approved", expected: "APPROVED" },
        { event: "auto_merge_enabled", expected: "AUTO_MERGE_ENABLED" },
        { event: "merged", expected: "MERGED" },
      ];

      for (const { event, expected } of steps) {
        const next = transition(state, event);
        expect(next).toBe(expected);
        state = next!;
      }
    });
  });

  describe("full lifecycle — merge queue", () => {
    it("handles OPENED → ... → IN_MERGE_QUEUE → MERGED", () => {
      let state: PRState = "OPENED";
      const steps: Array<{ event: PREvent; expected: PRState }> = [
        { event: "poll_started", expected: "CI_PENDING" },
        { event: "ci_passed", expected: "CI_PASSED" },
        { event: "review_posted", expected: "AWAITING_REVIEW" },
        { event: "all_approved", expected: "APPROVED" },
        { event: "auto_merge_enabled", expected: "AUTO_MERGE_ENABLED" },
        { event: "entered_merge_queue", expected: "IN_MERGE_QUEUE" },
        { event: "merged", expected: "MERGED" },
      ];

      for (const { event, expected } of steps) {
        const next = transition(state, event);
        expect(next).toBe(expected);
        state = next!;
      }
    });

    it("handles being dequeued and re-entering the queue", () => {
      let state: PRState = "AUTO_MERGE_ENABLED";
      const steps: Array<{ event: PREvent; expected: PRState }> = [
        { event: "entered_merge_queue", expected: "IN_MERGE_QUEUE" },
        { event: "left_queue", expected: "AUTO_MERGE_ENABLED" },
        { event: "entered_merge_queue", expected: "IN_MERGE_QUEUE" },
        { event: "merged", expected: "MERGED" },
      ];

      for (const { event, expected } of steps) {
        const next = transition(state, event);
        expect(next).toBe(expected);
        state = next!;
      }
    });
  });

  describe("full lifecycle — CI failure + fix loop", () => {
    it("handles CI fail → fix → pass → review → merge", () => {
      let state: PRState = "OPENED";
      const steps: Array<{ event: PREvent; expected: PRState }> = [
        { event: "poll_started", expected: "CI_PENDING" },
        { event: "ci_failed", expected: "CI_FAILED" },
        { event: "new_commit", expected: "CI_PENDING" },
        { event: "ci_passed", expected: "CI_PASSED" },
        { event: "all_approved", expected: "APPROVED" },
        { event: "merged", expected: "MERGED" },
      ];

      for (const { event, expected } of steps) {
        const next = transition(state, event);
        expect(next).toBe(expected);
        state = next!;
      }
    });
  });

  describe("full lifecycle — changes requested loop", () => {
    it("handles review changes → fix → re-review → merge", () => {
      let state: PRState = "OPENED";
      const steps: Array<{ event: PREvent; expected: PRState }> = [
        { event: "poll_started", expected: "CI_PENDING" },
        { event: "ci_passed", expected: "CI_PASSED" },
        { event: "changes_requested", expected: "CHANGES_REQUESTED" },
        { event: "new_commit", expected: "CI_PENDING" },
        { event: "ci_passed", expected: "CI_PASSED" },
        { event: "all_approved", expected: "APPROVED" },
        { event: "auto_merge_enabled", expected: "AUTO_MERGE_ENABLED" },
        { event: "merged", expected: "MERGED" },
      ];

      for (const { event, expected } of steps) {
        const next = transition(state, event);
        expect(next).toBe(expected);
        state = next!;
      }
    });
  });
});
