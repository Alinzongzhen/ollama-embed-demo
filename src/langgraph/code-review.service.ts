// src/langgraph/code-review.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOllama } from '@langchain/ollama'
import { StateGraph, START, END, Annotation, Send, Command } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'

// 顶层 State：贯穿整个审查流程的全局状态
const ReviewState = Annotation.Root({
  code:     Annotation<string>(),   // 待审查的源代码
  language: Annotation<string>(),   // 代码语言（TypeScript / Python 等）
  reviewResults: Annotation<{ aspect: string; issues: string[]; score: number }[]>({
  reducer: (prev, curr) => [...prev, ...curr], // 累加：3 个维度的审查结果依次追加
  default: () => [],
}),
  report: Annotation<string>(),     // 最终生成的综合报告
  })

// 子图 State：单个审查实例的局部状态（dispatch → reviewAgent 之间传递）
const SingleReviewState = Annotation.Root({
  code:     Annotation<string>(),   // 待审查代码
  language: Annotation<string>(),   // 代码语言
  aspect:   Annotation<string>(),   // 审查维度（安全性 / 性能 / 代码规范）
  prompt:   Annotation<string>(),   // 该维度的审查提示词
})

@Injectable()
  export class CodeReviewService implements OnModuleInit {
    private graph: any

    onModuleInit() {
      const llm = new ChatOllama({
        model: config.langGraph.model,
        temperature: config.langGraph.temperature,
        baseUrl: config.langGraph.baseURL,
        think: false,
        numPredict: 512,
      })

      // 分发节点：用 Send API 同时启动 3 个并行审查实例（安全性 / 性能 / 代码规范）
      const dispatch = (state: typeof ReviewState.State) => {
        // 定义三个审查维度的任务模板
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
        // Command + Send：将 3 个任务并行派发给 reviewAgent，各自携带独立 state 副本
        return new Command({
          goto: tasks.map(t =>
            new Send('reviewAgent', {
              code:     state.code,      // 传入待审查代码
              language: state.language,  // 传入语言类型
              aspect:   t.aspect,        // 当前审查维度
              prompt:   t.prompt,        // 当前审查提示词
            })
          ),
        })
      }

      // 审查节点：3 个实例并行运行，各自处理一个维度（安全性 / 性能 / 代码规范）
      const reviewAgent = async (state: typeof SingleReviewState.State) => {
        // 组装提示词 + 代码，发给 LLM 审查
        const res = await llm.invoke([
          new HumanMessage(
            `${state.prompt}\n\n${state.language} 代码：\n\`\`\`\n${state.code}\n\`\`\``
          ),
        ])
        let parsed: { issues: string[]; score: number }
        try {
          // LLM 返回的 JSON 可能被 markdown 代码块包裹，需要清理后解析
          const json = (res.content as string).replace(/```json\n?|\n?```/g, '').trim()
          parsed = JSON.parse(json)
        } catch {
          // 解析失败时给默认值，避免整个流程崩溃
          parsed = { issues: ['结果解析失败'], score: 5 }
        }
        return {
          // 将结果追加到顶层 state 的 reviewResults 数组
          reviewResults: [{ aspect: state.aspect, ...parsed }],
        }
      }

      // 汇总节点：等待 3 个审查实例全部完成后，生成综合报告
      const generateReport = async (state: typeof ReviewState.State) => {
        // 计算三个维度的平均分
        const avgScore = Math.round(
          state.reviewResults.reduce((s, r) => s + r.score, 0) / state.reviewResults.length
        )
        // 将三个维度的审查详情拼接成文本
        const detail = state.reviewResults
          .map(r => `【${r.aspect}】评分：${r.score}/10\n问题：\n${r.issues.map(i => `  - ${i}`).join('\n')}`)
          .join('\n\n')

        // 让 LLM 基于审查详情生成结构化的综合报告
        const res = await llm.invoke([
          new HumanMessage(
            `根据以下代码审查结果生成综合报告（综合评分、主要问题、改进建议）：\n\n${detail}`
        ),
      ])
      return { report: `综合评分：${avgScore}/10\n\n${res.content}` }
    }

    // 构建 LangGraph 工作流
    this.graph = new StateGraph(ReviewState)
      .addNode('dispatch',       dispatch,       { ends: ['reviewAgent'] }) // 分发 → 3 个并行审查实例
      .addNode('reviewAgent',    reviewAgent,    { ends: ['generateReport'] }) // 审查完成后统一进入汇总
      .addNode('generateReport', generateReport)  // 汇总 → END
      .addEdge(START,            'dispatch')
      .addEdge('reviewAgent',    'generateReport')
      .addEdge('generateReport', END)
      .compile()
  }

  // 对外暴露的入口方法：接收代码 + 语言，启动审查工作流
  async review(code: string, language = 'TypeScript') {
    const t0 = Date.now()
    // 启动图工作流，传入待审查的代码和语言
    const result = await this.graph.invoke({ code, language })
    return {
      language,
      reviewResults: result.reviewResults,  // 三个维度的审查详情
      report:        result.report,          // LLM 生成的综合报告
      totalTime:     `${Date.now() - t0}ms`, // 总耗时
    }
  }
}