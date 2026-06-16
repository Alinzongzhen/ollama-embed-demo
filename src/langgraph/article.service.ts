// src/langgraph/article.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import { StateGraph, START, END, Annotation } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'

// 自定义 State：定义这个工作流里所有节点共享的数据结构
const ArticleState = Annotation.Root({
  // 原始文章（输入，各节点只读）
  article:  Annotation<string>(),

  // 关键词数组（extractKeywords 写入，generateSummary 读取）
  // reducer 追加：如果并行有多个节点写入，不会互相覆盖
  keywords: Annotation<string[]>({
    reducer: (prev, curr) => [...prev, ...curr],
    default: () => [],
  }),

    // 最终摘要（generateSummary 写入）
    summary:  Annotation<string>(),

  // 执行日志（每个节点追加自己的耗时）
  log:      Annotation<string[]>({
    reducer: (prev, curr) => [...prev, ...curr],
    default: () => [],
  }),
    })

@Injectable()
  export class ArticleService implements OnModuleInit {
    private graph: any

    onModuleInit() {
      const llm = new ChatOpenAI({
        model:         config.langGraph.model,
        apiKey:        config.langGraph.apiKey,
        configuration: { baseURL: config.langGraph.baseURL },
        temperature:   0.3,    // 摘要任务用低温度，输出更稳定
      })

      // 节点一：提取关键词
      const extractKeywords = async (state: typeof ArticleState.State) => {
        const t0 = Date.now()
        const res = await llm.invoke([
          new HumanMessage(
            `从以下文章提取 5-8 个核心关键词，只输出关键词，逗号分隔，不要其他内容：\n\n${state.article}`
          ),
        ])

        const keywords = (res.content as string)
          .split(/[,，]/).map(k => k.trim()).filter(Boolean)/// 1. 中英文按逗号分割，2. 去空格，3. 过滤空字符串
        return {
          keywords,
          log: [`关键词提取完成（${Date.now() - t0}ms）`],
        }
      }

      // 节点二：生成摘要
      // state.keywords 此时已经是 extractKeywords 写入的值
      const generateSummary = async (state: typeof ArticleState.State) => {
        const t0 = Date.now()
        const res = await llm.invoke([
          new HumanMessage(
            `根据以下文章生成 200 字以内的摘要。\n关键词参考：${state.keywords.join('、')}\n\n文章：\n${state.article}`
          ),
        ])
        return {
          summary: res.content as string,
          log:     [`摘要生成完成（${Date.now() - t0}ms）`],
        }
      }

      this.graph = new StateGraph(ArticleState)
        .addNode('extractKeywords', extractKeywords)
        .addNode('generateSummary', generateSummary)
        .addEdge(START, 'extractKeywords')
        .addEdge('extractKeywords', 'generateSummary')  // 串行：先提关键词再生成摘要
        .addEdge('generateSummary', END)
        .compile()
    }

    async process(article: string) {
      const result = await this.graph.invoke({ article })
      console.log(result,999999999)
      return {
        keywords: result.keywords,
        summary:  result.summary,
        log:      result.log,
      }
    }
  }