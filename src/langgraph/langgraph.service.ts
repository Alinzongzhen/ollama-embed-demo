import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChatOllama } from '@langchain/ollama';
import { StateGraph, MessagesAnnotation, END, START,MemorySaver } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
@Injectable()
export class LanggraphService implements OnModuleInit {
    private simpleGraph: any;
    private memoryGraph: any;

    async onModuleInit() {
        const llm = new ChatOllama({
            model: 'qwen2.5:0.5b',       // 模型名称
            baseUrl: 'http://localhost:11434', // Ollama 服务地址
            temperature: 0.3,            // 生成文本随机性，默认值为 0.7
            think: false,                // 是否开启思考模式
            numPredict: 512,             // 生成文本的最大长度，单位为 token
        });

        const callModel = async (state: typeof MessagesAnnotation.State) => {
            const res = await llm.invoke(state.messages);// 调用模型，传入当前状态的消息数组
            return { messages: [res] };// 返回模型回复，封装为数组
        };
        const memoryCallModel = async (state: typeof MessagesAnnotation.State) => {
             const messages = [
          new SystemMessage('你是专业的 AI 助手，请记住对话上下文。'),
          ...state.messages,   // 展开全部历史，让 LLM 看到完整上下文
        ]
        console.log(messages,111)
            const response = await llm.invoke(messages);// 调用模型，传入当前状态的消息数组
            return { messages: [response] };// 返回模型回复，封装为数组
        };
        this.simpleGraph = new StateGraph(MessagesAnnotation)// 创建状态图
            .addNode('callModel', callModel)// 添加节点
            .addEdge(START, 'callModel')// 设置边，从 START 节点到 callModel 节点
            .addEdge('callModel', END)// 设置边，从 callModel 节点到 END 节点
            .compile();// 编译图
        
        this.memoryGraph = new StateGraph(MessagesAnnotation)
            .addNode('memoryCallModel', memoryCallModel)
            .addEdge(START, 'memoryCallModel')
            .addEdge('memoryCallModel', END)
            .compile({ checkpointer: new MemorySaver() }); // 传入 checkpointer 开启记忆
    }
     async simpleChat(message: string): Promise<string> {
      const result = await this.simpleGraph.invoke({
        messages: [
          new SystemMessage('你是专业的 AI 助手，回答简洁清晰。'),
          new HumanMessage(message),
        ],
      })
      return result.messages.at(-1).content as string
  }
  async memoryChat(message: string, threadId: string): Promise<string> {
    const result = await this.memoryGraph.invoke({
      messages: [
      
        new HumanMessage(message),
      ]
    },{ configurable: { thread_id: threadId } })// 设置线程 ID
    return result.messages.at(-1).content as string
  }
}
