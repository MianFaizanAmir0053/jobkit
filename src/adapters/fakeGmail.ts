import type { GmailSender, GmailSendResult } from "@/core/ports";

/**
 * A Gmail port for tests and the test server (decisions A20): it keeps each
 * message it sends, and answers as the test sets, sent with fresh IDs until
 * told otherwise. Nothing leaves the process.
 */
export interface FakeGmail extends GmailSender {
  /** The messages sent, in order, as MIME text. */
  readonly sent: string[];
  /** What every later send answers; null goes back to sending with fresh IDs. */
  answerWith(result: GmailSendResult | null): void;
}

export function fakeGmail(): FakeGmail {
  const sent: string[] = [];
  let answer: GmailSendResult | null = null;
  return {
    sent,
    answerWith(result) {
      answer = result;
    },
    async send(message) {
      const given = answer ?? {
        ok: true,
        messageId: `m${sent.length + 1}`,
        threadId: `t${sent.length + 1}`,
      };
      if (given.ok) sent.push(message);
      return given;
    },
  };
}
