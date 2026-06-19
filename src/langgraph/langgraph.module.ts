import { Module } from '@nestjs/common';
import { LanggraphController } from './langgraph.controller';
import { LanggraphService } from './langgraph.service';
import { ArticleService } from './article.service';
import { ReactAgentService } from './react-agent.service';
import { RoutingService } from './routing.service';
import { ParallelService } from './parallel.service';
import { SupervisorService } from './supervisor.service';
import { PipelineService } from './pipeline.service';
import { CodeReviewService } from './code-review.service';


@Module({
  controllers: [LanggraphController],
  providers: [LanggraphService, ArticleService, ReactAgentService, RoutingService, ParallelService, SupervisorService, PipelineService, CodeReviewService],
})
export class LanggraphModule {}
