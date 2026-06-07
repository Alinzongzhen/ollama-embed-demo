import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EmbedModule } from './embed/embed.module';
import { RagModule } from './rag/rag.module';

@Module({
  imports: [EmbedModule, RagModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
