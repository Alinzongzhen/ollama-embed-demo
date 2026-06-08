import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as fs from 'fs';

async function bootstrap() {
  // 判断是否需要启用 HTTPS（生产环境可通过环境变量控制）
  const httpsOptions =
    process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH
      ? {
          key: fs.readFileSync(process.env.SSL_KEY_PATH),
          cert: fs.readFileSync(process.env.SSL_CERT_PATH),
        }
      : undefined;

  const app = await NestFactory.create(AppModule, {
    ...(httpsOptions ? { httpsOptions } : {}),
  });

  // 全局 API 前缀
  app.setGlobalPrefix('api');

  // 跨域配置（开发环境宽松）
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization',
  });

  await app.listen(process.env.PORT ?? 3000);
  console.log(`🚀 服务启动：${httpsOptions ? 'https' : 'http'}://localhost:${process.env.PORT ?? 3000}/api`);
}

bootstrap();
