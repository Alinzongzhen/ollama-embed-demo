// src/langgraph/pipeline.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import { StateGraph, START, END, Annotation } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'

const PipelineState = Annotation.Root({
  topic:          Annotation<string>(),
  researchResult: Annotation<string>(),
  outlineResult:  Annotation<string>(),
  draft:          Annotation<string>(),
  finalArticle:   Annotation<string>(),
  progress:       Annotation<string[]>({
    reducer: (prev, curr) => [...prev, ...curr],
    default: () => [],
  }),
    })

@Injectable()
  export class PipelineService implements OnModuleInit {
    private graph: any

    onModuleInit() {
      const llm = new ChatOpenAI({
        model:         config.langGraph.model,
        apiKey:        config.langGraph.apiKey,
        configuration: { baseURL: config.langGraph.baseURL },
        temperature:   0.7,
      })

      const researchAgent = async (state: typeof PipelineState.State) => {
        const res = await llm.invoke([
          new HumanMessage(`你是研究员，为主题"${state.topic}"收集素材：
1. 背景介绍（2-3 句）
2. 核心要点（3-5 个）
3. 典型案例（1-2 个）
每条不超过 50 字。`),
        ])
        return { researchResult: res.content as string, progress: ['✅ 素材收集完成'] }
      }

      const outlineAgent = async (state: typeof PipelineState.State) => {
        const res = await llm.invoke([
          new HumanMessage(`你是内容策划，根据素材为"${state.topic}"生成大纲：
素材：${state.researchResult}
格式：# 章节 / - 子项，共 3-5 章`),
        ])
    
        return { outlineResult: res.content as string, progress: ['✅ 大纲生成完成'] }
      }

      const writingAgent = async (state: typeof PipelineState.State) => {
        const res = await llm.invoke([
          new HumanMessage(`你是撰稿人，根据大纲写文章（400-600 字）：
主题：${state.topic}
大纲：${state.outlineResult}
参考素材：${state.researchResult}`),
        ])
        
        return { draft: res.content as string, progress: ['✅ 初稿写作完成'] }
      }

      const reviewAgent = async (state: typeof PipelineState.State) => {
        const res = await llm.invoke([
          new HumanMessage(`你是编辑，优化以下文章，直接输出优化后全文：\n${state.draft}`),
        ])
            console.log('res.content', res.content)
        return { finalArticle: res.content as string, progress: ['✅ 审校优化完成'] }
      }

      this.graph = new StateGraph(PipelineState)
        .addNode('research', researchAgent)
        .addNode('outline',  outlineAgent)
        .addNode('writing',  writingAgent)
        .addNode('review',   reviewAgent)
        .addEdge(START,       'research')
        .addEdge('research',  'outline')
        .addEdge('outline',   'writing')
        .addEdge('writing',   'review')
        .addEdge('review',    END)
        .compile()
    }

    async createContent(topic: string) {
      const t0 = Date.now()
      const result = await this.graph.invoke({ topic })
      return {
        topic,
        progress:     result.progress,
        finalArticle: result.finalArticle,
        totalTime:    `${Date.now() - t0}ms`,
      }
    }
  }