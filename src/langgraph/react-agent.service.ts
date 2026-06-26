// src/langgraph/react-agent.service.ts
// ═══════════════════════════════════════════════════════════════════════
// ReAct Agent 服务（Reasoning + Acting）
// 核心思想：LLM 自主推理"是否需要调用工具"，需要则生成 tool_calls，
//          执行完工具后将结果反馈给 LLM，LLM 再决定继续调工具还是给出最终答案。
// 工作流：START → callModel ⇄ tools → END
//         用户输入 → LLM 推理 → 需要工具？→ 执行工具 → 返回结果给 LLM
//                              → 不需要工具 → 返回最终答案
// ═══════════════════════════════════════════════════════════════════════

import { Injectable, OnModuleInit } from '@nestjs/common'//
import { ChatOpenAI } from '@langchain/openai'// OpenAI 模型，用于生成回复
import {
  StateGraph, START, END, MessagesAnnotation, MemorySaver,
} from '@langchain/langgraph'// 状态图，用于定义状态机
import { ToolNode } from '@langchain/langgraph/prebuilt'// 工具节点，用于调用工具
import { tool }     from '@langchain/core/tools'// 工具定义，用于创建可调用的函数
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { RunnableConfig } from '@langchain/core/runnables'// 运行时配置，用于传递 threadId 等信息
import { z } from 'zod'// 数据验证库，用于定义工具参数 schema
import { config } from '../config'// 配置文件，包含 API 密钥等

// ═══════════════════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════════════════

/**
 * 计算器工具
 * 使用 Function 构造函数动态执行 JS 数学表达式，支持四则运算、括号等
 * @param expression - 合法的 JS 数学表达式，例如 "(2 + 3) * 4"
 * @returns 计算结果字符串，出错时返回错误信息
 */
const calculatorTool = tool(
  async ({ expression }) => {
    try {
      // 使用 Function 构造函数在严格模式下执行表达式，避免恶意注入
      const result = Function(`'use strict'; return (${expression})`)()
      return `计算结果：${expression} = ${result}`
    } catch (e: any) {
      return `计算错误：${e.message}`
    }
  },
  {
    name:        'calculator',                            // 工具名称，LLM 通过 name 识别要调哪个工具
    description: '计算数学表达式，例如：(2 + 3) * 4',      // 描述，帮助 LLM 判断何时使用该工具
    schema:      z.object({                               // zod 定义工具参数 schema，LLM 按此格式生成参数
      expression: z.string().describe('合法的 JS 数学表达式'),
    }),
  }
)

/**
 * 天气查询工具（Mock 数据，实际项目可替换为真实 API）
 * 根据城市名返回模拟天气信息
 * @param city - 城市名，如：北京、上海、武汉、广州
 * @returns 该城市的天气描述字符串
 */
/**
 * 工具级缓存：按 threadId + 城市 缓存，不同用户不同会话互相隔离
 * 同一会话同一城市不重复调 API
 */
const weatherCache = new Map<string, { result: string; time: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟

const weatherTool = tool(
  async ({ city }, config?: RunnableConfig) => {
    // 从运行时 config 中提取 threadId，实现线程级缓存隔离
    const threadId = (config?.configurable as any)?.thread_id as string || '_global_'
    const cacheKey = `${threadId}::${city}`
    console.log(`🌤️ [weatherTool] 收到请求 city="${city}", threadId="${threadId}"`)

    // 检查缓存：同一 thread 同一城市 5 分钟内不重复调 API
    const cached = weatherCache.get(cacheKey)
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      console.log(`🌤️ [weatherTool] 命中缓存(${threadId})，跳过 API → "${cached.result}"`)
      return `[缓存] ${cached.result}`
    }

    try {
      // 1. 地理编码：城市名 → 经纬度（Open-Meteo Geocoding API，免费无 Key）
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`
      const geoRes = await fetch(geoUrl)
      const geoData = await geoRes.json() as any
      if (!geoData.results?.length) {
        return `${city}：未找到该城市，请检查城市名`
      }
      const { latitude, longitude, name, country } = geoData.results[0]
      console.log(`🌤️ [weatherTool] 地理编码: ${name}, ${country} (${latitude}, ${longitude})`)

      // 2. 获取天气数据（Open-Meteo Weather API，免费无 Key）
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`
      const weatherRes = await fetch(weatherUrl)
      const weatherData = await weatherRes.json() as any
      const current = weatherData.current
      if (!current) {
        return `${city}：天气数据获取失败`
      }

      // WMO 天气码 → 中文描述
      const weatherDesc: Record<number, string> = {
        0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
        45: '雾', 48: '雾凇', 51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
        61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪',
        80: '阵雨', 81: '大阵雨', 82: '暴阵雨', 85: '小阵雪', 86: '大阵雪',
        95: '雷暴', 96: '冰雹雷暴', 99: '大冰雹雷暴',
      }
      const wmoCode = current.weather_code ?? 0
      const desc = weatherDesc[wmoCode] ?? `天气码${wmoCode}`

      const result = `${name || city}：${desc}，${current.temperature_2m}°C，`
        + `湿度${current.relative_humidity_2m}%，风速${current.wind_speed_10m}km/h`

      // 写入缓存（按 threadId + 城市）
      weatherCache.set(cacheKey, { result, time: Date.now() })
      console.log(`🌤️ [weatherTool] 结果="${result}"`)
      return result
    } catch (e: any) {
      console.error(`🌤️ [weatherTool] API 调用失败:`, e.message)
      return `${city}：天气查询失败，请稍后重试`
    }
  },
  {
    name:        'get_weather',                            // 工具名称
    description: '查询指定城市的当前天气',                   // 描述，LLM 在用户问天气时会选择此工具
    schema:      z.object({
      city: z.string().describe('城市名，如：北京、上海、武汉'),//
    }),
    
  }
)
// bindTools 后 LLM "看到"的东西：
// {
//   "name": "get_weather",
//   "description": "查询指定城市的当前天气",
//   "parameters": {
//     "type": "object",
//     "properties": {
//       "city": {
//         "type": "string",
//         "description": "城市名，如：北京、上海、武汉"
//       }
//     },
//     "required": ["city"]
//   }
// }
// 汇总所有可用工具，后续会 bind 到 LLM 上
const tools = [calculatorTool, weatherTool]

// ═══════════════════════════════════════════════════════════════════════
// ReAct Agent 服务类
// 使用 OnModuleInit 生命周期钩子在模块初始化时构建 LangGraph 状态图
// ═══════════════════════════════════════════════════════════════════════

@Injectable()
export class ReactAgentService implements OnModuleInit {
  /** 编译后的 LangGraph 状态图实例 */
  private graph: any

  /**
   * 模块初始化时构建 ReAct Agent 图
   * 图的执行流程：
   *   START → callModel（LLM 推理）
   *            ├─ 有 tool_calls → tools（执行工具）→ 回到 callModel
   *            └─ 无 tool_calls → END（返回最终答案）
   */
  onModuleInit() {
    // ── 初始化 LLM ──
    // temperature=0 保证工具调用场景下输出更确定，减少幻觉
    const llm = new ChatOpenAI({
      model:         config.langGraph.model,
      apiKey:        config.langGraph.apiKey,
      configuration: { baseURL: config.langGraph.baseURL },
      temperature:   0,    // 工具调用用 0 温度，输出更确定
    })

    /**
     * bindTools：把工具的 name/description/schema 注入 LLM
     * LLM 推理时知道有哪些工具可以调，需要时自动生成 tool_calls
     * tool_calls 包含：工具 name 和符合 schema 的参数
     */
    const llmWithTools = llm.bindTools(tools)
    // bindTools 后 LLM "看到"的东西：
// {
//   "name": "get_weather",
//   "description": "查询指定城市的当前天气",
//   "parameters": {
//     "type": "object",
//     "properties": {
//       "city": {
//         "type": "string",
//         "description": "城市名，如：北京、上海、武汉"
//       }
//     },
//     "required": ["city"]
//   }
// }

    /**
     * ToolNode：LangGraph 预置节点，封装"执行 LLM 返回的 tool_calls"的完整逻辑
     * 它会自动解析 AIMessage 中的 tool_calls，逐一执行对应的工具函数，
     * 并将返回结果封装成 ToolMessage 追加到消息列表
     */
    const toolNode = new ToolNode(tools)

    /**
     * callModel 节点：调用 LLM 进行推理
     * 将 SystemMessage（工具说明）+ 历史消息一起发给 LLM
     * LLM 可能返回普通文本答案，也可能返回 tool_calls 请求
     */
    const callModel = async (state: typeof MessagesAnnotation.State) => {
      // 打印上下文消息数量，确认 MemorySaver 是否生效
      console.log(`📨 [callModel] 当前上下文消息数: ${state.messages.length}`)
      // 构建消息列表：系统提示词 + 历史对话消息
      const messages = [
        new SystemMessage(`你是专业助手。你必须严格遵守以下规则：
1. 当用户询问天气时，优先查看对话历史中是否已有 tool 返回的天气数据；若有且用户问题相同，直接引用历史数据回答，无需重复调用工具
2. 若历史中没有该城市的天气数据，或用户询问的是新城市，则必须调用 get_weather 工具查询
3. 当用户要求数学计算时，必须调用 calculator 工具
4. 不要猜测或编造数据，所有事实数据必须通过工具获取或从历史对话中引用
5. 工具返回结果后，基于结果用中文给出简洁回答`),
        ...state.messages,  // 包含用户历史消息、之前的工具调用结果等
      ]
      // 调用绑定了工具的 LLM，获取响应（可能是文本答案或 tool_calls）
      const response = await llmWithTools.invoke(messages)
    
      // 打印 token 消耗（Ollama ChatOpenAI 兼容模式下通过 response_metadata 返回）
      const tokenUsage = (response as any).response_metadata?.tokenUsage
        || (response as any).usage_metadata
      if (tokenUsage) {
        console.log(`📊 [callModel] Token消耗: 输入=${tokenUsage.input_tokens ?? tokenUsage.promptTokens}, 输出=${tokenUsage.output_tokens ?? tokenUsage.completionTokens}, 总计=${tokenUsage.total_tokens ?? tokenUsage.totalTokens}`)
      }

      const toolCalls = (response as AIMessage).tool_calls// 从 LLM 响应中提取 tool_calls 数组
      if (toolCalls?.length) {
        console.log(`🔧 [callModel] LLM 请求调用 ${toolCalls.length} 个工具：`, 
          JSON.stringify(toolCalls.map(t => ({ name: t.name, args: t.args }))))
      } else {
        console.log(`💬 [callModel] LLM 直接回复（无工具调用）：${(response.content as string).slice(0, 100)}...`)
      }

      // 将 LLM 响应追加到消息列表返回
      return { messages: [response] }
    }

    /**
     * shouldContinue 条件路由函数：检查最后一条消息是否包含 tool_calls
     * - 有 tool_calls → 路由到 'tools' 节点，执行工具调用
     * - 没有 tool_calls → 路由到 END，LLM 已给出最终答案，对话结束
     */
    const shouldContinue = (state: typeof MessagesAnnotation.State) => {

      // 获取消息列表最后一条，即 LLM 最新的响应
      const last = state.messages.at(-1) as AIMessage
      // 检查 AIMessage 中是否有 tool_calls 数组且长度大于 0
      return (last.tool_calls?.length ?? 0) > 0 ? 'tools' : END
    }

    // ── 构建 ReAct 状态图 ──
    // 图结构：
    //   START ──→ callModel ──┬──(有 tool_calls)──→ tools ──┐
    //                          │                              │
    //                          └──(无 tool_calls)──→ END      │
    //                                                         │
    //                          ←──────── 循环回去 ────────────┘
    this.graph = new StateGraph(MessagesAnnotation)       // 使用内置的消息注解作为状态
      .addNode('callModel', callModel)                     // 注册 LLM 推理节点
      .addNode('tools',     toolNode)                      // 注册工具执行节点
      .addEdge(START, 'callModel')                         // 入口：用户消息直接进入 LLM
      .addConditionalEdges('callModel', shouldContinue, {  // 条件分支：根据是否有 tool_calls 决定去向
        tools: 'tools',   // 有工具调用 → 执行工具
        [END]:  END,       // 无工具调用 → 结束对话
      })
      .addEdge('tools', 'callModel')   // 工具执行完后回到 LLM，由 LLM 决定是否继续调用工具
      .compile({
        checkpointer: new MemorySaver()  // 内存检查点，支持多轮对话上下文持久化
      })
       // ── 下面都是可选参数 ──
    //checkpointer,        // 检查点存储
    //interruptBefore,     // 在指定节点前挂起
    //interruptAfter,      // 在指定节点后挂起
    //store,               // 跨会话持久化存储（MemoryStore）
    //name,                // 图名称，用于日志/调试

    console.log('✅ ReAct Agent 初始化完成')
  }

  /**
   * 对外暴露的聊天接口
   * 每次调用 graph.invoke 会从检查点恢复历史消息，实现多轮对话
   * @param threadId - 会话线程 ID，同一 threadId 共享对话上下文
   * @param message  - 用户输入的消息
   * @returns LLM 最终回复的文本内容
   */
  async chat(threadId: string, message: string): Promise<string> {
    console.log(`\n🚀 [chat] ══════════════════════════════════════`)
    console.log(`🚀 [chat] threadId="${threadId}", 用户输入: "${message}"`)
    // 执行状态图，传入用户消息和运行时配置
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(message)] },
      {
        configurable:   { thread_id: threadId },  // thread_id 用于检查点隔离，不同会话互不干扰
        recursionLimit: 20,   // 最多允许 20 次节点跳转（LLM↔工具循环），防止死循环
      }
    )

    // 汇总本次执行所有 LLM 调用的 token 消耗
    let totalInput = 0, totalOutput = 0
    const allMsgs = result.messages as any[]
    allMsgs.forEach((m: any) => {
      const tu = m.response_metadata?.tokenUsage || m.usage_metadata
      if (tu) {
        totalInput  += tu.input_tokens  ?? tu.promptTokens     ?? 0
        totalOutput += tu.output_tokens ?? tu.completionTokens ?? 0
      }
    })
    console.log(`📊 [chat] 本轮总Token: 输入=${totalInput}, 输出=${totalOutput}, 合计=${totalInput + totalOutput}`)
    console.log(`📊 [chat] 上下文消息总数: ${allMsgs.length}`)
    console.log(`🚀 [chat] ══════════════════════════════════════\n`)

    // 返回最终消息的内容（最后一条消息即 LLM 的最终答案）
    return result.messages.at(-1).content as string
  }
}