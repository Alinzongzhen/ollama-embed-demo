import { Test, TestingModule } from '@nestjs/testing';
import { CodeReviewService } from './code-review.service';

describe('CodeReviewService', () => {
  let service: CodeReviewService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CodeReviewService],
    }).compile();

    service = module.get<CodeReviewService>(CodeReviewService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
