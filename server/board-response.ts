import { boardSchema, type Board as BoardResponse } from "../shared/contracts.ts";
import type { Board as LedgerBoard } from "./ledger/model.ts";

export function toBoardResponse(board: LedgerBoard): BoardResponse {
  return boardSchema.parse({
    ...board,
    documents: board.documents.map((document) => ({
      ...document,
      vocabulary: {
        bases: document.vocabulary.bases,
        source: document.vocabulary.source,
      },
    })),
  });
}
