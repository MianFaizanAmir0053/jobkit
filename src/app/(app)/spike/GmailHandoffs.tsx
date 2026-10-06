"use client";

import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Nothing is sent: example.com receives no mail, and the owner discards the draft.
const ADDRESS = "spike@example.com";
const SUBJECT = "Application: Test Engineer (jobkit spike)";
const BODY =
  "Dear Hiring Manager,\n\nThis is a test draft from jobkit's handoff spike.\n\nKind regards";

/**
 * The two email handoffs (review spec, "Handoffs"), for counting taps on the
 * owner's phone. A follows a mailto: link and the CV is attached in Gmail; B
 * copies the address and subject, then shares the CV and the body.
 */
export function GmailHandoffs() {
  const [pdf, setPdf] = useState<{ file: File; url: string } | null>(null);
  const [canShareFiles, setCanShareFiles] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const file = new File([testPdf()], "test-cv.pdf", { type: "application/pdf" });
    const url = URL.createObjectURL(file);
    // The file and the browser's sharing support are known only in the browser.
    queueMicrotask(() => {
      setPdf({ file, url });
      setCanShareFiles(
        typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }),
      );
    });
    return () => URL.revokeObjectURL(url);
  }, []);

  const mailto = `mailto:${ADDRESS}?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(BODY)}`;

  function shareWithCv() {
    if (!pdf) return;
    // The share must start inside the tap, with nothing awaited before it.
    void navigator.clipboard?.writeText(`${ADDRESS}\n${SUBJECT}`).catch(() => undefined);
    navigator
      .share({ files: [pdf.file], text: BODY, title: SUBJECT })
      .then(() => setNotice("Shared. Count the taps until Gmail's draft is ready to send."))
      .catch((error: unknown) =>
        setNotice(`Share did not finish: ${error instanceof Error ? error.name : "unknown"}`),
      );
  }

  return (
    <div className="mt-3 space-y-6">
      <div>
        <h3 className="font-medium">A: Open in Gmail</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          First download the test CV once, then tap Open in Gmail and attach it from Gmail&apos;s
          recent files. Count every tap from Open in Gmail until the draft is ready to send.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {pdf && (
            <a
              href={pdf.url}
              download="test-cv.pdf"
              className={buttonVariants({ variant: "outline" })}
            >
              Download the test CV
            </a>
          )}
          <a href={mailto} className={cn(buttonVariants())}>
            Open in Gmail
          </a>
        </div>
      </div>
      <div>
        <h3 className="font-medium">B: Share with CV</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Copies the address and subject, then shares the test CV and the body. Count every tap from
          Share with CV until the draft is ready to send.
        </p>
        {canShareFiles === false ? (
          <p className="mt-2 text-sm">
            This browser cannot share files, so B is not available here.
          </p>
        ) : (
          <Button className="mt-2" disabled={!pdf} onClick={shareWithCv}>
            Share with CV
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </div>
  );
}

/** A one-page PDF reading "Test CV", with a correct cross-reference table; all ASCII. */
function testPdf(): string {
  const text = "BT /F1 24 Tf 72 760 Td (Test CV) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
