// src/embed/embed.service.ts
import { Injectable } from '@nestjs/common'
import { OllamaEmbeddings } from '@langchain/ollama'

@Injectable()
  export class EmbedService {
    private embeddings: OllamaEmbeddings

    constructor() {
      this.embeddings = new OllamaEmbeddings({
        model: 'mxbai-embed-large',
        baseUrl: 'http://localhost:11434',
      })
    }

    // 单条文本 embedding
    async embedSingle(text: string) {
      const vector = await this.embeddings.embedQuery(text)
      return {
        text,
        dimension: vector.length,
        vector,
      }
    }

    // 批量文本 embedding
    async embedBatch(texts: string[]) {
      const vectors = await this.embeddings.embedDocuments(texts)
      return texts.map((text, index) => ({
        index,
        text,
        dimension: vectors[index].length,
        vector: vectors[index],
      }))
    }

    // 相似度计算（余弦相似度）
    async similarity(query: string, documents: string[]) {
      // 查询向量：加上检索前缀
      const queryVector = await this.embeddings.embedQuery(
        `Represent this sentence for searching relevant passages: ${query}`
      )

      // 文档向量：直接 embed
      const docVectors = await this.embeddings.embedDocuments(documents)

      // 计算余弦相似度
      const scores = docVectors.map((docVec, i) => {
        const score = this.cosineSimilarity(queryVector, docVec)
        return {
          index: i,
          text: documents[i],
          score: parseFloat(score.toFixed(6)),
        }
      })

      // 按相似度降序排列
      scores.sort((a, b) => b.score - a.score)

      return {
        query,
        results: scores,
      }
    }

    // 余弦相似度计算
    private cosineSimilarity(vecA: number[], vecB: number[]): number {
      const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0)
      const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0))
      const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0))
      return dot / (normA * normB)
    }
  }