import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import { z } from "zod";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG = "belentani7";

if (!GITHUB_TOKEN) {
  logger.error("GITHUB_TOKEN environment variable required");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new Server(
  { name: "belentani-audit", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Tool: List all repos with health metrics
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_repos",
      description: "List all belentani7 repositories with health metrics",
      inputSchema: {
        type: "object",
        properties: {
          include_private: { type: "boolean", default: true },
          per_page: { type: "number", default: 100 },
        },
      },
    },
    {
      name: "audit_repo",
      description: "Comprehensive audit of a single repository",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          include_workflows: { type: "boolean", default: true },
          include_deployments: { type: "boolean", default: true },
        },
        required: ["repo"],
      },
    },
    {
      name: "check_branch_protection",
      description: "Verify branch protection rules on main branch",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
        },
        required: ["repo"],
      },
    },
    {
      name: "get_deployment_status",
      description: "Check Vercel deployment status for a repo",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
        },
        required: ["repo"],
      },
    },
    {
      name: "run_security_scan",
      description: "Run security checks (gitleaks, dependabot, secrets)",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
        },
        required: ["repo"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_repos": {
        const { include_private = true, per_page = 100 } = args as { include_private?: boolean; per_page?: number };
        const repos = [];
        for await (const response of octokit.paginate.iterator(octokit.rest.repos.listForUser, {
          username: ORG,
          type: include_private ? "all" : "public",
          per_page,
          sort: "updated",
        })) {
          repos.push(...response.data);
        }
        
        const enriched = await Promise.all(repos.map(async (repo) => {
          const [workflows, deployments, branches] = await Promise.allSettled([
            octokit.rest.actions.listRepoWorkflows({ owner: ORG, repo: repo.name }),
            octokit.rest.repos.listDeployments({ owner: ORG, repo: repo.name }),
            octokit.rest.repos.getBranchProtection({ owner: ORG, repo: repo.name, branch: "main" }),
          ]);
          
          return {
            name: repo.name,
            description: repo.description,
            language: repo.language,
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            updated_at: repo.updated_at,
            private: repo.private,
            archived: repo.archived,
            has_workflows: workflows.status === "fulfilled" && workflows.value.data.total_count > 0,
            workflow_count: workflows.status === "fulfilled" ? workflows.value.data.total_count : 0,
            recent_deployments: deployments.status === "fulfilled" ? deployments.value.data.slice(0, 5) : [],
            branch_protected: branches.status === "fulfilled",
            topics: repo.topics,
            license: repo.license?.spdx_id,
          };
        }));
        
        return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
      }

      case "audit_repo": {
        const { repo, include_workflows = true, include_deployments = true } = args as { 
          repo: string; 
          include_workflows?: boolean; 
          include_deployments?: boolean;
        };
        
        const [repoData, contents, workflows, issues, pulls, releases, deployments, branchProtection] = 
          await Promise.allSettled([
            octokit.rest.repos.get({ owner: ORG, repo }),
            octokit.rest.repos.getContent({ owner: ORG, repo, path: "" }),
            include_workflows ? octokit.rest.actions.listRepoWorkflows({ owner: ORG, repo }) : Promise.resolve({ data: { workflows: [] } }),
            octokit.rest.issues.listForRepo({ owner: ORG, repo, state: "all", per_page: 20 }),
            octokit.rest.pulls.list({ owner: ORG, repo, state: "all", per_page: 20 }),
            octokit.rest.repos.listReleases({ owner: ORG, repo, per_page: 10 }),
            include_deployments ? octokit.rest.repos.listDeployments({ owner: ORG, repo }) : Promise.resolve({ data: [] }),
            octokit.rest.repos.getBranchProtection({ owner: ORG, repo, branch: "main" }),
          ]);

        const audit = {
          repo: repo.status === "fulfilled" ? repo.value.data.name : repo,
          timestamp: new Date().toISOString(),
          metadata: repo.status === "fulfilled" ? {
            description: repo.value.data.description,
            language: repo.value.data.language,
            stars: repo.value.data.stargazers_count,
            forks: repo.value.data.forks_count,
            updated_at: repo.value.data.updated_at,
            private: repo.value.data.private,
            archived: repo.value.data.archived,
            license: repo.value.data.license?.spdx_id,
            topics: repo.value.data.topics,
          } : null,
          files: contents.status === "fulfilled" ? contents.value.data.map(f => ({ name: f.name, type: f.type, size: f.size })) : [],
          workflows: workflows.status === "fulfilled" ? workflows.value.data.workflows.map(w => ({ name: w.name, state: w.state, path: w.path })) : [],
          open_issues: issues.status === "fulfilled" ? issues.value.data.filter(i => !i.pull_request).length : 0,
          open_prs: pulls.status === "fulfilled" ? pulls.value.data.length : 0,
          releases: releases.status === "fulfilled" ? releases.value.data.map(r => ({ name: r.name, tag: r.tag_name, published: r.published_at })) : [],
          deployments: deployments.status === "fulfilled" ? deployments.value.data.slice(0, 10) : [],
          branch_protected: branchProtection.status === "fulfilled",
          branch_protection_details: branchProtection.status === "fulfilled" ? branchProtection.value.data : null,
          health_score: calculateHealthScore({
            has_workflows: workflows.status === "fulfilled" && workflows.value.data.workflows.length > 0,
            has_readme: contents.status === "fulfilled" && contents.value.data.some(f => f.name.toLowerCase().includes("readme")),
            has_license: repo.status === "fulfilled" && !!repo.value.data.license,
            branch_protected: branchProtection.status === "fulfilled",
            recent_activity: repo.status === "fulfilled" && new Date(repo.value.data.updated_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            open_issues_count: issues.status === "fulfilled" ? issues.value.data.filter(i => !i.pull_request).length : 999,
          }),
        };
        
        return { content: [{ type: "text", text: JSON.stringify(audit, null, 2) }] };
      }

      case "check_branch_protection": {
        const { repo } = args as { repo: string };
        const result = await octokit.rest.repos.getBranchProtection({ owner: ORG, repo, branch: "main" });
        return { content: [{ type: "text", text: JSON.stringify({ protected: true, rules: result.data }, null, 2) }] };
      }

      case "get_deployment_status": {
        const { repo } = args as { repo: string };
        const deployments = await octokit.rest.repos.listDeployments({ owner: ORG, repo, per_page: 5 });
        const vercelDeployments = deployments.data.filter(d => d.environment === "production" || d.environment === "preview");
        return { content: [{ type: "text", text: JSON.stringify(vercelDeployments, null, 2) }] };
      }

      case "run_security_scan": {
        const { repo } = args as { repo: string };
        // Check for gitleaks config
        const gitleaksConfig = await octokit.rest.repos.getContent({ owner: ORG, repo, path: ".gitleaks.toml" }).catch(() => null);
        const dependabotConfig = await octokit.rest.repos.getContent({ owner: ORG, repo, path: ".github/dependabot.yml" }).catch(() => null);
        const codeqlConfig = await octokit.rest.repos.getContent({ owner: ORG, repo, path: ".github/codeql" }).catch(() => null);
        
        // Get recent workflow runs for security
        const securityRuns = await octokit.rest.actions.listWorkflowRuns({
          owner: ORG,
          repo,
          per_page: 10,
        }).then(r => r.data.workflow_runs.filter(w => w.name.toLowerCase().includes("security") || w.name.toLowerCase().includes("gitleaks") || w.name.toLowerCase().includes("codeql")));

        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              gitleaks_configured: !!gitleaksConfig,
              dependabot_configured: !!dependabotConfig,
              codeql_configured: !!codeqlConfig,
              security_workflows: securityRuns.map(w => ({ name: w.name, conclusion: w.conclusion, updated: w.updated_at })),
            }, null, 2) 
          }] 
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error({ error, tool: name }, "Tool execution failed");
    return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

function calculateHealthScore(metrics: Record<string, boolean | number>): number {
  let score = 0;
  const weights = {
    has_workflows: 20,
    has_readme: 15,
    has_license: 15,
    branch_protected: 20,
    recent_activity: 15,
    open_issues_count: 15, // inverse
  };
  
  for (const [key, weight] of Object.entries(weights)) {
    if (key === "open_issues_count") {
      score += (metrics[key] as number) < 10 ? weight : Math.max(0, weight - (metrics[key] as number - 10) * 2);
    } else if (metrics[key]) {
      score += weight;
    }
  }
  return Math.min(100, Math.max(0, score));
}

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info("Belentani Audit MCP Server running");