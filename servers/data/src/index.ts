import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import { Database } from "duckdb";
import { z } from "zod";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG = "belentani7";

if (!GITHUB_TOKEN) { logger.error("GITHUB_TOKEN required"); process.exit(1); }

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const db = new Database(":memory:");

const server = new Server({ name: "belentani-data", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "ingest_github_data", description: "Ingest GitHub data into DuckDB", inputSchema: { type: "object", properties: { since_days: { type: "number", default: 90 }, include_private: { type: "boolean", default: true } } } },
  { name: "query_analytics", description: "Run SQL queries on ingested data", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
  { name: "get_commit_frequency", description: "Get commit frequency analysis", inputSchema: { type: "object", properties: { repo: { type: "string" }, granularity: { type: "string", enum: ["day","week","month"], default: "week" } } } },
  { name: "get_contributor_stats", description: "Get contributor statistics", inputSchema: { type: "object", properties: { since_days: { type: "number", default: 90 } } } },
  { name: "get_issue_pr_metrics", description: "Get issue/PR metrics", inputSchema: { type: "object", properties: { repo: { type: "string" }, since_days: { type: "number", default: 90 } } } },
  { name: "export_analytics", description: "Export analytics to CSV/JSON", inputSchema: { type: "object", properties: { format: { type: "string", enum: ["csv","json"], default: "csv" }, query: { type: "string" } }, required: ["query"] } }
] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "ingest_github_data": {
        const { since_days = 90, include_private = true } = args as { since_days?: number; include_private?: boolean };
        const since = new Date(Date.now() - since_days * 86400000).toISOString();
        await db.exec("CREATE TABLE IF NOT EXISTS repos (id BIGINT, name VARCHAR, full_name VARCHAR, private BOOLEAN, language VARCHAR, stars INT, forks INT, updated_at TIMESTAMP, archived BOOLEAN, topics VARCHAR)");
        await db.exec("CREATE TABLE IF NOT EXISTS commits (sha VARCHAR, repo VARCHAR, author VARCHAR, message VARCHAR, date TIMESTAMP, additions INT, deletions INT, files_changed INT)");
        await db.exec("CREATE TABLE IF NOT EXISTS issues (number INT, repo VARCHAR, state VARCHAR, title VARCHAR, author VARCHAR, created_at TIMESTAMP, closed_at TIMESTAMP, labels VARCHAR)");
        await db.exec("CREATE TABLE IF NOT EXISTS pull_requests (number INT, repo VARCHAR, state VARCHAR, title VARCHAR, author VARCHAR, created_at TIMESTAMP, merged_at TIMESTAMP, merged_by VARCHAR, additions INT, deletions INT, changed_files INT)");
        let reposIngested = 0, commitsIngested = 0, issuesIngested = 0, prsIngested = 0;
        for await (const response of octokit.paginate.iterator(octokit.rest.repos.listForUser, { username: ORG, type: include_private ? "all" : "public", per_page: 100, sort: "updated" })) {
          for (const repo of response.data) {
            if (repo.archived) continue;
            reposIngested++;
            await db.run("INSERT OR REPLACE INTO repos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [repo.id, repo.name, repo.full_name, repo.private, repo.language, repo.stargazers_count, repo.forks_count, repo.updated_at, repo.archived, JSON.stringify(repo.topics)]);
            try {
              for await (const commitResponse of octokit.paginate.iterator(octokit.rest.repos.listCommits, { owner: ORG, repo: repo.name, since, per_page: 100 })) {
                for (const commit of commitResponse.data) {
                  commitsIngested++;
                  await db.run("INSERT INTO commits VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [commit.sha, repo.name, commit.commit.author?.name || "unknown", commit.commit.message, commit.commit.author?.date, commit.stats?.additions || 0, commit.stats?.deletions || 0, commit.files?.length || 0]);
                }
              }
            } catch {}
            try {
              for await (const issueResponse of octokit.paginate.iterator(octokit.rest.issues.listForRepo, { owner: ORG, repo: repo.name, state: "all", since, per_page: 100 })) {
                for (const issue of issueResponse.data) { if (issue.pull_request) continue; issuesIngested++; await db.run("INSERT INTO issues VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [issue.number, repo.name, issue.state, issue.title, issue.user?.login, issue.created_at, issue.closed_at, JSON.stringify(issue.labels.map(l => l.name))]); }
              }
            } catch {}
            try {
              for await (const prResponse of octokit.paginate.iterator(octokit.rest.pulls.list, { owner: ORG, repo: repo.name, state: "all", per_page: 100 })) {
                for (const pr of prResponse.data) { if (new Date(pr.created_at) < new Date(since)) continue; prsIngested++; await db.run("INSERT INTO pull_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [pr.number, repo.name, pr.state, pr.title, pr.user?.login, pr.created_at, pr.merged_at, pr.merged_by?.login, pr.additions || 0, pr.deletions || 0, pr.changed_files || 0]); }
              }
            } catch {}
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ repos: reposIngested, commits: commitsIngested, issues: issuesIngested, prs: prsIngested, since_days }) }] };
      }
      case "query_analytics": {
        const { sql } = args as { sql: string };
        const result = await db.all(sql);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_commit_frequency": {
        const { repo, granularity = "week" } = args as { repo: string; granularity?: "day"|"week"|"month" };
        const result = await db.all("SELECT strftime('%Y-%W', date) as period, COUNT(*) as commits, SUM(additions) as additions, SUM(deletions) as deletions FROM commits WHERE repo = ? GROUP BY period ORDER BY period DESC LIMIT 52", [repo]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_contributor_stats": {
        const { since_days = 90 } = args as { since_days?: number };
        const since = new Date(Date.now() - since_days * 86400000).toISOString();
        const result = await db.all("SELECT author, COUNT(*) as commits, SUM(additions) as total_additions, SUM(deletions) as total_deletions FROM commits WHERE date > ? GROUP BY author ORDER BY commits DESC LIMIT 20", [since]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_issue_pr_metrics": {
        const { repo, since_days = 90 } = args as { repo: string; since_days?: number };
        const since = new Date(Date.now() - since_days * 86400000).toISOString();
        const issues = await db.all("SELECT state, COUNT(*) as count, AVG(julianday(closed_at) - julianday(created_at)) as avg_days_to_close FROM issues WHERE repo = ? AND created_at > ? GROUP BY state", [repo, since]);
        const prs = await db.all("SELECT state, COUNT(*) as count, AVG(julianday(merged_at) - julianday(created_at)) as avg_days_to_merge FROM pull_requests WHERE repo = ? AND created_at > ? GROUP BY state", [repo, since]);
        return { content: [{ type: "text", text: JSON.stringify({ issues, prs }, null, 2) }] };
      }
      case "export_analytics": {
        const { format = "csv", query } = args as { format?: "csv"|"json"; query: string };
        const result = await db.all(query);
        if (format === "json") return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        if (result.length === 0) return { content: [{ type: "text", text: "No data" }] };
        const headers = Object.keys(result[0]).join(",");
        const rows = result.map(r => Object.values(r).map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
        return { content: [{ type: "text", text: headers + "\n" + rows }] };
      }
      default: throw new Error("Unknown tool: " + name);
    }
  } catch (error) {
    logger.error({ error, tool: name }, "Data tool failed");
    return { content: [{ type: "text", text: "Error: " + (error instanceof Error ? error.message : String(error)) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info("Belentani Data MCP Server running");