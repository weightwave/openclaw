/**
 * Tool factory module.
 * Dynamically generates OpenClaw Agent Tools from Capability-Hub capabilities.
 */

import type { CapabilityItem, InvocationResult } from "./types.js";

/**
 * Options for creating tools from capabilities.
 */
export interface ToolFactoryOptions {
  baseUrl: string;
  defaultTimeout: number;
}

/**
 * The shape of an OpenClaw Agent Tool.
 * Matches the AnyAgentTool interface from pi-agent-core.
 */
export interface GeneratedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

/**
 * Converts a Capability-Hub capability name to an OpenClaw tool name.
 * OpenClaw uses underscores; Capability-Hub uses hyphens.
 *
 * @example "twitter-create-tweet" → "twitter_create_tweet"
 */
export function toToolName(capabilityName: string): string {
  return capabilityName.replace(/-/g, "_");
}

/**
 * Patches a JSON Schema to ensure compatibility with various LLM providers.
 * Some providers (like Claude) have specific requirements for tool schemas.
 */
function patchSchemaForCompatibility(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const patched = { ...schema };

  // Ensure object schemas have additionalProperties: false
  // This is required by some LLM providers
  if (patched.type === "object" && patched.additionalProperties === undefined) {
    patched.additionalProperties = false;
  }

  // Recursively patch nested object schemas in properties
  if (patched.properties && typeof patched.properties === "object") {
    const patchedProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      patched.properties as Record<string, unknown>
    )) {
      if (value && typeof value === "object") {
        patchedProperties[key] = patchSchemaForCompatibility(
          value as Record<string, unknown>
        );
      } else {
        patchedProperties[key] = value;
      }
    }
    patched.properties = patchedProperties;
  }

  return patched;
}

/**
 * Creates an OpenClaw Agent Tool from a Capability-Hub capability.
 *
 * The generated tool will invoke the capability through Capability-Hub's
 * unified proxy endpoint (POST /api/invoke/:capabilityId), which handles:
 * - Status checking (only active capabilities can be invoked)
 * - Authentication (based on authType/authConfig in the tools table)
 * - Timeout management
 * - Error handling and response normalization
 */
export function createToolFromCapability(
  capability: CapabilityItem,
  options: ToolFactoryOptions
): GeneratedTool {
  const tool = capability.tool!;
  const toolName = toToolName(capability.name);
  const { baseUrl, defaultTimeout } = options;

  // Normalize baseUrl
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  // Determine the timeout for this tool
  const toolTimeout = tool.timeoutMs || defaultTimeout;

  return {
    name: toolName,
    description:
      capability.description ?? `Invoke ${capability.name} via Capability Hub`,

    // Use the parametersSchema from the database, with compatibility patches
    parameters: patchSchemaForCompatibility(tool.parametersSchema),

    async execute(
      _id: string,
      params: Record<string, unknown>
    ): Promise<ToolResult> {
      const invokeUrl = `${normalizedBase}/invoke/${capability.id}`;

      try {
        const response = await fetch(invokeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            payload: params,
            timeout: toolTimeout,
          }),
          // Add buffer time to the fetch timeout to allow for network overhead
          signal: AbortSignal.timeout(toolTimeout + 5000),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          return formatErrorResult(
            `HTTP ${response.status}`,
            errorBody || response.statusText,
            { url: invokeUrl, status: response.status }
          );
        }

        const result = (await response.json()) as InvocationResult;

        if (!result.success) {
          return formatErrorResult(
            result.error?.code ?? "UNKNOWN_ERROR",
            result.error?.message ?? "Tool invocation failed",
            result.error?.details
          );
        }

        return formatSuccessResult(result.data, result.metadata);
      } catch (error) {
        return formatCatchError(error, invokeUrl);
      }
    },
  };
}

/**
 * Formats a successful tool result.
 */
function formatSuccessResult(
  data: unknown,
  metadata?: InvocationResult["metadata"]
): ToolResult {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

  return {
    content: [{ type: "text", text }],
    details: { data, metadata },
  };
}

/**
 * Formats an error result from a known error response.
 */
function formatErrorResult(
  code: string,
  message: string,
  details?: unknown
): ToolResult {
  const errorText = `Error [${code}]: ${message}${
    details ? `\nDetails: ${JSON.stringify(details, null, 2)}` : ""
  }`;

  return {
    content: [{ type: "text", text: errorText }],
    details: { error: { code, message, details } },
  };
}

/**
 * Formats an error result from a caught exception.
 */
function formatCatchError(error: unknown, url: string): ToolResult {
  // Handle timeout errors
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return formatErrorResult("TIMEOUT", "Request timed out", { url });
  }

  // Handle abort errors
  if (error instanceof DOMException && error.name === "AbortError") {
    return formatErrorResult("ABORTED", "Request was aborted", { url });
  }

  // Handle network errors
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return formatErrorResult(
      "NETWORK_ERROR",
      "Failed to connect to Capability Hub",
      { url, originalError: error.message }
    );
  }

  // Generic error handling
  const message = error instanceof Error ? error.message : String(error);
  return formatErrorResult("INVOCATION_ERROR", message, { url });
}

/**
 * Creates multiple tools from an array of capabilities.
 */
export function createToolsFromCapabilities(
  capabilities: CapabilityItem[],
  options: ToolFactoryOptions
): GeneratedTool[] {
  return capabilities
    .filter((cap) => cap.tool != null)
    .map((cap) => createToolFromCapability(cap, options));
}
