import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWorkflowDocument, WorkflowLoader } from "../workflow.mjs";

test("parseWorkflowDocument parses YAML-subset frontmatter, lists, plain markdown, and truncates long bodies", () => {
  const sample = [
    "---",
    "mode: auto",
    "ciAutoFix: false",
    "reviewAutoResume: true",
    "maxCiFixRounds: 5",
    'customNote: "quoted 42"',
    "checks:",
    "  - pnpm lint",
    "  - pnpm test",
    "tags: [backend, sync]",
    "---",
    "",
    "# Repository Workflow",
    "Always run tests before opening a PR.",
  ].join("\n");

  const parsed = parseWorkflowDocument(sample);
  assert.deepEqual(parsed.frontmatter, {
    mode: "auto",
    ciAutoFix: false,
    reviewAutoResume: true,
    maxCiFixRounds: 5,
    customNote: "quoted 42",
    checks: ["pnpm lint", "pnpm test"],
    tags: ["backend", "sync"],
  });
  assert.equal(parsed.body, "# Repository Workflow\nAlways run tests before opening a PR.");

  const plain = parseWorkflowDocument("# Just markdown\nNo frontmatter here.");
  assert.deepEqual(plain.frontmatter, {});
  assert.equal(plain.body, "# Just markdown\nNo frontmatter here.");

  const truncated = parseWorkflowDocument("A".repeat(100), { maxBodyChars: 40 });
  assert.ok(truncated.body.startsWith("A".repeat(40)));
  assert.match(truncated.body, /\.\.\.\[truncated\]$/);
});

test("WorkflowLoader loads local WORKFLOW.md first, fetches via gh api with TTL caching, and caches 404 misses", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-workflow-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "WORKFLOW.md"),
      "---\nmode: plan\n---\nLocal workflow instructions\n",
      "utf8"
    );

    let fakeNow = 1_000_000;
    const ghCalls = [];
    const loader = new WorkflowLoader({
      config: {
        workflow: { enabled: true, cacheTtlMs: 60_000, timeoutMs: 5_000, ghBin: "gh" },
      },
      nowFn: () => fakeNow,
      logger: { warn() {} },
      execFileImpl: async (bin, args) => {
        ghCalls.push({ bin, args });
        if (args[1].includes("missing/repo")) {
          const err = new Error("gh: Not Found (HTTP 404)");
          err.stderr = "HTTP 404 Not Found";
          throw err;
        }
        if (args[1].includes("broken/repo")) {
          throw new Error("network timeout");
        }
        const md = "---\nciAutoFix: true\nmaxCiFixRounds: 2\n---\nGitHub workflow policy";
        return {
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from(md, "utf8").toString("base64"),
          }),
        };
      },
    });

    const localDoc = await loader.load({ localPath: tmpDir, githubRepo: "ignored/repo" });
    assert.equal(localDoc.source, "local");
    assert.equal(localDoc.frontmatter.mode, "plan");
    assert.equal(localDoc.body, "Local workflow instructions");
    assert.equal(ghCalls.length, 0);

    const ghDoc1 = await loader.load({ githubRepo: "acme/backend-app" });
    const ghDoc2 = await loader.load({ githubRepo: "acme/backend-app" });
    assert.equal(ghDoc1.source, "github");
    assert.equal(ghDoc1.frontmatter.maxCiFixRounds, 2);
    assert.equal(ghDoc2.body, "GitHub workflow policy");
    assert.equal(ghCalls.length, 1);

    fakeNow += 61_000;
    await loader.load({ githubRepo: "acme/backend-app" });
    assert.equal(ghCalls.length, 2);

    const miss1 = await loader.load({ githubRepo: "missing/repo" });
    const miss2 = await loader.load({ githubRepo: "missing/repo" });
    assert.equal(miss1, null);
    assert.equal(miss2, null);
    assert.equal(ghCalls.length, 3);

    const broken = await loader.load({ githubRepo: "broken/repo" });
    assert.equal(broken, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
