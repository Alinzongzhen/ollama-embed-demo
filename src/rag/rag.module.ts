import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';     
import { RagPgvectorService } from './rag-pgvector.service';

@Module({
  controllers: [RagController],
  providers: [RagService, RagPgvectorService],
})
export class RagModule {}
