const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const mermaidCode = `sequenceDiagram
    participant U as 👤 用户
    participant G as 📊 LangGraph
    participant CM as 🧠 callModel<br/>(LLM 推理)
    participant SC as 🔀 shouldContinue<br/>(条件路由)
    participant TN as 🔧 tools<br/>(ToolNode 执行)
    participant CK as 💾 MemorySaver<br/>(检查点)

    U->>G: chat(threadId, "北京和上海哪个更热？")
    G->>CK: 通过 thread_id 恢复历史消息
    CK-->>G: 返回消息列表 []

    Note over G,CM: 【第 1 轮】进入 callModel

    G->>CM: invoke([SystemMessage, HumanMessage])
    CM->>CM: LLM 推理 → 生成 tool_calls
    CM-->>G: AIMessage { tool_calls: [北京, 上海] }

    Note over G,SC: callModel 完毕，进入路由

    G->>SC: shouldContinue(state)
    SC->>SC: tool_calls.length > 0 → 是！
    SC-->>G: 路由到 tools

    Note over G,TN: 【工具执行阶段】

    G->>TN: ToolNode 解析 tool_calls
    TN->>TN: 并行 get_weather("北京") → 25°C
    TN->>TN: 并行 get_weather("上海") → 28°C
    TN-->>G: 返回 ToolMessage × 2

    Note over G,CM: 【第 2 轮】回到 callModel

    G->>CM: invoke([SystemMsg..., ToolMsg×2])
    CM->>CM: LLM: 北京 25°C vs 上海 28°C
    CM-->>G: AIMessage { content: "...", tool_calls: [] }

    Note over G,SC: 再次进入路由

    G->>SC: shouldContinue(state)
    SC->>SC: tool_calls.length > 0 → 否！
    SC-->>G: 路由到 END

    G->>CK: 保存快照 (thread_id)
    G-->>U: 返回 "上海比北京更热"`;

const encoded = Buffer.from(mermaidCode, 'utf-8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

const outDir = path.resolve(__dirname, '..', 'src', 'langgraph', 'img');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// 用 sharp 从 mermaid.ink 的 SVG 生成 PNG，强制白底
async function main() {
  // 获取 SVG
  const svgBuffer = await new Promise((resolve, reject) => {
    https.get(`https://mermaid.ink/img/${encoded}?type=svg`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });

  // 保存原始 SVG
  const svgPath = path.join(outDir, 'react-agent-flow.svg');
  fs.writeFileSync(svgPath, svgBuffer);
  console.log(`✅ SVG saved: ${svgPath}`);

  // 用 sharp 渲染 SVG → PNG，强制白底
  const pngPath = path.join(outDir, 'react-agent-flow.png');
  await sharp(svgBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })  // 强制白色背景
    .png()
    .toFile(pngPath);
  console.log(`✅ PNG saved: ${pngPath} (white background)`);
}

main().catch(e => { console.error(e); process.exit(1); });
