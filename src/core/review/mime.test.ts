import { describe, expect, it } from "vitest";

import { buildMime } from "./mime";

/* The email jobkit sends through the Gmail API: decisions A20. */

const CR_LF = String.fromCharCode(13, 10);
const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);

function parts(message: string) {
  const [head, ...rest] = message.split(`${CR_LF}${CR_LF}`);
  return { head: head!, rest: rest.join(`${CR_LF}${CR_LF}`) };
}

const decoded = (base64Lines: string) =>
  Buffer.from(base64Lines.replaceAll(CR_LF, ""), "base64").toString("utf8");

describe("buildMime", () => {
  const message = buildMime({
    to: "jobs@example.com",
    subject: "Application: Software Engineer, New Grad – Faizan Amir",
    body: "Dear Tamer Omar,\n\nI am writing to apply.\n\nKind regards,\nFaizan Amir",
    attachment: { filename: "Faizan-Amir-CV.pdf", contentType: "application/pdf", bytes: pdf },
    boundary: "jobkit-boundary",
  });

  it("addresses the one recipient, and writes a subject with any character in it", () => {
    const { head } = parts(message);
    // Header lines folded onto the next start with a space; each encoded word is UTF-8 base64.
    const unfolded = head.replaceAll(`${CR_LF} `, " ").split(CR_LF);
    const subject = unfolded
      .find((line) => line.startsWith("Subject: "))!
      .slice("Subject: ".length);
    const words = subject.split(" ").map((word) => {
      const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word);
      expect(match, word).not.toBeNull();
      return Buffer.from(match![1]!, "base64");
    });

    expect(unfolded.filter((line) => !line.startsWith("Subject: "))).toEqual([
      "MIME-Version: 1.0",
      "To: jobs@example.com",
      'Content-Type: multipart/mixed; boundary="jobkit-boundary"',
    ]);
    expect(Buffer.concat(words).toString("utf8")).toBe(
      "Application: Software Engineer, New Grad – Faizan Amir",
    );
    for (const line of head.split(CR_LF)) expect(line.length).toBeLessThanOrEqual(78);
  });

  it("carries the body as UTF-8 text with line breaks as email has them, then the CV as a PDF", () => {
    const sections = message.split("--jobkit-boundary");
    const [textHead, textBody] = sections[1]!.trim().split(`${CR_LF}${CR_LF}`);
    const [fileHead, fileBody] = sections[2]!.trim().split(`${CR_LF}${CR_LF}`);

    expect(textHead).toBe(
      ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"].join(CR_LF),
    );
    expect(decoded(textBody!)).toBe(
      ["Dear Tamer Omar,", "", "I am writing to apply.", "", "Kind regards,", "Faizan Amir"].join(
        CR_LF,
      ),
    );
    expect(fileHead).toBe(
      [
        'Content-Type: application/pdf; name="Faizan-Amir-CV.pdf"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="Faizan-Amir-CV.pdf"',
      ].join(CR_LF),
    );
    expect(Buffer.from(fileBody!.replaceAll(CR_LF, ""), "base64")).toEqual(Buffer.from(pdf));
    expect(sections.at(-1)!.startsWith("--")).toBe(true);
  });

  it("refuses a recipient or subject that would add a header, and a file name that breaks out", () => {
    const base = {
      to: "jobs@example.com",
      subject: "Hello",
      body: "Hi",
      attachment: { filename: "cv.pdf", contentType: "application/pdf", bytes: pdf },
    };

    expect(() =>
      buildMime({ ...base, to: `jobs@example.com${CR_LF}Bcc: spy@example.net` }),
    ).toThrow();
    expect(() => buildMime({ ...base, to: "a@example.com, b@example.com" })).toThrow();
    expect(() => buildMime({ ...base, subject: `Hello${CR_LF}Bcc: spy@example.net` })).toThrow();
    expect(() =>
      buildMime({ ...base, attachment: { ...base.attachment, filename: 'cv".pdf' } }),
    ).toThrow();
  });

  it("keeps base64 lines to 76 characters, as email asks", () => {
    const long = buildMime({
      to: "jobs@example.com",
      subject: "Hello",
      body: "word ".repeat(200),
      attachment: {
        filename: "cv.pdf",
        contentType: "application/pdf",
        bytes: new Uint8Array(500),
      },
    });

    for (const line of long.split(CR_LF)) expect(line.length).toBeLessThanOrEqual(78);
  });
});
