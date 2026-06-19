// src/langgraph/supervisor.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
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
      const llm = new ChatOpenAI({
        model:         config.langGraph.model,
        apiKey:        config.langGraph.apiKey,
        configuration: { baseURL: config.langGraph.baseURL },
        temperature:   0,
      })

      // Supervisor 节点：LLM 决定下一步调哪个 Agent
      const supervisor = async (state: typeof SupervisorState.State) => {
        const done = state.completedAgents.length
          ? `已完成：${state.completedAgents.join('、')}`
          : '尚未调用任何 Agent'

        const res = await llm.invoke([
          new SystemMessage(`你是任务协调者，管理以下专业 Agent：
- researcher：收集信息、搜索资料
- analyst：数据分析、逻辑推理
- writer：撰写报告、优化表达

规则：
1. ${done}。若当前无任何 Agent 已完成，你必须先派发一个合适的 Agent，禁止直接 FINISH
2. 至少依次派发 researcher → analyst → writer 三个 Agent 各一次后，才可输出 FINISH
3. 只输出下一个 Agent 名称或 FINISH，不要任何解释

可选值：researcher | analyst | writer | FINISH`),
          ...state.messages,
        ])
      

        const raw = (res.content as string).trim()
        const valid = ['researcher', 'analyst', 'writer', 'FINISH']
        // 模糊匹配：容忍 LLM 输出额外的标点或解释文字
        let safeNext = valid.find(v => raw.includes(v)) ?? 'FINISH'

        // 强制顺序：三个核心 Agent 必须全部跑过才允许 FINISH
        const required = ['researcher', 'analyst', 'writer']
        const missing = required.filter(a => !state.completedAgents.includes(a))
  console.log(res.content ,missing, 'res') 
        if (safeNext === 'FINISH' && missing.length > 0) {
          safeNext = missing[0] // 按顺序补上缺失的 Agent
          console.log(`[supervisor] LLM 想 FINISH，但尚未执行：${missing.join('、')}，强制 → ${safeNext}`)
        }

        // 防止 LLM 重复调度已完成的 Agent
        if (safeNext !== 'FINISH' && state.completedAgents.includes(safeNext)) {
          if (missing.length > 0) {
            console.log(`[supervisor] LLM 想重复调用 ${safeNext}，改为 → ${missing[0]}`)
            safeNext = missing[0]
          } else {
            console.log(`[supervisor] LLM 想重复调用 ${safeNext}，但全部 Agent 已完成 → FINISH`)
            safeNext = 'FINISH'
          }
        }

        return {
          nextAgent: safeNext,
          messages:  [new AIMessage(`[Supervisor] 下一步 → ${safeNext}`)],
        }
      }

      // 路由函数：FINISH → END，其他 → 对应 Worker 节点
      const routeToAgent = (state: typeof SupervisorState.State) =>
        state.nextAgent === 'FINISH' ? END : state.nextAgent

      // Worker 工厂函数：避免三个 Worker 节点重复代码
      const createWorker = (name: string, systemPrompt: string) =>
        async (state: typeof SupervisorState.State) => {
          // 取第一条用户消息作为任务描述
          const userMsg = state.messages.find(m => m instanceof HumanMessage)
          // 取最近 4 条消息作为上下文（包含其他 Agent 的输出）
          const context = state.messages.slice(-4).map(m => m.content).join('\n')

          const res = await llm.invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(
              `原始任务：${userMsg?.content ?? ''}\n\n当前上下文：\n${context}`
            ),
          ])

          return {
            messages:        [new AIMessage(`[${name}] ${res.content}`)],
            completedAgents: [name],
          }
        }

      this.graph = new StateGraph(SupervisorState)
        .addNode('supervisor', supervisor)
        .addNode('researcher', createWorker('researcher', '你是研究员，擅长收集整理信息，提供详细调研结果。'))
        .addNode('analyst',    createWorker('analyst',    '你是分析师，擅长数据分析，提供洞察和建议。'))
      .addNode('writer',     createWorker('writer',     '你是写作专家，把信息整理成清晰专业的报告。'))
      .addEdge(START, 'supervisor')
      .addConditionalEdges('supervisor', routeToAgent, {
        researcher: 'researcher',
        analyst:    'analyst',
        writer:     'writer',
        [END]:      END,
      })
      // 所有 Worker 完成后都回到 supervisor，让它决定下一步
      .addEdge('researcher', 'supervisor')
      .addEdge('analyst',    'supervisor')
      .addEdge('writer',     'supervisor')
      .compile()
  }

  async run(userInput: string) {
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(userInput)] },
      { recursionLimit: 30 }
    )

    const messages  = result.messages as AIMessage[]
    const agentLog  = messages
      .filter(m => typeof m.content === 'string' && (m.content as string).startsWith('['))
      .map(m => m.content as string)

    const writerOutputs = agentLog.filter(l => l.startsWith('[writer]'))
    const finalReport   = writerOutputs.length
      ? writerOutputs.at(-1)!.replace('[writer] ', '')
      : agentLog.at(-1) ?? '无输出'

    return {
      agentLog,
      completedAgents: result.completedAgents,
      finalReport,
    }
  }
}