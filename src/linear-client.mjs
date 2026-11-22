const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const VIEWER_QUERY = `
  query ViewerInfo {
    viewer {
      id
      name
      displayName
      email
      app
      active
    }
    organization {
      id
      name
      urlKey
    }
  }
`;

const ISSUE_CONTEXT_QUERY = `
  query IssueContext($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      url
      branchName
      priorityLabel
      description
      team {
        id
        key
        name
      }
      project {
        id
        name
        slugId
        description
      }
      parent {
        id
        identifier
        title
      }
      creator {
        id
        name
        displayName
      }
      assignee {
        id
        name
        displayName
      }
      labels {
        nodes {
          id
          name
        }
      }
      state {
        name
        type
      }
    }
  }
`;

const AGENT_ACTIVITY_CREATE_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
      agentActivity {
        id
      }
    }
  }
`;

const AGENT_SESSION_UPDATE_MUTATION = `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) {
      success
      agentSession {
        id
      }
    }
  }
`;

/**
 * Minimal GraphQL client for Linear App-actor operations.
 */
export class LinearClient {
  constructor({ tokenManager, fetchImpl = fetch, endpoint = LINEAR_GRAPHQL_ENDPOINT }) {
    this.tokenManager = tokenManager;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
  }

  async graphql(query, variables = {}) {
    let token = await this.tokenManager.getAccessToken();
    let res = await this._sendGraphql(token, query, variables);

    if (res.status === 401) {
      token = await this.tokenManager.getAccessToken({ forceRefresh: true });
      res = await this._sendGraphql(token, query, variables);
    }

    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const msg = payload?.errors?.[0]?.message || text || `HTTP ${res.status}`;
      const err = new Error(`Linear GraphQL HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }

    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const messages = payload.errors.map((e) => e.message).join("; ");
      const err = new Error(`Linear GraphQL error: ${messages}`);
      err.graphqlErrors = payload.errors;
      throw err;
    }

    return payload?.data;
  }

  async _sendGraphql(token, query, variables) {
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  }

  async getViewer() {
    return this.graphql(VIEWER_QUERY);
  }

  async getIssueContext(issueId) {
    const data = await this.graphql(ISSUE_CONTEXT_QUERY, { id: issueId });
    return data?.issue || null;
  }

  async createAgentActivity({
    agentSessionId,
    content,
    ephemeral,
    signal,
    signalMetadata,
  }) {
    const input = {
      agentSessionId,
      content,
    };
    if (ephemeral !== undefined) {
      input.ephemeral = ephemeral;
    }
    if (signal !== undefined) {
      input.signal = signal;
    }
    if (signalMetadata !== undefined) {
      input.signalMetadata = signalMetadata;
    }
    const data = await this.graphql(AGENT_ACTIVITY_CREATE_MUTATION, { input });
    return data?.agentActivityCreate || { success: false };
  }

  async updateAgentSession({
    id,
    summary,
    externalLink,
    externalUrls,
    addedExternalUrls,
    removedExternalUrls,
    plan,
  }) {
    const input = {};
    if (summary !== undefined) input.summary = summary;
    if (externalLink !== undefined) input.externalLink = externalLink;
    if (externalUrls !== undefined) input.externalUrls = externalUrls;
    if (addedExternalUrls !== undefined) input.addedExternalUrls = addedExternalUrls;
    if (removedExternalUrls !== undefined) input.removedExternalUrls = removedExternalUrls;
    if (plan !== undefined) input.plan = plan;

    const data = await this.graphql(AGENT_SESSION_UPDATE_MUTATION, { id, input });
    return data?.agentSessionUpdate || { success: false };
  }
}
