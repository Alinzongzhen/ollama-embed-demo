import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EmbedModule } from './embed/embed.module';

@Module({
  imports: [EmbedModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
