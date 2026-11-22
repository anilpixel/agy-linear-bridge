import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ROUTING_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["dispatch", "elicit"] },
    projectKey: { type: ["string", "null"] },
    clarifyingQuestion: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["action", "projectKey", "clarifyingQuestion", "reason"],
});

/**
 * Deterministically match a Linear issue to a configured project entry.
 */
export function matchProjectDeterministically(issueContext, projectsConfig) {
  const projects = projectsConfig?.projects || [];
  if (!issueContext || projects.length === 0) {
    return null;
  }

  const linearProject = issueContext.project || null;
  if (linearProject?.id) {
    const byId = projects.find((p) => p.linear.projectIds.includes(linearProject.id));
    if (byId) {
      return { project: byId, matchedBy: "projectId" };
    }
  }

  if (linearProject?.slugId) {
    const bySlug = projects.find((p) =>
      p.linear.projectSlugs.includes(linearProject.slugId)
    );
    if (bySlug) {
      return { project: bySlug, matchedBy: "projectSlug" };
    }
  }

  if (linearProject?.name) {
    const needle = linearProject.name.trim().toLowerCase();
    const byName = projects.find((p) =>
      p.linear.projectNames.some((name) => name.toLowerCase() === needle)
    );
    if (byName) {
      return { project: byName, matchedBy: "projectName" };
    }
  }

  const labelNames = (issueContext.labels?.nodes || [])
    .map((l) => String(l?.name || "").trim().toLowerCase())
    .filter(Boolean);
  if (labelNames.length > 0) {
    const labelMatches = projects.filter((p) =>
      p.linear.labels.some((lbl) => labelNames.includes(lbl.toLowerCase()))
    );
    if (labelMatches.length === 1) {
      return { project: labelMatches[0], matchedBy: "label" };
    }
  }

  const teamKey = issueContext.team?.key ? String(issueContext.team.key).trim() : "";
  if (!linearProject && teamKey) {
    const teamMatches = projects.filter((p) =>
      p.linear.teamKeys.some((key) => key.toLowerCase() === teamKey.toLowerCase())
    );
    if (teamMatches.length === 1) {
      return { project: teamMatches[0], matchedBy: "teamKey" };
    }
  }

  return null;
}

function buildRoutingPrompt({ issueContext, promptContext, projectsConfig }) {
  const catalog = (projectsConfig?.projects || []).map((p) => ({
    key: p.key,
    name: p.name,
    description: p.description,
    linearTeams: p.linear.teamKeys,
    linearProjects: p.linear.projectNames,
  }));

  const issueSummary = {
    identifier: issueContext?.identifier || "",
    title: issueContext?.title || "",
    team: issueContext?.team || null,
    project: issueContext?.project
      ? {
          id: issueContext.project.id,
          name: issueContext.project.name,
          slugId: issueContext.project.slugId,
        }
      : null,
    labels: (issueContext?.labels?.nodes || []).map((l) => l.name),
    description: (issueContext?.description || "").slice(0, 2000),
  };

  return [
    "You are a stateless dispatcher for Linear issues into Antigravity Remote Projects.",
    "Choose either action='dispatch' with an exact projectKey from the catalog below, OR action='elicit' with a concise Chinese clarifyingQuestion if the target project is ambiguous or critical scope is missing.",
    "Do NOT invent projectKey values outside the catalog. Do NOT call any tools.",
    "",
    `Project Catalog:\n${JSON.stringify(catalog, null, 2)}`,
    "",
    `Issue Summary:\n${JSON.stringify(issueSummary, null, 2)}`,
    promptContext ? `\nLinear Prompt Context:\n${String(promptContext).slice(0, 2000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractStructuredResult(stdoutText) {
  const trimmed = String(stdoutText || "").trim();
  if (!trimmed) {
    throw new Error("Empty output from agy router");
  }
  let envelope;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    const lastLine = trimmed.split(/\r?\n/).filter(Boolean).pop() || "";
    envelope = JSON.parse(lastLine);
  }

  if (envelope?.status && envelope.status !== "SUCCESS") {
    throw new Error(envelope.error || `Router agy exited with status ${envelope.status}`);
  }

  if (envelope?.structured_output && typeof envelope.structured_output === "object") {
    return envelope.structured_output;
  }
  if (typeof envelope?.response === "string" && envelope.response.trim()) {
    return JSON.parse(envelope.response.trim());
  }
  if (envelope?.action) {
    return envelope;
  }
  throw new Error("Router output missing structured_output");
}

/**
 * Use a stateless fast `agy -p` call to classify ambiguous tickets.
 */
export async function routeWithLlmAgent({
  issueContext,
  promptContext = "",
  projectsConfig,
  agyBin = "agy",
  routerModel = "gemini-3.8-flash-low",
  routerTimeoutMs = 90_000,
  execFileImpl = execFileAsync,
}) {
  const prompt = buildRoutingPrompt({ issueContext, promptContext, projectsConfig });
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    routerModel,
    "--disable-slash-commands",
    "--json-schema",
    ROUTING_JSON_SCHEMA,
  ];

  const { stdout } = await execFileImpl(agyBin, args, {
    timeout: routerTimeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });

  const decision = extractStructuredResult(stdout);
  const projects = projectsConfig?.projects || [];

  if (decision.action === "elicit") {
    return {
      action: "elicit",
      project: null,
      remoteProject: null,
      matchedBy: "llm",
      clarifyingQuestion:
        decision.clarifyingQuestion ||
        "请补充这条工单所属的目标项目或需要修改的具体范围，我再帮你派发到对应远端环境。",
      reason: decision.reason || "LLM router requested clarification",
    };
  }

  const matched = projects.find((p) => p.key === decision.projectKey);
  if (matched && matched.remoteProject) {
    return {
      action: "dispatch",
      project: matched,
      remoteProject: matched.remoteProject,
      matchedBy: "llm",
      clarifyingQuestion: null,
      reason: decision.reason || `Routed by LLM to ${matched.key}`,
    };
  }

  if (projectsConfig?.defaultRemoteProject) {
    return {
      action: "dispatch",
      project: {
        key: "default",
        name: "Default Remote Project",
        remoteProject: projectsConfig.defaultRemoteProject,
        extraInstructions: "",
      },
      remoteProject: projectsConfig.defaultRemoteProject,
      matchedBy: "defaultFallback",
      clarifyingQuestion: null,
      reason: decision.reason || "Fell back to defaultRemoteProject",
    };
  }

  return {
    action: "elicit",
    project: null,
    remoteProject: null,
    matchedBy: "llmFallback",
    clarifyingQuestion:
      decision.clarifyingQuestion ||
      "暂时无法确定这条工单归属哪个项目，请告诉我目标项目名称或仓库。",
    reason: "Unknown projectKey returned and no defaultRemoteProject configured",
  };
}

/**
 * Route an issue through deterministic rules first, then optional LLM fallback.
 */
export async function routeIssue({
  issueContext,
  promptContext = "",
  projectsConfig,
  routerConfig = { mode: "hybrid", model: "gemini-3.8-flash-low", timeoutMs: 90_000 },
  agyBin = "agy",
  execFileImpl = execFileAsync,
}) {
  const deterministic = matchProjectDeterministically(issueContext, projectsConfig);
  if (deterministic) {
    return {
      action: "dispatch",
      project: deterministic.project,
      remoteProject: deterministic.project.remoteProject || projectsConfig?.defaultRemoteProject || "",
      matchedBy: deterministic.matchedBy,
      clarifyingQuestion: null,
      reason: `Matched deterministically by ${deterministic.matchedBy}`,
    };
  }

  if (routerConfig?.mode === "hybrid") {
    try {
      return await routeWithLlmAgent({
        issueContext,
        promptContext,
        projectsConfig,
        agyBin,
        routerModel: routerConfig.model || "gemini-3.8-flash-low",
        routerTimeoutMs: routerConfig.timeoutMs || 90_000,
        execFileImpl,
      });
    } catch (err) {
      if (projectsConfig?.defaultRemoteProject) {
        return {
          action: "dispatch",
          project: {
            key: "default",
            name: "Default Remote Project",
            remoteProject: projectsConfig.defaultRemoteProject,
            extraInstructions: "",
          },
          remoteProject: projectsConfig.defaultRemoteProject,
          matchedBy: "defaultOnRouterError",
          clarifyingQuestion: null,
          reason: `Router fallback after error: ${err.message}`,
        };
      }
      const sampleNames = (projectsConfig?.projects || [])
        .map((p) => p?.name || p?.key)
        .filter(Boolean)
        .slice(0, 5);
      const projectHint = sampleNames.length ? `（例如 ${sampleNames.join(" / ")}）` : "";
      return {
        action: "elicit",
        project: null,
        remoteProject: null,
        matchedBy: "routerError",
        clarifyingQuestion: `请确认这条工单属于哪个项目${projectHint}？`,
        reason: `Router failed: ${err.message}`,
      };
    }
  }

  if (projectsConfig?.defaultRemoteProject) {
    return {
      action: "dispatch",
      project: {
        key: "default",
        name: "Default Remote Project",
        remoteProject: projectsConfig.defaultRemoteProject,
        extraInstructions: "",
      },
      remoteProject: projectsConfig.defaultRemoteProject,
      matchedBy: "defaultRule",
      clarifyingQuestion: null,
      reason: "No deterministic match; using defaultRemoteProject",
    };
  }

  return {
    action: "elicit",
    project: null,
    remoteProject: null,
    matchedBy: "unmatched",
    clarifyingQuestion: "未匹配到对应项目，请补充这条工单所属的项目或团队。",
    reason: "No deterministic match and no defaultRemoteProject configured",
  };
}
