import { Body, Controller, Post, Delete, Get, Param, Query } from '@nestjs/common'
import { RagService, }   from './rag.service'
import { RagPgvectorService } from './rag-pgvector.service'
import { AddDocumentsDto, SearchDto, QueryDto } from './dto/rag.dto'

@Controller('rag')
  export class RagController {
    constructor(
      private readonly ragSvc:   RagService,
      private readonly pgvectorSvc: RagPgvectorService,
    ) {}

    // ── Chroma 接口 ──────────────────────────────────────
    // POST /rag/chroma/documents
    @Post('chroma/documents')
    addChromaDocs(@Body() dto: AddDocumentsDto) {
      return this.ragSvc.addDocuments(dto)
    }

    // POST /rag/chroma/search
    @Post('chroma/search')
    searchChroma(@Body() dto: SearchDto) {
      return this.ragSvc.search(dto)
    }

    // POST /rag/chroma/query
    @Post('chroma/query')
    queryChroma(@Body() dto: QueryDto) {
      return this.ragSvc.query(dto)
    }

    // GET /rag/chroma/collection/:name
    @Get('chroma/collection/:name')
    chromaCollectionInfo(@Param('name') name: string) {
      return this.ragSvc.collectionInfo(name)
    }

    // DELETE /rag/chroma/collection/:name
    @Delete('chroma/collection/:name')
    deleteChromaCollection(@Param('name') name: string) {
      return this.ragSvc.deleteCollection(name)
    }

    // // ── pgvector 接口 ─────────────────────────────────────
    // // POST /rag/pgvector/documents
    // @Post('pgvector/documents')
    // addPgDocs(@Body() dto: AddDocumentsDto) {
    //   return this.pgvectorSvc.addDocuments(dto)
    // }

    // // POST /rag/pgvector/search
    // @Post('pgvector/search')
    // searchPg(@Body() dto: SearchDto) {
    //   return this.pgvectorSvc.search(dto)
    // }

    // // POST /rag/pgvector/query
    // @Post('pgvector/query')
    // queryPg(@Body() dto: QueryDto) {
    //   return this.pgvectorSvc.query(dto)
    // }

    // // GET /rag/pgvector/collection/:name
    // @Get('pgvector/collection/:name')
    // pgCollectionInfo(@Param('name') name: string) {
    //   return this.pgvectorSvc.collectionInfo(name)
    // }

    // // DELETE /rag/pgvector/collection/:name
    // @Delete('pgvector/collection/:name')
    // deletePgCollection(@Param('name') name: string) {
    //   return this.pgvectorSvc.deleteCollection(name)
    // }
  }