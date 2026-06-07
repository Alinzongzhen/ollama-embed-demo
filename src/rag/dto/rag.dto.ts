export class AddDocumentsDto {
  collectionName: string
  documents: {
    id:        string
    content:   string
    metadata?: Record<string, any>
  }[]
  chunkSize?:    number   // 默认 500
  chunkOverlap?: number   // 默认 50
}

export class SearchDto {
  collectionName: string
  query:          string
  topK?:          number
}

export class QueryDto {
  collectionName: string
  question:       string
  topK?:          number
}