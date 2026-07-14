import { describe, it, expect } from "vitest";
import { findNewReplies } from "../src/reply-watch.js";
import type { ReviewThreadComment } from "../src/github.js";

function comment(overrides: Partial<ReviewThreadComment>): ReviewThreadComment {
  return {
    id: 1,
    inReplyToId: null,
    author: "someone",
    body: "a comment",
    createdAt: "2026-07-14T10:00:00Z",
    path: "src/foo.ts",
    ...overrides,
  };
}

describe("findNewReplies", () => {
  it("detects a reply to a thread we rooted", () => {
    const comments = [
      comment({ id: 100, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 101, inReplyToId: 100, author: "alice", body: "I disagree", createdAt: "2026-07-14T11:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({
      rootId: 100,
      path: "src/foo.ts",
      author: "alice",
      body: "I disagree",
      createdAt: "2026-07-14T11:00:00Z",
    });
  });

  it("detects a reply in a thread we joined mid-way (root not ours)", () => {
    const comments = [
      comment({ id: 200, author: "alice", createdAt: "2026-07-14T09:00:00Z" }),
      comment({ id: 201, inReplyToId: 200, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 202, inReplyToId: 200, author: "alice", body: "responding to you", createdAt: "2026-07-14T11:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies).toHaveLength(1);
    expect(replies[0].rootId).toBe(200);
    expect(replies[0].body).toBe("responding to you");
  });

  it("ignores threads we never participated in", () => {
    const comments = [
      comment({ id: 300, author: "alice", createdAt: "2026-07-14T09:00:00Z" }),
      comment({ id: 301, inReplyToId: 300, author: "bob", createdAt: "2026-07-14T10:00:00Z" }),
    ];
    expect(findNewReplies(comments, "shepherd", null)).toHaveLength(0);
  });

  it("ignores our own comments (loop guard) and matches identity case-insensitively", () => {
    const comments = [
      comment({ id: 400, author: "Shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 401, inReplyToId: 400, author: "alice", createdAt: "2026-07-14T11:00:00Z" }),
      comment({ id: 402, inReplyToId: 400, author: "SHEPHERD", body: "our in-thread response", createdAt: "2026-07-14T12:00:00Z" }),
    ];
    // Our 12:00 response is the latest OUR comment; alice's 11:00 reply is
    // before it, so nothing is pending.
    expect(findNewReplies(comments, "shepherd", null)).toHaveLength(0);
  });

  it("ignores replies older than our last comment in the thread", () => {
    const comments = [
      comment({ id: 500, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 501, inReplyToId: 500, author: "alice", createdAt: "2026-07-14T11:00:00Z" }),
      comment({ id: 502, inReplyToId: 500, author: "shepherd", createdAt: "2026-07-14T12:00:00Z" }),
      comment({ id: 503, inReplyToId: 500, author: "alice", body: "round two", createdAt: "2026-07-14T13:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe("round two");
  });

  it("excludes replies at or before the cursor", () => {
    const comments = [
      comment({ id: 600, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 601, inReplyToId: 600, author: "alice", createdAt: "2026-07-14T11:00:00Z" }),
      comment({ id: 602, inReplyToId: 600, author: "alice", body: "newer", createdAt: "2026-07-14T12:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", "2026-07-14T11:00:00Z");
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe("newer");
  });

  it("returns replies across threads sorted oldest-first", () => {
    const comments = [
      comment({ id: 700, author: "shepherd", createdAt: "2026-07-14T09:00:00Z" }),
      comment({ id: 800, author: "shepherd", createdAt: "2026-07-14T09:00:00Z", path: "src/bar.ts" }),
      comment({ id: 801, inReplyToId: 800, author: "bob", body: "second", createdAt: "2026-07-14T12:00:00Z" }),
      comment({ id: 701, inReplyToId: 700, author: "alice", body: "first", createdAt: "2026-07-14T11:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies.map((r) => r.body)).toEqual(["first", "second"]);
  });
});
