import { Controller, Post, Body} from '@nestjs/common';
import { LanggraphService } from './langgraph.service';

@Controller('langgraph')
export class LanggraphController {


  constructor(private readonly svc: LanggraphService) {}

  @Post('simple-chat')
  async simpleChat(@Body() body: { message: string }) {
    return (await this.svc.simpleChat(body.message).then(res => (res)) ) 
  }
  @Post('memory-chat')
  async memoryChat(@Body() body: { message: string, threadId:string }) {
    return (await this.svc.memoryChat(body.message, body.threadId).then(res => (res)) ) 
  }

}
