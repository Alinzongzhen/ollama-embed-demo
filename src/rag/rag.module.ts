import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { RagChromaService } from './rag-chroma.service';


@Module({
  controllers: [RagController],
  providers: [RagService, RagChromaService],
})
export class RagModule {}
