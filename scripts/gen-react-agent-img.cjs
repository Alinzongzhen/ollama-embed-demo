const https = require('https');
const fs = require('fs');
const path = require('path');

const mermaid = `sequenceDiagram
    participant U as 👤 用户
    participant G as 📊 LangGraph
    participant CM as 🧠 callModel<br/>(LLM 推理)
    participant SC as 🔀 shouldContinue<br/>(条件路由)
    participant TN as 🔧 tools<br/>(ToolNode 执行)
    participant CK as 💾 MemorySaver<br/>(检查点)

    U->>G: chat(threadId, "北京和上海哪个更热？")
    G->>CK: 通过 thread_id 恢复历史消息
    CK-->>G: 返回消息列表 []

    Note over G,CM: 【第 1 轮】进入 callModel 节点

    G->>CM: invoke([SystemMessage(工具说明), HumanMessage(用户问题)])
    CM->>CM: LLM 推理：需要查天气 → 生成 tool_calls
    CM-->>G: AIMessage { tool_calls: [{get_weather, 北京}, {get_weather, 上海}] }

    Note over G,SC: callModel 执行完毕，进入条件路由

    G->>SC: shouldContinue(state)
    SC->>SC: last.tool_calls.length > 0 ? 是！
    SC-->>G: 路由到 "tools" 节点

    Note over G,TN: 【工具执行阶段】

    G->>TN: ToolNode 解析 tool_calls
    TN->>TN: 并行执行 get_weather("北京") → "晴，25°C"
    TN->>TN: 并行执行 get_weather("上海") → "多云，28°C"
    TN->>TN: 封装为 ToolMessage 追加到 messages
    TN-->>G: { messages: [ToolMessage(北京), ToolMessage(上海)] }

    Note over G,CM: 【第 2 轮】回到 callModel 节点

    G->>CM: invoke([SystemMessage, HumanMessage, AIMessage(tool_calls), ToolMessage×2])
    CM->>CM: LLM 分析数据：北京 25°C vs 上海 28°C
    CM-->>G: AIMessage { content: "上海更热", tool_calls: [] }

    Note over G,SC: 再次进入条件路由

    G->>SC: shouldContinue(state)
    SC->>SC: last.tool_calls.length > 0 ? 否！
    SC-->>G: 路由到 END

    G->>CK: 保存当前消息快照（thread_id 索引）
    G-->>U: 返回 "上海比北京更热一些"`;

// URL-safe base64 编码
const encoded = Buffer.from(mermaid, 'utf-8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

const url = `https://mermaid.ink/img/${encoded}?type=png`;
console.log('Downloading PNG from mermaid.ink...');

const outDir = path.resolve(__dirname, '..', 'src', 'langgraph', 'img');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

https
  .get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      const outPath = path.join(outDir, 'react-agent-flow.png');
      fs.writeFileSync(outPath, buf);
      console.log(`✅ Saved: ${outPath} (${buf.length} bytes)`);
    });
  })
  .on('error', (e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
