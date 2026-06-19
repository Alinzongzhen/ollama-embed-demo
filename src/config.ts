export const config = {
  langGraph: {
    model: 'qwen2.5:1.5b',
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    temperature: 0.3,
  },
  ollama: {
    chatModel: 'qwen2.5:1.5b',
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434',
    temperature: 0.3,
    host: 'localhost',
    port: 11434,
  },  
};
