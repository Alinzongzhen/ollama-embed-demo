import { Injectable, OnModuleInit } from '@nestjs/common';
import {ChatOllama} from '@langchain/ollama';
import { StateGraph, Annotation, START, END, Send, Command } from '@langchain/langgraph';
import { config } from '../config';
import { HumanMessage } from '@langchain/core/messages';


// 主图 state： 收集所有字任务结果
const ParallelState = Annotation.Root({
    task: Annotation<string>(),
    results: Annotation<{task: string, result: string}[]>({
        reducer: (prev, curr) => [...prev, ...curr],
        default: () => [],
    }),
    finalReport: Annotation<string>(),
})

// 子图 state： 每个子任务的输入输出
const SubState = Annotation.Root({
    task: Annotation<string>(),
})

@Injectable()
export class ParallelService implements OnModuleInit {
    private graph: any;
    onModuleInit() {
        // 创建 chatOllama 实例
        const llm = new ChatOllama({
            model: config.ollama.chatModel, // Ollama 模型名称
            temperature: config.ollama.temperature, // 生成文本的随机程度
            baseUrl: config.ollama.host, // Ollama 服务器地址
            think: false, // 是否开启思考模式，开启后模型会先返回一个思考中的消息，等生成完成后再返回最终回答
            numPredict: 512, // 生成文本的最大 token 数量，512 是一个比较合理的值，可以根据需要调整
        });


        // 拆分节点  
        const splitTask = async (state: typeof ParallelState.State) => {
            // 根据输入的任务描述，拆分成三个子任务
            const res = await llm.invoke([
                new HumanMessage(`把以下任务拆成 3 个独立子任务，每个子任务单独一行，不要编号：\n\n${state.task}`),
            ])
            console.log('拆分结果：', res.content)
            const subTasks = (res.content as string).split('\n').map(t => t.replace(/^\d+[\.\)、]\s*/, '').trim()).filter(Boolean).slice(0, 3);

            subTasks.forEach((t, i) => console.log(`子任务 ${i + 1}: ${t}`));
            return new Command({
                goto: subTasks.map((task) => new Send('processSubTask', { task })),
            })
        }

        // 子任务节点， 多个实例 并行运行
        const processSubTask = async (state: typeof SubState.State) => {
            console.log('\n⚡ [processSubTask] 处理子任务：', state.task)

            const res = await llm.invoke([
                new HumanMessage(`请完成以下任务, 100字以内：\n\n${state.task}`),
            ])
            console.log('子任务结果：', res.content)
            return { results: [{task: state.task, result: res.content as string}] }

        }

        // 汇总节点， 收集所有子任务结果，生成最终报告
        const mergeResults = async (state: typeof ParallelState.State) => {
            console.log('汇总子任务结果：', state.results.length)
            const text = state.results
                .map((r, i) => `子任务 ${i + 1}：${r.task}\n结果：${r.result}`)
                .join('\n\n')
                // console.log('汇总子任务结果1：', text)
            
            const res = await llm.invoke([
                new HumanMessage(`根据以下子任务结果，生成 200 字综合报告：\n\n${text}`),
            ])
            console.log('最终报告：', res.content)
            return { finalReport: res.content as string }
        }

        this.graph = new StateGraph(ParallelState)
            .addNode('splitTask', splitTask, { ends: ['processSubTask'] })
            .addNode('processSubTask', processSubTask, { ends: ['mergeResults'] })
            .addNode('mergeResults', mergeResults)
            .addEdge(START, 'splitTask')
            .addEdge('processSubTask', 'mergeResults')
            .addEdge('mergeResults', END)
            .compile()
    }


    async parallelChat(task: string) {
        const t0 = Date.now();
        const result = await this.graph.invoke({ task })
        console.log('总耗时：', (Date.now() - t0) / 1000, '秒')

        return {
            subTasks: result.results.map((r: any) => r.task),
            results: result.results,
            finalReport: result.finalReport,
            totalTime: `${Date.now() - t0}ms`,
        };
    }   


}