/**
 * Capability Hub Bridge Plugin for OpenClaw
 *
 * This plugin dynamically discovers and bridges tools from a Capability-Hub
 * instance, making them available to OpenClaw agents.
 *
 * Features:
 * - Automatic tool discovery from Capability-Hub's REST API
 * - Dynamic tool generation with proper schema handling
 * - Unified invocation through Capability-Hub's proxy endpoint
 * - Full integration with OpenClaw's tool policy system
 * - Sandbox-aware (tools are not available in sandboxed environments)
 *
 * Configuration example (in openclaw.config.yaml):
 * ```yaml
 * plugins:
 *   entries:
 *     capability-hub-bridge:
 *       enabled: true
 *       config:
 *         baseUrl: "http://localhost:3000/api"
 *         filter:
 *           tags: ["twitter"]
 *         timeout: 15000
 * ```
 */

import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import type { BridgePluginConfig, CapabilityItem } from "./src/types.js";
import { discoverTools } from "./src/discovery.js";
import { toToolName } from "./src/tool-factory.js";

const DEFAULT_TIMEOUT = 15000;

/**
 * Discover capabilities from Capability-Hub.
 */
async function getCapabilities(
  baseUrl: string,
  authToken: string | undefined,
  filter: BridgePluginConfig["filter"],
  timeout: number
): Promise<CapabilityItem[]> {
  return discoverTools({ baseUrl, authToken, filter, timeout });
}

/**
 * Find a capability by tool name (with underscore to hyphen conversion).
 */
function findCapabilityByToolName(
  capabilities: CapabilityItem[],
  toolName: string
): CapabilityItem | undefined {
  // Convert tool name back to capability name (underscores -> hyphens)
  const capabilityName = toolName.replace(/_/g, "-");
  return capabilities.find((cap) => cap.name === capabilityName);
}

/**
 * Invoke a capability through Capability-Hub's proxy endpoint.
 */
async function invokeCapability(
  baseUrl: string,
  authToken: string | undefined,
  capability: CapabilityItem,
  params: Record<string, unknown>,
  timeout: number
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const invokeUrl = `${normalizedBase}/invoke/${capability.id}`;
  const toolTimeout = capability.tool?.timeoutMs || timeout;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(invokeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      payload: params,
      timeout: toolTimeout,
    }),
    signal: AbortSignal.timeout(toolTimeout + 5000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    return {
      success: false,
      error: `HTTP ${response.status}: ${errorBody || response.statusText}`,
    };
  }

  const result = await response.json();
  return result;
}

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as unknown as BridgePluginConfig | undefined;

  // Validate required configuration early
  if (!config?.baseUrl) {
    api.logger.warn(
      "capability-hub-bridge: baseUrl not configured, skipping tool registration"
    );
    return;
  }

  const { baseUrl, authToken, filter, timeout } = config;
  const defaultTimeout = timeout ?? DEFAULT_TIMEOUT;

  // Register tools using a SYNCHRONOUS factory function.
  // This returns a single bridge tool that can invoke any capability.
  api.registerTool(
    (ctx) => {
      // Block in sandboxed environments for security
      if (ctx.sandboxed) {
        api.logger.debug?.(
          "capability-hub-bridge: skipping in sandboxed environment"
        );
        return null;
      }

      // Return a single bridge tool that handles all capability invocations
      return {
        name: "capability_hub_invoke",
        label: "Capability Hub Invoke",
        description: `Invoke tools from Capability-Hub at ${baseUrl}. Use this to call external capabilities like Twitter, GitHub, Slack, etc. First use capability_hub_list to see available tools, then invoke them by name.`,
        parameters: {
          type: "object",
          properties: {
            tool_name: {
              type: "string",
              description:
                "The name of the tool to invoke (e.g., 'twitter_search_tweets','twitter_get_trends'). Use capability_hub_list to see available tools.",
            },
            params: {
              type: "object",
              description:
                "Parameters to pass to the tool. Check the tool's schema for required and optional parameters.",
              additionalProperties: true,
            },
          },
          required: ["tool_name"],
          additionalProperties: false,
        },
        async execute(
          _id: string,
          args: Record<string, unknown>
        ) {
          const toolName = args.tool_name as string;
          const params = (args.params as Record<string, unknown>) || {};

          try {
            // Lazy-load capabilities
            const capabilities = await getCapabilities(
              baseUrl,
              authToken,
              filter,
              defaultTimeout
            );

            // Find the requested capability
            const capability = findCapabilityByToolName(capabilities, toolName);
            if (!capability) {
              const availableTools = capabilities
                .map((c) => toToolName(c.name))
                .join(", ");
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error: Tool '${toolName}' not found. Available tools: ${availableTools || "none"}`,
                  },
                ],
                details: { error: "tool_not_found", toolName, availableTools },
              };
            }

            // Invoke the capability
            const result = await invokeCapability(
              baseUrl,
              authToken,
              capability,
              params,
              defaultTimeout
            );

            if (!result.success) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error invoking ${toolName}: ${result.error || "Unknown error"}`,
                  },
                ],
                details: { error: result.error, toolName },
              };
            }

            const text =
              typeof result.data === "string"
                ? result.data
                : JSON.stringify(result.data, null, 2);

            return {
              content: [{ type: "text" as const, text }],
              details: result.data,
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: ${message}`,
                },
              ],
              details: { error: message },
            };
          }
        },
      };
    },
    {
      name: "capability_hub_invoke",
    }
  );

  // Register a tool to list available capabilities
  api.registerTool(
    (ctx) => {
      if (ctx.sandboxed) {
        return null;
      }

      return {
        name: "capability_hub_list",
        label: "Capability Hub List",
        description: `List all available tools from Capability-Hub at ${baseUrl}. Use this to discover what tools are available before invoking them.`,
        parameters: {
          type: "object",
          properties: {
            tag: {
              type: "string",
              description: "Optional: filter tools by tag (e.g., 'twitter')",
            },
          },
          additionalProperties: false,
        },
        async execute(_id: string, args: Record<string, unknown>) {
          const tagFilter = args.tag as string | undefined;

          try {
            const capabilities = await getCapabilities(
              baseUrl,
              authToken,
              filter,
              defaultTimeout
            );

            let filtered = capabilities;
            if (tagFilter) {
              filtered = capabilities.filter((cap) =>
                cap.tags.some(
                  (t) => t.toLowerCase() === tagFilter.toLowerCase()
                )
              );
            }

            if (filtered.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: tagFilter
                      ? `No tools found with tag '${tagFilter}'.`
                      : "No tools available from Capability-Hub.",
                  },
                ],
                details: { tools: [], tagFilter },
              };
            }

            const toolList = filtered.map((cap) => ({
              name: toToolName(cap.name),
              description: cap.description,
              tags: cap.tags,
              parameters: cap.tool?.parametersSchema,
            }));

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(toolList, null, 2),
                },
              ],
              details: { tools: toolList },
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error discovering tools: ${message}`,
                },
              ],
              details: { error: message },
            };
          }
        },
      };
    },
    {
      name: "capability_hub_list",
    }
  );

  api.logger.info(
    `capability-hub-bridge: registered bridge tools (invoke + list) for ${baseUrl}`
  );

  // Register a gateway method to check bridge status
  api.registerGatewayMethod("capability_hub_bridge_status", async (opts) => {
    try {
      const capabilities = await getCapabilities(
        baseUrl,
        authToken,
        filter,
        defaultTimeout
      );

      opts.respond(true, {
        configured: true,
        baseUrl,
        toolCount: capabilities.length,
        tools: capabilities.map((cap) => ({
          id: cap.id,
          name: cap.name,
          toolName: toToolName(cap.name),
          description: cap.description,
          tags: cap.tags,
        })),
      });
    } catch (error) {
      opts.respond(true, {
        configured: true,
        baseUrl,
        error: error instanceof Error ? error.message : "Discovery failed",
      });
    }
  });
}
