const AppError = require('../errors/AppError.js');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

// Wrapper fino sobre a Chat Completions API da Groq (compatível com o formato OpenAI) — mesmo
// padrão de metaAdapter#postToGraphApi, sem SDK. Genérico e reaproveitável por qualquer feature de
// IA futura; o conteúdo do prompt e o parsing da resposta ficam por conta de quem chama.
class GroqAdapter {
    static async chatCompletion (prompt, { temperature = 0.2 } = {}) {
        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature,
                response_format: { type: 'json_object' }
            })
        });
        const data = await response.json();

        if (!response.ok) {
            console.error('Erro ao chamar Groq', { httpStatus: response.status, erro: data.error });
            throw new AppError(`Erro ao consultar IA: ${data.error?.message ?? 'erro desconhecido'}`);
        }

        return data.choices[0].message.content;
    }
}

module.exports = GroqAdapter;
