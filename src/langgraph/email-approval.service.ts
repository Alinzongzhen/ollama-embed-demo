import { Injectable, OnModuleInit } from '@nestjs/common'
import { ChatOpenAI } from '@langchain/openai'
import {
  StateGraph, START, END, Annotation,
  MemorySaver, interrupt, Command,
} from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import { config } from '../config'

const EmailState = Annotation.Root({
  emailRequest: Annotation<string>(),//邮件请求
  draftEmail: Annotation<{ subject: string; recipient: string; body: string }>(),//起草邮件
  approvalStatus: Annotation<'pending' | 'approved' | 'rejected' | 'need_modify'>(),//审批状态
  modifyFeedback: Annotation<string>(),//修改意见
  revisionCount: Annotation<number>({
    reducer: (prev, curr) => prev + curr,
    default: () => 0,
  }),//修订次数
  finalStatus: Annotation<string>(),//最终状态
})

@Injectable()
  export class EmailApprovalService implements OnModuleInit {
  private graph: any

  onModuleInit() {
    const llm = new ChatOpenAI({
      model:         config.langGraph.model,
      apiKey:        config.langGraph.apiKey,
      configuration: { baseURL: config.langGraph.baseURL + '/v1' },
      temperature:   0.7,
    })

    // ── 节点一：起草邮件 ─────────────────────────────
    // ✅ 节点名改为 draftNode，避免和 State 字段 draftEmail 冲突
    const draftNode = async (state: typeof EmailState.State) => {
      const isRevision = !!state.modifyFeedback
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
        draft = { subject: '草稿', recipient: '未知', body: res.content as string }
      }

      console.log(`   收件人: ${draft.recipient}，主题: ${draft.subject}`)
      return {
        draftEmail: draft,
        approvalStatus: 'pending' as const,
        revisionCount: isRevision ? 1 : 0,
      }
    }

    // ── 节点二：等待人工审批（interrupt 暂停）──────────
    // ✅ 节点名改为 waitNode，避免和可能的字段名冲突
    const waitNode = async (state: typeof EmailState.State) => {
      console.log(`\n⏸️  [waitNode] 等待人工审批（第 ${state.revisionCount + 1} 版）`)

            const decision = interrupt({
                type: 'email_review',
                message: `请审查邮件草稿（第 ${state.revisionCount + 1} 版）`,
                draft: state.draftEmail,
                options: {
                    approve: '批准发送',
                    reject: '拒绝（取消发送）',
                    modify: '需要修改（附修改意见）',
                },
            })

            console.log(`   人工决定: ${JSON.stringify(decision)}`)

            if (typeof decision === 'string') {
                return { approvalStatus: decision as any }
            }
            if (typeof decision === 'object' && (decision as any)?.action === 'modify') {
                return {
                    approvalStatus: 'need_modify' as const,
                    modifyFeedback: (decision as any).feedback as string,
                }
            }
            return { approvalStatus: 'rejected' as const }
        }

        // ── 路由函数 ──────────────────────────────────────
        const routeAfterApproval = (state: typeof EmailState.State) => {
            console.log(`\n🔀 [route] approvalStatus = ${state.approvalStatus}`)
            switch (state.approvalStatus) {
                case 'approved': return 'sendNode'
                case 'need_modify': return 'draftNode'   // 回到起草节点重新起草
                default: return 'cancelNode'
            }
        }

        // ── 节点三：发送邮件 ──────────────────────────────
        // ✅ 节点名改为 sendNode
        const sendNode = async (state: typeof EmailState.State) => {
            console.log(`\n📤 [sendNode] 发送邮件`)
            console.log(`   收件人: ${state.draftEmail.recipient}`)
            console.log(`   主题:   ${state.draftEmail.subject}`)
            // 实际项目里调用 Nodemailer / SendGrid / 企业邮件 API
            return {
                finalStatus: `✅ 邮件已发送\n收件人：${state.draftEmail.recipient}\n主题：${state.draftEmail.subject}`,
            }
        }

        // ── 节点四：取消发送 ──────────────────────────────
        // ✅ 节点名改为 cancelNode
        const cancelNode = async (state: typeof EmailState.State) => {
            console.log(`\n🚫 [cancelNode] 邮件已取消，状态: ${state.approvalStatus}`)
            return {
                finalStatus: `❌ 邮件已取消（审批状态：${state.approvalStatus}）`,
            }
        }

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

    // ── 对外方法 ──────────────────────────────────────

    async start(emailRequest: string, threadId: string) {
        console.log(`\n${'═'.repeat(50)}`)
        console.log(`📨 [email/start] threadId: ${threadId}`)
        console.log(`   需求: "${emailRequest}"`)

        const result = await this.graph.invoke(
            { emailRequest },
            { configurable: { thread_id: threadId } }
        )

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

    async approve(threadId: string) {
        console.log(`\n✅ [email/approve] threadId: ${threadId}`)
        await this.graph.invoke(
            new Command({ resume: 'approved' }),
            { configurable: { thread_id: threadId } }
        )
        const state = await this.graph.getState({ configurable: { thread_id: threadId } })
        return { status: 'email_sent', finalStatus: state.values.finalStatus }
    }

    async reject(threadId: string) {
        console.log(`\n❌ [email/reject] threadId: ${threadId}`)
        await this.graph.invoke(
            new Command({ resume: 'rejected' }),
            { configurable: { thread_id: threadId } }
        )
        return { status: 'cancelled', message: '邮件已取消发送' }
    }

    async requestModify(threadId: string, feedback: string) {
        console.log(`\n✏️  [email/modify] threadId: ${threadId}`)
        console.log(`   修改意见: "${feedback}"`)
        const result = await this.graph.invoke(
            new Command({ resume: { action: 'modify', feedback } }),
            { configurable: { thread_id: threadId } }
        )
        if (result.__interrupt__) {
            return {
                status: 'waiting_for_approval',
                reviewData: result.__interrupt__[0].value,
                message: '邮件已修改，请重新审批',
            }
        }
        return { status: 'completed' }
    }

    async getState(threadId: string) {
        const state = await this.graph.getState({ configurable: { thread_id: threadId } })
        return state.values
    }
}