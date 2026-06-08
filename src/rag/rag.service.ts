import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { OllamaEmbeddings, ChatOllama } from '@langchain/ollama';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import type { DistanceStrategy } from '@langchain/community/vectorstores/pgvector';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { Document } from '@langchain/core/documents'
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { AddDocumentsDto, SearchDto, QueryDto} from './dto/rag.dto';
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
  // 是否已完成表结构初始化（只在第一次运行时建表/加列）
  private tableInitialized = false;

  // PGVector 配置（每个 collection 独立）
  private getPgConfig(collectionName: string) {
    return {
      pool: this.pool,// 共享数据库连接池
      tableName: 'langchain_pg_embedding',//tableName 指向的表（存向量数据）
      collectionTableName: 'langchain_pg_collection',// 存知识库元信息
      collectionName,// 当前查询的知识库名称
      columns: {
        idColumnName: 'id',// 文档ID字段名
        vectorColumnName: 'embedding',// 向量字段名
        contentColumnName: 'document',// 文档内容字段名
        metadataColumnName: 'cmetadata',// 元数据字段名
      },
      distanceStrategy: 'cosine' as DistanceStrategy,
      // 表结构只需初始化一次，后续操作跳过建表检查（避免重复 ALTER TABLE 报错）
      skipInitializationCheck: this.tableInitialized,
    };
  }

  async onModuleInit(): Promise<void> {
    // 初始化向量模型
    this.ollamaEmbeddings = new OllamaEmbeddings({
      model:  'mxbai-embed-large',
      baseUrl: 'http://localhost:11434',
    });

    // 初始化聊天模型
    this.chatOllama = new ChatOllama({
      model: 'qwen2.5:0.5b',
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

    // 一次性完成数据库表结构初始化（建表、加列、加约束）
    try {
      const initStore = await PGVectorStore.initialize(
        this.ollamaEmbeddings,
        {
          pool: this.pool,
          tableName: 'langchain_pg_embedding',
          collectionTableName: 'langchain_pg_collection',
          collectionName: '_init_',
          columns: {
            idColumnName: 'id',
            vectorColumnName: 'embedding',
            contentColumnName: 'document',
            metadataColumnName: 'cmetadata',
          },
          distanceStrategy: 'cosine' as DistanceStrategy,
        },
      );
      // 注意：不能调用 initStore.end()，因为它会销毁共享的 pool
      // initStore 用完即弃，借用的连接会随对象 GC 自动归还
      this.tableInitialized = true;
      this.logger.log('PGVector 表结构初始化完成');
    } catch (err: any) {
      // 如果表/列已存在（中文或英文 "already exists"），也视为初始化成功
      if (err.message?.includes('already exists') || err.message?.includes('已经存在')) {
        this.tableInitialized = true;
        this.logger.log('PGVector 表结构已存在，跳过初始化');
      } else {
        this.logger.error('PGVector 表结构初始化失败', err);
      }
    }
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
      const store = await PGVectorStore.fromDocuments(
        // 要入库的文档数组
        allDocs,
       // 用哪个模型做向量化
        this.ollamaEmbeddings,
        // 数据库配置
        this.getPgConfig(collectionName),
      )
      // 释放连接但不销毁共享连接池
      store.client?.release()
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
    try {
      this.logger.log(`SearchDto: ${JSON.stringify(dto)}`)
      const topK = dto.topK ?? 3

      const vectorStore = await PGVectorStore.initialize(
        this.ollamaEmbeddings,
        this.getPgConfig(dto.collectionName),
      )
      const results = await vectorStore.similaritySearchWithScore(dto.query, topK)
      // 释放连接但不销毁共享连接池
      vectorStore.client?.release()

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
    } catch (err: any) {
      this.logger.error('search 失败', err)
      throw err
    }
  }

  // ── query（RAG 完整流程）───────────────────────────────
  async query(dto: QueryDto) {
    let vectorStore: PGVectorStore | undefined;
    try {
      const topK        = dto.topK ?? 3
      vectorStore = await PGVectorStore.initialize(
        this.ollamaEmbeddings,
        this.getPgConfig(dto.collectionName),
      )

      const queryWithPrefix = `Represent this sentence for searching relevant passages: ${dto.question}`
      const allRetrieved   = await vectorStore.similaritySearchWithScore(queryWithPrefix, topK)

      // 相似度阈值：余弦相似度 < 0.5 的基本不相关，不喂给 LLM
      const SIMILARITY_THRESHOLD = 0.5
      const retrieved = allRetrieved.filter(([, score]) => score >= SIMILARITY_THRESHOLD)

      if (retrieved.length === 0) {
        return {
          question: dto.question,
          answer:   '知识库中暂无相关内容，请先添加文档。',
          sources:  [],
        }
      }

      const context = retrieved
        .map(([doc], i) => `[${i + 1}] ${doc.pageContent}`)
        .join('\n\n')

      const prompt = ChatPromptTemplate.fromMessages([
        ['system', `你是专业的知识库问答助手。严格根据参考资料回答问题，无相关内容时直接回答"知识库中暂无相关内容"，不要编造。

参考资料：
{context}`],
        ['human', '{question}'],
      ])

      const chain  = prompt.pipe(this.chatOllama).pipe(new StringOutputParser())
      const answer = await chain.invoke({ context, question: dto.question })

      return {
        question: dto.question,
        backend:  'pgvector',
        answer,
        sources: retrieved.map(([doc, score]) => ({
          content:  doc.pageContent,
          score:    parseFloat(score.toFixed(6)),
          metadata: doc.metadata,
        })),
      }
    } catch (err: any) {
      this.logger.error('query 失败', err)
      throw err
    } finally {
      // 释放连接但不销毁共享连接池
      vectorStore?.client?.release()
    }
  }
    // ── collectionInfo ───────────────────────────────────
  async collectionInfo(collectionName: string) {
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*) AS count
         FROM langchain_pg_embedding e
         JOIN langchain_pg_collection c ON e.collection_id = c.uuid
         WHERE c.name = $1`,
        [collectionName],
      )
      const count = parseInt(result.rows[0].count, 10)
      return { backend: 'pgvector', collectionName, chunkCount: count, exists: count > 0 }
    } catch {
      return { backend: 'pgvector', collectionName, chunkCount: 0, exists: false }
    }
  }
    // ── deleteCollection ───────────────────────────────────

  // ── deleteCollection ─────────────────────────────────
  async deleteCollection(collectionName: string) {
    await this.pool.query(
      `DELETE FROM langchain_pg_embedding
       WHERE collection_id = (
         SELECT uuid FROM langchain_pg_collection WHERE name = $1
       )`,
      [collectionName],
    )
    await this.pool.query(
      'DELETE FROM langchain_pg_collection WHERE name = $1',
      [collectionName],
    )
    return {
      success:  true,
      backend:  'pgvector',
      collectionName,
      message:  `集合 ${collectionName} 已删除`,
    }
  }
}
