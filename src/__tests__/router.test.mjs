import assert from "node:assert/strict";
import test from "node:test";
import { matchProjectDeterministically, routeIssue } from "../router.mjs";

const PROJECTS_CONFIG = {
  defaultRemoteProject: "default-remote-id",
  defaultMode: "accept-edits",
  projects: [
    {
      key: "backend-app",
      name: "Backend App",
      description: "Core backend API platform",
      remoteProject: "remote-backend",
      linear: {
        projectIds: ["proj-backend-id"],
        projectSlugs: ["slug-backend-01"],
        projectNames: ["backend-app", "Backend App"],
        teamKeys: ["ENG"],
        labels: ["backend-only"],
      },
      extraInstructions: "",
    },
    {
      key: "game-client",
      name: "Game Client",
      description: "Godot game client",
      remoteProject: "remote-game",
      linear: {
        projectIds: ["proj-game-id"],
        projectSlugs: ["slug-game-02"],
        projectNames: ["Game Client"],
        teamKeys: [],
        labels: [],
      },
      extraInstructions: "",
    },
  ],
};

test("matchProjectDeterministically matches by id, slug, name, label, and unambiguous team", () => {
  assert.equal(
    matchProjectDeterministically(
      { project: { id: "proj-backend-id", name: "Other" }, team: { key: "OPS" } },
      PROJECTS_CONFIG
    )?.project.key,
    "backend-app"
  );

  assert.equal(
    matchProjectDeterministically(
      { project: { slugId: "slug-game-02" } },
      PROJECTS_CONFIG
    )?.project.key,
    "game-client"
  );

  assert.equal(
    matchProjectDeterministically(
      { project: { name: "BACKEND APP" } },
      PROJECTS_CONFIG
    )?.project.key,
    "backend-app"
  );

  assert.equal(
    matchProjectDeterministically(
      { labels: { nodes: [{ name: "Backend-Only" }] } },
      PROJECTS_CONFIG
    )?.project.key,
    "backend-app"
  );

  assert.equal(
    matchProjectDeterministically({ team: { key: "ENG" } }, PROJECTS_CONFIG)?.project.key,
    "backend-app"
  );

  // Does not misroute when issue already belongs to an unconfigured Linear project
  assert.equal(
    matchProjectDeterministically(
      { project: { id: "other-proj", name: "Support Portal" }, team: { key: "ENG" } },
      PROJECTS_CONFIG
    ),
    null
  );
});

test("routeIssue falls back to stateless agy LLM router in hybrid mode for dispatch & elicit", async () => {
  let capturedArgs = null;
  const dispatchDecision = await routeIssue({
    issueContext: {
      identifier: "OPS-99",
      title: "Fix player hitbox frame check",
      team: { key: "OPS" },
    },
    projectsConfig: PROJECTS_CONFIG,
    routerConfig: { mode: "hybrid", model: "gemini-3.8-flash-medium" },
    execFileImpl: async (_bin, args) => {
      capturedArgs = args;
      return {
        stdout: JSON.stringify({
          status: "SUCCESS",
          structured_output: {
            action: "dispatch",
            projectKey: "game-client",
            clarifyingQuestion: null,
            reason: "Matches Game Client Godot project",
          },
        }),
      };
    },
  });

  assert.equal(dispatchDecision.action, "dispatch");
  assert.equal(dispatchDecision.project.key, "game-client");
  assert.equal(dispatchDecision.remoteProject, "remote-game");
  assert.equal(dispatchDecision.matchedBy, "llm");
  assert.ok(capturedArgs.includes("--json-schema"));
  assert.ok(capturedArgs.includes("--disable-slash-commands"));

  const elicitDecision = await routeIssue({
    issueContext: { identifier: "OPS-100", title: "Please check this error" },
    projectsConfig: PROJECTS_CONFIG,
    routerConfig: { mode: "hybrid", model: "gemini-3.8-flash-medium" },
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        status: "SUCCESS",
        structured_output: {
          action: "elicit",
          projectKey: null,
          clarifyingQuestion: "Does this error belong to Backend App or Game Client?",
          reason: "Insufficient context",
        },
      }),
    }),
  });

  assert.equal(elicitDecision.action, "elicit");
  assert.match(elicitDecision.clarifyingQuestion, /Backend App/);
});

test("routeIssue handles rules mode and invalid router output safely", async () => {
  const rulesDecision = await routeIssue({
    issueContext: { identifier: "OPS-101", title: "Misc task" },
    projectsConfig: PROJECTS_CONFIG,
    routerConfig: { mode: "rules" },
  });
  assert.equal(rulesDecision.action, "dispatch");
  assert.equal(rulesDecision.remoteProject, "default-remote-id");
  assert.equal(rulesDecision.matchedBy, "defaultRule");

  const noDefaultNoMatch = await routeIssue({
    issueContext: { identifier: "OPS-102", title: "Unclear" },
    projectsConfig: { ...PROJECTS_CONFIG, defaultRemoteProject: "" },
    routerConfig: { mode: "hybrid" },
    execFileImpl: async () => {
      throw new Error("agy binary missing");
    },
  });
  assert.equal(noDefaultNoMatch.action, "elicit");
  assert.match(noDefaultNoMatch.clarifyingQuestion, /Backend App \/ Game Client/);

  const rulesNoDefaultNoMatch = await routeIssue({
    issueContext: {
      identifier: "OPS-103",
      title: "Unmapped Linear project issue",
      project: { id: "unmapped-id", name: "Unmapped" },
    },
    projectsConfig: { ...PROJECTS_CONFIG, defaultRemoteProject: "" },
    routerConfig: { mode: "rules" },
  });
  assert.equal(rulesNoDefaultNoMatch.action, "elicit");
  assert.equal(rulesNoDefaultNoMatch.remoteProject, null);
  assert.equal(rulesNoDefaultNoMatch.matchedBy, "unmatched");
});
