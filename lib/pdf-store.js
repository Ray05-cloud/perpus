/*
  PDF storage and upload handling.

  Files live on disk under storage/pdf/<slug>.pdf, not in Postgres, because a
  book PDF is tens of megabytes and a row is not the place for it. Postgres
  keeps the metadata (books.pdf_name, books.pdf_size, books.pdf_added_at) so the
  shelf still knows which books have a file.
*/
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import Busboy from 'busboy';

export const STORAGE_DIR = process.env.PDF_STORAGE_DIR
  ? resolve(process.env.PDF_STORAGE_DIR)
  : fileURLToPath(new URL('../storage/pdf/', import.meta.url));

// A single book that takes more than this is a scan, not a novel.
export const MAX_PDF_BYTES = 200 * 1024 * 1024; // 200 MB

export async function ensureStorage() {
  await mkdir(STORAGE_DIR, { recursive: true });
}

export function pdfPath(slug) {
  return join(STORAGE_DIR, slug + '.pdf');
}

export async function removePdf(slug) {
  try {
    await unlink(pdfPath(slug));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function pdfInfo(slug) {
  try {
    const s = await stat(pdfPath(slug));
    return { size: s.size, modified: s.mtime };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const SNIFF_BYTES = 5;

/*
  Reads a multipart form with exactly one PDF in it.

  Two things this refuses on purpose:
  - anything whose first five bytes are not "%PDF-", because a .pdf extension is
    a claim, not a fact;
  - anything over MAX_PDF_BYTES, checked while streaming so a 4 GB upload is
    rejected before it fills the disk.

  The file is written to a temporary name and only renamed into place once the
  whole stream arrived, so a dropped upload never leaves a half PDF that the
  reader would try to open.
*/
export function receivePdf(req, { destPath, maxBytes = MAX_PDF_BYTES }) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: maxBytes, fields: 10 }
      });
    } catch (err) {
      reject(err);
      return;
    }

    const tmpPath = destPath + '.part';
    let out = null;
    let received = 0;
    let head = Buffer.alloc(0);
    let truncated = false;
    let sawFile = false;
    let done = false;

    function fail(err) {
      if (done) return;
      done = true;
      if (out) out.destroy();
      unlink(tmpPath).catch(() => {});
      reject(err);
    }

    busboy.on('file', (name, stream, info) => {
      if (sawFile) {
        stream.resume();
        return;
      }
      sawFile = true;

      // Some browsers send "application/octet-stream" for a real PDF, so the
      // declared type is only a hint. The magic bytes below decide.
      const looksPdf = /pdf/i.test(info.mimeType || '') || /\.pdf$/i.test(info.filename || '');
      if (!looksPdf) {
        stream.resume();
        fail(new Error('That file is not a PDF. Choose a file ending in .pdf.'));
        return;
      }

      out = createWriteStream(tmpPath);

      stream.on('data', (chunk) => {
        received += chunk.length;
        if (head.length < SNIFF_BYTES) {
          head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
        }
      });

      stream.on('limit', () => {
        truncated = true;
      });

      stream.on('error', fail);
      out.on('error', fail);

      stream.pipe(out);
    });

    busboy.on('filesLimit', () => fail(new Error('Send one PDF at a time.')));
    busboy.on('error', fail);

    busboy.on('close', () => {
      if (done) return;

      if (!sawFile) {
        fail(new Error('No file was sent.'));
        return;
      }
      if (truncated) {
        fail(new Error(`That PDF is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`));
        return;
      }
      if (head.subarray(0, SNIFF_BYTES).toString('latin1') !== '%PDF-') {
        fail(new Error('That file does not start like a PDF, even though it is named .pdf.'));
        return;
      }
      if (received === 0) {
        fail(new Error('That PDF is empty.'));
        return;
      }

      // Finish the write before the rename, otherwise the rename can land while
      // the last chunk is still in the stream buffer.
      out.end(() => {
        import('node:fs/promises')
          .then(({ rename }) => rename(tmpPath, destPath))
          .then(() => {
            done = true;
            resolve({ size: received });
          })
          .catch(fail);
      });
    });

    req.pipe(busboy);
  });
}
