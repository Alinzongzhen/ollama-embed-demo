import { Module } from '@nestjs/common';
import { LanggraphController } from './langgraph.controller';
import { LanggraphService } from './langgraph.service';
import { ArticleService } from './article.service';

@Module({
  controllers: [LanggraphController],
  providers: [LanggraphService, ArticleService],
})
export class LanggraphModule {}
