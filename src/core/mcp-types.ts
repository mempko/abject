/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Covers JSON-RPC 2.0 message framing and MCP-specific request/response
 * structures for tool invocation, resource reading, and server initialization.
 */

// ═══════════════════════════════════════════════════════════════════════
// JSON-RPC 2.0
// ═══════════════════════════════════════════════════════════════════════

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ═══════════════════════════════════════════════════════════════════════
// MCP Initialization
// ═══════════════════════════════════════════════════════════════════════

export interface MCPClientInfo {
  name: string;
  version: string;
}

export interface MCPInitParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: MCPClientInfo;
}

export interface MCPServerInfo {
  name: string;
  version: string;
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
}

export interface MCPInitResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: MCPServerInfo;
}

// ═══════════════════════════════════════════════════════════════════════
// MCP Tools
// ═══════════════════════════════════════════════════════════════════════

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPContentItem {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri: string; mimeType?: string; text?: string };
}

export interface MCPToolCallResult {
  content: MCPContentItem[];
  isError?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// MCP Resources
// ═══════════════════════════════════════════════════════════════════════

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface MCPReadResourceResult {
  contents: MCPResourceContent[];
}

// ═══════════════════════════════════════════════════════════════════════
// MCP List responses
// ═══════════════════════════════════════════════════════════════════════

export interface MCPListToolsResult {
  tools: MCPToolDefinition[];
}

export interface MCPListResourcesResult {
  resources: MCPResourceDefinition[];
}
