import { Test, TestingModule } from '@nestjs/testing';
import { LanggraphService } from './langgraph.service';

describe('LanggraphService', () => {
  let service: LanggraphService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LanggraphService],
    }).compile();

    service = module.get<LanggraphService>(LanggraphService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
