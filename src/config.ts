export const config = {
  langGraph: {
    model: 'qwen3.5:0.8b',
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    temperature: 0.3,
  },
  ollama: {
    chatModel: 'qwen3.5:0.8b',
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434',
    temperature: 0.3,
    host: 'localhost',
    port: 11434,
  },  
};
