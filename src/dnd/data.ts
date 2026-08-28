/**
 * The payload carried by a drag, and the guards that read it back.
 *
 * A symbol key keeps these payloads distinguishable from any other drag on the
 * page, which is what lets a drop target refuse work that is not its own instead
 * of coercing whatever arrives.
 */
const CARD = Symbol("board.card");
const ROW = Symbol("board.row");

export interface CardDragData {
  readonly [CARD]: true;
  readonly taskId: string;
  /** The status base the card started in, so a no-op drop can be ignored. */
  readonly from: string | null;
  /**
   * The base states this row's own document allows. Carried on the drag so a
   * column can refuse the drop at the cursor rather than after a write the
   * validator would reject.
   */
  readonly allowed: readonly string[];
}

export interface RowDragData {
  readonly [ROW]: true;
  readonly taskId: string;
  readonly file: string;
  readonly section: string | null;
  readonly line: number;
}

export function cardData(data: Omit<CardDragData, typeof CARD>): Record<string, unknown> {
  return { [CARD]: true, ...data };
}

export function rowData(data: Omit<RowDragData, typeof ROW>): Record<string, unknown> {
  return { [ROW]: true, ...data };
}

type Payload = Record<string | symbol, unknown>;

export function isCardData(data: Payload): data is Payload & CardDragData {
  return data[CARD] === true;
}

export function isRowData(data: Payload): data is Payload & RowDragData {
  return data[ROW] === true;
}
