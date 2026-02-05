/**
 * Tool discovery module.
 * Fetches available tool capabilities from Capability-Hub's REST API.
 */

import type {
  CapabilityItem,
  SearchCapabilitiesResponse,
  BridgePluginConfig,
} from "./types.js";

export interface DiscoveryOptions {
  baseUrl: string;
  authToken?: string;
  filter?: BridgePluginConfig["filter"];
  timeout?: number;
}

/**
 * Discovers all active tool capabilities from Capability-Hub.
 * Handles pagination automatically to fetch all available tools.
 *
 * @param options Discovery options including baseUrl and filters
 * @returns Array of capability items that have tool details
 */
export async function discoverTools(
  options: DiscoveryOptions
): Promise<CapabilityItem[]> {
  const { baseUrl, authToken, filter, timeout = 10000 } = options;
  const allTools: CapabilityItem[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const url = buildSearchUrl(baseUrl, { page, limit, filter });

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new DiscoveryError(
        `Capability-Hub discovery failed: HTTP ${response.status}`,
        response.status,
        errorBody
      );
    }

    const rawBody = await response.json();

    // Handle wrapped response format: { success: true, data: { items, meta } }
    const body: SearchCapabilitiesResponse =
      rawBody.data && rawBody.data.items ? rawBody.data : rawBody;

    // Filter to only items that have tool details populated
    const toolItems = body.items.filter(
      (item) => item.type === "tool" && item.tool != null
    );
    allTools.push(...toolItems);

    // Check if we've fetched all pages
    if (body.items.length < limit || allTools.length >= body.meta.total) {
      break;
    }

    page++;

    // Safety limit to prevent infinite loops
    if (page > 100) {
      break;
    }
  }

  return allTools;
}

/**
 * Builds the search URL with query parameters.
 */
function buildSearchUrl(
  baseUrl: string,
  params: {
    page: number;
    limit: number;
    filter?: BridgePluginConfig["filter"];
  }
): URL {
  // Normalize baseUrl - remove trailing slash if present
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = new URL(`${normalizedBase}/capabilities`);

  url.searchParams.set("type", "tool");
  url.searchParams.set("status", params.filter?.status ?? "active");
  url.searchParams.set("page", String(params.page));
  url.searchParams.set("limit", String(params.limit));

  // Add tag filters if specified
  if (params.filter?.tags && params.filter.tags.length > 0) {
    for (const tag of params.filter.tags) {
      url.searchParams.append("tags", tag);
    }
  }

  return url;
}

/**
 * Custom error class for discovery failures.
 */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}
