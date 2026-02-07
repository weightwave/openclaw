# Capability Hub Bridge Plugin

A bridge plugin that dynamically discovers and exposes tools from a [Capability-Hub](../../capability-hub) instance to OpenClaw agents.

## Features

- **Automatic Discovery**: Fetches all available tool capabilities from Capability-Hub's REST API at startup
- **Dynamic Tool Generation**: Creates OpenClaw Agent Tools from discovered capabilities with proper schema handling
- **Unified Invocation**: All tool calls go through Capability-Hub's proxy endpoint, which handles authentication, status checking, and error normalization
- **Policy Integration**: Bridged tools fully integrate with OpenClaw's tool policy system (allow/deny lists, agent-specific policies, etc.)
- **Sandbox Aware**: Tools are automatically disabled in sandboxed environments for security

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  OpenClaw Agent │────▶│ Capability Hub Bridge│────▶│  Capability Hub  │
│                 │     │      (this plugin)   │     │                  │
│  LLM decides to │     │                      │     │  GET /capabilities│
│  call tool      │     │  1. Discover tools   │     │  POST /invoke/:id │
│                 │     │  2. Generate tools   │     │                  │
│                 │     │  3. Forward calls    │     │  Twitter, GitHub, │
│                 │     │                      │     │  Slack, etc.     │
└─────────────────┘     └──────────────────────┘     └──────────────────┘
```

## Configuration

Add the following to your `openclaw.config.yaml`:

```yaml
plugins:
  entries:
    capability-hub-bridge:
      enabled: true
      config:
        # Required: Capability-Hub API base URL
        baseUrl: "http://localhost:3000/api"

        # Optional: Filter which tools to discover
        filter:
          tags: ["twitter"]       # Only tools with these tags
          status: "active"        # Only active capabilities (default)

        # Optional: Default timeout for tool invocations (ms)
        timeout: 15000
```

## Tool Policy

Bridged tools follow OpenClaw's standard tool policy system. You can control access at various levels:

### Global Level

```yaml
tools:
  allow:
    - "twitter_create_tweet"
    - "twitter_search_tweets"
  deny:
    - "twitter_delete_tweet"
```

### Agent Level

```yaml
agents:
  list:
    - id: social-media-manager
      tools:
        allow: ["twitter_*"]
    - id: researcher
      tools:
        deny: ["twitter_*"]
```

### Group Level (for chat channels)

```yaml
channels:
  telegram:
    groups:
      "marketing-team":
        tools:
          allow: ["twitter_create_tweet"]
```

## Tool Naming

Capability-Hub uses hyphens in capability names (e.g., `twitter-create-tweet`), while OpenClaw uses underscores. The plugin automatically converts:

| Capability-Hub Name | OpenClaw Tool Name |
|---------------------|-------------------|
| `twitter-create-tweet` | `twitter_create_tweet` |
| `github-create-issue` | `github_create_issue` |

## Gateway Method

The plugin registers a gateway method `capability_hub_bridge_status` that can be used to check the bridge status:

```typescript
// Returns:
{
  configured: true,
  baseUrl: "http://localhost:3000/api",
  toolCount: 6,
  tools: [
    { id: "uuid", name: "twitter-create-tweet", toolName: "twitter_create_tweet", ... },
    ...
  ]
}
```

## Error Handling

The plugin handles various error scenarios:

| Scenario | Behavior |
|----------|----------|
| Capability-Hub unreachable | Logs error, continues without bridged tools |
| Discovery API returns error | Logs error with status code, continues without bridged tools |
| Tool invocation fails | Returns formatted error to LLM with details |
| Request timeout | Returns timeout error with context |
| Sandboxed environment | Silently skips tool registration |

## Requirements

- Capability-Hub must be running and accessible
- The configured `baseUrl` must be reachable from the OpenClaw process
- Tools in Capability-Hub must have `status: "active"` to be discovered

## Development

The plugin consists of the following modules:

- `index.ts` - Plugin entry point, registers tool factory and gateway method
- `src/types.ts` - TypeScript types mirroring Capability-Hub's API
- `src/discovery.ts` - Tool discovery logic with pagination
- `src/tool-factory.ts` - Generates OpenClaw tools from capabilities

## License

MIT
