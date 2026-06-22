// src/langgraph/code-review.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import { StateGraph, START, END, Annotation, Send, Command } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'

const ReviewState = Annotation.Root({
  code:     Annotation<string>(),
  language: Annotation<string>(),
  reviewResults: Annotation<{ aspect: string; issues: string[]; score: number }[]>({
  reducer: (prev, curr) => [...prev, ...curr],
  default: () => [],
}),
  report: Annotation<string>(),
  })

const SingleReviewState = Annotation.Root({
  code:     Annotation<string>(),
  language: Annotation<string>(),
  aspect:   Annotation<string>(),
  prompt:   Annotation<string>(),
})

@Injectable()
  export class CodeReviewService implements OnModuleInit {
    private graph: any

    onModuleInit() {
      const llm = new ChatOpenAI({
        model:         config.langGraph.model,
        apiKey:        config.langGraph.apiKey,
        configuration: { baseURL: config.langGraph.baseURL },
        temperature:   0,
      })

      // 分发节点：用 Send 同时启动 3 个审查实例
      const dispatch = (state: typeof ReviewState.State) => {
        const tasks = [
          {
            aspect: '安全性',
            prompt: `检查代码安全问题（SQL 注入、XSS、敏感信息泄露等）。
输出 JSON（不要其他内容）：{"issues":["问题描述"],"score":7}`,
          },
          {
            aspect: '性能',
            prompt: `检查代码性能问题（算法复杂度、N+1 查询、内存泄漏等）。
输出 JSON（不要其他内容）：{"issues":["问题描述"],"score":7}`,
          },
          {
            aspect: '代码规范',
            prompt: `检查代码规范（命名、注释、DRY 原则、错误处理等）。
输出 JSON（不要其他内容）：{"issues":["问题描述"],"score":7}`,
          },
        ]
        return new Command({
          goto: tasks.map(t =>
            new Send('reviewAgent', {
              code:     state.code,
              language: state.language,
              aspect:   t.aspect,
              prompt:   t.prompt,
            })
          ),
        })
      }

      // 审查节点：多个实例并行运行，各自处理一个维度
      const reviewAgent = async (state: typeof SingleReviewState.State) => {
        const res = await llm.invoke([
          new HumanMessage(
            `${state.prompt}\n\n${state.language} 代码：\n\`\`\`\n${state.code}\n\`\`\``
          ),
        ])
        let parsed: { issues: string[]; score: number }
        try {
          const json = (res.content as string).replace(/```json\n?|\n?```/g, '').trim()
          parsed = JSON.parse(json)
        } catch {
          parsed = { issues: ['结果解析失败'], score: 5 }
        }
        return {
          reviewResults: [{ aspect: state.aspect, ...parsed }],
        }
      }

      // 汇总节点：所有审查实例完成后生成综合报告
      const generateReport = async (state: typeof ReviewState.State) => {
        const avgScore = Math.round(
          state.reviewResults.reduce((s, r) => s + r.score, 0) / state.reviewResults.length
        )
        const detail = state.reviewResults
          .map(r => `【${r.aspect}】评分：${r.score}/10\n问题：\n${r.issues.map(i => `  - ${i}`).join('\n')}`)
          .join('\n\n')

        const res = await llm.invoke([
          new HumanMessage(
            `根据以下代码审查结果生成综合报告（综合评分、主要问题、改进建议）：\n\n${detail}`
        ),
      ])
      return { report: `综合评分：${avgScore}/10\n\n${res.content}` }
    }

    this.graph = new StateGraph(ReviewState)
      .addNode('dispatch',       dispatch,       { ends: ['reviewAgent'] })
      .addNode('reviewAgent',    reviewAgent,    { ends: ['generateReport'] })
      .addNode('generateReport', generateReport)
      .addEdge(START,            'dispatch')
      .addEdge('reviewAgent',    'generateReport')
      .addEdge('generateReport', END)
      .compile()
  }

  async review(code: string, language = 'TypeScript') {
    const t0 = Date.now()
    const result = await this.graph.invoke({ code, language })
    return {
      language,
      reviewResults: result.reviewResults,
      report:        result.report,
      totalTime:     `${Date.now() - t0}ms`,
    }
  }
}