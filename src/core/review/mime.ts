import { isStrictAddress } from "@/core/extraction/contacts";

/**
 * The email jobkit sends through the Gmail API (decisions A20): a MIME
 * message to one recipient, its subject in UTF-8 encoded words, the body as
 * UTF-8 text and the CV as a PDF attachment, both in base64 lines of 76
 * characters. Gmail adds From, Date and the Message-ID. Nothing from a post
 * can add a header: the recipient must pass the strict address check, the
 * subject is one line, and the file name is plain.
 */

const CRLF = "\r\n";
const LINE = 76;
/** Bytes per encoded word, so even the first, after "Subject: ", stays within 78 characters. */
const WORD_BYTES = 42;

export interface MimeAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface MimeEmail {
  to: string;
  subject: string;
  body: string;
  attachment: MimeAttachment;
  /** The multipart boundary; a fresh random one when not given. */
  boundary?: string;
}

function base64Lines(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += LINE) lines.push(text.slice(at, at + LINE));
  return lines.join(CRLF);
}

/** The subject as UTF-8 encoded words, each whole characters, folded onto lines of their own. */
function encodedSubject(subject: string): string {
  const words: string[] = [];
  let bytes: number[] = [];
  for (const char of subject) {
    const encoded = [...Buffer.from(char, "utf8")];
    if (bytes.length + encoded.length > WORD_BYTES) {
      words.push(`=?UTF-8?B?${Buffer.from(bytes).toString("base64")}?=`);
      bytes = [];
    }
    bytes.push(...encoded);
  }
  if (bytes.length > 0) words.push(`=?UTF-8?B?${Buffer.from(bytes).toString("base64")}?=`);
  return words.join(`${CRLF} `);
}

export function buildMime(email: MimeEmail): string {
  const to = email.to.trim();
  if (!isStrictAddress(to)) throw new Error("The recipient is not one plain email address");
  if (/[\r\n\p{Zl}\p{Zp}]/u.test(email.subject)) throw new Error("The subject runs over a line");
  if (!/^[A-Za-z0-9._ -]{1,100}$/.test(email.attachment.filename)) {
    throw new Error("The attachment's file name is not plain");
  }
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(email.attachment.contentType)) {
    throw new Error("The attachment's type is not plain");
  }
  const boundary =
    email.boundary ?? `jobkit-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const text = email.body.replace(/\r\n|\r|\n/g, CRLF);
  const { filename, contentType, bytes } = email.attachment;
  return [
    "MIME-Version: 1.0",
    `To: ${to}`,
    `Subject: ${encodedSubject(email.subject)}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(text, "utf8")),
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    base64Lines(bytes),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}
