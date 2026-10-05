import type {
  AbjectHandlers, AbjectMessage, PackageSettings, HttpResponse,
  LLMMessage, ProviderCompleteRequest, ProviderCompleteReply, RegisterProviderReply,
} from '../../sdk/script/abject';

/** The settings abject.json declares, entered in Settings → Packages. */
interface Settings {
  name: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string;
}

// A script package is one handler-map expression: helpers and constants live
// inside it as `_` members (they are not message handlers).
({
  _package: 'OpenAICompatible',

  /** The provider name this abject currently holds, if any (live state, not saved). */
  _registeredAs: null as string | null,

  /** The workspace started this package (it is tagged autostart): become a provider. */
  async startup() {
    await this.observe(this.dep('Packages'));
    return this._register();
  },

  /** Settings → Packages saved new settings for this package: register again with them. */
  async changed(msg: AbjectMessage<{ aspect: string; value?: { package?: string } }>) {
    if (msg.payload?.aspect === 'settingsChanged' && msg.payload.value?.package === this._package) await this._register();
    return true;
  },

  /** A completion the LLM object routed to this provider. */
  async providerComplete(msg: AbjectMessage<ProviderCompleteRequest>): Promise<ProviderCompleteReply> {
    const s: Partial<Settings> = await this._settings();
    const { messages, options } = msg.payload;
    const res = await this.call<HttpResponse>(this.dep('HttpClient'), 'request', {
      method: 'POST',
      url: `${(s.baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: messages.map((m: LLMMessage) => this._toOpenAI(m)),
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      timeout: 600_000,
    }, { timeout: 610_000 });
    if (!res.ok) throw new Error(`${s.baseUrl} answered ${res.status}: ${res.body.slice(0, 300)}`);

    const data = JSON.parse(res.body) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason === 'length' ? 'length' : 'stop',
      ...(data.usage ? { usage: { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } } : {}),
    };
  },

  /** An OpenAI chat message: text, or text and images as data URLs. Documents are dropped. */
  _toOpenAI(m: LLMMessage): { role: string; content: unknown } {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const parts: unknown[] = [];
    for (const p of m.content) {
      if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      else if (p.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
    }
    return { role: m.role, content: parts };
  },

  /** This package's settings (Packages answers only this package's own abjects). */
  async _settings(): Promise<Partial<Settings>> {
    const reply = await this.call<PackageSettings<Settings>>(this.dep('Packages'), 'getSettings', {});
    return reply.values;
  },

  /** Register (or re-register) with the LLM object under the configured name. */
  async _register(): Promise<{ registered: boolean; reason?: string; backends?: number }> {
    const s: Partial<Settings> = await this._settings();
    const models = (s.models ?? '').split(',').map((m: string) => m.trim()).filter(Boolean);
    const name = s.name || 'openai-compatible';
    const llm = await this.dep('LLM');

    // A renamed provider: withdraw the old name first.
    if (this._registeredAs && this._registeredAs !== name) {
      await this.call(llm, 'unregisterProvider', { name: this._registeredAs });
      this._registeredAs = null;
    }
    if (!s.baseUrl || models.length === 0) {
      return { registered: false, reason: 'Set Base URL and Models in Settings → Packages → OpenAICompatible.' };
    }

    const reply = await this.call<RegisterProviderReply>(llm, 'registerProvider', {
      name,
      label: s.label || 'OpenAI-compatible',
      models: models.map((id: string) => ({ id, name: id })),
      defaultTierModels: { smart: models[0], balanced: models[0], code: models[0], fast: models[models.length - 1] },
    });
    this._registeredAs = name;
    return { registered: true, backends: reply.backends };
  },
}) satisfies AbjectHandlers;
