import { Module } from '@nestjs/common';
import { EmbedController } from './embed.controller';
import { EmbedService } from './embed.service';

@Module({
  controllers: [EmbedController],
  providers: [EmbedService]
})
export class EmbedModule {}
