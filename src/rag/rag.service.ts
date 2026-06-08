import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { OllamaEmbeddings, ChatOllama } from '@langchain/ollama';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import type { DistanceStrategy } from '@langchain/community/vectorstores/pgvector';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { Document } from '@langchain/core/documents'
import { AddDocumentsDto, SearchDto } from './dto/rag.dto';
import { Pool } from 'pg';
@Injectable()
export class RagService implements OnModuleInit {
  // 日志记录器
  private readonly logger = new Logger(RagService.name);
  // 聊天模型
   private chatOllama!: ChatOllama;
   // 数据库连接池
  private pool!: Pool;
  // 向量模型
  private ollamaEmbeddings!: OllamaEmbeddings;

  // PGVector 配置（每个 collection 独立）
  private getPgConfig(collectionName: string) {
    return {
      pool: this.pool,// 共享数据库连接池
      tableName: 'langchain_pg_embedding',//tableName 指向的表（存向量数据）
      collectionName,// 指向的表（存知识库元信息）
      columns: {
        idColumnName: 'id',// 文档ID字段名
        vectorColumnName: 'embedding',// 向量字段名
        contentColumnName: 'document',// 文档内容字段名
        metadataColumnName: 'cmetadata',// 元数据字段名
      },
      distanceStrategy: 'cosine' as DistanceStrategy,
    };
  }

  onModuleInit(): void {
    // 初始化向量模型
    this.ollamaEmbeddings = new OllamaEmbeddings({
      model:  'mxbai-embed-large',
      baseUrl: 'http://localhost:11434',
    });

    // 初始化聊天模型
    this.chatOllama = new ChatOllama({
      model: 'qwen3.5:0.8b',
      baseUrl: 'http://localhost:11434',
      temperature: 0.3,
    });

    // 初始化数据库连接
    this.pool = new Pool({
      host:     process.env.PG_HOST     || 'localhost',
      port:     parseInt(process.env.PG_PORT || '5432', 10),
      user:     process.env.PG_USER     || 'postgres',
      password: process.env.PG_PASSWORD || 'postgres',
      database: process.env.PG_DATABASE || 'ragdb',
    });

    this.logger.log('RAG Service 初始化完成');
  }
  async addDocuments(dto: AddDocumentsDto) {
    try {
      const { collectionName, documents, chunkSize = 500, chunkOverlap = 50 } = dto;
      // 分割文档为小段落
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap,
        separators: ['\n\n', '\n', '。', '！', '？', '；', ' ', ''],
      })
      const allDocs: Document[] = []
      const allIds: string[] = []
      for (const doc of dto.documents) {
        const chunks = await splitter.createDocuments(
          [doc.content],
          [{ ...doc.metadata, sourceId: doc.id }],
        )
        chunks.forEach((chunk, i) => {
          chunk.metadata.chunkIndex = i
          chunk.metadata.totalChunks = chunks.length
          allDocs.push(chunk)
          allIds.push(`${doc.id}-chunk-${i}`)
        })
        this.logger.log(`[PGVector] 文档 ${doc.id} 分块完成：共 ${chunks.length} 块`)
      }

      this.logger.log(`即将写入 PGVector：host=${process.env.PG_HOST}, port=${process.env.PG_PORT}, user=${process.env.PG_USER}, db=${process.env.PG_DATABASE}`)
      await PGVectorStore.fromDocuments(
        // 要入库的文档数组
        allDocs,
       // 用哪个模型做向量化
        this.ollamaEmbeddings,
        // 数据库配置
        this.getPgConfig(collectionName),
      )
      return {
        success: true,
        backend: 'pgvector',
        collectionName,
        originalDocCount: documents.length,
        totalChunks: allDocs.length,
        chunkSize,
        chunkOverlap,
      }
    } catch (err: any) {
      this.logger.error('addDocuments 失败', err)
      return {
        success: false,
        error: err?.message || String(err),
      }
    }
  }
    // ── search ───────────────────────────────────────────
  async search(dto: SearchDto) {
    const topK = dto.topK ?? 3

    const vectorStore = await PGVectorStore.initialize(
      this.ollamaEmbeddings,
      this.getPgConfig(dto.collectionName),
    )
    const results = await vectorStore.similaritySearchWithScore(dto.query, topK)
    await vectorStore.end()

    return {
      query:          dto.query,
      backend:        'pgvector',
      collectionName: dto.collectionName,
      results: results.map(([doc, score]) => ({
        content:  doc.pageContent,
        metadata: doc.metadata,
        score:    parseFloat(score.toFixed(6)),
      })),
    }
  }
}
