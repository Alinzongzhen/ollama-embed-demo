import { Controller, Post, Body, Get } from '@nestjs/common';
import { EmbedService } from './embed.service';
import { EmbedSingleDto, EmbedBatchDto, EmbedQueryDto } from './doc/embed.cot';

@Controller('embed')
export class EmbedController {
      constructor(private readonly embedService: EmbedService) {}

  // POST /embed/single
  @Post('single')
  async embedSingle(@Body() dto: EmbedSingleDto) {
    return this.embedService.embedSingle(dto.text)
  }
   // POST /embed/batch
  @Post('batch')
  async embedBatch(@Body() dto: EmbedBatchDto) {
    return this.embedService.embedBatch(dto.texts)
  }
  // POST /embed/similarity
  @Post('similarity')
  async similarity(@Body() dto: EmbedQueryDto) {
    return this.embedService.similarity(dto.query, dto.documents)
  }

}
