// src/langgraph/article.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common'
import { StateGraph, START, END, Annotation } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'
import { ChatOllama } from '@langchain/ollama'

// 自定义 State：定义这个工作流里所有节点共享的数据结构
const ArticleState = Annotation.Root({
  // 原始文章（输入，只读）
  article: Annotation<string>(),

  // 文章分块数量（batchExtract 写入）
  chunkCount: Annotation<number>(),

  // 关键词数组（batchExtract 写入原始数据，mergeAndSummarize 去重覆盖）
  keywords: Annotation<string[]>({
    reducer: (_, curr) => curr,      // 去重后直接覆盖
    default: () => [],
  }),

  // 各分块的段落摘要（batchExtract 写入，mergeAndSummarize 读取）
  chunkSummaries: Annotation<string[]>({
    reducer: (_, curr) => curr,
    default: () => [],
  }),

  // 最终摘要（mergeAndSummarize 写入）
  summary: Annotation<string>(),

  // 执行日志（每个节点追加自己的耗时）
  log: Annotation<string[]>({
    reducer: (prev, curr) => [...prev, ...curr],
    default: () => [],
  }),
})

@Injectable()
  export class ArticleService implements OnModuleInit {
    private graph: any

    // 每块最大字符数（约 3000 字符 ≈ 750 token，安全落在 context window 内）
    private readonly CHUNK_SIZE = 3000;

    onModuleInit() {
      const llm = new ChatOllama({
        model: config.langGraph.model,
        temperature: config.langGraph.temperature,
        baseUrl: config.langGraph.baseURL,
        think: false,
        numPredict: 512,
      })

      /**
       * 节点一：分块 → 逐块并行提取关键词 + 段落摘要
       */
      const batchExtract = async (state: typeof ArticleState.State) => {
        const t0 = Date.now()
        const article = state.article

        // 1. 按 CHUNK_SIZE 切块
        const chunks: string[] = []
        for (let i = 0; i < article.length; i += this.CHUNK_SIZE) {
          chunks.push(article.slice(i, i + this.CHUNK_SIZE))
        }

        // 2. 并行处理每个分块
        const results = await Promise.all(
          chunks.map(async (chunk, idx) => {
            const res = await llm.invoke([
              new HumanMessage(
                `从以下文章片段（第 ${idx + 1}/${chunks.length} 部分）提取 3~5 个核心关键词，并生成一句话段落摘要（不超过50字）。\n\n请严格按以下格式输出：\n关键词：xxx,xxx,xxx\n摘要：xxx\n\n文章片段：\n${chunk}`
              ),
            ])
            return { idx, text: res.content as string }
          })
        )
        // 3. 解析 LLM 输出
        const allKeywords: string[] = []
        const chunkSummaries: string[] = new Array(chunks.length).fill('')

        for (const r of results) {
          const text = r.text
          const kwMatch = text.match(/关键词[：:]\s*(.+)/)
          const sumMatch = text.match(/摘要[：:]\s*(.+)/)
          if (kwMatch) {
            allKeywords.push(...kwMatch[1].split(/[,，]/).map(k => k.trim()).filter(Boolean))
          }
          if (sumMatch) {
            chunkSummaries[r.idx] = sumMatch[1]
          }
        }

        return {
          chunkCount: chunks.length,
          keywords: allKeywords,
          chunkSummaries,
          log: [`分块提取完成：${chunks.length} 块，${Date.now() - t0}ms`],
        }
      }

      /**
       * 节点二：关键词去重排序 → 用段落摘要合成总摘要
       */
      const mergeAndSummarize = async (state: typeof ArticleState.State) => {
        const t0 = Date.now()

        // 1. 关键词按频次排序，取 top 8
        const freqMap = new Map<string, number>()
        for (const kw of state.keywords) {
          freqMap.set(kw, (freqMap.get(kw) || 0) + 1)
        }
        const topKeywords = [...freqMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([k]) => k)

        // 2. 用各段落摘要合成总摘要
        const segmentText = state.chunkSummaries
          .map((s, i) => `[段${i + 1}] ${s}`)
          .join('\n')

        const res = await llm.invoke([
          new HumanMessage(
            `根据以下各段落的摘要，整合生成一篇 200 字以内的全文摘要。\n\n关键词参考：${topKeywords.join('、')}\n\n各段落摘要：\n${segmentText}`
          ),
        ])

        return {
          keywords: topKeywords,
          summary: res.content as string,
          log: [`汇总摘要完成（${Date.now() - t0}ms）`],
        }
      }

      this.graph = new StateGraph(ArticleState)
        .addNode('batchExtract', batchExtract)
        .addNode('mergeAndSummarize', mergeAndSummarize)
        .addEdge(START, 'batchExtract')
        .addEdge('batchExtract', 'mergeAndSummarize')
        .addEdge('mergeAndSummarize', END)
        .compile()
    }

    async process(article: string) {
      const result = await this.graph.invoke({ article })
      console.log(result, 999999999)
      return {
        keywords:   result.keywords,
        summary:    result.summary,
        log:        result.log,
        chunkCount: result.chunkCount,   // 告知调用方文章被分成了几块
      }
    }
  }