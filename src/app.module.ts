import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EmbedModule } from './embed/embed.module';
import { RagModule } from './rag/rag.module';
import { LanggraphModule } from './langgraph/langgraph.module';


@Module({
  imports: [EmbedModule, RagModule, LanggraphModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
