import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Vercel } from "vercel";
import { Octokit } from "octokit";
import { z } from "zod";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG = "belentani7";

if (!VERCEL_TOKEN || !GITHUB_TOKEN) {
  logger.error("VERCEL_TOKEN and GITHUB_TOKEN required");
  process.exit(1);
}

const vercel = new Vercel({ bearerToken: VERCEL_TOKEN });
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new Server(
  { name: "belentani-deploy", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_vercel_projects",
      description: "List all Vercel projects for the organization",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_project_deployments",
      description: "Get recent deployments for a Vercel project",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" }, limit: { type: "number", default: 10 } },
        required: ["project_id"],
      },
    },
    {
      name: "sync_vercel_github",
      description: "Sync Vercel project to track GitHub main branch",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          github_repo: { type: "string" },
          branch: { type: "string", default: "main" },
        },
        required: ["project_id", "github_repo"],
      },
    },
    {
      name: "create_preview_deployment",
      description: "Create a Vercel preview deployment for a PR",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          github_pr_number: { type: "number" },
          github_repo: { type: "string" },
        },
        required: ["project_id", "github_pr_number", "github_repo"],
      },
    },
    {
      name: "promote_to_production",
      description: "Promote a preview deployment to production",
      inputSchema: {
        type: "object",
        properties: { deployment_id: { type: "string" } },
        required: ["deployment_id"],
      },
    },
    {
      name: "verify_deployment_health",
      description: "Verify deployment health (200 status, health endpoint)",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          check_endpoints: { type: "array", items: { type: "string" }, default: ["/health", "/robots.txt", "/sitemap.xml"] },
        },
        required: ["url"],
      },
    },
    {
      name: "set_branch_protection",
      description: "Configure GitHub branch protection rules",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          branch: { type: "string", default: "main" },
          required_checks: { type: "array", items: { type: "string" }, default: ["build", "typecheck", "test", "lint"] },
          require_reviews: { type: "number", default: 1 },
        },
        required: ["repo"],
      },
    },
    {
      name: "rollback_deployment",
      description: "Rollback to previous production deployment",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          target_deployment_id: { type: "string" },
        },
        required: ["project_id", "target_deployment_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_vercel_projects": {
        const projects = [];
        for await (const response of vercel.paginate(vercel.projects.list, {})) {
          projects.push(...response);
        }
        return { content: [{ type: "text", text: JSON.stringify(projects.map(p => ({
          id: p.id,
          name: p.name,
          framework: p.framework,
          git_repo: p.gitRepository,
          production_branch: p.targets?.production?.branch,
          latest_deployment: p.latestDeployments?.[0] ? {
            url: p.latestDeployments[0].url,
            state: p.latestDeployments[0].readyState,
            created: p.latestDeployments[0].createdAt,
          } : null,
        })), null, 2) }] };
      }

      case "get_project_deployments": {
        const { project_id, limit = 10 } = args as { project_id: string; limit?: number };
        const deployments = await vercel.deployments.list({ projectId: project_id, limit });
        return { content: [{ type: "text", text: JSON.stringify(deployments.deployments.map(d => ({
          id: d.uid,
          url: d.url,
          state: d.readyState,
          created: d.createdAt,
          meta: d.meta,
          github: d.gitSource,
        })), null, 2) }] };
      }

      case "sync_vercel_github": {
        const { project_id, github_repo, branch = "main" } = args as { project_id: string; github_repo: string; branch?: string };
        await vercel.projects.update(project_id, {
          gitRepository: github_repo,
          target: { production: { branch } },
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, project_id, branch }) }] };
      }

      case "create_preview_deployment": {
        const { project_id, github_pr_number, github_repo } = args as { project_id: string; github_pr_number: number; github_repo: string };
        const deployment = await vercel.deployments.create({
          projectId: project_id,
          gitSource: {
            type: "github",
            repo: github_repo,
            ref: `refs/pull/${github_pr_number}/head`,
            sha: "", // Will be filled by Vercel
          },
          target: "preview",
        });
        return { content: [{ type: "text", text: JSON.stringify({ deployment_id: deployment.uid, url: deployment.url }) }] };
      }

      case "promote_to_production": {
        const { deployment_id } = args as { deployment_id: string };
        await vercel.deployments.promote(deployment_id, { target: "production" });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, deployment_id }) }] };
      }

      case "verify_deployment_health": {
        const { url, check_endpoints = ["/health", "/robots.txt", "/sitemap.xml"] } = args as { url: string; check_endpoints?: string[] };
        const results = await Promise.allSettled(
          check_endpoints.map(async (endpoint) => {
            const res = await fetch(`${url}${endpoint}`, { method: "HEAD" });
            return { endpoint, status: res.status, ok: res.ok };
          })
        );
        return { content: [{ type: "text", text: JSON.stringify(results.map(r => r.status === "fulfilled" ? r.value : { error: r.reason }), null, 2) }] };
      }

      case "set_branch_protection": {
        const { repo, branch = "main", required_checks = ["build", "typecheck", "test", "lint"], require_reviews = 1 } = args as { repo: string; branch?: string; required_checks?: string[]; require_reviews?: number };
        await octokit.rest.repos.updateBranchProtection({
          owner: ORG,
          repo,
          branch,
          required_status_checks: { strict: true, contexts: required_checks },
          enforce_admins: true,
          required_pull_request_reviews: { required_approving_review_count: require_reviews, dismiss_stale_reviews: true, require_code_owner_reviews: true },
          restrictions: null,
          allow_force_pushes: false,
          allow_deletions: false,
          required_linear_history: true,
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, repo, branch, checks: required_checks }) }] };
      }

      case "rollback_deployment": {
        const { project_id, target_deployment_id } = args as { project_id: string; target_deployment_id: string };
        await vercel.deployments.promote(target_deployment_id, { target: "production" });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, project_id, rolled_back_to: target_deployment_id }) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error({ error, tool: name }, "Deploy tool failed");
    return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info("Belentani Deploy MCP Server running");