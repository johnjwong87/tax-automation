import { NextRequest, NextResponse } from "next/server";
import { analyzeRentalDocuments } from "@/lib/gemini";
import { del } from "@vercel/blob";
import mammoth from "mammoth";
import MsgReader from "@kenjiuno/msgreader";
import * as XLSX from "xlsx";

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// Helper to convert ArrayBuffer to Buffer
function toBuffer(arrayBuffer: ArrayBuffer) {
    const buffer = Buffer.alloc(arrayBuffer.byteLength);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < buffer.length; ++i) {
        buffer[i] = view[i];
    }
    return buffer;
}

// Helper to identify MIME type from filename/content
function getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
        case "pdf": return "application/pdf";
        case "png": return "image/png";
        case "jpg":
        case "jpeg": return "image/jpeg";
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case "msg": return "application/vnd.ms-outlook";
        case "xlsx":
        case "xls": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case "csv": return "text/csv";
        default: return "application/octet-stream";
    }
}

// Helper to check if file should be skipped
function shouldSkipFile(filename: string): boolean {
    const skipPatterns = [
        /^\./, // Hidden files
        /^~\$/, // Temp files
        /\.tmp$/i,
        /\.DS_Store$/i,
        /Thumbs\.db$/i,
    ];
    return skipPatterns.some(pattern => pattern.test(filename));
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

// Recursive file processor
async function processFile(
    fileBuffer: Buffer,
    filename: string,
    manifest: string[],
    currentPath: string
): Promise<{ inlineData: { data: string; mimeType: string } }[]> {
    const normalizedName = currentPath || filename;

    if (shouldSkipFile(filename)) {
        console.log(`Skipping file: ${normalizedName}`);
        return [];
    }

    if (fileBuffer.length > MAX_FILE_SIZE) {
        console.log(`File too large, skipping: ${normalizedName}`);
        return [];
    }

    manifest.push(normalizedName);
    const parts: { inlineData: { data: string; mimeType: string } }[] = [];
    const mimeType = getMimeType(filename);

    try {
        if (filename.endsWith(".msg")) {
            // Convert Node.js Buffer to ArrayBuffer for MsgReader
            const arrayBuffer = fileBuffer.buffer.slice(
                fileBuffer.byteOffset,
                fileBuffer.byteOffset + fileBuffer.byteLength
            );
            const msgReader = new MsgReader(arrayBuffer as ArrayBuffer);
            const fileData = msgReader.getFileData();

            let emailText = `--- EMAIL: ${normalizedName} ---\n`;
            if (fileData.headers) {
                emailText += `From: ${fileData.senderName || fileData.senderEmail || "Unknown"}\n`;
                emailText += `To: ${fileData.recipients?.map((r: any) => r.name || r.email).join(", ") || "Unknown"}\n`;
                emailText += `Subject: ${fileData.subject || "No Subject"}\n`;
            }
            emailText += `\nBody:\n${fileData.body || "(No body text)"}\n`;

            parts.push({
                inlineData: {
                    data: Buffer.from(emailText).toString("base64"),
                    mimeType: "text/plain",
                },
            });

            if (fileData.attachments && fileData.attachments.length > 0) {
                console.log(`Found ${fileData.attachments.length} attachments in ${normalizedName}`);
                for (const attach of fileData.attachments) {
                    const attachmentData = msgReader.getAttachment(attach);
                    if (attachmentData && attachmentData.content) {
                        const attachBuffer = Buffer.from(attachmentData.content);
                        const attachFilename = attachmentData.fileName || "attachment";
                        const attachPath = `${normalizedName} > ${attachFilename}`;
                        const nestedParts = await processFile(attachBuffer, attachFilename, manifest, attachPath);
                        parts.push(...nestedParts);
                    }
                }
            }
        } else if (filename.endsWith(".docx")) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            const text = `--- DOCUMENT: ${normalizedName} ---\n${result.value}`;
            parts.push({
                inlineData: {
                    data: Buffer.from(text).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        } else if (filename.endsWith(".xlsx") || filename.endsWith(".xls") || filename.endsWith(".csv")) {
            const workbook = XLSX.read(fileBuffer, { type: "buffer" });
            let text = `--- SPREADSHEET: ${normalizedName} ---\n`;
            workbook.SheetNames.forEach((sheetName) => {
                const sheet = workbook.Sheets[sheetName];
                const csvData = XLSX.utils.sheet_to_csv(sheet);
                text += `\nSheet: ${sheetName}\n${csvData}\n`;
            });
            parts.push({
                inlineData: {
                    data: Buffer.from(text).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        } else if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
            parts.push({
                inlineData: {
                    data: fileBuffer.toString("base64"),
                    mimeType: mimeType,
                },
            });
        } else {
            parts.push({
                inlineData: {
                    data: Buffer.from(`--- BINARY FILE: ${normalizedName} ---`).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        }
    } catch (error) {
        console.error(`Error processing ${normalizedName}:`, error);
    }

    return parts;
}

export async function POST(request: NextRequest) {
    const blobsToDelete: string[] = [];

    try {
        const body = await request.json();
        const { blobs } = body;

        if (!blobs || !Array.isArray(blobs)) {
            return NextResponse.json({ error: "Invalid request: blobs array required" }, { status: 400 });
        }

        const geminiParts: { inlineData: { data: string; mimeType: string } }[] = [];
        const manifest: string[] = [];

        // Download and process files from blob URLs
        for (const blobInfo of blobs) {
            const { blobUrl, filename, section } = blobInfo;
            blobsToDelete.push(blobUrl);

            try {
                const response = await fetch(blobUrl);
                if (!response.ok) {
                    console.error(`Failed to download blob: ${blobUrl}`);
                    continue;
                }

                const arrayBuffer = await response.arrayBuffer();
                const fileBuffer = Buffer.from(arrayBuffer);

                // Add section header
                if (section === "files_prior") {
                    geminiParts.push({
                        inlineData: {
                            data: Buffer.from("--- SECTION: PRIOR YEAR FILES (Context Only) ---").toString("base64"),
                            mimeType: "text/plain",
                        },
                    });
                } else if (section === "files_t776") {
                    geminiParts.push({
                        inlineData: {
                            data: Buffer.from("--- SECTION: PRIOR YEAR T776 (Template) ---").toString("base64"),
                            mimeType: "text/plain",
                        },
                    });
                } else if (section === "files_current") {
                    geminiParts.push({
                        inlineData: {
                            data: Buffer.from("--- SECTION: CURRENT YEAR FILES ---").toString("base64"),
                            mimeType: "text/plain",
                        },
                    });
                }

                const parts = await processFile(fileBuffer, filename, manifest, "");
                geminiParts.push(...parts);
            } catch (error) {
                console.error(`Error processing blob ${filename}:`, error);
            }
        }

        const prompt = `
      # ROLE: Senior CPA & Tax Reviewer (T776 Specialized)
      Your value is not just data entry, but **Critical Analysis, Error Detection, and Event Reconstruction**. You do not blindly accept client data; you audit it for consistency, completeness, and tax compliance (specifically Accrual Basis).

      # THE DATA ECOSYSTEM
      You have three sources of truth that must be triangulated:
      1. **The Legal/Historical Baseline (PY Files):** Lease agreements, mortgage contracts, property tax assessments. (This tells you what *should* happen).
      2. **The Prior Benchmark (PY T776):** What was reported last year. (This establishes the trend/run-rate).
      3. **The Client's Claim (CY Files):** The raw data/spreadsheets the client provided this year. (This is what *did* happen, according to them).

      # THE "CPA REASONING" PROTOCOL
      Before generating any output, you must perform the following cognitive steps:

      ## Step 1: Construct the "Expected Reality"
      Ignore the current year files for a moment. Look at the PY Files and PY T776.
      - **Revenue:** Based on the lease agreements found in PY files, what *should* the annual rent be? (Rate x 12).
      - **Expenses:** What fixed costs existed last year? (e.g., Property Tax, Insurance, Mortgage Interest). These rarely disappear.
      - **Tenancy:** Who is the tenant? When does the lease end?

      ## Step 2: Audit the "Reported Reality"
      Now review the CY Files (Client Spreadsheet/Docs).
      - Extract the totals provided by the client.

      ## Step 3: The Gap Analysis & Event Reconstruction
      Compare Step 1 (Expected) vs. Step 2 (Reported). Use the following **Logic Chains** to identify discrepancies and reconstruct the "Real-World Events" behind the numbers.

      ### Logic Chain A: The "Tenant Turnover" Chain
      **Trigger:** A change in monthly rent amount, a gap in rent received, or a lease end date occurring during the tax year.
      **Reasoning:** If a tenant moved out and a new one moved in, specific expenses *must* exist.
      **Checklist for Questions:**
      *   **Commissions:** If a new tenant started, was a Realtor hired? Check for "Commissions" expense. If $0, **ASK** if they paid a finder's fee.
      *   **Vacancy Period:** If there is a gap in rent (e.g., 1-2 months empty), who paid the hydro/gas? Landlords usually pay utilities during vacancy. If Utilities = $0 during the gap, **ASK** about them.
      *   **Turnover Costs:** Did they clean, paint, or repair the unit for the new tenant? If Repairs/Maintenance is low, **ASK** if they incurred these costs to get the unit ready.
      *   **Deposit Reconciliation:** If the old lease ended, was the "Last Month's Rent" (LMR) deposit applied to the final month? Was a *new* deposit collected?

      ### Logic Chain B: The "New Property / New Build" Chain
      **Trigger:** A property acquired in the current tax year or a newly completed condo.
      **Reasoning:** New properties have unique, often missed, costs.
      **Checklist for Questions:**
      *   **Supplemental Taxes:** For new condos, the city often delays the final tax bill. If Property Tax is low or round numbers, **ASK** if a "Supplemental Tax Bill" was received later.
      *   **Closing Adjustments:** Check the Statement of Adjustments (legal doc). Were prepaid taxes or condo fees reimbursed to the seller? These are deductible/capitalizable.

      ### Logic Chain C: The "Cross-Property Benchmarking" Chain
      **Trigger:** The client owns multiple properties (Property A vs. Property B).
      **Reasoning:** Similar assets should have similar expense profiles.
      **Checklist for Questions:**
      *   **Insurance/Mortgage:** Compare premiums/interest across properties. If Property A is significantly lower than Property B (and they are similar value), **WARN** the client to check their coverage or explain the variance.
      *   **Missing Categories:** If Property A claims "Landscaping" or "Snow Removal" and Property B doesn't, ask if Property B was missed.

      ### Logic Chain D: The "Accrual vs. Cash" Chain
      **Trigger:** Cash received does not equal (Monthly Rent x 12).
      **Reasoning:** Canadian tax is Accrual-based.
      **Checklist for Questions:**
      *   **Arrears vs. Deposits:** If rent is missing, is it unpaid (Arrears) or was it prepaid in a prior year (Deposit application)? You must ask the client to clarify the *nature* of the missing funds.

      # OUTPUT INSTRUCTIONS

      ## 1. The T776 Data Generation
      - Produce the T776 figures.
      - **Auto-Correction:** If you find clear evidence of Accrual items (like LMR application) that the client missed, adjust the figures to be tax-compliant, but flag them clearly as "AI Adjustments."

      ## 2. The "Smart" Client Email
      - Draft a list of questions/clarifications.
      - **Rule:** Never ask a question that you could answer by looking at the other files.
      - **Rule:** Connect the dots for the client. Show them *why* you are asking.

      ### Examples of "CPA Reasoning" in Email Drafts:
      *   **Bad (Lazy):** "Why is insurance zero?"
      *   **Good (Reasoned):** "Last year, we claimed $1,200 for insurance. Your current spreadsheet lists $0. Did you pay the insurance policy this year, or was it perhaps missed in the upload?"
      *   **Bad (Lazy):** "Why is rent lower?"
      *   **Good (Reasoned):** "The lease on file shows rent of $4,000/mo, which should total $48,000. Your spreadsheet shows $40,000 (missing Jan/Feb). Since the lease started prior to Jan 1st, were these months covered by the Last Month's Rent deposit collected previously, or was the unit vacant?"

      # OUTPUT FORMAT (STRICT JSON):
      {
        "tax_year": number,
        "properties": [
          {
            "address": "string",
            "income": {
              "category_name": { "amount": number, "source_file": "string" }
            },
            "income_prior": { "category_name": number },
            "expenses": {
              "category_name": { "amount": number, "source_file": "string" }
            },
            "expenses_prior": { "category_name": number },
            "source_files_read": ["string"],
            "notes": "string (Include LOGICAL DISCONNECTS found and AI ADJUSTMENTS here)"
          }
        ],
        "email_draft": "string",
        "all_files_detected": ["string"]
      }
    `;

        const responseText = await analyzeRentalDocuments(prompt, geminiParts);

        if (!responseText || responseText.trim() === "") {
            return NextResponse.json({ error: "Empty response from AI" }, { status: 500 });
        }

        // Robust cleanup of markdown or chatter if JSON mode fails
        let cleanedResult = responseText.trim();
        if (cleanedResult.includes("{")) {
            // If there's conversational filler, find the first '{' and last '}'
            const start = cleanedResult.indexOf("{");
            const end = cleanedResult.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
                cleanedResult = cleanedResult.substring(start, end + 1);
            }
        }

        let data;
        try {
            data = JSON.parse(cleanedResult);
        } catch (e) {
            console.error("Failed to parse Gemini JSON:", cleanedResult);
            return NextResponse.json({
                error: "The AI returned an invalid response. Please try re-sending with slightly fewer files.",
                raw: cleanedResult.substring(0, 500)
            }, { status: 500 });
        }

        // Overwrite Gemini's list with our reliable manifest from the recursive read
        data.all_files_detected = manifest;

        // Clean up blobs
        for (const blobUrl of blobsToDelete) {
            try {
                await del(blobUrl);
                console.log(`Deleted blob: ${blobUrl}`);
            } catch (error) {
                console.error(`Failed to delete blob ${blobUrl}:`, error);
            }
        }

        return NextResponse.json({ data });

    } catch (error: any) {
        console.error("Analysis error:", error);

        // Attempt cleanup even on error
        for (const blobUrl of blobsToDelete) {
            try {
                await del(blobUrl);
            } catch (e) {
                console.error(`Cleanup failed for ${blobUrl}:`, e);
            }
        }

        return NextResponse.json(
            { error: error.message || "Internal Server Error" },
            { status: 500 }
        );
    }
}
