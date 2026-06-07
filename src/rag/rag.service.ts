import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { OllamaEmbeddings, ChatOllama } from '@langchain/ollama';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import type { DistanceStrategy } from '@langchain/community/vectorstores/pgvector';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { Document } from '@langchain/core/documents'
import { AddDocumentsDto } from './dto/rag.dto';
import { Pool } from 'pg';
@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private chatOllama!: ChatOllama;
  private pool!: Pool;
  private ollamaEmbeddings!: OllamaEmbeddings;

  // PGVector 配置（每个 collection 独立）
  private getPgConfig(collectionName: string) {
    return {
      pool: this.pool,
      tableName: 'langchain_pg_embedding',
      collectionTableName: 'langchain_pg_collection',
      collectionName,
      columns: {
        idColumnName: 'id',
        vectorColumnName: 'embedding',
        contentColumnName: 'document',
        metadataColumnName: 'cmetadata',
      },
      distanceStrategy: 'cosine' as DistanceStrategy,
    };
  }

  onModuleInit(): void {
    // 初始化向量模型
    this.ollamaEmbeddings = new OllamaEmbeddings({
      model: process.env.OLLAMA_MODEL || 'mxbai-embed-large',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    });

    // 初始化聊天模型
    this.chatOllama = new ChatOllama({
      model: 'qwen3.5:0.8b',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      temperature: 0.3,
    });

    // 初始化数据库连接
    this.pool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432', 10),
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || 'postgres',
      database: process.env.PG_DATABASE || 'ragdb',
    });

    this.logger.log('RAG Service 初始化完成');
  }
  async addDocuments(dto: AddDocumentsDto) {
    const { collectionName, documents, chunkSize = 500, chunkOverlap = 50 } = dto;
    // 分割文档为小段落
      const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      separators: ['\n\n', '\n', '。', '！', '？', '；', ' ', ''],
    })
    const allDocs: Document[] = []
    const allIds:  string[]   = []
       for (const doc of dto.documents) {
      const chunks = await splitter.createDocuments(
        [doc.content],
        [{ ...doc.metadata, sourceId: doc.id }],
      )
      chunks.forEach((chunk, i) => {
        chunk.metadata.chunkIndex  = i
        chunk.metadata.totalChunks = chunks.length
        allDocs.push(chunk)
        // ✅ id 必须是非空字符串，格式自定义即可
        allIds.push(`${doc.id}-chunk-${i}`)
      })
      this.logger.log(`[PGVector] 文档 ${doc.id} 分块完成：共 ${chunks.length} 块`)
    }
        // ✅ fromDocuments 第四个参数传 ids，确保每条记录有明确的 id
    //    不传 ids 时，1.1.x 内部生成 uuid，但部分环境下会出现 null 问题
    await PGVectorStore.fromDocuments(
      allDocs,
      this.ollamaEmbeddings,
      this.getPgConfig(collectionName),
    )
   return {
      success:          true,
      backend:          'pgvector',
      collectionName,
      originalDocCount: documents.length,
      totalChunks:      allDocs.length, 
      chunkSize,
      chunkOverlap,
    }
     
  }
}
