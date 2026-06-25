const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const outDir = path.resolve(__dirname, '..', 'src', 'langgraph', 'img');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ═══════════════════════════════════════════════════════════
// 1. Supervisor 工作流
// ═══════════════════════════════════════════════════════════
const supervisorMermaid = `flowchart TD
    START(("START")) --> supervisor

    supervisor["🧠 Supervisor<br/>LLM 决策节点<br/>——————<br/>1. 检查 completedAgents<br/>2. LLM 分析上下文<br/>3. 输出下个 Agent 或 FINISH"]

    supervisor -->|"researcher"| researcher
    supervisor -->|"analyst"| analyst
    supervisor -->|"writer"| writer
    supervisor -->|"FINISH"| ENDNODE(("END"))

    researcher["🔍 Researcher<br/>收集信息搜索资料<br/>返回 completedAgents"]
    analyst["📊 Analyst<br/>数据分析逻辑推理<br/>返回 completedAgents"]
    writer["✍️ Writer<br/>撰写报告优化表达<br/>返回 completedAgents"]

    researcher --> supervisor
    analyst --> supervisor
    writer --> supervisor`;

// ═══════════════════════════════════════════════════════════
// 2. ReAct Agent 工作流（含实际 LLM 响应输出 + 备注）
// ═══════════════════════════════════════════════════════════
const reactAgentMermaid = `sequenceDiagram
    participant U as 👤 用户
    participant G as 📊 LangGraph
    participant CM as 🧠 callModel<br/>(LLM 推理)
    participant SC as 🔀 shouldContinue<br/>(条件路由)
    participant TN as 🔧 tools<br/>(ToolNode 执行)
    participant CK as 💾 MemorySaver<br/>(检查点)

    U->>G: chat(threadId, "北京和上海哪个更热？")
    G->>CK: 通过 thread_id 恢复历史消息
    CK-->>G: 返回 []

    rect rgb(255, 245, 230)
        Note over G,CM: ═══ 第 1 轮 callModel ═══<br/>LLM 收到：SystemMessage(工具说明) + HumanMessage(用户问题)<br/>小模型 qwen2.5:1.5b 指令遵循不稳定
        G->>CM: llmWithTools.invoke(messages)
        CM->>CM: LLM 推理中...
        CM-->>G: AIMessage ①
        Note right of CM: 📤 响应 ①（没调工具！）<br/>content: "请告诉我您想查询的日期"<br/>tool_calls: [] ← 空！<br/>finish_reason: "stop"<br/>promptTokens: 236
    end

    rect rgb(240, 248, 255)
        Note over G,SC: callModel 返回后 → 进入条件路由
        G->>SC: shouldContinue(state)
        SC->>SC: last.tool_calls.length > 0 ?<br/>→ 0 === 0 → false！
        Note right of SC: tool_calls 为空 → 路由到 END<br/>图结束！第 1 次 chat() 返回<br/>"请告诉我日期"
    end

    rect rgb(255, 245, 230)
        Note over U,G: ═══ 用户不满意，第 2 次调用 chat() ═══
        U->>G: chat(threadId, "北京和上海今天哪个更热？")
        Note over G,CM: ═══ 第 2 轮 callModel（重新开始）═══
        G->>CM: llmWithTools.invoke(messages)
        CM->>CM: LLM 推理中...
        CM-->>G: AIMessage ②
        Note right of CM: 📤 响应 ②（调了工具！）<br/>content: "我需要查询天气..."<br/>tool_calls: [{name:"get_weather",<br/>  args:{city:"北京"}},<br/>  {name:"get_weather",<br/>  args:{city:"上海"}}]<br/>finish_reason: "tool_calls"<br/>promptTokens: 236
    end

    rect rgb(240, 248, 255)
        Note over G,SC: 进入条件路由
        G->>SC: shouldContinue(state)
        SC->>SC: last.tool_calls.length > 0 ?<br/>→ 2 > 0 → true！
        Note right of SC: 有 tool_calls → 路由到 tools 节点
    end

    rect rgb(245, 255, 245)
        Note over G,TN: ═══ 工具执行阶段 ═══
        G->>TN: ToolNode 解析 AIMessage 中的 tool_calls
        TN->>TN: 并行执行<br/>get_weather("北京") → "晴，25°C"<br/>get_weather("上海") → "多云，28°C"
        TN-->>G: 返回 ToolMessage × 2<br/>（通过 tool_call.id 一一对应）
    end

    rect rgb(255, 245, 230)
        Note over G,CM: ═══ 第 3 轮 callModel（工具结果已追加）═══
        G->>CM: invoke([SystemMsg, HumanMsg,<br/>AIMsg(tool_calls), ToolMsg×2])
        CM->>CM: LLM 分析工具返回数据<br/>北京: 25°C | 上海: 28°C
        CM-->>G: AIMessage ③
        Note right of CM: 📤 响应 ③（最终答案）<br/>content: "北京 25°C，上海 28°C，<br/>上海更热"<br/>tool_calls: [] ← 空！<br/>finish_reason: "stop"<br/>promptTokens: 325<br/>⚠️ 小模型结论错误: 25 < 28<br/>却说"北京更热"
    end

    rect rgb(240, 248, 255)
        Note over G,SC: 再次进入条件路由
        G->>SC: shouldContinue(state)
        SC->>SC: last.tool_calls.length > 0 ?<br/>→ 0 === 0 → false！
        Note right of SC: tool_calls 为空 → 路由到 END
    end

    G->>CK: 保存完整消息快照（thread_id 索引）
    G-->>U: 返回 result.messages.at(-1).content<br/>"上海比北京更热一些"`;

// ═══════════════════════════════════════════════════════════
// 3. ReAct Agent 正常链路（去掉不稳定段落，纯正常流程）
// ═══════════════════════════════════════════════════════════
const reactAgentNormalMermaid = `sequenceDiagram
    participant U as 👤 用户
    participant G as 📊 LangGraph
    participant CM as 🧠 callModel<br/>(LLM 推理)
    participant SC as 🔀 shouldContinue<br/>(条件路由)
    participant TN as 🔧 tools<br/>(ToolNode 执行)
    participant CK as 💾 MemorySaver<br/>(检查点)

    Note over G,TN: ═══════════ onModuleInit() 初始化阶段 ═══════════

    rect rgb(255, 240, 245)
        Note over G,TN: ▸ 定义工具 ①：calculatorTool
        Note right of TN: const calculatorTool = tool(<br/>  async ({ expression }) => {<br/>    return Function("...(expression)")()<br/>  },<br/>  {<br/>    name: "calculator",<br/>    description: "计算数学表达式",<br/>    schema: z.object({<br/>      expression: z.string()<br/>    })<br/>  }<br/>)
    end

    rect rgb(240, 255, 245)
        Note over G,TN: ▸ 定义工具 ②：weatherTool (Mock)
        Note right of TN: const weatherTool = tool(<br/>  async ({ city }) => {<br/>    mock = { "北京":"晴，25°C",<br/>             "上海":"多云，28°C",<br/>             "武汉":"晴，30°C",<br/>             "广州":"雷阵雨，32°C" }<br/>    return mock[city] ?? "晴，22°C"<br/>  },<br/>  {<br/>    name: "get_weather",<br/>    description: "查询城市天气",<br/>    schema: z.object({<br/>      city: z.string()<br/>    })<br/>  }<br/>)
    end

    rect rgb(255, 248, 230)
        Note over G: const tools = [calculatorTool, weatherTool]
        G->>CM: llm.bindTools(tools)
        Note right of CM: bindTools 将工具的<br/>name/description/schema<br/>注入 LLM 上下文<br/>→ LLM 知道何时调用哪个工具
        G->>TN: const toolNode = new ToolNode(tools)
        Note right of TN: ToolNode 封装<br/>工具调用的执行逻辑
    end

    Note over U,CK: ═══════════ 初始化完成，等待用户调用 ═══════════

    U->>G: chat(threadId, "北京和上海今天哪个城市更热？")
    G->>CK: 通过 thread_id 恢复历史消息
    CK-->>G: 返回 []

    rect rgb(255, 245, 230)
        Note over G,CM: ═══ 第 1 轮 callModel ═══<br/>state.messages = [SystemMessage(工具说明), HumanMessage(用户问题)]
        G->>CM: llmWithTools.invoke(messages)
        CM->>CM: LLM 推理:<br/>需要查询天气 → 调用 get_weather
        CM-->>G: AIMessage ① returned
        Note right of CM: 📤 响应 ①（调了工具！）<br/>id: "chatcmpl-983"<br/>content: "我需要查询这两个城市的<br/>天气...首先查询北京的天气"<br/>tool_calls: [<br/>  {name:"get_weather",<br/>   args:{city:"北京"},<br/>   id:"call_bjgwhm6e"},<br/>  {name:"get_weather",<br/>   args:{city:"上海"},<br/>   id:"call_dyssaw4r"}<br/>]<br/>finish_reason: "tool_calls"<br/>tokens: 236+88=324
    end

    rect rgb(240, 248, 255)
        Note over G,SC: callModel 返回 → shouldContinue
        G->>SC: shouldContinue(state)
        SC->>SC: last.tool_calls.length > 0 ?<br/>→ 2 > 0 → true!
        Note right of SC: 路由到 "tools" 节点
    end

    rect rgb(245, 255, 245)
        Note over G,TN: ═══ 工具执行阶段 ═══
        G->>TN: ToolNode 解析 tool_calls<br/>→ 并行执行 weatherTool × 2
        TN->>TN: ① weatherTool({city:"北京"})
        Note right of TN: ToolMessage<br/>name: "get_weather"<br/>tool_call_id: "call_bjgwhm6e"<br/>content: "晴，25°C，东北风 3 级"
        TN->>TN: ② weatherTool({city:"上海"})
        Note right of TN: ToolMessage<br/>name: "get_weather"<br/>tool_call_id: "call_dyssaw4r"<br/>content: "多云，28°C，东风 2 级"
        TN-->>G: 追加 2 个 ToolMessage 到 messages
    end

    rect rgb(255, 245, 230)
        Note over G,CM: ═══ 第 2 轮 callModel ═══<br/>messages = [SystemMsg, HumanMsg, AIMsg(tool_calls),<br/>  ToolMsg("晴，25°C"), ToolMsg("多云，28°C")]
        G->>CM: llmWithTools.invoke(messages)
        CM->>CM: LLM 分析工具返回数据:<br/>北京: 25°C / 上海: 28°C → 上海更热
        CM-->>G: AIMessage ② returned
        Note right of CM: 📤 响应 ②（最终答案）<br/>id: "chatcmpl-529"<br/>content: "根据这两个城市的天气<br/>预报，北京温度是 25°C，<br/>上海温度是 28°C。因此，<br/>上海比北京更热一些。"<br/>tool_calls: []<br/>finish_reason: "stop"<br/>tokens: 325+63=388
    end

    rect rgb(240, 248, 255)
        Note over G,SC: 再次 shouldContinue
        G->>SC: shouldContinue(state)
        SC->>SC: last.tool_calls.length > 0 ?<br/>→ 0 === 0 → false!
        Note right of SC: 路由到 END → 图结束
    end

    G->>CK: 保存完整消息快照 (thread_id)
    G-->>U: result.messages.at(-1).content<br/>"上海比北京更热一些"`;

// ═══════════════════════════════════════════════════════════
// 通用：从 mermaid.ink 获取 SVG → sharp 转白底 PNG
// ═══════════════════════════════════════════════════════════
async function genImage(name, mermaidCode) {
  const encoded = Buffer.from(mermaidCode, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  // 1. 下载 SVG
  console.log(`⬇  ${name}: 下载 SVG...`);
  const svgBuffer = await new Promise((resolve, reject) => {
    https.get(`https://mermaid.ink/img/${encoded}?type=svg`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });

  // 2. 保存 SVG
  const svgPath = path.join(outDir, `${name}.svg`);
  fs.writeFileSync(svgPath, svgBuffer);
  console.log(`✅ SVG: ${path.basename(svgPath)}`);

  // 3. sharp 渲染 → 强制白底 PNG
  const pngPath = path.join(outDir, `${name}.png`);
  await sharp(svgBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toFile(pngPath);
  console.log(`✅ PNG: ${path.basename(pngPath)}`);
}

// ═══════════════════════════════════════════════════════════
// 执行
// �══════════════════════════════════════════════════════════
(async () => {
  console.log('═══ 生成 LangGraph 流程图 ═══\n');
  await genImage('supervisor-flow', supervisorMermaid);
  console.log('');
  await genImage('react-agent-flow', reactAgentMermaid);
  console.log('');
  await genImage('react-agent-normal-flow', reactAgentNormalMermaid);
  console.log('\n🎉 全部完成！');
})().catch(e => { console.error(e); process.exit(1); });
