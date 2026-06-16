import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { LanggraphService } from './langgraph.service';
import { ArticleService } from './article.service';

@Controller('langgraph')
export class LanggraphController {


  constructor(private readonly svc: LanggraphService, private readonly articleSvc: ArticleService) {}

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

}
