import { Test, TestingModule } from '@nestjs/testing';
import { ParallelService } from './parallel.service';

describe('ParallelService', () => {
  let service: ParallelService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ParallelService],
    }).compile();

    service = module.get<ParallelService>(ParallelService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
