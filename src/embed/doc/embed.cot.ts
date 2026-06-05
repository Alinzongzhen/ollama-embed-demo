export class EmbedSingleDto {
  text: string | undefined
}

export class EmbedBatchDto {
  texts: string[] | undefined
}

export class EmbedQueryDto {
  query: string | undefined
  documents: string[] | undefined
}