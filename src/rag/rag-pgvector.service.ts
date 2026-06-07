import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { OllamaEmbeddings, ChatOllama } from '@langchain/ollama';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import type { DistanceStrategy } from '@langchain/community/vectorstores/pgvector';
import { Pool } from 'pg';

@Injectable()
export class RagPgvectorService implements OnModuleInit {
  private readonly logger = new Logger(RagPgvectorService.name);
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
  aaddDocument(collectionName: string, document: string, metadata?: Record<string, any>) {
    
  }
}
