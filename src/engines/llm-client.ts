import type { Config } from '../config.js';

interface LlmPayload {
    systemPrompt?: string;
    userPrompt: string;
}

export async function callLlmApi(config: Config, payload: LlmPayload): Promise<string> {
    switch (config.engine) {
        case 'ollama':
            return callOllama(config, payload);
        case 'openai':
            return callOpenAI(config, payload);
        case 'gemini':
            return callGemini(config, payload);
        case 'anthropic':
            throw new Error('Anthropic engine not implemented.');
        case 'none':
        default:
            throw new Error('Cannot call LLM API with engine "none"');
    }
}

async function callOllama(config: Config, payload: LlmPayload): Promise<string> {
    const OLLAMA_API = 'http://127.0.0.1:11434/api/generate';
    const fullPrompt = [payload.systemPrompt, payload.userPrompt].filter(Boolean).join('\n\n');

    try {
        const response = await fetch(OLLAMA_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.model,
                prompt: fullPrompt,
                stream: false,
                options: { temperature: 0.7, top_p: 0.9 },
            }),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
        }
        const data = await response.json() as any;
        const text = data?.response ?? '';
        if (!text) throw new Error('Empty response from Ollama');
        return text;
    } catch (error) {
        if (error instanceof TypeError && error.message.includes('fetch')) {
            throw new Error(`Cannot connect to Ollama at ${OLLAMA_API}. Is ollama serve running?`);
        }
        throw error;
    }
}

async function callOpenAI(config: Config, payload: LlmPayload): Promise<string> {
    const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not found.');

    const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
    const modelName = config.model && !config.model.includes(':') ? config.model : 'gpt-4o-mini';

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (payload.systemPrompt) {
        messages.push({ role: 'system', content: payload.systemPrompt });
    }
    messages.push({ role: 'user', content: payload.userPrompt });

    const body = {
        model: modelName,
        temperature: 0.7,
        top_p: 0.9,
        messages,
    };

    try {
        const response = await fetch(OPENAI_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            let details = '';
            try {
                const err: any = await response.json();
                if (err?.error?.message) details = ` - ${err.error.message}`;
            } catch { }
            if (response.status === 401) throw new Error('OpenAI HTTP 401: Unauthorized - check OPENAI_API_KEY');
            throw new Error(`OpenAI HTTP ${response.status}${details}`);
        }
        const data = await response.json() as any;
        const text = data?.choices?.[0]?.message?.content ?? '';
        if (!text) throw new Error('Empty response from OpenAI');
        return text;
    } catch (error) {
        if (error instanceof TypeError && error.message.includes('fetch')) {
            throw new Error('Network error calling OpenAI. Check internet connectivity.');
        }
        throw error;
    }
}

async function callGemini(config: Config, payload: LlmPayload): Promise<string> {
    const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY not found.');

    const modelName = config.model && !config.model.includes(':') ? config.model : 'gemini-1.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const contents = [{ role: 'user', parts: [{ text: payload.userPrompt }] }];
    const body: any = {
        contents,
        generationConfig: { temperature: 0.7, topP: 0.9 },
    };

    if (payload.systemPrompt) {
        body.systemInstruction = { parts: [{ text: payload.systemPrompt }] };
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            let details = '';
            try {
                const err: any = await response.json();
                if (err?.error?.message) details = ` - ${err.error.message}`;
            } catch { }
            if (response.status === 401 || response.status === 403) throw new Error(`Gemini HTTP ${response.status}: Unauthorized/Forbidden - check API key`);
            throw new Error(`Gemini HTTP ${response.status}${details}`);
        }
        const data = await response.json() as any;
        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
        if (!text) throw new Error('Empty response from Gemini');
        return text;
    } catch (error) {
        if (error instanceof TypeError && error.message.includes('fetch')) {
            throw new Error('Network error calling Gemini. Check internet connectivity.');
        }
        throw error;
    }
}