// src/langgraph/react-agent.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import {
  StateGraph, START, END, MessagesAnnotation, MemorySaver,
} from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { tool }     from '@langchain/core/tools'
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { config } from '../config'

// ── 工具定义 ──────────────────────────────────────────
const calculatorTool = tool(
  async ({ expression }) => {
    try {
      const result = Function(`'use strict'; return (${expression})`)()
      return `计算结果：${expression} = ${result}`
    } catch (e: any) {
      return `计算错误：${e.message}`
    }
  },
  {
    name:        'calculator',
    description: '计算数学表达式，例如：(2 + 3) * 4',
    schema:      z.object({
      expression: z.string().describe('合法的 JS 数学表达式'),
    }),
  }
)

const weatherTool = tool(
  async ({ city }) => {
    const mock: Record<string, string> = {
    '北京': '晴，25°C，东北风 3 级',
    '上海': '多云，28°C，东风 2 级',
    '武汉': '晴，30°C，南风 1 级',
    '广州': '雷阵雨，32°C，南风 2 级',
  }
  return mock[city] ?? `${city}：晴，22°C，微风`
},
{
  name:        'get_weather',
    description: '查询指定城市的当前天气',
    schema:      z.object({
    city: z.string().describe('城市名，如：北京、上海、武汉'),
  }),
    }
)

const tools = [calculatorTool, weatherTool]

@Injectable()
  export class ReactAgentService implements OnModuleInit {
    private graph: any

    onModuleInit() {
      const llm = new ChatOpenAI({
        model:         config.langGraph.model,
        apiKey:        config.langGraph.apiKey,
        configuration: { baseURL: config.langGraph.baseURL },
        temperature:   0,    // 工具调用用 0 温度，输出更确定
      })

      // bindTools：把工具的 name/description/schema 注入 LLM
      // LLM 推理时知道有哪些工具可以调，需要时自动生成 tool_calls
      const llmWithTools = llm.bindTools(tools)

      // ToolNode：封装"执行 LLM 返回的 tool_calls"的完整逻辑
      const toolNode = new ToolNode(tools)

      const callModel = async (state: typeof MessagesAnnotation.State) => {
        const messages = [
          new SystemMessage(`你是专业助手，可用工具：
- calculator：数学计算
- get_weather：查询天气
根据问题决定是否调用工具。`),
          ...state.messages,
        ]
        const response = await llmWithTools.invoke(messages)
        return { messages: [response] }
      }

      // 路由函数：检查最后一条消息是否包含 tool_calls
      const shouldContinue = (state: typeof MessagesAnnotation.State) => {
        const last = state.messages.at(-1) as AIMessage
        // 有 tool_calls → 去执行工具，继续循环
        // 没有 tool_calls → LLM 已给出最终答案，结束
        console.log('last:', last,11111)
        return (last.tool_calls?.length ?? 0) > 0 ? 'tools' : END
      }

      this.graph = new StateGraph(MessagesAnnotation)
        .addNode('callModel', callModel)
        .addNode('tools',     toolNode)
        .addEdge(START, 'callModel')
        .addConditionalEdges('callModel', shouldContinue, {
          tools: 'tools',
          [END]:  END,
        })
        .addEdge('tools', 'callModel')   // 工具执行完 → 回到 LLM，形成循环
      .compile({ checkpointer: new MemorySaver() })

    console.log('✅ ReAct Agent 初始化完成')
  }

  async chat(threadId: string, message: string): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(message)] },
      {
        configurable:   { thread_id: threadId },
        recursionLimit: 20,   // 最多循环 10 次工具调用，防止死循环
      }
    )
    return result.messages.at(-1).content as string
  }
}