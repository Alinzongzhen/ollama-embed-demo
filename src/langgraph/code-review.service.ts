// ============================================================
// src/langgraph/code-review.service.ts
// ============================================================
// 概述：
//   基于 LangGraph 的代码审查服务，采用「Fan-out / Map-Reduce」模式：
//     1. dispatch 节点将一份代码同时派发给 3 个审查维度（安全性/性能/代码规范）
//     2. 3 个 reviewAgent 实例并行运行，各自由独立的 LLM 调用完成审查
//     3. generateReport 等待全部审查完毕（barrier 同步），汇总生成综合报告
//
// 设计亮点：
//   - 使用 Command + Send API 实现真正的并行分发（而非顺序调用）
//   - 两层 State 设计：顶层 ReviewState 共享全局上下文，子图 SingleReviewState 隔离各审查维度
//   - reviewResults 使用累加 reducer，天然实现 3 路结果归并
//   - 每个维度独立 prompt，可灵活定制审查侧重点
//
// 局限性：
//   - 三个审查实例共享同一段代码原文，若代码过长（>8000 tokens）仍有 context window 风险
//   - reviewAgent 的 JSON 解析依赖 LLM 输出格式，稳定性受模型能力影响
//   - 未实现审查结果缓存，重复审查相同代码会浪费 token
// ============================================================

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { StateGraph, START, END, Annotation, Send, Command } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'

// ============================================================
// ReviewState - 顶层全局 State
// ============================================================
// 作用域：整个审查工作流共享，从 START 到 END 贯穿始终
// reviewResults 使用累加 reducer：
//   - 3 个 reviewAgent 返回各自的审查结果时，prev 为已有数据，curr 为新追加的数据
//   - LangGraph 自动触发 reducer 合并，最终得到包含 3 条记录的完整数组
//   - 注意：reducer 对顺序无保证（3 路并行，先完成的先累加），但这对汇总无影响
const ReviewState = Annotation.Root({
  code:     Annotation<string>(),   // 待审查的源代码（完整原文）
  language: Annotation<string>(),   // 代码语言（TypeScript / Python 等）
  reviewResults: Annotation<{ aspect: string; issues: string[]; score: number }[]>({
  reducer: (prev, curr) => [...prev, ...curr], // 累加：3 个维度的审查结果依次追加
  default: () => [],
}),
  report: Annotation<string>(),     // 最终生成的综合报告文本
  })

// ============================================================
// SingleReviewState - 子图局部 State
// ============================================================
// 作用域：仅存在于 dispatch → reviewAgent 之间的单次传递
// 设计原因：
//   - Command + Send 会为每个 Send 目标创建一个独立的 state 副本
//   - 3 个 reviewAgent 实例各自持有独立的 SingleReviewState，互不干扰
//   - aspect + prompt 字段使得每个实例知道自己在审查哪个维度，用什么指令
// 注意：
//   - 此 State 不会回流到顶层 ReviewState，仅在子图边界内流转
//   - reviewAgent 的返回值通过 reviewResults 字段写回顶层 State（累加 reducer）
const SingleReviewState = Annotation.Root({
  code:     Annotation<string>(),   // 待审查代码（与顶层同步，由 Send 携带）
  language: Annotation<string>(),   // 代码语言（与顶层同步，由 Send 携带）
  aspect:   Annotation<string>(),   // 审查维度（安全性 / 性能 / 代码规范）
  prompt:   Annotation<string>(),   // 该维度的审查提示词（由 dispatch 分发时注入）
})

// ============================================================
// CodeReviewService - NestJS 可注入服务
// ============================================================
// 实现 OnModuleInit：在模块初始化时构建 LangGraph 工作流
// graph 成员：持有编译后的 StateGraph 实例，供 review() 方法调用
@Injectable()
  export class CodeReviewService implements OnModuleInit {
    private graph: any

    // ============================================================
    // onModuleInit - 模块初始化钩子：构建 LangGraph 工作流
    // ============================================================
    onModuleInit() {
      // ----------------------------------------------------------
      // LLM 实例配置
      // ----------------------------------------------------------
      // 当前使用 ChatOllama（本地部署），注释部分为 ChatOpenAI（远程 API）
      // 关键参数说明：
      //   think: false    → 关闭思考链输出，避免审查结果被思考内容污染
      //   numPredict: 512 → 限制输出长度，审查结果通常不会超过此值
      //   temperature     → 较低温度（建议 0~0.3）可提高 JSON 输出稳定性
      // const llm = new ChatOpenAI({
      //   model:         config.langGraph.model,
      //   apiKey:        config.langGraph.apiKey,
      //   configuration: { baseURL: config.langGraph.baseURL + '/v1' },
      //   temperature:   config.langGraph.temperature,
      // })
           const llm = new ChatOllama({
            model: config.langGraph.model,        // Ollama 模型名称（如 qwen3.5:0.8b）
            temperature: config.langGraph.temperature, // 生成文本的随机程度
            baseUrl: config.langGraph.baseURL,    // Ollama 服务器地址（如 http://localhost:11434）
            think: false,  // 关闭思考模式 → 避免 reviewAgent 返回思考内容干扰 JSON 解析
            numPredict: 512, // 最大输出 token 数，512 足够覆盖审查结果（issues + score）
        }); 

      // ============================================================
      // dispatch 节点 ——「分发器」
      // ============================================================
      // 职责：将待审查代码并行派发给 3 个 reviewAgent 实例
      //
      // 工作原理：
      //   Command + Send API 是 LangGraph 的 fan-out 机制：
      //   1. Command.goto 接收一个 Send 数组
      //   2. 每个 Send 指定目标节点 + 携带的 state 数据
      //   3. LangGraph 为每个 Send 创建独立的执行分支，并行运行
      //   4. 所有分支都完成后，自动在下一个节点汇聚（barrier）
      //
      // 为什么不用 for 循环 + 顺序调用？
      //   - 并行派发 → 3 个 LLM 调用同时进行，总耗时 ≈ max(单个审查耗时)
      //   - 顺序调用 → 总耗时 = sum(三个审查耗时)，是并行的 ~3 倍
      const dispatch = (state: typeof ReviewState.State) => {
        // ----------------------------------------------------------
        // 三个审查维度的任务模板
        // ----------------------------------------------------------
        // 每个任务定义审查方向 + 专属 prompt
        // prompt 设计要求：
        //   - 明确输出格式为 JSON，避免 markdown 包裹
        //   - issues 数组即使没有发现问题也建议返回空数组而非省略
        //   - score 范围 0-10，便于后续计算平均分
        // 扩展建议：
        //   - 可新增维度：可维护性、可测试性、安全合规（GDPR/SOC2）等
        //   - 不同语言可定制不同的审查模板（Python 侧重 PEP8，TS 侧重 ESLint）
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

        // Command.goto 传入 Send[] → LangGraph 并行派发 3 个 reviewAgent
        // 每个 Send 携带独立的 SingleReviewState 副本，互不干扰
        return new Command({
          goto: tasks.map(t =>
            new Send('reviewAgent', {
              code:     state.code,      // 待审查代码原文（3 个实例共享）
              language: state.language,  // 语言类型
              aspect:   t.aspect,        // 当前审查维度标识
              prompt:   t.prompt,        // 当前审查维度专属 prompt
            })
          ),
        })
      }

      // ============================================================
      // reviewAgent 节点 ——「审查执行器」
      // ============================================================
      // 职责：接收 dispatch 分配的审查任务，调 LLM 完成单一维度的代码审查
      //
      // 执行特性：
      //   - 3 个实例并行运行，各自持有独立的 SingleReviewState
      //   - 每个实例调一次 LLM，共享同一个 llm 对象（ChatOllama 内部已处理并发）
      //   - reviewAgent 完成后将结果写入顶层 ReviewState.reviewResults（累加 reducer）
      //
      // JSON 解析策略：
      //   - 正则清理 markdown 代码块包裹（```json ... ```）
      //   - 解析失败时返回兜底值（score=5），不中断整体流程
      //   - 兜底设计保证：一个维度解析失败不影响其他两个维度的结果收集
      //
      // 注意：
      //   - reviewAgent 接收的是 SingleReviewState 的子集（code/language/aspect/prompt）
      //   - 返回值中的 reviewResults 会被 LangGraph 自动 merge 到顶层 State
      const reviewAgent = async (state: typeof SingleReviewState.State) => {
        // ----------------------------------------------------------
        // 组装 prompt → LLM 调用
        // ----------------------------------------------------------
        // prompt 结构：专属指令 + 语言标注 + 代码块
        // 使用 HumanMessage（而非 SystemMessage）：
        //   - Ollama 对小模型的 SystemMessage 支持不稳定
        //   - HumanMessage 作为通用载体更可靠
        const res = await llm.invoke([
          new HumanMessage(
            `${state.prompt}\n\n${state.language} 代码：\n\`\`\`\n${state.code}\n\`\`\``
          ),
        ])
        console.log(res.content,999999999)
        // ----------------------------------------------------------
        // JSON 解析与容错
        // ----------------------------------------------------------
        let parsed: { issues: string[]; score: number }
        try {
          // 1. 清理 markdown 代码块包裹（LLM 经常多输出 ```json ... ```）
          // 2. trim() 去除首尾空白
          // 3. JSON.parse 还原为对象
          const json = (res.content as string).replace(/```json\n?|\n?```/g, '').trim()
          parsed = JSON.parse(json)
        } catch {
          // 兜底策略：
          //   - 不做重试（会阻塞其他并行分支）
          //   - 返回占位数据，标记解析失败原因
          //   - 后续 generateReport 可根据 "结果解析失败" 判断是否需要人工复核
          parsed = { issues: ['结果解析失败'], score: 5 }
        }

        // ----------------------------------------------------------
        // 返回审查结果 → 写入顶层 ReviewState.reviewResults
        // ----------------------------------------------------------
        // 返回的 reviewResults 是一个单元素数组（当前维度的审查结果）
        // LangGraph 自动触发累加 reducer：(prev, curr) => [...prev, ...curr]
        // 最终顶层 State.reviewResults = [安全性结果, 性能结果, 代码规范结果]
        return {
          reviewResults: [{ aspect: state.aspect, ...parsed }],
        }
      }

      // ============================================================
      // generateReport 节点 ——「报告生成器」
      // ============================================================
      // 职责：等待 3 个 reviewAgent 全部完成后，汇总生成综合报告
      //
      // 触发时机：
      //   - 所有 Send 分支都执行完毕（barrier 同步）后自动进入此节点
      //   - 此时 state.reviewResults 已包含 3 条完整的审查记录
      //
      // 处理流程：
      //   1. 计算三个维度的平均分（取整）
      //   2. 拼接审查详情的格式化文本
      //   3. 调 LLM 生成结构化报告（综合评分 + 主要问题 + 改进建议）
      //
      // 设计考量：
      //   - 报告生成也使用 LLM，而非简单的字符串拼接
      //   - LLM 可以识别各维度问题的关联性（如：某个性能问题可能由安全修复引入）
      //   - 但增加了一次额外的 LLM 调用，如果不需要 AI 分析可省略此步骤
      const generateReport = async (state: typeof ReviewState.State) => {
        // ----------------------------------------------------------
        // 计算平均分 & 拼接审查详情
        // ----------------------------------------------------------
        // 平均分取整（Math.round），便于展示直观的评分
        // 拼接格式：每个维度一行标题 + 评分 + 问题列表
        const avgScore = Math.round(
          state.reviewResults.reduce((s, r) => s + r.score, 0) / state.reviewResults.length
        )
        const detail = state.reviewResults
          .map(r => `【${r.aspect}】评分：${r.score}/10\n问题：\n${r.issues.map(i => `  - ${i}`).join('\n')}`)
          .join('\n\n')

        // ----------------------------------------------------------
        // 调 LLM 生成综合报告
        // ----------------------------------------------------------
        // 注意：此处传入的是审查详情摘要（detail），而非原始代码
        // 好处：context window 更安全（detail 远小于原文，通常 < 500 tokens）
        // 风险：LLM 报告的准确性受 detail 质量影响（garbage in, garbage out）
        const res = await llm.invoke([
          new HumanMessage(
            `根据以下代码审查结果生成综合报告（综合评分、主要问题、改进建议）：\n\n${detail}`
        ),
      ])
      // 报告格式：综合评分（数字）+ LLM 生成的文本分析
      return { report: `综合评分：${avgScore}/10\n\n${res.content}` }
    }

    // ============================================================
    // 构建 LangGraph 工作流
    // ============================================================
    // 节点拓扑：
    //   START → dispatch → reviewAgent × 3（并行）
    //                             ↓
    //                     generateReport → END
    //
    // addNode 参数说明：
    //   - dispatch: { ends: ['reviewAgent'] }
    //     → Command.goto 指定目标为 reviewAgent，LangGraph 需预先声明这个目标
    //   - reviewAgent: { ends: ['generateReport'] }
    //     → 3 个实例完成后都汇聚到 generateReport（barrier）
    //   - generateReport 无 ends → 默认连接 END
    //
    // addEdge 说明：
    //   - START → dispatch：工作流入口
    //   - reviewAgent → generateReport：barrier 汇聚（LangGraph 自动等待所有实例）
    //   - generateReport → END：工作流出口
    //
    // 注意：
    //   - dispatch → reviewAgent 的连接由 Command.goto 动态决定，不需要 addEdge
    //   - compile() 会校验图的完整性（无孤立节点、无死循环）
    this.graph = new StateGraph(ReviewState)
      .addNode('dispatch',       dispatch,       { ends: ['reviewAgent'] })   // 分发 → 3 路并行审查
      .addNode('reviewAgent',    reviewAgent,    { ends: ['generateReport'] }) // 审查完成 → 汇聚到汇总
      .addNode('generateReport', generateReport)                                // 汇总 → END（默认连接）
      .addEdge(START,            'dispatch')        // 入口：START → dispatch
      .addEdge('reviewAgent',    'generateReport')  // 汇聚：3 路审查 → generateReport
      .addEdge('generateReport', END)               // 出口：generateReport → END
      .compile()
  }

  // ============================================================
  // review() - 对外入口方法
  // ============================================================
  // 参数：
  //   code     → 待审查的源代码字符串
  //   language → 代码语言（默认 TypeScript）
  //
  // 返回值：
  //   language       → 审查的语言
  //   reviewResults  → 三个维度的审查详情数组 [{aspect, issues, score}]
  //   report         → LLM 生成的综合报告文本
  //   totalTime      → 审查总耗时（毫秒），可用于性能监控
  //
  // 调用方式：通过 LangGraph 的 graph.invoke() 启动工作流
  // 注意：
  //   - invoke 是异步阻塞调用，返回时所有节点已执行完毕
  //   - 如需流式输出，可改用 graph.stream() 逐节点获取中间状态
  async review(code: string, language = 'TypeScript') {
    const t0 = Date.now()
    const result = await this.graph.invoke({ code, language })
    return {
      language,
      reviewResults: result.reviewResults,  // 三个维度的审查详情
      report:        result.report,          // LLM 生成的综合报告
      totalTime:     `${Date.now() - t0}ms`, // 总耗时（含 3 路并行 + 报告生成）
    }
  }
}