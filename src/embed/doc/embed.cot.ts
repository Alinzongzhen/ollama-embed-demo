import { IsString, IsArray, ArrayNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class EmbedSingleDto {
  @ApiProperty({ description: '要嵌入的单个文本' })
  @IsString({ message: 'text 必须是字符串' })
  text!: string;
}

export class EmbedBatchDto {
  @ApiProperty({ description: '要嵌入的文本数组' })
  @IsArray({ message: 'texts 必须是数组' })
  @ArrayNotEmpty({ message: 'texts 不能为空数组' })
  @IsString({ each: true, message: 'texts 中的每个元素必须是字符串' })
  texts!: string[];
}

export class EmbedQueryDto {
  @ApiProperty({ description: '查询文本' })
  @IsString({ message: 'query 必须是字符串' })
  query!: string;

  @ApiProperty({ description: '文档文本数组' })
  @IsArray({ message: 'documents 必须是数组' })
  @ArrayNotEmpty({ message: 'documents 不能为空数组' })
  @IsString({ each: true, message: 'documents 中的每个元素必须是字符串' })
  documents!: string[];
}