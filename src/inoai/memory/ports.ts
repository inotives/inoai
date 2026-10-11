export type MemoryRecord = {
  id: number;
  body: string;
  source_message_id: number | null;
  created_by_user_id: number | null;
  review_id: number | null;
  origin: "manual" | "review";
  state: "active" | "deleted";
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  deleted_at: number | null;
  deleted_by: string | null;
};

export interface MemoryOperationsStore {
  listMemories(): Promise<MemoryRecord[]>;
  createMemory(input: {
    body: string;
    source_message_id: number | null;
    created_by_user_id: number | null;
    review_id: number | null;
    origin: "manual" | "review";
  }, actor: string): Promise<MemoryRecord>;
  softDeleteMemory(id: number, actor: string): Promise<void>;
}
