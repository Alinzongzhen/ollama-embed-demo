import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { OllamaEmbeddings } from '@langchain/ollama';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { Document } from '@langchain/core/documents';
import { AddDocumentsDto } from './dto/rag.dto';

@Injectable()
export class RagChromaService implements OnModuleInit {
  private readonly logger = new Logger(RagChromaService.name);
  private embeddings!: OllamaEmbeddings;

  onModuleInit(): void {
    this.embeddings = new OllamaEmbeddings({
      model: process.env.OLLAMA_MODEL || 'mxbai-embed-large',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    });
    this.logger.log('Chroma Service 初始化完成');
  }

  /** POST /rag/chroma/documents —— 添加文档到 Chroma 向量库 */
  async addDocuments(dto: AddDocumentsDto) {
    const { collectionName, documents, chunkSize = 500, chunkOverlap = 50 } = dto;

    // 文本分块
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      separators: ['\n\n', '\n', '。', '！', '？', '；', ' ', ''],
    });

    const allDocs: Document[] = [];

    for (const doc of documents) {
      const chunks = await splitter.createDocuments(
        [doc.content],
        [{ ...doc.metadata, sourceId: doc.id }],
      );
      chunks.forEach((chunk, i) => {
        chunk.metadata.chunkIndex = i;
        chunk.metadata.totalChunks = chunks.length;
        allDocs.push(chunk);
      });
      this.logger.log(`[Chroma] 文档 ${doc.id} 分块完成：共 ${chunks.length} 块`);
    }

    // 存入 Chroma
    await Chroma.fromDocuments(allDocs, this.embeddings, {
      collectionName,
      url: process.env.CHROMA_URL || 'http://localhost:8000',
    });

    return {
      success: true,
      backend: 'chroma',
      collectionName,
      originalDocCount: documents.length,
      totalChunks: allDocs.length,
      chunkSize,
      chunkOverlap,
    };
  }

  /** POST /rag/chroma/search —— 语义搜索 */
  async search(collectionName: string, query: string, topK = 3) {
    const vectorStore = await Chroma.fromExistingCollection(this.embeddings, {
      collectionName,
      url: process.env.CHROMA_URL || 'http://localhost:8000',
    });

    const results = await vectorStore.similaritySearchWithScore(query, topK);

    return {
      query,
      backend: 'chroma',
      collectionName,
      results: results.map(([doc, score]) => ({
        content: doc.pageContent,
        metadata: doc.metadata,
        score: parseFloat(score.toFixed(6)),
      })),
    };
  }
}
