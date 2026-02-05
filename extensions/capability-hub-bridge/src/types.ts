/**
 * Type definitions mirroring Capability-Hub's REST API responses.
 * These types correspond to the database schema and API DTOs in capability-hub.
 */

/**
 * Tool-specific details from the tools table.
 * Corresponds to capability-hub/src/database/schema/tools.ts
 */
export interface CapabilityToolDetail {
  id: string;
  capabilityId: string;
  functionName: string;
  parametersSchema: Record<string, unknown>;
  returnTypeSchema?: Record<string, unknown>;
  endpointUrl: string;
  invocationMethod: "http_post" | "http_get" | "grpc" | "graphql";
  authType: string | null;
  authConfig: Record<string, unknown> | null;
  timeoutMs: number;
  isStrict: boolean;
}

/**
 * A capability item as returned by GET /api/capabilities.
 * Corresponds to capability-hub/src/capabilities/capabilities.service.ts
 */
export interface CapabilityItem {
  id: string;
  name: string;
  description: string | null;
  version: string;
  type: "tool" | "skill" | "mcp";
  status: "active" | "inactive" | "deprecated" | "error";
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  tool?: CapabilityToolDetail | null;
  skill?: unknown;
  mcpServer?: unknown;
}

/**
 * Response from GET /api/capabilities search endpoint.
 * Corresponds to capability-hub/src/capabilities/dto/search-capabilities.dto.ts
 */
export interface SearchCapabilitiesResponse {
  items: CapabilityItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
  };
}

/**
 * Result from POST /api/invoke/:capabilityId proxy endpoint.
 * Corresponds to capability-hub/src/proxy/strategies/proxy-strategy.interface.ts
 */
export interface InvocationResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  metadata?: {
    latencyMs: number;
    upstream: string;
  };
}

/**
 * Plugin configuration schema.
 */
export interface BridgePluginConfig {
  baseUrl: string;
  authToken?: string;
  filter?: {
    tags?: string[];
    status?: "active" | "inactive";
  };
  timeout?: number;
  cache?: {
    enabled?: boolean;
    ttlMs?: number;
  };
}
