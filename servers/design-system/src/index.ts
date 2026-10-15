import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import { z } from "zod";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG = "belentani7";

if (!GITHUB_TOKEN) { logger.error("GITHUB_TOKEN required"); process.exit(1); }

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new Server({ name: "belentani-design-system", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "get_design_tokens", description: "Get Belentani design tokens (colors, spacing, typography, shadows, motion)", inputSchema: { type: "object", properties: { format: { type: "string", enum: ["css", "json", "scss"], default: "json" } } } },
  { name: "list_components", description: "List available design system components with props", inputSchema: { type: "object", properties: {} } },
  { name: "get_component_docs", description: "Get documentation for a specific component", inputSchema: { type: "object", properties: { component: { type: "string", enum: ["Button", "Card", "Input", "Toast", "Badge", "Avatar"] } }, required: ["component"] } },
  { name: "check_component_usage", description: "Check which repos use design system components", inputSchema: { type: "object", properties: { component: { type: "string" } } } },
  { name: "validate_token_usage", description: "Validate that a repo uses design tokens correctly", inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "generate_component_boilerplate", description: "Generate boilerplate for a new component", inputSchema: { type: "object", properties: { name: { type: "string" }, variant: { type: "string", enum: ["simple", "compound", "form"] }, description: { type: "string" } }, required: ["name", "description"] } },
] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "get_design_tokens": {
        const { format = "json" } = args as { format?: "css"|"json"|"scss" };
        const tokens = {
          colors: {
            bg: { deep: "#071A14", surface: "#0D2A20", elevated: "#143D2E", border: "#1E4D38" },
            brand: { primary: "#39D98A", lime: "#A7F36C", mint: "#B7F7D4", emerald: "#10B981" },
            text: { primary: "#E9FFF3", secondary: "#A7D9B8", muted: "#6B9B7D", onBrand: "#052E16" },
            status: { error: "#FF7D7D", warning: "#FDE68A", info: "#7DD3FC", success: "#39D98A" },
          },
          spacing: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px", 8: "32px", 10: "40px", 12: "48px", 16: "64px", 20: "80px", 24: "96px" },
          motion: { fast: "150ms", normal: "300ms", slow: "500ms", easeStandard: "cubic-bezier(0.4,0,0.2,1)", easeExpressive: "cubic-bezier(0.25,0.1,0.25,1)", easeSpring: "cubic-bezier(0.34,1.56,0.64,1)" },
          shadows: { xs: "0 1px 2px rgb(0 0 0 / 0.3)", sm: "0 2px 4px rgb(0 0 0 / 0.3), 0 1px 2px rgb(0 0 0 / 0.2)", md: "0 4px 8px rgb(0 0 0 / 0.3), 0 2px 4px rgb(0 0 0 / 0.2)", lg: "0 8px 16px rgb(0 0 0 / 0.4), 0 4px 8px rgb(0 0 0 / 0.2)", xl: "0 16px 32px rgb(0 0 0 / 0.4), 0 8px 16px rgb(0 0 0 / 0.3)", glow: "0 0 24px rgb(57 217 138 / 0.3), 0 0 48px rgb(57 217 138 / 0.15)", focus: "0 0 0 3px rgb(57 217 138 / 0.4)" },
          radii: { sm: "4px", md: "8px", lg: "12px", xl: "16px", full: "9999px" },
          typography: { fontSans: "Inter, system-ui, -apple-system, sans-serif", fontMono: "JetBrains Mono, Fira Code, monospace", sizes: { xs: "0.75rem", sm: "0.875rem", base: "1rem", lg: "1.125rem", xl: "1.25rem", "2xl": "1.5rem", "3xl": "1.875rem", "4xl": "2.25rem", "5xl": "3rem" }, weights: { normal: 400, medium: 500, semibold: 600, bold: 700 } },
          zIndex: { dropdown: 100, sticky: 200, modal: 300, popover: 400, tooltip: 500, toast: 600 },
        };
        
        if (format === "css") {
          let css = ":root {\n";
          for (const [category, values] of Object.entries(tokens)) {
            if (typeof values === "object" && values !== null) {
              for (const [key, value] of Object.entries(values)) {
                const tokenName = category + (key.charAt(0).toUpperCase() + key.slice(1)).replace(/([A-Z])/g, "-$1").toLowerCase();
                css += "  --color-" + tokenName + ": " + value + ";\n";
              }
            }
          }
          css += "}";
          return { content: [{ type: "text", text: css }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(tokens, null, 2) }] };
      }
      case "list_components": {
        return { content: [{ type: "text", text: JSON.stringify([
          { name: "Button", description: "Interactive button with variants, sizes, loading state, asChild", variants: ["default", "destructive", "outline", "secondary", "ghost", "link", "success"], sizes: ["sm", "default", "lg", "xl", "icon"] },
          { name: "Card", description: "Container with variants and interactive states", variants: ["default", "elevated", "outlined", "glass", "gradient"], subComponents: ["CardHeader", "CardTitle", "CardDescription", "CardContent", "CardFooter"] },
          { name: "Input", description: "Form input with label, error, hint, leading/trailing icons" },
          { name: "Toast", description: "Notification with variants, auto-dismiss, action support", variants: ["default", "success", "error", "warning", "info"] },
          { name: "Badge", description: "Status indicator with variants, sizes, dot indicator", variants: ["default", "success", "error", "warning", "info", "brand"], sizes: ["sm", "md", "lg"] },
          { name: "Avatar", description: "User avatar with image fallback, status indicator", sizes: ["xs", "sm", "md", "lg", "xl", "2xl"], shapes: ["circle", "square"], statuses: ["online", "offline", "busy", "away"] },
        ], null, 2) }] };
      }
      case "get_component_docs": {
        const { component } = args as { component: string };
        const docs = {
          Button: { description: "Primary interactive element", props: { variant: "default | destructive | outline | secondary | ghost | link | success", size: "sm | default | lg | xl | icon", loading: "boolean", asChild: "boolean", disabled: "boolean", onClick: "function" }, examples: ["<Button variant='default'>Click</Button>", "<Button variant='success' loading>Saving...</Button>", "<Button asChild><a href='/link'>Link</a></Button>"] },
          Card: { description: "Flexible container component", props: { variant: "default | elevated | outlined | glass | gradient", interactive: "boolean", className: "string" }, subComponents: "CardHeader, CardTitle, CardDescription, CardContent, CardFooter", examples: ["<Card variant='glass' interactive><CardHeader><CardTitle>Title</CardTitle></CardHeader><CardContent>Content</CardContent></Card>"] },
          Input: { description: "Form input with accessibility features", props: { label: "string", error: "string", hint: "string", leadingIcon: "ReactNode", trailingIcon: "ReactNode", ...HTMLInputProps }, examples: ["<Input label='Email' type='email' placeholder='you@example.com' />", "<Input label='Password' type='password' error='Invalid password' />"] },
          Toast: { description: "Notification component", props: { variant: "default | success | error | warning | info", title: "string", description: "ReactNode", action: "ReactNode", onClose: "function", duration: "number" }, examples: ["<Toast variant='success' title='Saved' description='Changes saved' />"] },
          Badge: { description: "Status indicator", props: { variant: "default | success | error | warning | info | brand", size: "sm | md | lg", dot: "boolean" }, examples: ["<Badge variant='success' dot>Online</Badge>"] },
          Avatar: { description: "User avatar", props: { src: "string", alt: "string", fallback: "string", size: "xs | sm | md | lg | xl | 2xl", shape: "circle | square", status: "online | offline | busy | away" }, examples: ["<Avatar src='/avatar.jpg' fallback='JB' status='online' size='lg' />"] },
        };
        return { content: [{ type: "text", text: JSON.stringify(docs[component as keyof typeof docs] || { error: "Component not found" }, null, 2) }] };
      }
      case "check_component_usage": {
        const { component } = args as { component: string };
        const results = [];
        for await (const response of octokit.paginate.iterator(octokit.rest.repos.listForUser, { username: ORG, type: "all", per_page: 100 })) {
          for (const repo of response.data) {
            if (repo.archived) continue;
            try {
              const content = await octokit.rest.repos.getContent({ owner: ORG, repo: repo.name, path: "package.json" });
              const pkg = JSON.parse(Buffer.from(content.data.content, "base64").toString());
              const usesDesignSystem = pkg.dependencies?.["@belentani/ui"] || pkg.devDependencies?.["@belentani/ui"];
              if (usesDesignSystem) {
                results.push({ repo: repo.name, version: usesDesignSystem });
              }
            } catch {}
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ component, repos_using: results }, null, 2) }] };
      }
      case "validate_token_usage": {
        const { repo } = args as { repo: string };
        try {
          const content = await octokit.rest.repos.getContent({ owner: ORG, repo, path: "" });
          const files = content.data.filter(f => f.type === "file" && (f.name.endsWith(".css") || f.name.endsWith(".scss") || f.name === "tailwind.config.ts" || f.name === "tailwind.config.js"));
          const tokenUsage = [];
          for (const file of files.slice(0, 5)) {
            const fileContent = await octokit.rest.repos.getContent({ owner: ORG, repo, path: file.path });
            const text = Buffer.from(fileContent.data.content, "base64").toString();
            const hasBrandPrimary = text.includes("brand-primary") || text.includes("--color-brand-primary");
            const hasSpacing = text.includes("--space-") || text.includes("var(--space");
            const hasMotion = text.includes("--motion-") || text.includes("var(--motion");
            tokenUsage.push({ file: file.path, hasBrandPrimary, hasSpacing, hasMotion });
          }
          return { content: [{ type: "text", text: JSON.stringify({ repo, files_checked: tokenUsage.length, token_usage: tokenUsage }, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Repo not found or no access" }) }] };
        }
      }
      case "generate_component_boilerplate": {
        const { name, variant = "simple", description } = args as { name: string; variant?: "simple"|"compound"|"form"; description: string };
        const boilerplate = `import * as React from "react";
import { cn } from "../lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const ${name}Variants = cva(
  "base-styles-here",
  { variants: { variant: { default: "default-styles", secondary: "secondary-styles" }, size: { sm: "small", md: "medium", lg: "large" } }, defaultVariants: { variant: "default", size: "md" } }
);

export interface ${name}Props extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof ${name}Variants> {}

const ${name} = React.forwardRef<HTMLDivElement, ${name}Props>(({ className, variant, size, ...props }, ref) => (
  <div ref={ref} className={cn(${name}Variants({ variant, size }), className)} {...props} />
));
${name}.displayName = "${name}";

export { ${name}, ${name}Variants };
`;
        return { content: [{ type: "text", text: boilerplate }] };
      }
      default:
        throw new Error("Unknown tool: " + name);
    }
  } catch (error) {
    logger.error({ error, tool: name }, "Design system tool failed");
    return { content: [{ type: "text", text: "Error: " + (error instanceof Error ? error.message : String(error)) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info("Belentani Design System MCP Server running");