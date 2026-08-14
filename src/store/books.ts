/**
 * Book storage: the parsed EPUB (sections + raw bytes) plus its small
 * metadata record. `listBooks` only ever reads `bookMeta`, so rendering the
 * library grid never deserializes any book's section text.
 */
import type { BookMeta, ParsedBook, Section } from "../types";
import { getDb } from "./db";

export type StoredBook = {
  meta: BookMeta;
  sections: Section[];
  raw: Blob;
};

export async function addBook(book: ParsedBook, raw: Blob): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["bookMeta", "books"], "readwrite");
  await Promise.all([
    tx.objectStore("bookMeta").put(book.meta, book.meta.id),
    tx.objectStore("books").put({ sections: book.sections, raw }, book.meta.id),
    tx.done,
  ]);
}

export async function getBook(id: string): Promise<StoredBook | undefined> {
  const db = await getDb();
  const [meta, content] = await Promise.all([
    db.get("bookMeta", id),
    db.get("books", id),
  ]);
  if (!meta || !content) return undefined;
  return { meta, sections: content.sections, raw: content.raw };
}

/** Metadata only — cheap, safe to call to render the library grid. */
export async function listBooks(): Promise<BookMeta[]> {
  const db = await getDb();
  const all = await db.getAll("bookMeta");
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteBook(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["bookMeta", "books", "progress"], "readwrite");
  await Promise.all([
    tx.objectStore("bookMeta").delete(id),
    tx.objectStore("books").delete(id),
    tx.objectStore("progress").delete(id),
    tx.done,
  ]);
}

export async function getBookMeta(id: string): Promise<BookMeta | undefined> {
  const db = await getDb();
  return db.get("bookMeta", id);
}
