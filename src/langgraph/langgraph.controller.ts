import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { LanggraphService } from './langgraph.service';
import { ArticleService } from './article.service';
import { ReactAgentService } from './react-agent.service'
import { RoutingService } from './routing.service'
import { ParallelService } from './parallel.service'
@Controller('langgraph')
export class LanggraphController {


  constructor(private readonly svc: LanggraphService, private readonly articleSvc: ArticleService, private readonly reactSvc: ReactAgentService, private readonly routingSvc: RoutingService, private readonly parallelSvc: ParallelService ) {}

  @Post('simple-chat')
  async simpleChat(@Body() body: { message: string }) {
    return (await this.svc.simpleChat(body.message).then(res => (res)) ) 
  }
  @Post('memory-chat')
  async memoryChat(@Body() body: { message: string, threadId:string }) {
    return (await this.svc.memoryChat(body.message, body.threadId).then(res => (res)) ) 
  }
  @Get('history/:threadId')
  async history(@Param('threadId') threadId: string) {
    return (await this.svc.getHistory(threadId).then(res => (res)) ) 
  }
    // 工作流三：文章摘要流水线
    @Post('article')
    processArticle(@Body() body: { article: string }) {
      return this.articleSvc.process(body.article)
    }
       // ── 第二章接口 ──────────────────────────────────────
    @Post('react-chat')
    reactChat(@Body() body: { threadId: string; message: string }) {
      return this.reactSvc.chat(body.threadId, body.message)
        .then(answer => ({ answer }))
    }
       @Post('route')
    route(@Body() body: { input: string }) {
      return this.routingSvc.handle(body.input)
    }

    @Post('parallel')
    parallel(@Body() body: { task: string }) {
      return this.parallelSvc.parallelChat(body.task)
    }


}
