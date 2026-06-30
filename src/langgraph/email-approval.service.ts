// ============================================================
// src/langgraph/email-approval.service.ts
// ============================================================
// 概述：
//   基于 LangGraph 的邮件起草 + 人工审批工作流，核心模式：**Human-in-the-Loop（HITL）**
//   流程：LLM 起草邮件 → interrupt 暂停等人工审批 → 批准发送 / 拒绝取消 / 修改重写
//
// 设计亮点：
//   - interrupt() 实现人机协作：工作流在审批节点挂起，等待外部 API 调用 resume
//   - 条件路由：审批结果（approved / rejected / need_modify）驱动不同分支
//   - 循环修订：need_modify → draftNode → waitNode，支持多轮修改
//   - MemorySaver 持久化：interrupt 期间 state 保存在内存，resume 后恢复执行
//   - threadId 多实例隔离：每个审批请求独立线程，互不干扰
//
// 关键 API：
//   - interrupt({ type, message, draft, options })
//     → 暂停工作流，将审批信息暴露给外部调用方
//   - Command({ resume: 'approved' })
//     → 外部传入审批决定，工作流从 interrupt 处继续执行
//   - graph.getState({ configurable: { thread_id } })
//     → 查询任意 thread 的当前状态，无需等待工作流完成
//
// 局限性：
//   - MemorySaver 仅内存存储，服务重启后所有审批状态丢失（生产环境应换数据库 checkpointer）
//   - 无审批超时机制（若用户一直不审批，工作流永久挂起）
//   - 无审批人身份校验（任何持有 threadId 的人都可以 approve/reject）
// ============================================================

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import {
  StateGraph, START, END, Annotation,
  MemorySaver, interrupt, Command,
} from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'

// ============================================================
// EmailState - 邮件审批工作流的全局 State
// ============================================================
// 各字段生命周期：
//   emailRequest   → 入口传入，贯穿全程不变
//   draftEmail     → draftNode 产出，waitNode 展示，sendNode 使用
//   approvalStatus → waitNode 根据人工决定写入，路由函数据此分支
//   modifyFeedback → 人工审批选择"修改"时写入，draftNode 据此重写
//   revisionCount  → 使用累加 reducer：(prev, curr) => prev + curr
//                     draftNode 每次修改时加 1，累计修订次数
//   finalStatus    → sendNode 或 cancelNode 写入，表示最终结果
//
// 注意：revisionCount 的 reducer 是加法（prev + curr），而非覆盖
//   - draftNode 返回 { revisionCount: 1 } 时：
//     第 1 次：prev=0, curr=1 → 0+1=1
//     第 2 次：prev=1, curr=1 → 1+1=2
//     第 3 次：prev=2, curr=1 → 2+1=3
//   - 与 code-review 的数组累加不同，这里是数值累加
const EmailState = Annotation.Root({
  emailRequest: Annotation<string>(),// 邮件起草需求（用户输入的自然语言描述）
  draftEmail: Annotation<{ subject: string; recipient: string; body: string }>(),// 已起草的邮件内容（subject/recipient/body）
  approvalStatus: Annotation<'pending' | 'approved' | 'rejected' | 'need_modify'>(),// 审批状态（pending=待审批, approved=批准, rejected=拒绝, need_modify=需修改）
  modifyFeedback: Annotation<string>(),// 修改意见（审批人选择"修改"时填写的反馈文本）
  revisionCount: Annotation<number>({
    reducer: (prev, curr) => prev + curr, // 累加：每次修改 +1
    default: () => 0,                      // 初始修订次数为 0
  }),// 已修订次数
  finalStatus: Annotation<string>(),// 最终状态文本（发送成功 / 取消原因）
})

// ============================================================
// EmailApprovalService - NestJS 邮件审批服务
// ============================================================
// 实现 OnModuleInit：模块启动时构建 LangGraph 工作流
// 对外暴露 5 个方法：
//   start()          → 启动起草流程，返回审批数据（中断在 waitNode）
//   approve()        → 批准发送，resume 工作流继续执行
//   reject()         → 拒绝发送，resume 工作流并进入取消分支
//   requestModify()  → 提出修改意见，resume 工作流回到 draftNode 重写
//   getState()       → 查询任意 thread 的当前状态
//
// 调用时序示例：
//   1. POST /email/start  → 返回 { status: 'waiting_for_approval', reviewData: {...} }
//   2. 前端展示草稿给审批人
//   3. POST /email/approve → 工作流继续 → 发送邮件 → 返回最终结果
@Injectable()
  export class EmailApprovalService implements OnModuleInit {
  private graph: any

  onModuleInit() {
    // ----------------------------------------------------------
    // LLM 实例：用于起草邮件（ChatOpenAI 远程 API）
    // ----------------------------------------------------------
    // temperature: 0.7 → 中等创造性，邮件起草需要一定灵活性
    // 若需更稳定的格式化输出（JSON），可降低到 0.2~0.3
    const llm = new ChatOpenAI({
      model:         config.langGraph.model,
      apiKey:        config.langGraph.apiKey,
      configuration: { baseURL: config.langGraph.baseURL + '/v1' },
      temperature:   0.7,
    })

    // ============================================================
    // draftNode ——「邮件起草器」
    // ============================================================
    // 职责：根据用户需求（或修改意见）调用 LLM 生成邮件草稿
    //
    // 两种工作模式：
    //   1. 初次起草（isRevision = false）
    //      → prompt 仅包含用户原始需求
    //   2. 修订模式（isRevision = true，state.modifyFeedback 非空）
    //      → prompt 包含：修改意见 + 原始需求 + 上次草稿
    //      → 让 LLM 基于反馈做增量修改，而非从零重写
    //
    // 输出格式：严格 JSON，包含 subject / recipient / body
    // JSON 解析失败时兜底：用原始文本作为 body，避免整个流程中断
    //
    // 注意：节点名用 draftNode 而非 draftEmail
    //   → LangGraph 不允许节点名与 State 字段名相同
    const draftNode = async (state: typeof EmailState.State) => {
      const isRevision = !!state.modifyFeedback// 是否为修订模式
      console.log(`\n✍️  [draftNode] ${isRevision ? '根据修改意见重新起草' : '初次起草'}邮件`)

      const prompt = isRevision
        ? `根据修改意见重新起草邮件：
修改意见：${state.modifyFeedback}
原始需求：${state.emailRequest}
上次草稿：${JSON.stringify(state.draftEmail)}`
        : `根据需求起草一封专业邮件：${state.emailRequest}`

      const res = await llm.invoke([
        new HumanMessage(
          `${prompt}\n\n输出 JSON（不要其他内容）：
{"subject":"邮件主题","recipient":"收件人","body":"正文内容"}`
        ),
      ])
  

      let draft: { subject: string; recipient: string; body: string }
      try {
        const json = (res.content as string).replace(/```json\n?|\n?```/g, '').trim()
        draft = JSON.parse(json)
      } catch {
        // 兜底：解析失败时保留原始文本为 body
        draft = { subject: '草稿', recipient: '未知', body: res.content as string }
      }

      console.log(`   收件人: ${draft.recipient}，主题: ${draft.subject}`)
      return {
        draftEmail: draft,                          // 写入草稿内容
        approvalStatus: 'pending' as const,          // 重置为待审批
        revisionCount: isRevision ? 1 : 0,           // 修订时累加 1，初次为 0（不影响累加）
      }
    }

    // ============================================================
    // waitNode ——「人工审批等待点」
    // ============================================================
    // 职责：暂停工作流，暴露草稿给外部审批，等待人工决定
    //
    // interrupt() 工作原理：
    //   1. 工作流执行到此处暂停，state 保存到 MemorySaver
    //   2. graph.invoke() 返回 { __interrupt__: [...] } 给调用方
    //   3. 外部调用 Command({ resume: ... }) 后从挂起点继续执行
    //   4. interrupt() 的返回值就是 resume 传入的值
    //
    // 审批选项三种路径：
    //   approve  → resume: 'approved'        → approvalStatus = 'approved'
    //   reject   → resume: 'rejected'        → approvalStatus = 'rejected'
    //   modify   → resume: { action: 'modify', feedback: '...' }
    //            → approvalStatus = 'need_modify' + modifyFeedback = '...'
    //
    // 关键：interrupt 支持结构化数据
    //   - type: 分类标识（前端可根据 type 渲染不同 UI）
    //   - message: 审批提示文本
    //   - draft: 草稿数据（前端直接展示）
    //   - options: 可选操作（前端生成对应按钮）
    const waitNode = async (state: typeof EmailState.State) => {
      console.log(`\n⏸️  [waitNode] 等待人工审批（第 ${state.revisionCount + 1} 版）`)

            const decision = interrupt({
                type: 'email_review',// 审批类型：邮件审批
                message: `请审查邮件草稿（第 ${state.revisionCount + 1} 版）`,
                draft: state.draftEmail,// 直接传入 draftEmail 对象
                options: {// 审批选项
                    approve: '批准发送',
                    reject: '拒绝（取消发送）',
                    modify: '需要修改（附修改意见）',
                },
            })

            console.log(`   人工决定: ${JSON.stringify(decision)}`)

            // --- 解析 resume 返回值，写入对应的 approvalStatus ---
            // 简单字符串：直接当作审批状态（'approved' / 'rejected'）
            if (typeof decision === 'string') {
                return { approvalStatus: decision as any }
            }
            // 对象 + action='modify'：需要修改，附带 feedback
            if (typeof decision === 'object' && (decision as any)?.action === 'modify') {
                return {
                    approvalStatus: 'need_modify' as const,
                    modifyFeedback: (decision as any).feedback as string,
                }
            }
            // 其他情况：默认拒绝
            return { approvalStatus: 'rejected' as const }
        }

        // ============================================================
        // routeAfterApproval ——「审批后路由」
        // ============================================================
        // 职责：根据 approvalStatus 决定工作流下一步走向
        //
        // 三条路径：
        //   approved    → sendNode（发送邮件 → END）
        //   need_modify → draftNode（重新起草 → waitNode → 再次审批，形成循环）
        //   其他/默认    → cancelNode（取消发送 → END）
        //
        // 注意：这是 addConditionalEdges 的条件路由函数
        //   → 返回值必须匹配 addConditionalEdges 的 mapping key
        //   → LangGraph 根据返回值选择对应目标节点
        const routeAfterApproval = (state: typeof EmailState.State) => {
            console.log(`\n🔀 [route] approvalStatus = ${state.approvalStatus}`)
            switch (state.approvalStatus) {
                case 'approved': return 'sendNode'
                case 'need_modify': return 'draftNode'   // 回到起草节点重新起草（循环）
                default: return 'cancelNode'
            }
        }

        // ============================================================
        // sendNode ——「邮件发送器」
        // ============================================================
        // 职责：执行邮件发送（当前为模拟），记录最终状态
        //
        // 当前实现为 console.log 模拟，实际项目应替换为：
        //   - Nodemailer（自建 SMTP）
        //   - SendGrid / Resend（第三方邮件 API）
        //   - 企业微信 / 飞书 / 钉钉 消息推送
        //
        // 该节点始终走向 END，工作流到此终止
        const sendNode = async (state: typeof EmailState.State) => {
            console.log(`\n📤 [sendNode] 发送邮件`)
            console.log(`   收件人: ${state.draftEmail.recipient}`)
            console.log(`   主题:   ${state.draftEmail.subject}`)
            // 实际项目里调用 Nodemailer / SendGrid / 企业邮件 API
            return {
                finalStatus: `✅ 邮件已发送\n收件人：${state.draftEmail.recipient}\n主题：${state.draftEmail.subject}`,
            }
        }

        // ============================================================
        // cancelNode ——「取消发送」
        // ============================================================
        // 职责：记录取消原因，终止工作流
        //
        // 触发场景：
        //   1. 审批人点击"拒绝"
        //   2. 路由默认分支（approvalStatus 为 rejected 或未知值）
        //
        // 该节点始终走向 END
        const cancelNode = async (state: typeof EmailState.State) => {
            console.log(`\n🚫 [cancelNode] 邮件已取消，状态: ${state.approvalStatus}`)
            return {
                finalStatus: `❌ 邮件已取消（审批状态：${state.approvalStatus}）`,
            }
        }

        // ============================================================
        // 构建 LangGraph 工作流
        // ============================================================
        // 节点拓扑：
        //                  ┌──────────────────────────────┐
        //                  │        need_modify（循环）     │
        //                  ▼                              │
        //   START → draftNode → waitNode ──[路由]── sendNode → END
        //                                  │
        //                                  └── cancelNode → END
        //
        // 关键设计决策：
        //   - 节点名不能与 State 字段名冲突（LangGraph 限制）
        //     如 draftEmail 是字段名 → 节点取名 draftNode
        //   - addConditionalEdges 实现审批后的条件分支
        //     mapping 对象的 key 必须与路由函数返回值一致
        //   - need_modify 分支回到 draftNode，形成修改循环
        //     无退出条件（由审批人决定何时批准），理论上可无限循环
        //
        // MemorySaver 说明：
        //   - 基于内存的 checkpointer，实现 state 持久化
        //   - interrupt 挂起时，state 存入 MemorySaver
        //   - resume 时从 MemorySaver 恢复 state，继续执行
        //   - 服务重启后数据丢失 → 生产环境应换 SqliteSaver / PostgresSaver
        this.graph = new StateGraph(EmailState)
            // ✅ 节点名全部改掉，不再和 State 字段名冲突
            .addNode('draftNode', draftNode)
            .addNode('waitNode', waitNode)
            .addNode('sendNode', sendNode)
            .addNode('cancelNode', cancelNode)
            .addEdge(START, 'draftNode')
            .addEdge('draftNode', 'waitNode')
            .addConditionalEdges('waitNode', routeAfterApproval, {
                sendNode: 'sendNode',
                draftNode: 'draftNode',   // 修改意见 → 重新起草（循环）
                cancelNode: 'cancelNode',
            })
            .addEdge('sendNode', END)
            .addEdge('cancelNode', END)
            .compile({ checkpointer: new MemorySaver() })

        console.log('✅ 邮件审批工作流初始化完成')
    }

    // ============================================================
    // 对外方法
    // ============================================================

    // start() —— 启动邮件起草流程
    // ============================================================
    // 参数：
    //   emailRequest → 用户用自然语言描述的邮件需求
    //   threadId     → 审批线程唯一标识（用于后续 approve/reject/modify 操作）
    //
    // 执行流程：
    //   1. graph.invoke() 执行 START → draftNode → waitNode
    //   2. waitNode 中 interrupt() 挂起工作流
    //   3. invoke 返回 { __interrupt__: [...] }
    //   4. 提取 __interrupt__[0].value → 前端展示草稿和审批按钮
    //
    // 返回值：
    //   status: 'waiting_for_approval' → 需要人工审批
    //   reviewData → 包含 draft / options 等审批界面数据
    //
    // 注意：invoke 是同步阻塞的，但由于 interrupt 的存在，它会在挂起点返回
    //   → 这不是传统的"执行完毕"，而是"执行到中断点"
    async start(emailRequest: string, threadId: string) {
        console.log(`\n${'═'.repeat(50)}`)
        console.log(`📨 [email/start] threadId: ${threadId}`)
        console.log(`   需求: "${emailRequest}"`)

        const result = await this.graph.invoke(
            { emailRequest },
            { configurable: { thread_id: threadId } }// 传递 threadId 作为可配置参数
        )

        // 检查是否存在 interrupt 标记
        // → 存在：正常流程，返回审批数据给前端
        // → 不存在：异常情况（如 LLM 调用失败且兜底逻辑也没触发 interrupt）
        if (result.__interrupt__) {
            return {
                status: 'waiting_for_approval',
                threadId,
                reviewData: result.__interrupt__[0].value,
                message: '邮件草稿已生成，请审批',
            }
        }
        return { status: 'completed', result }
    }

    // approve() —— 批准发送
    // ============================================================
    // 通过 Command({ resume: 'approved' }) 恢复工作流
    //   → waitNode 中 interrupt() 返回 'approved'
    //   → routeAfterApproval 路由到 sendNode
    //   → sendNode 执行后工作流结束
    async approve(threadId: string) {
        console.log(`\n✅ [email/approve] threadId: ${threadId}`)
        await this.graph.invoke(
            new Command({ resume: 'approved' }),// 批准发送
            { configurable: { thread_id: threadId } }
        )
        // 工作流完成后，通过 getState 获取最终状态
        const state = await this.graph.getState({ configurable: { thread_id: threadId } })
        return { status: 'email_sent', finalStatus: state.values.finalStatus }
    }

    // reject() —— 拒绝发送
    // ============================================================
    // resume: 'rejected' → routeAfterApproval 路由到 cancelNode → END
    async reject(threadId: string) {
        console.log(`\n❌ [email/reject] threadId: ${threadId}`)
        await this.graph.invoke(
            new Command({ resume: 'rejected' }),// 拒绝发送
            { configurable: { thread_id: threadId } }
        )
        return { status: 'cancelled', message: '邮件已取消发送' }
    }

    // requestModify() —— 提出修改意见
    // ============================================================
    // 参数：
    //   feedback → 审批人填写的修改意见文本
    //
    // resume 传入 { action: 'modify', feedback } 对象
    //   → waitNode 解析出 action='modify'，设置 approvalStatus='need_modify'
    //   → routeAfterApproval 路由到 draftNode（重新起草）
    //   → draftNode 用 modifyFeedback 重写邮件
    //   → 再次进入 waitNode（下一轮审批）
    //
    // 注意：requestModify 返回后工作流再次挂起
    //   → 又返回 status: 'waiting_for_approval'
    //   → 前端展示新草稿，等待下一轮审批决定
    async requestModify(threadId: string, feedback: string) {
        console.log(`\n✏️  [email/modify] threadId: ${threadId}`)
        console.log(`   修改意见: "${feedback}"`)
        const result = await this.graph.invoke(
            new Command({ resume: { action: 'modify', feedback } }),// 提出修改意见
            { configurable: { thread_id: threadId } }
        )
        // 修改后 draftNode 重新起草 + waitNode 再次挂起
        if (result.__interrupt__) {
            return {
                status: 'waiting_for_approval',
                reviewData: result.__interrupt__[0].value,
                message: '邮件已修改，请重新审批',
            }
        }
        return { status: 'completed' }
    }

    // getState() —— 查询工作流当前状态
    // ============================================================
    // 用途：
    //   - 查询某个 thread 的审批进度
    //   - 获取草稿内容（用于前端展示）
    //   - 不需要 resume 工作流，纯只读操作
    //
    // 返回值：当前 state 的所有字段值
    //   { emailRequest, draftEmail, approvalStatus, revisionCount, finalStatus, ... }
    async getState(threadId: string) {
        const state = await this.graph.getState({ configurable: { thread_id: threadId } })
        return state.values
    }
}