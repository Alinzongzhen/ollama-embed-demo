import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import {ChatOllama} from '@langchain/ollama';
import {
  StateGraph, START, END, MessagesAnnotation, Annotation,
} from '@langchain/langgraph'
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages'
import { config } from '../config'

const SupervisorState = Annotation.Root({
  messages:        MessagesAnnotation.spec.messages,
  nextAgent:       Annotation<string>(),
  completedAgents: Annotation<string[]>({
    reducer: (prev, curr) => [...prev, ...curr],
    default: () => [],
  }),
})

@Injectable()
export class SupervisorService implements OnModuleInit {
  private graph: any

  onModuleInit() {
    // const llm = new ChatOpenAI({
    //   model:         config.langGraph.model,
    //   apiKey:        config.langGraph.apiKey,
    //   configuration: { baseURL: config.langGraph.baseURL },
    //   temperature:   0,
    // });
    // 创建 chatOllama 实例
    const llm = new ChatOllama({
        model: config.langGraph.model, // Ollama 模型名称
        temperature: config.langGraph.temperature, // 生成文本的随机程度
        baseUrl: config.langGraph.baseURL, // Ollama 服务器地址
        think: false, // 是否开启思考模式，开启后模型会先返回一个思考中的消息，等生成完成后再返回最终回答
        numPredict: 512, // 生成文本的最大 token 数量，512 是一个比较合理的值，可以根据需要调整
    }); 

    const supervisor = async (state: typeof SupervisorState.State) => {
      const done = state.completedAgents.length
        ? `已完成：${state.completedAgents.join('、')}`
        : '尚未调用任何 Agent'
      const res = await llm.invoke([
       new SystemMessage(`
你是 Supervisor（任务协调者），负责拆解用户请求，指派合适的 Agent 处理。

- researcher：擅长搜索、收集、整理外部信息（如市场数据、竞品分析）
- analyst：擅长数学计算、逻辑推理、数据对比、趋势判断
- writer：擅长将前两步的结论组织成结构化文档或建议

决策规则：
1. 任务需要查资料 → 先派 researcher
2. 需要分析或推理 → 派 analyst（可以基于 researcher 的结果）
3. 需要出报告或建议 → 派 writer（等前两步完成）
4. 简单问候或闲聊 → 直接 FINISH
5. 当前状态：${done}

【输出规则】
只输出一个单词：researcher / analyst / writer / FINISH
不要解释，不要多写任何字`),
        ...state.messages,
      ])
      const next     = (res.content as string).trim()
      const valid    = ['researcher', 'analyst', 'writer', 'FINISH']
      const safeNext = valid.includes(next) ? next : 'FINISH'
      console.log(`[Supervisor] Next agent: ${safeNext}`)
      return {
        nextAgent: safeNext,
        messages:  [new AIMessage(`[Supervisor] 下一步 → ${safeNext}`)],
      }
    }

    const createWorker = (name: string, prompt: string) =>
      async (state: typeof SupervisorState.State) => {
        const userMsg = state.messages.find((m: any) => m._getType?.() === 'human')
        const context = state.messages.slice(-4).map((m: any) => m.content).join('\n')
        const res = await llm.invoke([
          new SystemMessage(prompt),
          new HumanMessage(`任务：${userMsg?.content ?? ''}\n\n当前上下文：\n${context}`),
        ])
        return {
          messages:        [new AIMessage(`[${name}] ${res.content}`)],
          completedAgents: [name],
        }
      }

    this.graph = new StateGraph(SupervisorState)
      .addNode('supervisor', supervisor)
      .addNode('researcher', createWorker('researcher', '你是研究员，擅长收集整理信息。'))
      .addNode('analyst',    createWorker('analyst',    '你是分析师，擅长数据分析和推理。'))
      .addNode('writer',     createWorker('writer',     '你是写作专家，擅长生成清晰报告。'))
      .addEdge(START, 'supervisor')
      .addConditionalEdges('supervisor',
        (s) => s.nextAgent === 'FINISH' ? END : s.nextAgent,
        { researcher: 'researcher', analyst: 'analyst', writer: 'writer', [END]: END }
      )
      .addEdge('researcher', 'supervisor')
      .addEdge('analyst',    'supervisor')
      .addEdge('writer',     'supervisor')
      .compile()
  }

  async run(userInput: string) {
    const result  = await this.graph.invoke(
      { messages: [new HumanMessage(userInput)] },
      { recursionLimit: 30 }
    )
    const msgs     = result.messages as AIMessage[]
    const agentLog = msgs
      .filter((m: any) => typeof m.content === 'string' && m.content.startsWith('['))
      .map((m: any) => m.content as string)
    const writers     = agentLog.filter(l => l.startsWith('[writer]'))
    const finalReport = writers.length
      ? writers.at(-1)!.replace('[writer] ', '')
      : agentLog.at(-1) ?? '无输出'
    return { agentLog, completedAgents: result.completedAgents, finalReport }
  }
}
