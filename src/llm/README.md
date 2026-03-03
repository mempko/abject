# src/llm/ - LLM Provider Layer

Provider-agnostic LLM integration. Defines the abstract interface and provides implementations for Anthropic Claude, OpenAI, and Ollama (local).

## Files

### provider.ts

Abstract interface and shared utilities.

- **`LLMProvider`** interface: `name`, `isAvailable()`, `complete(messages, options)`, `stream?(messages, options)`
- **`LLMMessage`**: `{ role: 'system' | 'user' | 'assistant', content: string }`
- **`LLMCompletionOptions`**: `temperature`, `maxTokens`, `stopSequences`, `stream`
- **`LLMCompletionResult`**: `content`, `finishReason` (`'stop'` | `'length'` | `'error'`), `usage`
- **`BaseLLMProvider`**: abstract base with shared `fetch()` and `buildHeaders()`
- **`LLMProviderRegistry`**: `register()`, `get()`, `getDefault()`, `findAvailable()`
- **Helpers**: `systemMessage()`, `userMessage()`, `assistantMessage()`, `formatMessages()`

### anthropic.ts

Anthropic Claude API integration.

- Separates system message from conversation (Claude API format)
- Default model: `claude-sonnet-4-5-20250929`
- **Tier mapping**: `smart` → `claude-opus-4-6`, `balanced` → `claude-sonnet-4-6`, `fast` → `claude-haiku-4-5-20251001`
- SSE streaming via `ReadableStream`
- Authentication: `x-api-key` header + `anthropic-version`
- Factory: `createAnthropicProvider()` reads from `globalThis.ANTHROPIC_API_KEY`

### openai.ts

OpenAI Chat Completions API integration.

- Default model: `gpt-4-turbo-preview`
- **Tier mapping**: `smart` → `gpt-4o`, `balanced` → `gpt-4-turbo-preview`, `fast` → `gpt-4o-mini`
- SSE streaming with `[DONE]` sentinel
- Authentication: Bearer token
- Factory: `createOpenAIProvider()`

### ollama.ts

Local LLM via Ollama.

- Default URL: `http://localhost:11434`, default model: `llama3.2`
- Availability check via `/api/tags` endpoint (2s timeout)
- NDJSON streaming (not SSE)
- `listModels()`: enumerate available local models
- No API key required

## Usage

LLM providers are registered with the `LLMObject` system object, which exposes them to all other objects via the message bus. `ProxyGenerator` and `ObjectCreator` are the primary consumers. The `AgentAbject` also uses LLM completions for the observe→think→act loop.
