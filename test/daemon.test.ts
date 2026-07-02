import { describe, it, expect } from "vitest";
import { filterAuthoredPRs } from "../src/daemon.js";

function makePR(nameWithOwner: string, isDraft = false, number = 1) {
  return {
    number,
    repository: { name: nameWithOwner.split("/")[1], nameWithOwner },
    title: "test PR",
    url: `https://github.com/${nameWithOwner}/pull/${number}`,
    isDraft,
    updatedAt: new Date().toISOString(),
  };
}

describe("filterAuthoredPRs", () => {
  it("keeps PRs from non-ignored repos", () => {
    const prs = [makePR("erlloyd/agent-teams", false, 1)];
    const result = filterAuthoredPRs(prs, ["erlloyd/cardtable2"]);
    expect(result).toHaveLength(1);
    expect(result[0].repository.nameWithOwner).toBe("erlloyd/agent-teams");
  });

  it("drops PRs from ignored repos", () => {
    const prs = [
      makePR("erlloyd/cardtable2", false, 5),
      makePR("erlloyd/vscode-remote-demo1", false, 6),
      makePR("erlloyd/agent-teams", false, 7),
    ];
    const result = filterAuthoredPRs(prs, [
      "erlloyd/cardtable2",
      "erlloyd/vscode-remote-demo1",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].repository.nameWithOwner).toBe("erlloyd/agent-teams");
  });

  it("drops draft PRs regardless of ignoreRepos", () => {
    const prs = [
      makePR("erlloyd/agent-teams", true, 10),
      makePR("erlloyd/agent-teams", false, 11),
    ];
    const result = filterAuthoredPRs(prs, []);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(11);
  });

  it("passes all PRs through when ignoreRepos is empty", () => {
    const prs = [
      makePR("erlloyd/cardtable2", false, 1),
      makePR("erlloyd/agent-teams", false, 2),
    ];
    const result = filterAuthoredPRs(prs, []);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when all PRs are ignored", () => {
    const prs = [
      makePR("erlloyd/cardtable2", false, 1),
      makePR("erlloyd/vscode-remote-demo1", false, 2),
    ];
    const result = filterAuthoredPRs(prs, [
      "erlloyd/cardtable2",
      "erlloyd/vscode-remote-demo1",
    ]);
    expect(result).toHaveLength(0);
  });
});
