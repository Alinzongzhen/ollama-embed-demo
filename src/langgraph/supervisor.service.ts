import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import {ChatOllama} from '@langchain/ollama';
import {
  StateGraph, START, END, MessagesAnnotation, Annotation,
} from '@langchain/langgraph'
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages'
import { config } from '../config'

/**
 * Supervisor 多智能体编排模式的状态定义
 * ──────────────────────────────────────
 * 用 Annotation 声明图的状态结构（类似 Redux 的 state）：
 *   - messages：      对话消息列表（LangGraph 内置的 MessagesAnnotation）
 *   - nextAgent：     Supervisor 决定下一步调用哪个 Worker，值为 'researcher' | 'analyst' | 'writer' | 'FINISH'
 *   - completedAgents：已完成的 Worker 名称数组，reducer 负责累积追加
 */
const SupervisorState = Annotation.Root({
  messages:        MessagesAnnotation.spec.messages,                     // 继承 LangGraph 内置消息列表
  nextAgent:       Annotation<string>(),                                 // 下一个要执行的 Agent 名称
  completedAgents: Annotation<string[]>({                                // 已完成的 Agent 列表
    reducer: (prev, curr) => [...prev, ...curr],  // 每次返回的 Agent 名都会追加到数组中
    default: () => [],
  }),
})

/**
 * Supervisor 多智能体编排服务
 * ──────────────────────────────
 * 架构：多个专业 Agent（Worker）由 Supervisor 统一调度，协作完成复杂任务。
 *
 * 工作流程：
 *   用户输入 → Supervisor 调度 → 选一个 Worker 干活 → 干完回报 Supervisor
 *   → Supervisor 再判断 → 继续派活 或 FINISH 结束
 *
 * 三个 Worker 角色：
 *   - researcher：研究员，收集整理信息
 *   - analyst：   分析师，数据分析和逻辑推理
 *   - writer：    写作专家，生成清晰报告
 */
@Injectable()
export class SupervisorService implements OnModuleInit {
  /** 编译后的 LangGraph 图实例 */
  private graph: any

  onModuleInit() {
    // ──────────── LLM 实例 ────────────
    // 共用同一个 ChatOllama，所有 Agent（包括 Supervisor）都通过它调用模型
    const llm = new ChatOllama({
        model:       config.langGraph.model,      // 模型名称，如 qwen3.5:0.8b
        temperature: config.langGraph.temperature, // 随机性，越低越确定
        baseUrl:     config.langGraph.baseURL,     // Ollama 服务地址
        think:       false,                        // 关闭思考模式，避免输出推理过程
        numPredict:  512,                          // 最大生成 token 数
    });

    // ──────────── Supervisor 节点（纯代码调度，不依赖 LLM）────────────
    // 顺序：researcher → analyst → writer → FINISH（与问题内容无关）
    const PIPELINE = ['researcher', 'analyst', 'writer'] as const

    const supervisor = async (state: typeof SupervisorState.State) => {
      const done = state.completedAgents

      // 按 PIPELINE 顺序找到第一个尚未调用的 Agent
      const nextAgent = PIPELINE.find(a => !done.includes(a)) ?? 'FINISH'

      console.log(`\n━━━ 📋 Supervisor 调度 ━━━`)
      console.log(`   已完成: [${done.join(', ') || '无'}]`)
      console.log(`   下一步: → ${nextAgent}`)

      return {
        nextAgent,                                              // 驱动条件边路由
        messages: [new AIMessage(`[Supervisor] 下一步 → ${nextAgent}`)], // 记录决策日志
      }
    }

    // ──────────── Worker 节点工厂（通用）────────────
    // 传入 name（如 'researcher'）和 prompt（系统提示词），返回一个图节点函数
    const createWorker = (name: string, prompt: string) =>
      async (state: typeof SupervisorState.State) => {
        console.log(`\n🔧 [${name}] 开始工作...`)
        // 找到用户最初的问题
        const userMsg = state.messages.find((m: any) => m._getType?.() === 'human')
        // 取最近 4 条消息作为上下文（避免 token 爆炸）
        const context = state.messages.slice(-4).map((m: any) => m.content).join('\n')

        const startTime = Date.now()
        const res = await llm.invoke([
          new SystemMessage(prompt),                                        // 角色定位
          new HumanMessage(`任务：${userMsg?.content ?? ''}\n\n当前上下文：\n${context}`),  // 任务 + 上下文
        ])
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

        const output = (res.content as string).slice(0, 80)
        console.log(`✅ [${name}] 工作完成 (耗时 ${elapsed}s) → ${output}...`)

        return {
          messages:        [new AIMessage(`[${name}] ${res.content}`)], // 标注 Agent 名称的消息
          completedAgents: [name],                                      // 标记该 Agent 已完成
        }
      }

    // ──────────── 编译有状态图 ────────────
    // 节点和边的拓扑结构如下：
    //
    //   START → supervisor ──┬→ researcher ──┐
    //          ↑  ↑  ↑       ├→ analyst   ──┤
    //          │  │  │       └→ writer    ──┘
    //          └──┴──┴──────────(完成后回到 supervisor)──── FINISH → END
    //
    this.graph = new StateGraph(SupervisorState)
      .addNode('supervisor', supervisor)                                                         // 注册调度节点
      .addNode('researcher', createWorker('researcher', '你是研究员，擅长收集整理信息。'))         // 注册研究员
      .addNode('analyst',    createWorker('analyst',    '你是分析师，擅长数据分析和推理。'))        // 注册分析师
      .addNode('writer',     createWorker('writer',     '你是写作专家，擅长生成清晰报告。'))        // 注册写作专家
      .addEdge(START, 'supervisor')                                                              // 入口 → supervisor
      .addConditionalEdges('supervisor',                                                         // supervisor 的条件路由
        (s) => s.nextAgent === 'FINISH' ? END : s.nextAgent,                                     // FINISH 则结束，否则去对应 Worker
        { researcher: 'researcher', analyst: 'analyst', writer: 'writer', [END]: END }           // 路由映射表
      )
      .addEdge('researcher', 'supervisor')  // 研究员干完 → 回报 supervisor
      .addEdge('analyst',    'supervisor')  // 分析师干完 → 回报 supervisor
      .addEdge('writer',     'supervisor')  // 写作专家干完 → 回报 supervisor
      .compile()                            // 编译图，生成可执行的 Runnable
  }

  /**
   * 对外暴露的执行入口
   * ──────────────────
   * @param userInput  用户的原始输入（自然语言）
   * @returns          { agentLog: 各 Agent 的执行日志, completedAgents: 完成的 Agent 列表, finalReport: 最终报告 }
   *
   * 流程：
   *   1. 将用户输入包装为 HumanMessage 注入图
   *   2. 图自动执行 Supervisor → Worker → Supervisor → ... → FINISH 循环
   *   3. recursionLimit=30 防止无限循环（最多执行 30 步）
   *   4. 从结果中提取以 '[' 开头的 Agent 日志消息
   *   5. 优先取 writer 的最后一次输出作为最终报告
   */
  async run(userInput: string) {
    const jobStart = Date.now()
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`🚀 启动 Supervisor 多 Agent 协作`)
    console.log(`   用户输入: "${userInput.slice(0, 100)}${userInput.length > 100 ? '...' : ''}"`)
    console.log(`${'═'.repeat(60)}`)

    // 执行图，最多循环 30 步防止死循环
    const result  = await this.graph.invoke(
      { messages: [new HumanMessage(userInput)] },
      { recursionLimit: 30 }
    )

    // 提取所有以 '[' 开头的 Agent 系统日志（如 [Supervisor]、[researcher] 等）
    const msgs     = result.messages as AIMessage[]
    const agentLog = msgs
      .filter((m: any) => typeof m.content === 'string' && m.content.startsWith('['))
      .map((m: any) => m.content as string)

    // 最终报告：优先取 writer 的最后输出，否则取最后一条 Agent 日志
    const writers     = agentLog.filter(l => l.startsWith('[writer]'))
    const finalReport = writers.length
      ? writers.at(-1)!.replace('[writer] ', '')   // 去掉前缀标记，返回纯文本报告
      : agentLog.at(-1) ?? '无输出'

    // 汇总：哪些 Agent 配发了，哪些跳过了
    const allAgents = ['researcher', 'analyst', 'writer'] as const
    const dispatched = allAgents.filter(a => result.completedAgents.includes(a))
    const skipped    = allAgents.filter(a => !result.completedAgents.includes(a))

    const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1)
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`🏁 协作完成! 总耗时 ${elapsed}s`)
    console.log(`${'═'.repeat(60)}`)
    console.log(`   调用次序: ${result.completedAgents.join(' → ') || '(无)'}`)
    console.log(`   已配发:   ${dispatched.join(' ✅  ') || '(无)'}`)
    console.log(`   未配发:   ${skipped.length ? skipped.join(' ⏭️  ') : '无（全部配发）'}`)
    console.log(`   最终报告: ${finalReport.slice(0, 120)}${finalReport.length > 120 ? '...' : ''}`)
    console.log(`${'═'.repeat(60)}\n`)

    return {
      agentLog,
      completedAgents: result.completedAgents,
      dispatchSummary: { dispatched, skipped },
      finalReport,
    }
  }
}
