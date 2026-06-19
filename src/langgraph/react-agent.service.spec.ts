import { Test, TestingModule } from '@nestjs/testing';
import { ReactAgentService } from './react-agent.service';

describe('ReactAgentService', () => {
  let service: ReactAgentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReactAgentService],
    }).compile();

    service = module.get<ReactAgentService>(ReactAgentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
