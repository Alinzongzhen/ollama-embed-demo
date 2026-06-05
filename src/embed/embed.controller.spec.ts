import { Test, TestingModule } from '@nestjs/testing';
import { EmbedController } from './embed.controller';

describe('EmbedController', () => {
  let controller: EmbedController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmbedController],
    }).compile();

    controller = module.get<EmbedController>(EmbedController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
